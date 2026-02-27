"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const socket_io_1 = require("socket.io");
const GameRoom_1 = require("./GameRoom");
const types_1 = require("./types");
// ─── Setup ───────────────────────────────────────────────────────────────────
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: { origin: '*' },
});
const PORT = process.env.PORT ?? 3000;
// Serve static files from /public
app.use(express_1.default.static(path_1.default.join(__dirname, '..', '..', 'public')));
// SPA fallback — serve index.html for unknown routes
app.get('*', (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, '..', '..', 'public', 'index.html'));
});
// ─── In-memory rooms ───────────────────────────────────────────────────────
const rooms = new Map();
function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId))
        rooms.set(roomId, new GameRoom_1.GameRoom(roomId));
    return rooms.get(roomId);
}
function wireRoom(room) {
    // Broadcast full state to all players in the room
    room.broadcastState = () => {
        const state = room.toPublicState();
        io.to(room.roomId).emit('room:state', state);
    };
    // Send each player their role privately
    room.sendRoles = () => {
        const mafiaIds = room.getMafiaIds();
        for (const player of room.getPlayers()) {
            if (player.role === null)
                continue;
            const personalMafiaIds = player.role === types_1.Role.Mafia ? mafiaIds : [];
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
io.on('connection', (socket) => {
    let currentRoomId = null;
    let currentName = '';
    // ── Join room ──────────────────────────────────────────────────────────
    socket.on('room:join', (roomId, playerName) => {
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
        if (room.getPhase() !== types_1.Phase.Lobby && room.getPhase() !== types_1.Phase.GameOver) {
            socket.emit('error', 'Игра уже идёт. Подождите следующий раунд.');
            return;
        }
        // Leave previous room if any
        if (currentRoomId) {
            leaveRoom(socket, currentRoomId);
        }
        currentRoomId = roomId;
        currentName = playerName;
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
    socket.on('player:ready', (ready) => {
        if (!currentRoomId)
            return;
        const room = rooms.get(currentRoomId);
        if (!room)
            return;
        room.setReady(socket.id, ready);
        room.broadcastState();
    });
    // ── Host starts game ───────────────────────────────────────────────────
    socket.on('game:start', () => {
        if (!currentRoomId)
            return;
        const room = rooms.get(currentRoomId);
        if (!room)
            return;
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
    socket.on('night:action', (targetId) => {
        if (!currentRoomId)
            return;
        const room = rooms.get(currentRoomId);
        if (!room)
            return;
        room.submitNightAction(socket.id, targetId);
    });
    // ── Day vote ───────────────────────────────────────────────────────────
    socket.on('day:vote', (targetId) => {
        if (!currentRoomId)
            return;
        const room = rooms.get(currentRoomId);
        if (!room)
            return;
        room.submitDayVote(socket.id, targetId);
    });
    // ── Chat ───────────────────────────────────────────────────────────────
    socket.on('chat:send', (text) => {
        if (!currentRoomId)
            return;
        const room = rooms.get(currentRoomId);
        if (!room)
            return;
        const player = room.getPlayer(socket.id);
        if (!player)
            return;
        text = text.trim().slice(0, 300);
        if (!text)
            return;
        const phase = room.getPhase();
        // Mafia team chat during night (only visible to mafia members)
        if (phase === types_1.Phase.Night) {
            if (player.role === types_1.Role.Mafia) {
                const mafiaIds = room.getMafiaIds();
                for (const id of mafiaIds) {
                    io.to(id).emit('chat:message', player.name, text, true);
                }
            }
            return;
        }
        // Day / Voting — broadcast to all alive players (dead players can spectate)
        if (phase === types_1.Phase.Day || phase === types_1.Phase.Voting) {
            if (!player.alive)
                return; // dead can't speak
            io.to(currentRoomId).emit('chat:message', player.name, text, false);
        }
    });
    // ── WebRTC signaling ───────────────────────────────────────────────────
    socket.on('rtc:offer', (toId, offer) => {
        io.to(toId).emit('rtc:offer', socket.id, offer);
    });
    socket.on('rtc:answer', (toId, answer) => {
        io.to(toId).emit('rtc:answer', socket.id, answer);
    });
    socket.on('rtc:ice', (toId, candidate) => {
        io.to(toId).emit('rtc:ice', socket.id, candidate);
    });
    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        if (currentRoomId) {
            leaveRoom(socket, currentRoomId);
        }
    });
    // ─── Helper: leave room ────────────────────────────────────────────────
    function leaveRoom(sock, roomId) {
        const room = rooms.get(roomId);
        if (!room)
            return;
        room.removePlayer(sock.id);
        sock.leave(roomId);
        // Notify peers for WebRTC cleanup
        sock.to(roomId).emit('rtc:peer-left', sock.id);
        if (room.isEmpty()) {
            rooms.delete(roomId);
        }
        else {
            room.broadcastState();
        }
    }
});
// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`✅  Mafia server running at http://localhost:${PORT}`);
});
