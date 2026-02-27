"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameRoom = void 0;
const types_1 = require("./types");
// ─── Timers (ms) ─────────────────────────────────────────────────────────────
const TIMER_NIGHT = 60000;
const TIMER_DAY = 90000;
const TIMER_VOTING = 45000;
const TIMER_RESULT = 8000;
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
        this.roomId = roomId;
    }
    // ── Player management ────────────────────────────────────────────────────
    addPlayer(id, name) {
        if (this.players.size === 0)
            this.hostId = id;
        const player = {
            id, name, roomId: this.roomId,
            role: null, alive: true, ready: false,
            nightTarget: null, blocked: false, voteCount: 0, dayVote: null,
        };
        this.players.set(id, player);
    }
    removePlayer(id) {
        this.players.delete(id);
        if (this.hostId === id) {
            const first = this.players.keys().next().value;
            if (first)
                this.hostId = first;
        }
    }
    getPlayer(id) { return this.players.get(id); }
    getPlayers() { return [...this.players.values()]; }
    getHostId() { return this.hostId; }
    getPhase() { return this.phase; }
    isEmpty() { return this.players.size === 0; }
    size() { return this.players.size; }
    setReady(id, ready) {
        const p = this.players.get(id);
        if (p)
            p.ready = ready;
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
        // fill rest with civilians
        while (roles.length < n)
            roles.push(types_1.Role.Civilian);
        shuffled.forEach((p, i) => { p.role = roles[i]; });
    }
    getMafiaIds() {
        return this.getPlayers().filter(p => p.role === types_1.Role.Mafia).map(p => p.id);
    }
    // ── Game flow ────────────────────────────────────────────────────────────
    startGame() {
        this.round = 0;
        // reset alive / ready state
        for (const p of this.players.values()) {
            p.alive = true;
            p.ready = false;
        }
        this.assignRoles();
        this.sendRoles();
        this.startNight();
    }
    startNight() {
        this.round++;
        this.phase = types_1.Phase.Night;
        this.clearTimer();
        this.lastNightResult = null;
        // reset night action fields
        for (const p of this.players.values()) {
            p.nightTarget = null;
            p.blocked = false;
        }
        this.timerEndsAt = Date.now() + TIMER_NIGHT;
        this.broadcastState();
        this.broadcastNightStart(this.timerEndsAt);
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
        // Check if all active-role players have submitted → early resolve
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
        // 1. Prostitute blocks someone
        const prostitute = alive.find(p => p.role === types_1.Role.Prostitute);
        let blockedId = null;
        if (prostitute && prostitute.nightTarget) {
            blockedId = prostitute.nightTarget;
            const blocked = this.players.get(blockedId);
            if (blocked)
                blocked.blocked = true;
        }
        // 2. Mafia votes (blocked mafia members don't count)
        const mafiaMembers = alive.filter(p => p.role === types_1.Role.Mafia && !p.blocked);
        const mafiaVotes = {};
        for (const m of mafiaMembers) {
            if (m.nightTarget) {
                mafiaVotes[m.nightTarget] = (mafiaVotes[m.nightTarget] ?? 0) + 1;
            }
        }
        let mafiaTarget = null;
        if (Object.keys(mafiaVotes).length > 0) {
            const max = Math.max(...Object.values(mafiaVotes));
            const candidates = Object.entries(mafiaVotes)
                .filter(([, v]) => v === max).map(([k]) => k);
            mafiaTarget = candidates[Math.floor(Math.random() * candidates.length)];
        }
        // fallback: if mafia couldn't agree, pick first mafia member's target
        if (!mafiaTarget && mafiaMembers.length > 0 && mafiaMembers[0].nightTarget) {
            mafiaTarget = mafiaMembers[0].nightTarget;
        }
        // 3. Doctor heals
        const doctor = alive.find(p => p.role === types_1.Role.Doctor && !p.blocked);
        const healedId = doctor?.nightTarget ?? null;
        const healed = healedId !== null && healedId === mafiaTarget;
        // 4. Apply kill
        let killedId = null;
        if (mafiaTarget && !healed) {
            const victim = this.players.get(mafiaTarget);
            if (victim) {
                victim.alive = false;
                killedId = victim.id;
            }
        }
        // 5. Detective checks
        const detective = alive.find(p => p.role === types_1.Role.Detective && !p.blocked);
        if (detective && detective.nightTarget) {
            const target = this.players.get(detective.nightTarget);
            if (target) {
                this.sendDetectiveResult(detective.id, target.id, target.name, target.role === types_1.Role.Mafia);
            }
        }
        // 6. Build public result
        const killedName = killedId ? this.players.get(killedId)?.name ?? null : null;
        const pub = { killedName, healed };
        this.lastNightResult = pub;
        this.phase = types_1.Phase.Result;
        this.broadcastState();
        this.broadcastNightResult(pub);
        // Transition to Day after result display
        this.timerHandle = setTimeout(() => {
            if (this.checkWinCondition())
                return;
            this.startDay();
        }, TIMER_RESULT);
    }
    startDay() {
        this.phase = types_1.Phase.Day;
        this.timerEndsAt = Date.now() + TIMER_DAY;
        this.lastNightResult = null;
        this.broadcastState();
        this.broadcastDayStart(this.timerEndsAt);
        this.timerHandle = setTimeout(() => this.startVoting(), TIMER_DAY);
    }
    startVoting() {
        this.phase = types_1.Phase.Voting;
        this.timerEndsAt = Date.now() + TIMER_VOTING;
        // reset vote counts
        for (const p of this.players.values()) {
            p.voteCount = 0;
            p.dayVote = null;
        }
        this.broadcastState();
        this.broadcastVotingStart(this.timerEndsAt);
        this.timerHandle = setTimeout(() => this.processVoting(), TIMER_VOTING);
    }
    submitDayVote(voterId, targetId) {
        if (this.phase !== types_1.Phase.Voting)
            return false;
        const voter = this.players.get(voterId);
        const target = this.players.get(targetId);
        if (!voter || !target || !voter.alive || !target.alive)
            return false;
        // change vote
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
    publicVotes() {
        const out = {};
        for (const p of this.alivePlayers())
            out[p.id] = p.voteCount;
        return out;
    }
    maybeEarlyVoting() {
        const alive = this.alivePlayers();
        const allVoted = alive.every(p => p.dayVote !== null);
        if (allVoted) {
            this.clearTimer();
            this.processVoting();
        }
    }
    processVoting() {
        const alive = this.alivePlayers();
        let maxVotes = 0;
        for (const p of alive)
            if (p.voteCount > maxVotes)
                maxVotes = p.voteCount;
        let eliminatedId = null;
        let eliminatedName = null;
        if (maxVotes > 0) {
            const candidates = alive.filter(p => p.voteCount === maxVotes);
            if (candidates.length === 1) {
                // Majority -> eliminate
                const el = candidates[0];
                el.alive = false;
                eliminatedId = el.id;
                eliminatedName = el.name;
            }
            // Tie → no elimination
        }
        this.phase = types_1.Phase.Result;
        this.broadcastState();
        this.broadcastResult(eliminatedId, eliminatedName);
        this.timerHandle = setTimeout(() => {
            if (this.checkWinCondition())
                return;
            this.startNight();
        }, TIMER_RESULT);
    }
    // ── Win condition ────────────────────────────────────────────────────────
    checkWinCondition() {
        const alive = this.alivePlayers();
        const mafiaAlive = alive.filter(p => p.role === types_1.Role.Mafia).length;
        const cityAlive = alive.filter(p => p.role !== types_1.Role.Mafia).length;
        if (mafiaAlive === 0) {
            this.endGame('city', 'Вся мафия уничтожена!');
            return true;
        }
        if (mafiaAlive >= cityAlive) {
            this.endGame('mafia', 'Мафия захватила город!');
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
    // ── Helpers ──────────────────────────────────────────────────────────────
    alivePlayers() {
        return [...this.players.values()].filter(p => p.alive);
    }
    clearTimer() {
        if (this.timerHandle) {
            clearTimeout(this.timerHandle);
            this.timerHandle = null;
        }
    }
    toPublicState() {
        const players = [...this.players.values()].map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive,
            ready: p.ready,
        }));
        return {
            roomId: this.roomId,
            phase: this.phase,
            players,
            round: this.round,
            timerEndsAt: this.timerEndsAt,
            nightResult: this.lastNightResult,
            dayVotes: this.phase === types_1.Phase.Voting ? this.publicVotes() : {},
            winner: this.winner,
            hostId: this.hostId,
        };
    }
    canStart() {
        const players = [...this.players.values()];
        if (players.length < 4)
            return { ok: false, reason: 'Минимум 4 игрока' };
        if (players.length > 10)
            return { ok: false, reason: 'Максимум 10 игроков' };
        if (!players.every(p => p.ready))
            return { ok: false, reason: 'Не все готовы' };
        return { ok: true, reason: '' };
    }
    resetToLobby() {
        this.clearTimer();
        this.phase = types_1.Phase.Lobby;
        this.winner = null;
        this.round = 0;
        this.lastNightResult = null;
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
}
exports.GameRoom = GameRoom;
