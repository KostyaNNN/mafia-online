// ─── Enums ───────────────────────────────────────────────────────────────────

export enum Role {
  Civilian  = 'civilian',
  Mafia     = 'mafia',
  Detective = 'detective',
  Doctor    = 'doctor',
  Prostitute= 'prostitute',
}

export enum Phase {
  Lobby   = 'lobby',
  Night   = 'night',
  Day     = 'day',
  Voting  = 'voting',
  Result  = 'result',
  GameOver= 'gameover',
}

// ─── Player ──────────────────────────────────────────────────────────────────

export interface Player {
  id:        string;   // socket.id
  name:      string;
  roomId:    string;
  role:      Role | null;
  alive:     boolean;
  ready:     boolean;
  // night action target
  nightTarget: string | null;
  // whether this player is blocked by prostitute this night
  blocked: boolean;
  // whether this player was voted against (day vote count)
  voteCount: number;
  // who this player cast day-vote for
  dayVote: string | null;
}

// ─── Night Result ────────────────────────────────────────────────────────────

export interface NightResult {
  killed:   string | null;   // player id
  healed:   boolean;
  checked:  { targetId: string; isMafia: boolean } | null;
  blocked:  string | null;   // player id who was blocked
}

// ─── Room State (sent to clients, with role hidden) ──────────────────────────

export interface PublicPlayer {
  id:    string;
  name:  string;
  alive: boolean;
  ready: boolean;
}

export interface RoomState {
  roomId:      string;
  phase:       Phase;
  players:     PublicPlayer[];
  round:       number;
  timerEndsAt: number;   // epoch ms
  nightResult: NightResultPublic | null;
  dayVotes:    Record<string, number>;   // playerId → count (revealed during voting)
  winner:      'mafia' | 'city' | null;
  hostId:      string;
}

export interface NightResultPublic {
  killedName: string | null;
  healed:     boolean;
}

// Generic SDP / ICE objects (avoid browser-only types in Node.js context)
export interface SdpInit   { type: string; sdp: string }
export interface IceInit   { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }

// ─── Socket Events (server → client) ─────────────────────────────────────────

export interface ServerToClientEvents {
  // Room / lobby
  'room:state':         (state: RoomState) => void;
  'player:role':        (role: Role, mafiaIds: string[]) => void;
  // Night
  'night:start':        (timerEndsAt: number) => void;
  'night:result':       (result: NightResultPublic) => void;
  'detective:result':   (targetId: string, targetName: string, isMafia: boolean) => void;
  // Day / voting
  'day:start':          (timerEndsAt: number) => void;
  'voting:start':       (timerEndsAt: number) => void;
  'voting:update':      (votes: Record<string, number>) => void;
  // Result
  'result':             (eliminated: string | null, eliminatedName: string | null) => void;
  // Game over
  'gameover':           (winner: 'mafia' | 'city', reason: string) => void;
  // Chat
  'chat:message':       (from: string, text: string, isMafia: boolean) => void;
  // Errors
  'error':              (msg: string) => void;
  // WebRTC signaling
  'rtc:offer':          (fromId: string, offer: SdpInit) => void;
  'rtc:answer':         (fromId: string, answer: SdpInit) => void;
  'rtc:ice':            (fromId: string, candidate: IceInit) => void;
  'rtc:peer-joined':    (peerId: string, peerName: string) => void;
  'rtc:peer-left':      (peerId: string) => void;
}

export interface ClientToServerEvents {
  // Lobby
  'room:join':    (roomId: string, playerName: string) => void;
  'player:ready': (ready: boolean) => void;
  'game:start':   () => void;
  // Night actions
  'night:action': (targetId: string) => void;
  // Day vote
  'day:vote':     (targetId: string) => void;
  // Chat
  'chat:send':    (text: string) => void;
  // WebRTC signaling
  'rtc:offer':    (toId: string, offer: SdpInit) => void;
  'rtc:answer':   (toId: string, answer: SdpInit) => void;
  'rtc:ice':      (toId: string, candidate: IceInit) => void;
}
