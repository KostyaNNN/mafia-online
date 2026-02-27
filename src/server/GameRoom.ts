import { v4 as uuidv4 } from 'uuid';
import {
  Player, Role, Phase,
  NightResult, NightResultPublic, RoomState, PublicPlayer,
} from './types';

// ─── Timers (ms) ─────────────────────────────────────────────────────────────
const TIMER_NIGHT   = 60_000;
const TIMER_DAY     = 90_000;
const TIMER_VOTING  = 45_000;
const TIMER_RESULT  = 8_000;

// ─── GameRoom ────────────────────────────────────────────────────────────────

export class GameRoom {
  readonly roomId: string;
  private players: Map<string, Player> = new Map();
  private phase: Phase = Phase.Lobby;
  private round  = 0;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private timerEndsAt = 0;
  private lastNightResult: NightResultPublic | null = null;
  private winner: 'mafia' | 'city' | null = null;
  private hostId = '';

  // Callbacks injected by socket handler
  broadcastState!: () => void;
  sendRoles!:      () => void;
  broadcastNightResult!: (pub: NightResultPublic) => void;
  sendDetectiveResult!: (detectiveId: string, targetId: string, targetName: string, isMafia: boolean) => void;
  broadcastDayStart!:   (timerEndsAt: number) => void;
  broadcastVotingStart!:(timerEndsAt: number) => void;
  broadcastVoteUpdate!: (votes: Record<string, number>) => void;
  broadcastResult!:     (eliminatedId: string | null, eliminatedName: string | null) => void;
  broadcastGameOver!:   (winner: 'mafia' | 'city', reason: string) => void;
  broadcastNightStart!: (timerEndsAt: number) => void;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  // ── Player management ────────────────────────────────────────────────────

  addPlayer(id: string, name: string): void {
    if (this.players.size === 0) this.hostId = id;
    const player: Player = {
      id, name, roomId: this.roomId,
      role: null, alive: true, ready: false,
      nightTarget: null, blocked: false, voteCount: 0, dayVote: null,
    };
    this.players.set(id, player);
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    if (this.hostId === id) {
      const first = this.players.keys().next().value;
      if (first) this.hostId = first;
    }
  }

  getPlayer(id: string): Player | undefined { return this.players.get(id); }
  getPlayers(): Player[] { return [...this.players.values()]; }
  getHostId(): string { return this.hostId; }
  getPhase(): Phase { return this.phase; }
  isEmpty(): boolean { return this.players.size === 0; }
  size():    number  { return this.players.size; }

  setReady(id: string, ready: boolean): void {
    const p = this.players.get(id);
    if (p) p.ready = ready;
  }

  // ── Role assignment ──────────────────────────────────────────────────────

  assignRoles(): void {
    const alive = this.alivePlayers();
    const shuffled = [...alive].sort(() => Math.random() - 0.5);
    const n = shuffled.length;
    const mafiaCount = Math.max(1, Math.floor(n / 3));

    const roles: Role[] = [
      ...Array(mafiaCount).fill(Role.Mafia),
      Role.Detective,
      Role.Doctor,
      Role.Prostitute,
    ];
    // fill rest with civilians
    while (roles.length < n) roles.push(Role.Civilian);

    shuffled.forEach((p, i) => { p.role = roles[i]; });
  }

  getMafiaIds(): string[] {
    return this.getPlayers().filter(p => p.role === Role.Mafia).map(p => p.id);
  }

  // ── Game flow ────────────────────────────────────────────────────────────

  startGame(): void {
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

  private startNight(): void {
    this.round++;
    this.phase = Phase.Night;
    this.clearTimer();
    this.lastNightResult = null;
    // reset night action fields
    for (const p of this.players.values()) {
      p.nightTarget = null;
      p.blocked     = false;
    }
    this.timerEndsAt = Date.now() + TIMER_NIGHT;
    this.broadcastState();
    this.broadcastNightStart(this.timerEndsAt);
    this.timerHandle = setTimeout(() => this.processNight(), TIMER_NIGHT);
  }

  submitNightAction(playerId: string, targetId: string): boolean {
    if (this.phase !== Phase.Night) return false;
    const actor  = this.players.get(playerId);
    const target = this.players.get(targetId);
    if (!actor || !target || !actor.alive || !target.alive) return false;
    actor.nightTarget = targetId;
    // Check if all active-role players have submitted → early resolve
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

    // 1. Prostitute blocks someone
    const prostitute = alive.find(p => p.role === Role.Prostitute);
    let blockedId: string | null = null;
    if (prostitute && prostitute.nightTarget) {
      blockedId = prostitute.nightTarget;
      const blocked = this.players.get(blockedId);
      if (blocked) blocked.blocked = true;
    }

    // 2. Mafia votes (blocked mafia members don't count)
    const mafiaMembers = alive.filter(p => p.role === Role.Mafia && !p.blocked);
    const mafiaVotes: Record<string, number> = {};
    for (const m of mafiaMembers) {
      if (m.nightTarget) {
        mafiaVotes[m.nightTarget] = (mafiaVotes[m.nightTarget] ?? 0) + 1;
      }
    }
    let mafiaTarget: string | null = null;
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
    const doctor = alive.find(p => p.role === Role.Doctor && !p.blocked);
    const healedId = doctor?.nightTarget ?? null;
    const healed = healedId !== null && healedId === mafiaTarget;

    // 4. Apply kill
    let killedId: string | null = null;
    if (mafiaTarget && !healed) {
      const victim = this.players.get(mafiaTarget);
      if (victim) {
        victim.alive = false;
        killedId = victim.id;
      }
    }

    // 5. Detective checks
    const detective = alive.find(p => p.role === Role.Detective && !p.blocked);
    if (detective && detective.nightTarget) {
      const target = this.players.get(detective.nightTarget);
      if (target) {
        this.sendDetectiveResult(
          detective.id,
          target.id, target.name,
          target.role === Role.Mafia
        );
      }
    }

    // 6. Build public result
    const killedName = killedId ? this.players.get(killedId)?.name ?? null : null;
    const pub: NightResultPublic = { killedName, healed };
    this.lastNightResult = pub;

    this.phase = Phase.Result;
    this.broadcastState();
    this.broadcastNightResult(pub);

    // Transition to Day after result display
    this.timerHandle = setTimeout(() => {
      if (this.checkWinCondition()) return;
      this.startDay();
    }, TIMER_RESULT);
  }

  private startDay(): void {
    this.phase = Phase.Day;
    this.timerEndsAt = Date.now() + TIMER_DAY;
    this.lastNightResult = null;
    this.broadcastState();
    this.broadcastDayStart(this.timerEndsAt);
    this.timerHandle = setTimeout(() => this.startVoting(), TIMER_DAY);
  }

  private startVoting(): void {
    this.phase = Phase.Voting;
    this.timerEndsAt = Date.now() + TIMER_VOTING;
    // reset vote counts
    for (const p of this.players.values()) {
      p.voteCount = 0;
      p.dayVote   = null;
    }
    this.broadcastState();
    this.broadcastVotingStart(this.timerEndsAt);
    this.timerHandle = setTimeout(() => this.processVoting(), TIMER_VOTING);
  }

  submitDayVote(voterId: string, targetId: string): boolean {
    if (this.phase !== Phase.Voting) return false;
    const voter  = this.players.get(voterId);
    const target = this.players.get(targetId);
    if (!voter || !target || !voter.alive || !target.alive) return false;
    // change vote
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

  private publicVotes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.alivePlayers()) out[p.id] = p.voteCount;
    return out;
  }

  private maybeEarlyVoting(): void {
    const alive = this.alivePlayers();
    const allVoted = alive.every(p => p.dayVote !== null);
    if (allVoted) {
      this.clearTimer();
      this.processVoting();
    }
  }

  private processVoting(): void {
    const alive = this.alivePlayers();
    let maxVotes = 0;
    for (const p of alive) if (p.voteCount > maxVotes) maxVotes = p.voteCount;

    let eliminatedId: string | null = null;
    let eliminatedName: string | null = null;

    if (maxVotes > 0) {
      const candidates = alive.filter(p => p.voteCount === maxVotes);
      if (candidates.length === 1) {
        // Majority -> eliminate
        const el = candidates[0];
        el.alive = false;
        eliminatedId   = el.id;
        eliminatedName = el.name;
      }
      // Tie → no elimination
    }

    this.phase = Phase.Result;
    this.broadcastState();
    this.broadcastResult(eliminatedId, eliminatedName);

    this.timerHandle = setTimeout(() => {
      if (this.checkWinCondition()) return;
      this.startNight();
    }, TIMER_RESULT);
  }

  // ── Win condition ────────────────────────────────────────────────────────

  private checkWinCondition(): boolean {
    const alive = this.alivePlayers();
    const mafiaAlive = alive.filter(p => p.role === Role.Mafia).length;
    const cityAlive  = alive.filter(p => p.role !== Role.Mafia).length;

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

  private endGame(winner: 'mafia' | 'city', reason: string): void {
    this.winner = winner;
    this.phase  = Phase.GameOver;
    this.clearTimer();
    this.broadcastState();
    this.broadcastGameOver(winner, reason);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private alivePlayers(): Player[] {
    return [...this.players.values()].filter(p => p.alive);
  }

  private clearTimer(): void {
    if (this.timerHandle) { clearTimeout(this.timerHandle); this.timerHandle = null; }
  }

  toPublicState(): RoomState {
    const players: PublicPlayer[] = [...this.players.values()].map(p => ({
      id:    p.id,
      name:  p.name,
      alive: p.alive,
      ready: p.ready,
    }));
    return {
      roomId:      this.roomId,
      phase:       this.phase,
      players,
      round:       this.round,
      timerEndsAt: this.timerEndsAt,
      nightResult: this.lastNightResult,
      dayVotes:    this.phase === Phase.Voting ? this.publicVotes() : {},
      winner:      this.winner,
      hostId:      this.hostId,
    };
  }

  canStart(): { ok: boolean; reason: string } {
    const players = [...this.players.values()];
    if (players.length < 4) return { ok: false, reason: 'Минимум 4 игрока' };
    if (players.length > 10) return { ok: false, reason: 'Максимум 10 игроков' };
    if (!players.every(p => p.ready)) return { ok: false, reason: 'Не все готовы' };
    return { ok: true, reason: '' };
  }

  resetToLobby(): void {
    this.clearTimer();
    this.phase  = Phase.Lobby;
    this.winner = null;
    this.round  = 0;
    this.lastNightResult = null;
    for (const p of this.players.values()) {
      p.role        = null;
      p.alive       = true;
      p.ready       = false;
      p.nightTarget = null;
      p.blocked     = false;
      p.voteCount   = 0;
      p.dayVote     = null;
    }
  }
}
