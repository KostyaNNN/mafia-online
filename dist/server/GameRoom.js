"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameRoom = void 0;
const types_1 = require("./types");
// ─── Timers (ms) ─────────────────────────────────────────────────────────────
const TIMER_SPEECH = 30000; // per-player speech
const TIMER_DISCUSSION = 60000; // free chat after speeches
const TIMER_VOTING = 45000;
const TIMER_NIGHT = 60000;
const TIMER_RESULT = 8000; // night-result display
// ─── GameRoom ────────────────────────────────────────────────────────────────
class GameRoom {
    constructor(roomId) {
        this.players = new Map();
        this.phase = types_1.Phase.Lobby;
        this.round = 0;
        this.timerHandle = null;
        this.timerEndsAt = 0;
        this.lastNightResult = null;
        this.winner = null;
        this.hostId = '';
        // Speaking state
        this.speakingOrder = [];
        this.currentSpeakerIdx = -1;
        this.joinCounter = 0; // increments on each new player
        this.roomId = roomId;
    }
    // ── Player management ────────────────────────────────────────────────────
    addPlayer(id, name) {
        if (this.players.size === 0)
            this.hostId = id;
        this.players.set(id, {
            id, name, roomId: this.roomId,
            joinIndex: this.joinCounter++,
            role: null, alive: true, ready: false,
            nightTarget: null, blocked: false, voteCount: 0, dayVote: null,
        });
    }
    removePlayer(id) {
        this.players.delete(id);
        if (this.hostId === id) {
            const first = this.players.keys().next().value;
            if (first)
                this.hostId = first;
        }
        // Remove from speaking order if needed
        this.speakingOrder = this.speakingOrder.filter(sid => sid !== id);
    }
    getPlayer(id) { return this.players.get(id); }
    getPlayers() { return [...this.players.values()]; }
    getHostId() { return this.hostId; }
    getPhase() { return this.phase; }
    isEmpty() { return this.players.size === 0; }
    size() { return this.players.size; }
    getMafiaIds() { return this.getPlayers().filter(p => p.role === types_1.Role.Mafia).map(p => p.id); }
    setReady(id, ready) {
        const p = this.players.get(id);
        if (p)
            p.ready = ready;
    }
    canStart() {
        const players = [...this.players.values()];
        if (players.length < 4)
            return { ok: false, reason: 'Минимум 4 игрока' };
        if (players.length > 10)
            return { ok: false, reason: 'Максимум 10 игроков' };
        if (!players.every(p => p.ready))
            return { ok: false, reason: 'Не все нажали «Готов»' };
        return { ok: true, reason: '' };
    }
    // ── Role assignment ──────────────────────────────────────────────────────
    assignRoles() {
        const alive = this.alivePlayers();
        const shuffled = [...alive].sort(() => Math.random() - 0.5);
        const n = shuffled.length;
        const mafiaCount = Math.max(1, Math.floor(n / 3));
        const roles = [
            ...Array(mafiaCount).fill(types_1.Role.Mafia),
            types_1.Role.Detective,
            types_1.Role.Doctor,
            types_1.Role.Prostitute,
        ];
        while (roles.length < n)
            roles.push(types_1.Role.Civilian);
        shuffled.forEach((p, i) => { p.role = roles[i]; });
    }
    // ── Game start ───────────────────────────────────────────────────────────
    startGame() {
        this.round = 0;
        this.winner = null;
        this.lastNightResult = null;
        for (const p of this.players.values()) {
            p.alive = true;
            p.ready = false;
            p.nightTarget = null;
            p.blocked = false;
            p.voteCount = 0;
            p.dayVote = null;
        }
        this.assignRoles();
        this.sendRoles();
        this.broadcastSystem(`Роли розданы. Игра началась! Раунд 1.`);
        // ★ Game starts with Day (speaking round)
        this.startSpeaking();
    }
    // ── Speaking round (Day phase) ────────────────────────────────────────────
    startSpeaking() {
        this.round++;
        this.phase = types_1.Phase.Speaking;
        this.clearTimer();
        // Speaking order: all alive players in random order each round
        this.speakingOrder = this.alivePlayers()
            .map(p => p.id)
            .sort(() => Math.random() - 0.5);
        this.currentSpeakerIdx = -1;
        this.broadcastState();
        this.advanceSpeaker();
    }
    advanceSpeaker() {
        this.clearTimer();
        this.currentSpeakerIdx++;
        // Skip dead players (safety)
        while (this.currentSpeakerIdx < this.speakingOrder.length &&
            !this.players.get(this.speakingOrder[this.currentSpeakerIdx])?.alive) {
            this.currentSpeakerIdx++;
        }
        if (this.currentSpeakerIdx >= this.speakingOrder.length) {
            // Everyone has spoken → go to free discussion
            this.startDiscussion();
            return;
        }
        const speakerId = this.speakingOrder[this.currentSpeakerIdx];
        const speakerName = this.players.get(speakerId)?.name ?? '?';
        this.timerEndsAt = Date.now() + TIMER_SPEECH;
        this.broadcastState();
        this.broadcastSpeakingStart(speakerId, speakerName, this.timerEndsAt);
        this.sendYourTurn(speakerId, this.timerEndsAt);
        this.broadcastSystem(`Говорит: ${speakerName} (${this.currentSpeakerIdx + 1}/${this.speakingOrder.length})`);
        this.timerHandle = setTimeout(() => this.advanceSpeaker(), TIMER_SPEECH);
    }
    // Called when the current speaker presses "Закончил"
    speakerDone(playerId) {
        if (this.phase !== types_1.Phase.Speaking)
            return;
        if (this.speakingOrder[this.currentSpeakerIdx] !== playerId)
            return;
        this.advanceSpeaker();
    }
    // ── Discussion ────────────────────────────────────────────────────────────
    startDiscussion() {
        this.phase = types_1.Phase.Discussion;
        this.currentSpeakerIdx = -1;
        this.timerEndsAt = Date.now() + TIMER_DISCUSSION;
        this.broadcastState();
        this.broadcastDiscussionStart(this.timerEndsAt);
        this.broadcastSystem('Свободное обсуждение — выскажитесь перед голосованием!');
        this.timerHandle = setTimeout(() => this.startVoting(), TIMER_DISCUSSION);
    }
    // ── Voting ────────────────────────────────────────────────────────────────
    startVoting() {
        this.phase = types_1.Phase.Voting;
        this.timerEndsAt = Date.now() + TIMER_VOTING;
        for (const p of this.players.values()) {
            p.voteCount = 0;
            p.dayVote = null;
        }
        this.broadcastState();
        this.broadcastVotingStart(this.timerEndsAt);
        this.broadcastSystem('Голосование! Каждый голосует за того, кого считает мафией.');
        this.timerHandle = setTimeout(() => this.processVoting(), TIMER_VOTING);
    }
    submitDayVote(voterId, targetId) {
        if (this.phase !== types_1.Phase.Voting)
            return false;
        const voter = this.players.get(voterId);
        const target = this.players.get(targetId);
        if (!voter || !target || !voter.alive || !target.alive)
            return false;
        if (voter.dayVote) {
            const prev = this.players.get(voter.dayVote);
            if (prev)
                prev.voteCount--;
        }
        voter.dayVote = targetId;
        target.voteCount++;
        this.broadcastVoteUpdate(this.publicVotes());
        this.maybeEarlyVoting();
        return true;
    }
    maybeEarlyVoting() {
        if (this.alivePlayers().every(p => p.dayVote !== null)) {
            this.clearTimer();
            this.processVoting();
        }
    }
    processVoting() {
        const alive = this.alivePlayers();
        const maxVotes = Math.max(0, ...alive.map(p => p.voteCount));
        let eliminatedId = null;
        let eliminatedName = null;
        if (maxVotes > 0) {
            const candidates = alive.filter(p => p.voteCount === maxVotes);
            if (candidates.length === 1) {
                const el = candidates[0];
                el.alive = false;
                eliminatedId = el.id;
                eliminatedName = el.name;
            }
        }
        this.broadcastResult(eliminatedId, eliminatedName);
        if (eliminatedName) {
            this.broadcastSystem(`По итогам голосования выбыл: ${eliminatedName}.`);
        }
        else {
            this.broadcastSystem('Голосование не выявило единого решения — никто не выбыл.');
        }
        if (this.checkWinCondition())
            return;
        // ★ After voting → Night
        this.timerHandle = setTimeout(() => this.startNight(), TIMER_RESULT);
    }
    // ── Night ─────────────────────────────────────────────────────────────────
    startNight() {
        this.phase = types_1.Phase.Night;
        this.timerEndsAt = Date.now() + TIMER_NIGHT;
        for (const p of this.players.values()) {
            p.nightTarget = null;
            p.blocked = false;
        }
        this.lastNightResult = null;
        this.broadcastState();
        this.broadcastNightStart(this.timerEndsAt);
        this.broadcastSystem('Город засыпает. Просыпается мафия...');
        this.timerHandle = setTimeout(() => this.processNight(), TIMER_NIGHT);
    }
    submitNightAction(playerId, targetId) {
        if (this.phase !== types_1.Phase.Night)
            return false;
        const actor = this.players.get(playerId);
        const target = this.players.get(targetId);
        if (!actor || !target || !actor.alive || !target.alive)
            return false;
        actor.nightTarget = targetId;
        this.maybeEarlyNight();
        return true;
    }
    maybeEarlyNight() {
        const active = this.alivePlayers().filter(p => p.role === types_1.Role.Mafia || p.role === types_1.Role.Detective ||
            p.role === types_1.Role.Doctor || p.role === types_1.Role.Prostitute);
        if (active.every(p => p.nightTarget !== null)) {
            this.clearTimer();
            this.processNight();
        }
    }
    processNight() {
        const alive = this.alivePlayers();
        // 1. Проститутка блокирует
        const prostitute = alive.find(p => p.role === types_1.Role.Prostitute && !p.blocked);
        if (prostitute?.nightTarget) {
            const bl = this.players.get(prostitute.nightTarget);
            if (bl)
                bl.blocked = true;
        }
        // 2. Мафия голосует за жертву
        const mafiaAlive = alive.filter(p => p.role === types_1.Role.Mafia && !p.blocked);
        const mafiaVotes = {};
        for (const m of mafiaAlive) {
            if (m.nightTarget)
                mafiaVotes[m.nightTarget] = (mafiaVotes[m.nightTarget] ?? 0) + 1;
        }
        let mafiaTarget = null;
        if (Object.keys(mafiaVotes).length > 0) {
            const max = Math.max(...Object.values(mafiaVotes));
            const best = Object.entries(mafiaVotes).filter(([, v]) => v === max).map(([k]) => k);
            mafiaTarget = best[Math.floor(Math.random() * best.length)];
        }
        else if (mafiaAlive[0]?.nightTarget) {
            mafiaTarget = mafiaAlive[0].nightTarget;
        }
        // 3. Доктор лечит
        const doctor = alive.find(p => p.role === types_1.Role.Doctor && !p.blocked);
        const healedId = doctor?.nightTarget ?? null;
        const healed = !!healedId && healedId === mafiaTarget;
        // 4. Убийство
        let killedId = null;
        if (mafiaTarget && !healed) {
            const victim = this.players.get(mafiaTarget);
            if (victim) {
                victim.alive = false;
                killedId = victim.id;
            }
        }
        // 5. Детектив проверяет
        const detective = alive.find(p => p.role === types_1.Role.Detective && !p.blocked);
        if (detective?.nightTarget) {
            const target = this.players.get(detective.nightTarget);
            if (target) {
                this.sendDetectiveResult(detective.id, target.id, target.name, target.role === types_1.Role.Mafia);
            }
        }
        const killedName = killedId ? (this.players.get(killedId)?.name ?? null) : null;
        const pub = { killedName, healed };
        this.lastNightResult = pub;
        this.phase = types_1.Phase.NightResult;
        this.timerEndsAt = Date.now() + TIMER_RESULT;
        this.broadcastState();
        this.broadcastNightResult(pub);
        if (killedName) {
            this.broadcastSystem(healed ? `Доктор спас ${killedName}!` : `Этой ночью был убит: ${killedName}.`);
        }
        else {
            this.broadcastSystem('Ночь прошла тихо — никто не пострадал.');
        }
        this.timerHandle = setTimeout(() => {
            if (this.checkWinCondition())
                return;
            // ★ After night → new Speaking round
            this.startSpeaking();
        }, TIMER_RESULT);
    }
    // ── Win condition ─────────────────────────────────────────────────────────
    checkWinCondition() {
        const alive = this.alivePlayers();
        const mafiaAlive = alive.filter(p => p.role === types_1.Role.Mafia).length;
        const cityAlive = alive.filter(p => p.role !== types_1.Role.Mafia).length;
        if (mafiaAlive === 0) {
            this.endGame('city', 'Вся мафия уничтожена! 🏙');
            return true;
        }
        if (mafiaAlive >= cityAlive) {
            this.endGame('mafia', 'Мафия захватила город! 🔫');
            return true;
        }
        return false;
    }
    endGame(winner, reason) {
        this.winner = winner;
        this.phase = types_1.Phase.GameOver;
        this.clearTimer();
        this.broadcastState();
        this.broadcastGameOver(winner, reason);
    }
    resetToLobby() {
        this.clearTimer();
        this.phase = types_1.Phase.Lobby;
        this.winner = null;
        this.round = 0;
        this.lastNightResult = null;
        this.speakingOrder = [];
        this.currentSpeakerIdx = -1;
        for (const p of this.players.values()) {
            p.role = null;
            p.alive = true;
            p.ready = false;
            p.nightTarget = null;
            p.blocked = false;
            p.voteCount = 0;
            p.dayVote = null;
        }
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    alivePlayers() {
        return [...this.players.values()].filter(p => p.alive);
    }
    clearTimer() {
        if (this.timerHandle) {
            clearTimeout(this.timerHandle);
            this.timerHandle = null;
        }
    }
    publicVotes() {
        const out = {};
        for (const p of this.alivePlayers())
            out[p.id] = p.voteCount;
        return out;
    }
    toPublicState() {
        // sort by joinIndex so all clients see the same order
        const sorted = [...this.players.values()].sort((a, b) => a.joinIndex - b.joinIndex);
        return {
            roomId: this.roomId,
            phase: this.phase,
            players: sorted.map(p => ({
                id: p.id, name: p.name, alive: p.alive, ready: p.ready, joinIndex: p.joinIndex,
            })),
            round: this.round,
            timerEndsAt: this.timerEndsAt,
            nightResult: this.lastNightResult,
            dayVotes: this.phase === types_1.Phase.Voting ? this.publicVotes() : {},
            winner: this.winner,
            hostId: this.hostId,
            speakingOrder: this.speakingOrder,
            currentSpeakerIdx: this.currentSpeakerIdx,
        };
    }
}
exports.GameRoom = GameRoom;
