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
// ─── Setup ────────────────────────────────────────────────────────────────────
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: { origin: '*' },
});
const PORT = process.env.PORT ?? 3000;
app.use(express_1.default.static(path_1.default.join(__dirname, '..', '..', 'public')));
app.get('*', (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, '..', '..', 'public', 'index.html'));
});
// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = new Map();
function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId))
        rooms.set(roomId, new GameRoom_1.GameRoom(roomId));
    return rooms.get(roomId);
}
// ─── Wire callbacks ───────────────────────────────────────────────────────────
function wireRoom(room) {
    room.broadcastState = () => io.to(room.roomId).emit('room:state', room.toPublicState());
    room.sendRoles = () => {
        const mafiaIds = room.getMafiaIds();
        for (const p of room.getPlayers()) {
            if (!p.role)
                continue;
            io.to(p.id).emit('player:role', p.role, p.role === types_1.Role.Mafia ? mafiaIds : []);
        }
    };
    room.broadcastNightStart = (t) => io.to(room.roomId).emit('night:start', t);
    room.broadcastNightResult = (pub) => io.to(room.roomId).emit('night:result', pub);
    room.sendDetectiveResult = (detectiveId, targetId, targetName, isMafia) => io.to(detectiveId).emit('detective:result', targetId, targetName, isMafia);
    room.broadcastSpeakingStart = (speakerId, speakerName, t) => io.to(room.roomId).emit('speaking:start', speakerId, speakerName, t);
    room.sendYourTurn = (speakerId, t) => io.to(speakerId).emit('speaking:your-turn', t);
    room.broadcastDiscussionStart = (t) => io.to(room.roomId).emit('discussion:start', t);
    room.broadcastVotingStart = (t) => io.to(room.roomId).emit('voting:start', t);
    room.broadcastVoteUpdate = (votes, voterMap) => io.to(room.roomId).emit('voting:update', votes, voterMap);
    room.broadcastResult = (id, name) => io.to(room.roomId).emit('result', id, name);
    room.broadcastGameOver = (winner, reason) => io.to(room.roomId).emit('gameover', winner, reason);
    room.broadcastSystem = (text) => io.to(room.roomId).emit('chat:message', '⚙️ Сервер', text, 'system');
}
io.on('connection', (socket) => {
    let currentRoomId = null;
    let currentName = '';
    // ── Join ──────────────────────────────────────────────────────────────────
    socket.on('room:join', async (roomId, playerName) => {
        roomId = roomId.trim().toUpperCase();
        playerName = playerName.trim().slice(0, 24);
        if (!roomId || !playerName) {
            socket.emit('error', 'Введите имя и код комнаты.');
            return;
        }
        const room = getOrCreateRoom(roomId);
        if (room.size() >= 10) {
            socket.emit('error', 'Комната заполнена (максимум 10).');
            return;
        }
        const activePhases = [types_1.Phase.Speaking, types_1.Phase.Discussion, types_1.Phase.Voting, types_1.Phase.Night, types_1.Phase.NightResult];
        if (activePhases.includes(room.getPhase())) {
            socket.emit('error', 'Игра уже идёт. Дождитесь следующего раунда.');
            return;
        }
        if (currentRoomId)
            leaveRoom(socket, currentRoomId);
        currentRoomId = roomId;
        currentName = playerName;
        socket.join(roomId);
        wireRoom(room);
        room.addPlayer(socket.id, playerName);
        socket.emit('room:state', room.toPublicState());
        // Tell existing players about the newcomer
        socket.to(roomId).emit('rtc:peer-joined', socket.id, playerName);
        // Tell the newcomer about every player already in the room
        for (const p of room.getPlayers()) {
            if (p.id !== socket.id) {
                socket.emit('rtc:peer-joined', p.id, p.name);
            }
        }
        room.broadcastState();
    });
    // ── Ready ─────────────────────────────────────────────────────────────────
    socket.on('player:ready', (ready) => {
        if (!currentRoomId)
            return;
        const room = rooms.get(currentRoomId);
        if (!room)
            return;
        room.setReady(socket.id, ready);
        room.broadcastState();
    });
    // ── Start ─────────────────────────────────────────────────────────────────
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
    // ── Speaking done ─────────────────────────────────────────────────────────
    socket.on('speaking:done', () => {
        if (!currentRoomId)
            return;
        rooms.get(currentRoomId)?.speakerDone(socket.id);
    });
    // ── Night action ──────────────────────────────────────────────────────────
    socket.on('night:action', (targetId) => {
        if (!currentRoomId)
            return;
        rooms.get(currentRoomId)?.submitNightAction(socket.id, targetId);
    });
    // ── Day vote ──────────────────────────────────────────────────────────────
    socket.on('day:vote', (targetId) => {
        if (!currentRoomId)
            return;
        rooms.get(currentRoomId)?.submitDayVote(socket.id, targetId);
    });
    socket.on('day:unvote', () => {
        if (!currentRoomId)
            return;
        rooms.get(currentRoomId)?.cancelDayVote(socket.id);
    });
    // ── Chat ──────────────────────────────────────────────────────────────────
    socket.on('chat:send', (rawText) => {
        if (!currentRoomId)
            return;
        const room = rooms.get(currentRoomId);
        if (!room)
            return;
        const player = room.getPlayer(socket.id);
        if (!player)
            return;
        const text = rawText.trim().slice(0, 300);
        if (!text)
            return;
        const phase = room.getPhase();
        // Night: only mafia talk to each other
        if (phase === types_1.Phase.Night) {
            if (player.role === types_1.Role.Mafia) {
                for (const id of room.getMafiaIds())
                    io.to(id).emit('chat:message', player.name, text, 'mafia');
            }
            return;
        }
        // Speaking: only the current speaker can write
        if (phase === types_1.Phase.Speaking) {
            const state = room.toPublicState();
            const speakerId = state.speakingOrder[state.currentSpeakerIdx];
            if (player.id !== speakerId) {
                socket.emit('error', 'Сейчас не ваша очередь говорить.');
                return;
            }
        }
        // Discussion / Voting / Speaking — alive players only
        if ([types_1.Phase.Speaking, types_1.Phase.Discussion, types_1.Phase.Voting].includes(phase)) {
            if (!player.alive) {
                socket.emit('error', 'Выбывшие игроки не могут говорить.');
                return;
            }
            io.to(currentRoomId).emit('chat:message', player.name, text, 'normal');
        }
    });
    // ── WebRTC signaling ──────────────────────────────────────────────────────
    socket.on('rtc:offer', (toId, offer) => io.to(toId).emit('rtc:offer', socket.id, offer));
    socket.on('rtc:answer', (toId, answer) => io.to(toId).emit('rtc:answer', socket.id, answer));
    socket.on('rtc:ice', (toId, candidate) => io.to(toId).emit('rtc:ice', socket.id, candidate));
    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        if (currentRoomId)
            leaveRoom(socket, currentRoomId);
    });
    function leaveRoom(sock, roomId) {
        const room = rooms.get(roomId);
        if (!room)
            return;
        room.removePlayer(sock.id);
        sock.leave(roomId);
        sock.to(roomId).emit('rtc:peer-left', sock.id);
        if (room.isEmpty())
            rooms.delete(roomId);
        else
            room.broadcastState();
    }
});
// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`✅  Mafia server → http://localhost:${PORT}`));
