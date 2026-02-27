import express from 'express';
import http from 'http';
import path from 'path';
import { Server, Socket } from 'socket.io';
import { GameRoom } from './GameRoom';
import {
  ServerToClientEvents, ClientToServerEvents,
  SdpInit, IceInit,
  Phase, Role,
} from './types';

// ─── Setup ───────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT ?? 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// SPA fallback — serve index.html for unknown routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

// ─── In-memory rooms ───────────────────────────────────────────────────────

const rooms: Map<string, GameRoom> = new Map();

function getOrCreateRoom(roomId: string): GameRoom {
  if (!rooms.has(roomId)) rooms.set(roomId, new GameRoom(roomId));
  return rooms.get(roomId)!;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

function wireRoom(room: GameRoom): void {
  // Broadcast full state to all players in the room
  room.broadcastState = () => {
    const state = room.toPublicState();
    io.to(room.roomId).emit('room:state', state);
  };

  // Send each player their role privately
  room.sendRoles = () => {
    const mafiaIds = room.getMafiaIds();
    for (const player of room.getPlayers()) {
      if (player.role === null) continue;
      const personalMafiaIds = player.role === Role.Mafia ? mafiaIds : [];
      io.to(player.id).emit('player:role', player.role, personalMafiaIds);
    }
  };

  room.broadcastNightStart = (timerEndsAt) => {
    io.to(room.roomId).emit('night:start', timerEndsAt);
  };

  room.broadcastNightResult = (pub) => {
    io.to(room.roomId).emit('night:result', pub);
  };

  room.sendDetectiveResult = (detectiveId, targetId, targetName, isMafia) => {
    io.to(detectiveId).emit('detective:result', targetId, targetName, isMafia);
  };

  room.broadcastDayStart = (timerEndsAt) => {
    io.to(room.roomId).emit('day:start', timerEndsAt);
  };

  room.broadcastVotingStart = (timerEndsAt) => {
    io.to(room.roomId).emit('voting:start', timerEndsAt);
  };

  room.broadcastVoteUpdate = (votes) => {
    io.to(room.roomId).emit('voting:update', votes);
  };

  room.broadcastResult = (eliminatedId, eliminatedName) => {
    io.to(room.roomId).emit('result', eliminatedId, eliminatedName);
  };

  room.broadcastGameOver = (winner, reason) => {
    io.to(room.roomId).emit('gameover', winner, reason);
  };
}

// ─── Socket.IO event handlers ─────────────────────────────────────────────

io.on('connection', (socket: AppSocket) => {
  let currentRoomId: string | null = null;
  let currentName:   string        = '';

  // ── Join room ──────────────────────────────────────────────────────────
  socket.on('room:join', (roomId: string, playerName: string) => {
    roomId = roomId.trim().toUpperCase();
    playerName = playerName.trim().slice(0, 24);

    if (!roomId || !playerName) {
      socket.emit('error', 'Некорректный ID комнаты или имя.');
      return;
    }

    const room = getOrCreateRoom(roomId);

    if (room.size() >= 10) {
      socket.emit('error', 'Комната заполнена (максимум 10 игроков).');
      return;
    }

    if (room.getPhase() !== Phase.Lobby && room.getPhase() !== Phase.GameOver) {
      socket.emit('error', 'Игра уже идёт. Подождите следующий раунд.');
      return;
    }

    // Leave previous room if any
    if (currentRoomId) {
      leaveRoom(socket, currentRoomId);
    }

    currentRoomId = roomId;
    currentName   = playerName;

    socket.join(roomId);
    wireRoom(room);
    room.addPlayer(socket.id, playerName);

    // Tell new player the current state
    socket.emit('room:state', room.toPublicState());

    // Tell everyone else a new peer joined (for WebRTC)
    socket.to(roomId).emit('rtc:peer-joined', socket.id, playerName);

    // Broadcast updated state
    room.broadcastState();
  });

  // ── Ready toggle ───────────────────────────────────────────────────────
  socket.on('player:ready', (ready: boolean) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.setReady(socket.id, ready);
    room.broadcastState();
  });

  // ── Host starts game ───────────────────────────────────────────────────
  socket.on('game:start', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.getHostId() !== socket.id) {
      socket.emit('error', 'Только хост может начать игру.');
      return;
    }
    const { ok, reason } = room.canStart();
    if (!ok) {
      socket.emit('error', reason);
      return;
    }
    room.startGame();
  });

  // ── Night action ───────────────────────────────────────────────────────
  socket.on('night:action', (targetId: string) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.submitNightAction(socket.id, targetId);
  });

  // ── Day vote ───────────────────────────────────────────────────────────
  socket.on('day:vote', (targetId: string) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.submitDayVote(socket.id, targetId);
  });

  // ── Chat ───────────────────────────────────────────────────────────────
  socket.on('chat:send', (text: string) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const player = room.getPlayer(socket.id);
    if (!player) return;

    text = text.trim().slice(0, 300);
    if (!text) return;

    const phase = room.getPhase();

    // Mafia team chat during night (only visible to mafia members)
    if (phase === Phase.Night) {
      if (player.role === Role.Mafia) {
        const mafiaIds = room.getMafiaIds();
        for (const id of mafiaIds) {
          io.to(id).emit('chat:message', player.name, text, true);
        }
      }
      return;
    }

    // Day / Voting — broadcast to all alive players (dead players can spectate)
    if (phase === Phase.Day || phase === Phase.Voting) {
      if (!player.alive) return;   // dead can't speak
      io.to(currentRoomId).emit('chat:message', player.name, text, false);
    }
  });

  // ── WebRTC signaling ───────────────────────────────────────────────────
  socket.on('rtc:offer', (toId: string, offer: SdpInit) => {
    io.to(toId).emit('rtc:offer', socket.id, offer);
  });

  socket.on('rtc:answer', (toId: string, answer: SdpInit) => {
    io.to(toId).emit('rtc:answer', socket.id, answer);
  });

  socket.on('rtc:ice', (toId: string, candidate: IceInit) => {
    io.to(toId).emit('rtc:ice', socket.id, candidate);
  });

  // ── Disconnect ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (currentRoomId) {
      leaveRoom(socket, currentRoomId);
    }
  });

  // ─── Helper: leave room ────────────────────────────────────────────────
  function leaveRoom(sock: AppSocket, roomId: string): void {
    const room = rooms.get(roomId);
    if (!room) return;
    room.removePlayer(sock.id);
    sock.leave(roomId);
    // Notify peers for WebRTC cleanup
    sock.to(roomId).emit('rtc:peer-left', sock.id);
    if (room.isEmpty()) {
      rooms.delete(roomId);
    } else {
      room.broadcastState();
    }
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`✅  Mafia server running at http://localhost:${PORT}`);
});
