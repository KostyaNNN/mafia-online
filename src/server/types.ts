// ─── Enums ───────────────────────────────────────────────────────────────────

export enum Role {
  Civilian   = 'civilian',
  Mafia      = 'mafia',
  Detective  = 'detective',
  Doctor     = 'doctor',
  Prostitute = 'prostitute',
}

export enum Phase {
  Lobby      = 'lobby',
  Speaking   = 'speaking',     // round-robin: each player 30s
  Discussion = 'discussion',   // free chat 60s
  Voting     = 'voting',       // vote someone out 45s
  NightResult= 'nightresult',  // show night kill result 8s
  Night      = 'night',        // secret actions 60s
  GameOver   = 'gameover',
}

// ─── Player ──────────────────────────────────────────────────────────────────

export interface Player {
  id:          string;
  name:        string;
  roomId:      string;
  joinIndex:   number;   // stable insertion order (0-based)
  role:        Role | null;
  alive:       boolean;
  ready:       boolean;
  nightTarget: string | null;
  blocked:     boolean;
  voteCount:   number;
  dayVote:     string | null;
}

// ─── Room State ───────────────────────────────────────────────────────────────

export interface PublicPlayer {
  id:        string;
  name:      string;
  alive:     boolean;
  ready:     boolean;
  joinIndex: number;   // stable insertion order (0-based)
}

export interface NightResultPublic {
  killedName: string | null;
  healed:     boolean;
}

export interface RoomState {
  roomId:            string;
  phase:             Phase;
  players:           PublicPlayer[];
  round:             number;
  timerEndsAt:       number;
  nightResult:       NightResultPublic | null;
  dayVotes:          Record<string, number>;
  winner:            'mafia' | 'city' | null;
  hostId:            string;
  speakingOrder:     string[];    // player IDs in speech order
  currentSpeakerIdx: number;      // index into speakingOrder; -1 = N/A
}

// ─── SDP / ICE (plain, not browser-only) ─────────────────────────────────────

export interface SdpInit { type: string; sdp: string }
export interface IceInit { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }

// ─── Socket Events ────────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'room:state':        (state: RoomState) => void;
  'player:role':       (role: Role, mafiaIds: string[]) => void;
  // Night
  'night:start':       (timerEndsAt: number) => void;
  'night:result':      (result: NightResultPublic) => void;
  'detective:result':  (targetId: string, targetName: string, isMafia: boolean) => void;
  // Speaking
  'speaking:your-turn':(timerEndsAt: number) => void;
  'speaking:start':    (speakerId: string, speakerName: string, timerEndsAt: number) => void;
  // Discussion
  'discussion:start':  (timerEndsAt: number) => void;
  // Voting
  'voting:start':      (timerEndsAt: number) => void;
  'voting:update':     (votes: Record<string, number>) => void;
  // Result
  'result':            (eliminated: string | null, eliminatedName: string | null) => void;
  // Game Over
  'gameover':          (winner: 'mafia' | 'city', reason: string) => void;
  // Chat — tag: 'mafia'=mafia chat | 'system'=server message | 'normal'=day chat
  'chat:message':      (from: string, text: string, tag: 'mafia' | 'system' | 'normal') => void;
  // Error
  'error':             (msg: string) => void;
  // WebRTC
  'rtc:offer':         (fromId: string, offer: SdpInit) => void;
  'rtc:answer':        (fromId: string, answer: SdpInit) => void;
  'rtc:ice':           (fromId: string, candidate: IceInit) => void;
  'rtc:peer-joined':   (peerId: string, peerName: string) => void;
  'rtc:peer-left':     (peerId: string) => void;
}

export interface ClientToServerEvents {
  'room:join':     (roomId: string, playerName: string) => void;
  'player:ready':  (ready: boolean) => void;
  'game:start':    () => void;
  'speaking:done': () => void;   // speaker finishes early
  'night:action':  (targetId: string) => void;
  'day:vote':      (targetId: string) => void;
  'chat:send':     (text: string) => void;
  'rtc:offer':     (toId: string, offer: SdpInit) => void;
  'rtc:answer':    (toId: string, answer: SdpInit) => void;
  'rtc:ice':       (toId: string, candidate: IceInit) => void;
}
