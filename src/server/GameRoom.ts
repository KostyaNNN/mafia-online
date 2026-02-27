import {
  Player, Role, Phase,
  NightResultPublic, RoomState, PublicPlayer,
} from './types';

// ─── Timers (ms) ─────────────────────────────────────────────────────────────
const TIMER_SPEECH      = 30_000;   // per-player speech
const TIMER_DISCUSSION  = 60_000;   // free chat after speeches
const TIMER_VOTING      = 45_000;
const TIMER_NIGHT       = 60_000;
const TIMER_RESULT      =  8_000;   // night-result display

// ─── GameRoom ────────────────────────────────────────────────────────────────

export class GameRoom {
  readonly roomId: string;
  private players:    Map<string, Player> = new Map();
  private phase:      Phase  = Phase.Lobby;
  private round:      number = 0;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private timerEndsAt: number = 0;
  private lastNightResult: NightResultPublic | null = null;
  private winner:     'mafia' | 'city' | null = null;
  private hostId:     string = '';

  // Speaking state
  private speakingOrder:     string[] = [];
  private currentSpeakerIdx: number   = -1;
  private joinCounter:       number   = 0;   // increments on each new player

  // ── Callbacks wired in by socket layer ─────────────────────────────────
  broadcastState!:        () => void;
  sendRoles!:             () => void;
  broadcastNightResult!:  (pub: NightResultPublic) => void;
  sendDetectiveResult!:   (detectiveId: string, targetId: string, targetName: string, isMafia: boolean) => void;
  broadcastDiscussionStart!: (timerEndsAt: number) => void;
  broadcastVotingStart!:  (timerEndsAt: number) => void;
  broadcastVoteUpdate!:   (votes: Record<string, number>) => void;
  broadcastResult!:       (eliminatedId: string | null, eliminatedName: string | null) => void;
  broadcastGameOver!:     (winner: 'mafia' | 'city', reason: string) => void;
  broadcastNightStart!:   (timerEndsAt: number) => void;
  broadcastSpeakingStart!:(speakerId: string, speakerName: string, timerEndsAt: number) => void;
  sendYourTurn!:          (speakerId: string, timerEndsAt: number) => void;
  broadcastSystem!:       (text: string) => void;

  constructor(roomId: string) { this.roomId = roomId; }

  // ── Player management ────────────────────────────────────────────────────

  addPlayer(id: string, name: string): void {
    if (this.players.size === 0) this.hostId = id;
    this.players.set(id, {
      id, name, roomId: this.roomId,
      joinIndex: this.joinCounter++,
      role: null, alive: true, ready: false,
      nightTarget: null, blocked: false, voteCount: 0, dayVote: null,
    });
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    if (this.hostId === id) {
      const first = this.players.keys().next().value;
      if (first) this.hostId = first;
    }
    // Remove from speaking order if needed
    this.speakingOrder = this.speakingOrder.filter(sid => sid !== id);
  }

  getPlayer(id: string): Player | undefined { return this.players.get(id); }
  getPlayers():   Player[] { return [...this.players.values()]; }
  getHostId():    string   { return this.hostId; }
  getPhase():     Phase    { return this.phase; }
  isEmpty():      boolean  { return this.players.size === 0; }
  size():         number   { return this.players.size; }
  getMafiaIds():  string[] { return this.getPlayers().filter(p => p.role === Role.Mafia).map(p => p.id); }

  setReady(id: string, ready: boolean): void {
    const p = this.players.get(id); if (p) p.ready = ready;
  }

  canStart(): { ok: boolean; reason: string } {
    const players = [...this.players.values()];
    if (players.length < 4)  return { ok: false, reason: 'Минимум 4 игрока' };
    if (players.length > 10) return { ok: false, reason: 'Максимум 10 игроков' };
    if (!players.every(p => p.ready)) return { ok: false, reason: 'Не все нажали «Готов»' };
    return { ok: true, reason: '' };
  }

  // ── Role assignment ──────────────────────────────────────────────────────

  private assignRoles(): void {
    const alive    = this.alivePlayers();
    const shuffled = [...alive].sort(() => Math.random() - 0.5);
    const n        = shuffled.length;
    const mafiaCount = Math.max(1, Math.floor(n / 3));

    const roles: Role[] = [
      ...Array(mafiaCount).fill(Role.Mafia),
      Role.Detective,
      Role.Doctor,
      Role.Prostitute,
    ];
    while (roles.length < n) roles.push(Role.Civilian);

    shuffled.forEach((p, i) => { p.role = roles[i]; });
  }

  // ── Game start ───────────────────────────────────────────────────────────

  startGame(): void {
    this.round  = 0;
    this.winner = null;
    this.lastNightResult = null;
    for (const p of this.players.values()) {
      p.alive = true; p.ready = false;
      p.nightTarget = null; p.blocked = false;
      p.voteCount = 0; p.dayVote = null;
    }
    this.assignRoles();
    this.sendRoles();
    this.broadcastSystem(`Роли розданы. Игра началась! Раунд 1.`);
    // ★ Game starts with Day (speaking round)
    this.startSpeaking();
  }

  // ── Speaking round (Day phase) ────────────────────────────────────────────

  private startSpeaking(): void {
    this.round++;
    this.phase = Phase.Speaking;
    this.clearTimer();

    // Speaking order: all alive players in random order each round
    this.speakingOrder = this.alivePlayers()
      .map(p => p.id)
      .sort(() => Math.random() - 0.5);
    this.currentSpeakerIdx = -1;

    this.broadcastState();
    this.advanceSpeaker();
  }

  private advanceSpeaker(): void {
    this.clearTimer();
    this.currentSpeakerIdx++;

    // Skip dead players (safety)
    while (
      this.currentSpeakerIdx < this.speakingOrder.length &&
      !this.players.get(this.speakingOrder[this.currentSpeakerIdx])?.alive
    ) {
      this.currentSpeakerIdx++;
    }

    if (this.currentSpeakerIdx >= this.speakingOrder.length) {
      // Everyone has spoken → go to free discussion
      this.startDiscussion();
      return;
    }

    const speakerId   = this.speakingOrder[this.currentSpeakerIdx];
    const speakerName = this.players.get(speakerId)?.name ?? '?';
    this.timerEndsAt  = Date.now() + TIMER_SPEECH;

    this.broadcastState();
    this.broadcastSpeakingStart(speakerId, speakerName, this.timerEndsAt);
    this.sendYourTurn(speakerId, this.timerEndsAt);
    this.broadcastSystem(`Говорит: ${speakerName} (${this.currentSpeakerIdx + 1}/${this.speakingOrder.length})`);

    this.timerHandle = setTimeout(() => this.advanceSpeaker(), TIMER_SPEECH);
  }

  // Called when the current speaker presses "Закончил"
  speakerDone(playerId: string): void {
    if (this.phase !== Phase.Speaking) return;
    if (this.speakingOrder[this.currentSpeakerIdx] !== playerId) return;
    this.advanceSpeaker();
  }

  // ── Discussion ────────────────────────────────────────────────────────────

  private startDiscussion(): void {
    this.phase            = Phase.Discussion;
    this.currentSpeakerIdx = -1;
    this.timerEndsAt      = Date.now() + TIMER_DISCUSSION;
    this.broadcastState();
    this.broadcastDiscussionStart(this.timerEndsAt);
    this.broadcastSystem('Свободное обсуждение — выскажитесь перед голосованием!');
    this.timerHandle = setTimeout(() => this.startVoting(), TIMER_DISCUSSION);
  }

  // ── Voting ────────────────────────────────────────────────────────────────

  private startVoting(): void {
    this.phase        = Phase.Voting;
    this.timerEndsAt  = Date.now() + TIMER_VOTING;
    for (const p of this.players.values()) { p.voteCount = 0; p.dayVote = null; }
    this.broadcastState();
    this.broadcastVotingStart(this.timerEndsAt);
    this.broadcastSystem('Голосование! Каждый голосует за того, кого считает мафией.');
    this.timerHandle = setTimeout(() => this.processVoting(), TIMER_VOTING);
  }

  submitDayVote(voterId: string, targetId: string): boolean {
    if (this.phase !== Phase.Voting) return false;
    const voter  = this.players.get(voterId);
    const target = this.players.get(targetId);
    if (!voter || !target || !voter.alive || !target.alive) return false;
    if (voter.dayVote) {
      const prev = this.players.get(voter.dayVote);
      if (prev) prev.voteCount--;
    }
    voter.dayVote = targetId;
    target.voteCount++;
    this.broadcastVoteUpdate(this.publicVotes());
    this.maybeEarlyVoting();
    return true;
  }

  private maybeEarlyVoting(): void {
    if (this.alivePlayers().every(p => p.dayVote !== null)) {
      this.clearTimer();
      this.processVoting();
    }
  }

  private processVoting(): void {
    const alive    = this.alivePlayers();
    const maxVotes = Math.max(0, ...alive.map(p => p.voteCount));
    let   eliminatedId:   string | null = null;
    let   eliminatedName: string | null = null;

    if (maxVotes > 0) {
      const candidates = alive.filter(p => p.voteCount === maxVotes);
      if (candidates.length === 1) {
        const el = candidates[0];
        el.alive       = false;
        eliminatedId   = el.id;
        eliminatedName = el.name;
      }
    }

    this.broadcastResult(eliminatedId, eliminatedName);

    if (eliminatedName) {
      this.broadcastSystem(`По итогам голосования выбыл: ${eliminatedName}.`);
    } else {
      this.broadcastSystem('Голосование не выявило единого решения — никто не выбыл.');
    }

    if (this.checkWinCondition()) return;

    // ★ After voting → Night
    this.timerHandle = setTimeout(() => this.startNight(), TIMER_RESULT);
  }

  // ── Night ─────────────────────────────────────────────────────────────────

  private startNight(): void {
    this.phase       = Phase.Night;
    this.timerEndsAt = Date.now() + TIMER_NIGHT;
    for (const p of this.players.values()) {
      p.nightTarget = null;
      p.blocked     = false;
    }
    this.lastNightResult = null;
    this.broadcastState();
    this.broadcastNightStart(this.timerEndsAt);
    this.broadcastSystem('Город засыпает. Просыпается мафия...');
    this.timerHandle = setTimeout(() => this.processNight(), TIMER_NIGHT);
  }

  submitNightAction(playerId: string, targetId: string): boolean {
    if (this.phase !== Phase.Night) return false;
    const actor  = this.players.get(playerId);
    const target = this.players.get(targetId);
    if (!actor || !target || !actor.alive || !target.alive) return false;
    actor.nightTarget = targetId;
    this.maybeEarlyNight();
    return true;
  }

  private maybeEarlyNight(): void {
    const active = this.alivePlayers().filter(p =>
      p.role === Role.Mafia || p.role === Role.Detective ||
      p.role === Role.Doctor || p.role === Role.Prostitute
    );
    if (active.every(p => p.nightTarget !== null)) {
      this.clearTimer();
      this.processNight();
    }
  }

  private processNight(): void {
    const alive = this.alivePlayers();

    // 1. Проститутка блокирует
    const prostitute = alive.find(p => p.role === Role.Prostitute && !p.blocked);
    if (prostitute?.nightTarget) {
      const bl = this.players.get(prostitute.nightTarget);
      if (bl) bl.blocked = true;
    }

    // 2. Мафия голосует за жертву
    const mafiaAlive = alive.filter(p => p.role === Role.Mafia && !p.blocked);
    const mafiaVotes: Record<string, number> = {};
    for (const m of mafiaAlive) {
      if (m.nightTarget) mafiaVotes[m.nightTarget] = (mafiaVotes[m.nightTarget] ?? 0) + 1;
    }
    let mafiaTarget: string | null = null;
    if (Object.keys(mafiaVotes).length > 0) {
      const max = Math.max(...Object.values(mafiaVotes));
      const best = Object.entries(mafiaVotes).filter(([, v]) => v === max).map(([k]) => k);
      mafiaTarget = best[Math.floor(Math.random() * best.length)];
    } else if (mafiaAlive[0]?.nightTarget) {
      mafiaTarget = mafiaAlive[0].nightTarget;
    }

    // 3. Доктор лечит
    const doctor  = alive.find(p => p.role === Role.Doctor && !p.blocked);
    const healedId = doctor?.nightTarget ?? null;
    const healed   = !!healedId && healedId === mafiaTarget;

    // 4. Убийство
    let killedId: string | null = null;
    if (mafiaTarget && !healed) {
      const victim = this.players.get(mafiaTarget);
      if (victim) { victim.alive = false; killedId = victim.id; }
    }

    // 5. Детектив проверяет
    const detective = alive.find(p => p.role === Role.Detective && !p.blocked);
    if (detective?.nightTarget) {
      const target = this.players.get(detective.nightTarget);
      if (target) {
        this.sendDetectiveResult(detective.id, target.id, target.name, target.role === Role.Mafia);
      }
    }

    const killedName = killedId ? (this.players.get(killedId)?.name ?? null) : null;
    const pub: NightResultPublic = { killedName, healed };
    this.lastNightResult = pub;

    this.phase = Phase.NightResult;
    this.timerEndsAt = Date.now() + TIMER_RESULT;
    this.broadcastState();
    this.broadcastNightResult(pub);

    if (killedName) {
      this.broadcastSystem(healed ? `Доктор спас ${killedName}!` : `Этой ночью был убит: ${killedName}.`);
    } else {
      this.broadcastSystem('Ночь прошла тихо — никто не пострадал.');
    }

    this.timerHandle = setTimeout(() => {
      if (this.checkWinCondition()) return;
      // ★ After night → new Speaking round
      this.startSpeaking();
    }, TIMER_RESULT);
  }

  // ── Win condition ─────────────────────────────────────────────────────────

  private checkWinCondition(): boolean {
    const alive      = this.alivePlayers();
    const mafiaAlive = alive.filter(p => p.role === Role.Mafia).length;
    const cityAlive  = alive.filter(p => p.role !== Role.Mafia).length;

    if (mafiaAlive === 0) { this.endGame('city',  'Вся мафия уничтожена! 🏙'); return true; }
    if (mafiaAlive >= cityAlive) { this.endGame('mafia', 'Мафия захватила город! 🔫'); return true; }
    return false;
  }

  private endGame(winner: 'mafia' | 'city', reason: string): void {
    this.winner = winner;
    this.phase  = Phase.GameOver;
    this.clearTimer();
    this.broadcastState();
    this.broadcastGameOver(winner, reason);
  }

  resetToLobby(): void {
    this.clearTimer();
    this.phase             = Phase.Lobby;
    this.winner            = null;
    this.round             = 0;
    this.lastNightResult   = null;
    this.speakingOrder     = [];
    this.currentSpeakerIdx = -1;
    for (const p of this.players.values()) {
      p.role = null; p.alive = true; p.ready = false;
      p.nightTarget = null; p.blocked = false;
      p.voteCount = 0; p.dayVote = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private alivePlayers(): Player[] {
    return [...this.players.values()].filter(p => p.alive);
  }

  private clearTimer(): void {
    if (this.timerHandle) { clearTimeout(this.timerHandle); this.timerHandle = null; }
  }

  publicVotes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.alivePlayers()) out[p.id] = p.voteCount;
    return out;
  }

  toPublicState(): RoomState {
    // sort by joinIndex so all clients see the same order
    const sorted = [...this.players.values()].sort((a, b) => a.joinIndex - b.joinIndex);
    return {
      roomId:            this.roomId,
      phase:             this.phase,
      players:           sorted.map(p => ({
        id: p.id, name: p.name, alive: p.alive, ready: p.ready, joinIndex: p.joinIndex,
      })),
      round:             this.round,
      timerEndsAt:       this.timerEndsAt,
      nightResult:       this.lastNightResult,
      dayVotes:          this.phase === Phase.Voting ? this.publicVotes() : {},
      winner:            this.winner,
      hostId:            this.hostId,
      speakingOrder:     this.speakingOrder,
      currentSpeakerIdx: this.currentSpeakerIdx,
    };
  }
}
