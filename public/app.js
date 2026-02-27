/* ==========================================
   Мафия Онлайн — Client
   ========================================== */

// ─── Socket & State ───────────────────────────────────────────────────────

const socket = io();

let myId        = socket.id;
let myName      = '';
let myRole      = null;       // 'mafia' | 'detective' | 'doctor' | 'prostitute' | 'civilian'
let myMafiaIds  = [];         // filled only if mafia
let roomState   = null;       // latest RoomState from server
let timerInterval = null;
let nightActionTarget = null;

// ─── WebRTC ───────────────────────────────────────────────────────────────

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let localStream = null;                  // MediaStream
const peers     = new Map();             // peerId → RTCPeerConnection
const peerNames = new Map();             // peerId → name

async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (_) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (__) {
      localStream = null;
    }
  }
}

function createPeerConnection(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(STUN_SERVERS);
  peers.set(peerId, pc);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  // Remote stream → video tile
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (!stream) return;
    setVideoTileStream(peerId, stream);
  };

  // ICE
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('rtc:ice', peerId, e.candidate.toJSON());
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      pc.close();
      peers.delete(peerId);
    }
  };

  return pc;
}

async function callPeer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('rtc:offer', peerId, { type: offer.type, sdp: offer.sdp });
}

function closePeerConnection(peerId) {
  const pc = peers.get(peerId);
  if (pc) { pc.close(); peers.delete(peerId); }
  removeVideoTile(peerId);
}

// ─── Socket Events ────────────────────────────────────────────────────────

socket.on('connect', () => { myId = socket.id; });

socket.on('error', (msg) => {
  showJoinError(msg);
  showLobbyError(msg);
});

// ──── Room State ──────────────────────────────────────────────────────────
socket.on('room:state', (state) => {
  myId = socket.id;   // refresh in case reconnected
  roomState = state;

  const phase = state.phase;

  if (phase === 'lobby') {
    showScreen('lobby');
    renderLobby(state);
  } else if (['night','day','voting','result','gameover'].includes(phase)) {
    showScreen('game');
    renderGame(state);
  }
});

// ──── Role ────────────────────────────────────────────────────────────────
socket.on('player:role', (role, mafiaIds) => {
  myRole     = role;
  myMafiaIds = mafiaIds;
  updateRoleBadge();
  addChatSystem(`Ваша роль: ${roleLabel(role).toUpperCase()}`);
  if (role === 'mafia' && mafiaIds.length > 1) {
    const allies = mafiaIds.filter(id => id !== myId);
    const names  = allies.map(id => peerNames.get(id) || id);
    addChatSystem(`Ваши сообщники по мафии: ${names.join(', ')}`);
  }
  // Mark mafia tiles
  if (role === 'mafia') {
    for (const id of mafiaIds) markMafiaTile(id, true);
  }
});

// ──── Night ───────────────────────────────────────────────────────────────
socket.on('night:start', (timerEndsAt) => {
  nightActionTarget = null;
  startTimerCountdown(timerEndsAt);
});

socket.on('night:result', (result) => {
  const banner = $('#night-result-banner');
  if (result.killedName) {
    banner.textContent = result.healed
      ? `🩺 Доктор спас ${result.killedName} от гибели!`
      : `☠️ Ночью был убит: ${result.killedName}`;
  } else {
    banner.textContent = '🌙 Ночь прошла спокойно — никто не погиб.';
  }
  banner.classList.remove('hidden');
  addChatSystem(banner.textContent);
});

socket.on('detective:result', (targetId, targetName, isMafia) => {
  const verdict = isMafia ? 'МАФИЯ 🔴' : 'Мирный житель 🟢';
  addChatSystem(`🔎 Детектив: ${targetName} — ${verdict}`);
});

// ──── Day ─────────────────────────────────────────────────────────────────
socket.on('day:start', (timerEndsAt) => {
  startTimerCountdown(timerEndsAt);
});

// ──── Voting ──────────────────────────────────────────────────────────────
socket.on('voting:start', (timerEndsAt) => {
  startTimerCountdown(timerEndsAt);
  renderVotingPanel();
});

socket.on('voting:update', (votes) => {
  if (roomState) roomState.dayVotes = votes;
  updateVoteCounts(votes);
});

// ──── Result ──────────────────────────────────────────────────────────────
socket.on('result', (eliminatedId, eliminatedName) => {
  clearTimerCountdown();
  const msg = eliminatedName
    ? `⚖️ Игроки проголосовали: ${eliminatedName} выбывает из игры.`
    : '⚖️ Голосование не выявило победителя — никто не выбыл.';
  $('#result-content').textContent = msg;
  addChatSystem(msg);
});

// ──── Game Over ───────────────────────────────────────────────────────────
socket.on('gameover', (winner, reason) => {
  clearTimerCountdown();
  const t  = $('#gameover-title');
  const r  = $('#gameover-reason');
  t.textContent = winner === 'city' ? '🏙 Город победил!' : '🔫 Мафия победила!';
  t.style.color = winner === 'city' ? 'var(--green)' : 'var(--mafia-color)';
  r.textContent = reason;
  addChatSystem(`КОНЕЦ ИГРЫ — ${reason}`);

  // Reveal all roles
  if (roomState) {
    const reveal = $('#roles-reveal');
    reveal.innerHTML = '';
    for (const p of roomState.players) {
      const card = document.createElement('div');
      card.className = 'reveal-card';
      card.textContent = `${p.name}: ${p.alive ? '✅' : '☠️'}`;
      reveal.appendChild(card);
    }
  }
});

// ──── Chat ────────────────────────────────────────────────────────────────
socket.on('chat:message', (from, text, isMafia) => {
  addChatMessage(from, text, isMafia);
});

// ──── WebRTC signaling ─────────────────────────────────────────────────────
socket.on('rtc:peer-joined', async (peerId, peerName) => {
  peerNames.set(peerId, peerName);
  addVideoTile(peerId, peerName, false);
  // Caller initiates
  if (shouldInitiateCall(peerId)) {
    await callPeer(peerId);
  }
});

socket.on('rtc:peer-left', (peerId) => {
  closePeerConnection(peerId);
  peerNames.delete(peerId);
});

socket.on('rtc:offer', async (fromId, offer) => {
  const pc = createPeerConnection(fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('rtc:answer', fromId, { type: answer.type, sdp: answer.sdp });
});

socket.on('rtc:answer', async (fromId, answer) => {
  const pc = peers.get(fromId);
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('rtc:ice', async (fromId, candidate) => {
  const pc = peers.get(fromId);
  if (pc) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }
});

// Makes the player with the lexicographically lower ID act as caller
function shouldInitiateCall(peerId) {
  return myId < peerId;
}

// ─── UI Helpers ───────────────────────────────────────────────────────────

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function showScreen(name) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
}

function showJoinError(msg) {
  const el = $('#join-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function showLobbyError(msg) {
  const el = $('#lobby-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ─── Join Screen ──────────────────────────────────────────────────────────

$('#btn-join').addEventListener('click', async () => {
  const nameEl = $('#inp-name');
  const roomEl = $('#inp-room');
  const name   = nameEl.value.trim();
  let   roomId = roomEl.value.trim().toUpperCase();

  if (!name) { showJoinError('Введите ваше имя.'); return; }

  // Generate random room ID if empty
  if (!roomId) roomId = Math.random().toString(36).slice(2, 7).toUpperCase();

  myName = name;

  // Update URL so the link can be shared
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  history.replaceState({}, '', url.toString());

  await initMedia();
  socket.emit('room:join', roomId, name);
});

// Pre-fill room from URL param
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const room   = params.get('room');
  if (room) $('#inp-room').value = room.toUpperCase();
  // Allow Enter to join
  $('#inp-name').addEventListener('keyup', e => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#inp-room').addEventListener('keyup', e => { if (e.key === 'Enter') $('#btn-join').click(); });
});

// ─── Lobby ────────────────────────────────────────────────────────────────

function renderLobby(state) {
  $('#lbl-room-id').textContent = state.roomId;

  const list   = $('#player-list');
  list.innerHTML = '';
  for (const p of state.players) {
    const li   = document.createElement('li');
    li.className = 'player-list-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'pli-name';
    nameSpan.textContent = p.name + (p.id === socket.id ? ' (Вы)' : '');
    li.appendChild(nameSpan);

    if (p.id === state.hostId) {
      const hb = document.createElement('span');
      hb.className   = 'pli-host-badge';
      hb.textContent = 'Хост';
      li.appendChild(hb);
    }

    if (p.ready) {
      const rb = document.createElement('span');
      rb.className   = 'pli-ready-badge';
      rb.textContent = 'Готов';
      li.appendChild(rb);
    }

    list.appendChild(li);
  }

  // My ready button
  const me = state.players.find(p => p.id === socket.id);
  const readyBtn = $('#btn-ready');
  if (me) {
    readyBtn.textContent = me.ready ? '❌ Не готов' : '✅ Готов';
    readyBtn.className   = me.ready ? 'btn btn-danger' : 'btn btn-secondary';
  }

  // Start button (host only)
  const startBtn = $('#btn-start');
  if (socket.id === state.hostId) {
    startBtn.classList.remove('hidden');
  } else {
    startBtn.classList.add('hidden');
  }
}

$('#btn-ready').addEventListener('click', () => {
  if (!roomState) return;
  const me = roomState.players.find(p => p.id === socket.id);
  const isReady = !(me?.ready);
  socket.emit('player:ready', isReady);
});

$('#btn-start').addEventListener('click', () => {
  socket.emit('game:start');
});

$('#btn-copy-link').addEventListener('click', () => {
  const url = new URL(window.location.href);
  if (roomState) url.searchParams.set('room', roomState.roomId);
  navigator.clipboard.writeText(url.toString()).then(() => {
    $('#btn-copy-link').textContent = '✅ Скопировано!';
    setTimeout(() => $('#btn-copy-link').textContent = '📋 Скопировать ссылку', 2000);
  });
});

// ─── Video Tiles ──────────────────────────────────────────────────────────

function ensureMyTile() {
  if (!document.getElementById(`tile-${myId}`)) {
    addVideoTile(myId, myName, true);
    if (localStream) setVideoTileStream(myId, localStream, true);
  }
}

function addVideoTile(peerId, name, isMe) {
  if (document.getElementById(`tile-${peerId}`)) return;
  const tmpl = document.getElementById('tmpl-video-tile').content.cloneNode(true);
  const div  = tmpl.querySelector('.video-tile');
  div.id = `tile-${peerId}`;
  if (isMe) { div.classList.add('me-tile'); div.querySelector('video').muted = true; }

  div.querySelector('.player-name-tag').textContent = name + (isMe ? ' (Вы)' : '');

  if (!isMe && !localStream) {
    // Show avatar fallback
    const v = div.querySelector('video');
    v.style.display = 'none';
    const av = document.createElement('div');
    av.className = 'no-video-avatar';
    av.textContent = name.charAt(0).toUpperCase();
    div.insertBefore(av, v.parentNode ? v.nextSibling : null);
  }

  $('#video-grid').appendChild(div);
}

function setVideoTileStream(peerId, stream, muted) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (!tile) return;
  const v = tile.querySelector('video');
  v.style.display = 'block';
  v.srcObject = stream;
  if (muted) v.muted = true;
  v.play().catch(() => {});
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();
}

function markMafiaTile(peerId, show) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (!tile) return;
  tile.querySelector('.mafia-badge').classList.toggle('hidden', !show);
}

function updateTilesDead(state) {
  for (const p of state.players) {
    const tile = document.getElementById(`tile-${p.id}`);
    if (tile) {
      tile.classList.toggle('dead-tile', !p.alive);
      tile.querySelector('.player-status-tag').textContent = p.alive ? '' : '☠️';
    }
  }
}

// ─── Game Screen ──────────────────────────────────────────────────────────

function renderGame(state) {
  ensureMyTile();
  updateTilesDead(state);

  const phase = state.phase;
  const alive = state.players.find(p => p.id === socket.id)?.alive ?? true;

  // Update phase label
  const phaseNames = {
    night: '🌙 Ночь', day: '☀️ День', voting: '🗳 Голосование',
    result: '📋 Результат', gameover: '🏁 Конец игры',
  };
  $('#game-phase-label').textContent =
    (phaseNames[phase] || phase) + (state.round ? ` • Раунд ${state.round}` : '');

  // Hide all panels
  ['night','day','voting','result','gameover'].forEach(p =>
    $(`#panel-${p}`).classList.add('hidden')
  );
  $('#panel-spectator').classList.add('hidden');

  if (!alive) $('#panel-spectator').classList.remove('hidden');

  if (phase === 'night') {
    $(`#panel-night`).classList.remove('hidden');
    renderNightPanel(state);
  } else if (phase === 'day') {
    $(`#panel-day`).classList.remove('hidden');
    const banner = $('#night-result-banner');
    if (state.nightResult) {
      if (state.nightResult.killedName) {
        banner.textContent = state.nightResult.healed
          ? `🩺 Доктор спас ${state.nightResult.killedName}!`
          : `☠️ Убит: ${state.nightResult.killedName}`;
      } else {
        banner.textContent = '🌙 Ночь прошла спокойно.';
      }
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    if (state.timerEndsAt) startTimerCountdown(state.timerEndsAt);
  } else if (phase === 'voting') {
    $(`#panel-voting`).classList.remove('hidden');
    renderVotingPanel(state);
    if (state.timerEndsAt) startTimerCountdown(state.timerEndsAt);
  } else if (phase === 'result') {
    $(`#panel-result`).classList.remove('hidden');
    clearTimerCountdown();
  } else if (phase === 'gameover') {
    $(`#panel-gameover`).classList.remove('hidden');
    clearTimerCountdown();
  }
}

// ─── Night Panel ──────────────────────────────────────────────────────────

function renderNightPanel(state) {
  const me = state.players.find(p => p.id === socket.id);
  if (!me || !me.alive) return;

  const titles = {
    mafia:      '🔫 Мафия — выберите жертву',
    detective:  '🔎 Детектив — проверьте подозреваемого',
    doctor:     '🩺 Доктор — кого защитить?',
    prostitute: '💃 Проститутка — кого отвлечь?',
    civilian:   '😴 Вы спите…',
  };
  const descs = {
    mafia:      'Ваш выбор складывается с голосами остальной мафии.',
    detective:  'Вы узнаете, является ли цель мафией.',
    doctor:     'Вылеченный игрок не умрёт этой ночью.',
    prostitute: 'Заблокированный не сможет использовать своё действие.',
    civilian:   '',
  };

  const role  = myRole || 'civilian';
  $('#night-action-title').textContent = titles[role] ?? '🌙 Ночное действие';
  $('#night-action-desc').textContent  = descs[role]  ?? '';

  const targets = $('#night-targets');
  targets.innerHTML = '';

  if (role === 'civilian') return;   // civilians have no action

  // Targets: alive players (mafia can't target themselves, others can't target self)
  let candidates = state.players.filter(p => p.alive);

  if (role === 'mafia') {
    candidates = candidates.filter(p => !myMafiaIds.includes(p.id) && p.id !== socket.id);
  } else {
    // Doctor / detective / prostitute can't target self (by convention — optional for doctor)
    // Actually doctor CAN protect themselves, let's allow it
    candidates = candidates.filter(p => !(role !== 'doctor' && p.id === socket.id));
  }

  for (const p of candidates) {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.dataset.id = p.id;
    btn.textContent = p.name;
    if (nightActionTarget === p.id) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      nightActionTarget = p.id;
      $$('#night-targets .target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      socket.emit('night:action', p.id);
      $('#night-status').textContent = `✅ Выбрано: ${p.name}`;
    });
    targets.appendChild(btn);
  }
}

// ─── Voting Panel ─────────────────────────────────────────────────────────

function renderVotingPanel(state) {
  const me = roomState?.players.find(p => p.id === socket.id);
  const targets = $('#voting-targets');
  targets.innerHTML = '';

  const players = (state || roomState)?.players ?? [];
  for (const p of players) {
    if (!p.alive) continue;
    if (p.id === socket.id) continue;   // can't vote for self
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.id = `vote-btn-${p.id}`;
    btn.dataset.id = p.id;
    btn.textContent = `${p.name} (${p.id === socket.id ? '—' : ((state || roomState)?.dayVotes?.[p.id] ?? 0) + ' 🗳'})`;

    if (!me?.alive) { btn.disabled = true; btn.classList.add('dead'); }

    btn.addEventListener('click', () => {
      $$('#voting-targets .target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      socket.emit('day:vote', p.id);
    });
    targets.appendChild(btn);
  }
}

function updateVoteCounts(votes) {
  for (const [id, count] of Object.entries(votes)) {
    const btn = document.getElementById(`vote-btn-${id}`);
    if (!btn) continue;
    const name = roomState?.players.find(p => p.id === id)?.name ?? id;
    btn.textContent = `${name} (${count} 🗳)`;
  }
}

// ─── Timer ────────────────────────────────────────────────────────────────

function startTimerCountdown(endsAt) {
  clearTimerCountdown();
  const el = $('#game-timer');
  function tick() {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = left;
    el.classList.toggle('urgent', left <= 10);
    if (left === 0) clearTimerCountdown();
  }
  tick();
  timerInterval = setInterval(tick, 500);
}

function clearTimerCountdown() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const el = $('#game-timer');
  if (el) { el.textContent = ''; el.classList.remove('urgent'); }
}

// ─── Role Badge ───────────────────────────────────────────────────────────

function updateRoleBadge() {
  const el = $('#my-role-badge');
  if (!myRole) { el.textContent = ''; el.className = 'role-badge'; return; }
  el.textContent = roleLabel(myRole);
  el.className   = `role-badge role-${myRole}`;
}

function roleLabel(role) {
  return {
    mafia:      'Мафия',
    detective:  'Детектив',
    doctor:     'Доктор',
    prostitute: 'Проститутка',
    civilian:   'Житель',
  }[role] ?? role;
}

// ─── Chat ─────────────────────────────────────────────────────────────────

function addChatMessage(name, text, isMafia) {
  const box = $('#chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isMafia ? ' mafia-msg' : '');
  div.innerHTML = `<span class="chat-name">${escHtml(name)}${isMafia ? ' [Мафия]' : ''}:</span> ${escHtml(text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function addChatSystem(text) {
  const box = $('#chat-messages');
  const div = document.createElement('div');
  div.className   = 'chat-msg system-msg';
  div.textContent = '⚙️ ' + text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

$('#btn-send-chat').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keyup', e => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const inp  = $('#chat-input');
  const text = inp.value.trim();
  if (!text) return;
  socket.emit('chat:send', text);
  inp.value = '';
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── Back to lobby ────────────────────────────────────────────────────────

$('#btn-back-lobby').addEventListener('click', () => {
  if (roomState) socket.emit('room:join', roomState.roomId, myName);
});
