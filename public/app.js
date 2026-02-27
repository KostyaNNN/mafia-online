/* ════════════════════════════════════════════════
   Мафия Онлайн — Client
   ════════════════════════════════════════════════ */

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let myId         = '';
let myName       = '';
let myRole       = null;
let myMafiaIds   = [];
let roomState    = null;
let timerInterval= null;
let isMyTurn     = false;   // speaking turn
let nightActionTarget = null;

// ─── Media / WebRTC ───────────────────────────────────────────────────────────
const STUN = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]};

let localStream   = null;
let testStream    = null;     // join-screen test stream
let audioContext  = null;
let audioAnalyser = null;
let audioAnimId   = null;
let micMuted      = false;
let camOff        = false;
const peers       = new Map();   // peerId → RTCPeerConnection
const peerNames   = new Map();   // peerId → name

// ────────────────────── helpers ──────────────────────
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function showScreen(name) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
}
function showErr(id, msg, ms = 5000) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), ms);
}
function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ═══════════════════════════════════════════════════════
//  CAMERA / MIC TEST (join screen)
// ═══════════════════════════════════════════════════════

$('#btn-test-cam').addEventListener('click', startCamTest);
$('#btn-stop-test').addEventListener('click', stopCamTest);
$('#btn-toggle-mic').addEventListener('click', toggleTestMic);
$('#btn-toggle-cam').addEventListener('click', toggleTestCam);

async function startCamTest() {
  try {
    testStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const vid = $('#cam-preview');
    vid.srcObject = testStream;
    vid.style.display = 'block';
    $('#cam-placeholder').classList.add('hidden');
    $('#btn-test-cam').classList.add('hidden');
    $('#btn-toggle-mic').classList.remove('hidden');
    $('#btn-toggle-cam').classList.remove('hidden');
    $('#btn-stop-test').classList.remove('hidden');
    $('#cam-status').textContent = '✅ Камера и микрофон работают';
    startAudioMeter(testStream, 'audio-bar', 'audio-meter-wrap');
  } catch (e) {
    try {
      testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      $('#cam-status').textContent = '⚠️ Только микрофон (камера не найдена)';
      startAudioMeter(testStream, 'audio-bar', 'audio-meter-wrap');
      $('#btn-stop-test').classList.remove('hidden');
    } catch (_) {
      $('#cam-status').textContent = '❌ Нет доступа к камере и микрофону';
    }
  }
}

function stopCamTest() {
  if (testStream) { testStream.getTracks().forEach(t => t.stop()); testStream = null; }
  stopAudioMeter();
  $('#cam-preview').style.display = 'none';
  $('#cam-placeholder').classList.remove('hidden');
  $('#audio-meter-wrap').classList.add('hidden');
  $('#btn-test-cam').classList.remove('hidden');
  $('#btn-toggle-mic').classList.add('hidden');
  $('#btn-toggle-cam').classList.add('hidden');
  $('#btn-stop-test').classList.add('hidden');
  $('#cam-status').textContent = '';
}

function toggleTestMic() {
  if (!testStream) return;
  testStream.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
  const muted = !testStream.getAudioTracks()[0]?.enabled;
  $('#btn-toggle-mic').textContent = muted ? '🔇 Микрофон выкл' : '🎤 Микрофон';
  $('#btn-toggle-mic').classList.toggle('muted', muted);
}

function toggleTestCam() {
  if (!testStream) return;
  testStream.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
  const off = !testStream.getVideoTracks()[0]?.enabled;
  $('#btn-toggle-cam').textContent = off ? '🚫 Камера выкл' : '📷 Камера';
  $('#btn-toggle-cam').classList.toggle('muted', off);
}

// ─── Audio meter ──────────────────────────────────────────────────────────────
function startAudioMeter(stream, barId, wrapId) {
  stopAudioMeter();
  try {
    audioContext  = new (window.AudioContext || window.webkitAudioContext)();
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 256;
    const src = audioContext.createMediaStreamSource(stream);
    src.connect(audioAnalyser);
    const data   = new Uint8Array(audioAnalyser.frequencyBinCount);
    const barEl  = document.getElementById(barId);
    const wrapEl = document.getElementById(wrapId);
    if (wrapEl) wrapEl.classList.remove('hidden');
    function draw() {
      audioAnimId = requestAnimationFrame(draw);
      audioAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      if (barEl) barEl.style.width = Math.min(100, avg * 2) + '%';
    }
    draw();
  } catch (_) {}
}

function stopAudioMeter() {
  if (audioAnimId) { cancelAnimationFrame(audioAnimId); audioAnimId = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  audioAnalyser = null;
}

// ═══════════════════════════════════════════════════════
//  LOBBY CAM CONTROLS
// ═══════════════════════════════════════════════════════

$('#btn-lobby-mic').addEventListener('click', () => {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
  $('#btn-lobby-mic').textContent = micMuted ? '🔇 Микрофон выкл' : '🎤 Микрофон';
  $('#btn-lobby-mic').classList.toggle('muted', micMuted);
});

$('#btn-lobby-cam-toggle').addEventListener('click', () => {
  if (!localStream) return;
  camOff = !camOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !camOff; });
  $('#btn-lobby-cam-toggle').textContent = camOff ? '🚫 Камера выкл' : '📷 Камера';
  $('#btn-lobby-cam-toggle').classList.toggle('muted', camOff);
  const vid = $('#lobby-cam-preview');
  if (camOff) { vid.style.display = 'none'; $('#lobby-cam-placeholder').classList.remove('hidden'); }
  else        { vid.style.display = 'block'; $('#lobby-cam-placeholder').classList.add('hidden'); }
});

async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (_) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (__) {}
  }
  if (localStream) {
    const vid = $('#lobby-cam-preview');
    vid.srcObject = localStream;
    vid.style.display = 'block';
    $('#lobby-cam-placeholder').classList.add('hidden');
    startAudioMeter(localStream, 'lobby-audio-bar', 'lobby-audio-meter-wrap');
  }
}

// ═══════════════════════════════════════════════════════
//  JOIN SCREEN
// ═══════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  const p = new URLSearchParams(location.search).get('room');
  if (p) $('#inp-room').value = p.toUpperCase();
  ['#inp-name','#inp-room'].forEach(s =>
    $(s).addEventListener('keyup', e => { if (e.key === 'Enter') $('#btn-join').click(); })
  );
});

$('#btn-join').addEventListener('click', async () => {
  const name   = $('#inp-name').value.trim();
  let   roomId = $('#inp-room').value.trim().toUpperCase();
  if (!name) { showErr('join-error', 'Введите ваше имя.'); return; }
  if (!roomId) roomId = Math.random().toString(36).slice(2, 7).toUpperCase();

  myName = name;
  const url = new URL(location.href);
  url.searchParams.set('room', roomId);
  history.replaceState({}, '', url.toString());

  // Stop test stream if running
  stopCamTest();
  // Start actual media
  if (!localStream) await startLocalMedia();

  socket.emit('room:join', roomId, name);
});

// ═══════════════════════════════════════════════════════
//  LOBBY SCREEN
// ═══════════════════════════════════════════════════════

function renderLobby(state) {
  $('#lbl-room-id').textContent = state.roomId;
  const list = $('#player-list');
  list.innerHTML = '';

  for (const p of state.players) {
    const li = document.createElement('li');
    li.className = 'player-list-item';
    li.innerHTML = `
      <span class="pli-name">${esc(p.name)}${p.id === socket.id ? ' <em>(Вы)</em>' : ''}</span>
      ${p.id === state.hostId ? '<span class="pli-host-badge">Хост</span>' : ''}
      ${p.ready ? '<span class="pli-ready-badge">✅ Готов</span>' : '<span class="pli-wait-badge">⏳</span>'}
    `;
    list.appendChild(li);
  }

  const me = state.players.find(p => p.id === socket.id);
  const rb = $('#btn-ready');
  if (me) {
    rb.textContent = me.ready ? '❌ Не готов' : '✅ Готов';
    rb.className   = 'btn ' + (me.ready ? 'btn-danger' : 'btn-secondary');
  }
  const sb = $('#btn-start');
  sb.classList.toggle('hidden', socket.id !== state.hostId);
}

$('#btn-ready').addEventListener('click', () => {
  if (!roomState) return;
  const me = roomState.players.find(p => p.id === socket.id);
  socket.emit('player:ready', !(me?.ready));
});

$('#btn-start').addEventListener('click', () => socket.emit('game:start'));

$('#btn-copy-link').addEventListener('click', () => {
  const url = new URL(location.href);
  if (roomState) url.searchParams.set('room', roomState.roomId);
  navigator.clipboard.writeText(url.toString()).then(() => {
    $('#btn-copy-link').textContent = '✅ Скопировано!';
    setTimeout(() => $('#btn-copy-link').textContent = '📋 Скопировать ссылку', 2000);
  });
});

// ═══════════════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════════════

socket.on('connect', () => { myId = socket.id; });

socket.on('error', (msg) => {
  showErr('join-error', msg);
  showErr('lobby-error', msg);
  addChat('⚙️ Сервер', msg, 'system');
});

// ── Room state ────────────────────────────────────────
socket.on('room:state', (state) => {
  myId = socket.id;
  roomState = state;

  // Ensure a video tile exists for every player we know about
  for (const p of state.players) {
    peerNames.set(p.id, p.name);
    addVideoTile(p.id, p.name, p.id === socket.id, p.joinIndex);
  }
  // Remove tiles for players no longer in the room
  const knownIds = new Set(state.players.map(p => p.id));
  $$('.video-tile').forEach(tile => {
    const id = tile.id.replace('tile-', '');
    if (id && !knownIds.has(id)) tile.remove();
  });
  // Sort all tiles in DOM by joinIndex
  sortTilesByJoinIndex();

  if (state.phase === 'lobby' || state.phase === 'gameover') {
    if (state.phase === 'lobby') {
      showScreen('lobby');
      renderLobby(state);
      // wire lobby cam
      if (localStream) {
        const vid = $('#lobby-cam-preview');
        if (!vid.srcObject) { vid.srcObject = localStream; vid.style.display = 'block'; $('#lobby-cam-placeholder').classList.add('hidden'); }
      }
    }
    if (state.phase === 'gameover') {
      showScreen('game');
      renderGame(state);
    }
    return;
  }

  showScreen('game');
  renderGame(state);
});

// ── Role ──────────────────────────────────────────────
socket.on('player:role', (role, mafiaIds) => {
  myRole     = role;
  myMafiaIds = mafiaIds;
  updateRoleBadge();
  addChat('⚙️ Сервер', `Ваша роль: ${roleLabel(role).toUpperCase()}`, 'system');
  if (role === 'mafia' && mafiaIds.length > 1) {
    const allies = mafiaIds.filter(id => id !== myId)
      .map(id => peerNames.get(id) || id);
    addChat('⚙️ Сервер', `Сообщники: ${allies.join(', ')}`, 'system');
    for (const id of mafiaIds) markMafiaTile(id, true);
  }
});

// ── Speaking start ────────────────────────────────────
socket.on('speaking:start', (speakerId, speakerName, timerEndsAt) => {
  highlightSpeaker(speakerId);
  startTimerCountdown(timerEndsAt);
});

socket.on('speaking:your-turn', (timerEndsAt) => {
  isMyTurn = true;
  $('#your-turn-banner').classList.remove('hidden');
  startTimerCountdown(timerEndsAt);
  // Auto-hide after timer
  setTimeout(() => {
    isMyTurn = false;
    $('#your-turn-banner').classList.add('hidden');
  }, timerEndsAt - Date.now());
});

// ── Discussion start ──────────────────────────────────
socket.on('discussion:start', (timerEndsAt) => {
  startTimerCountdown(timerEndsAt);
});

// ── Night ─────────────────────────────────────────────
socket.on('night:start', (timerEndsAt) => {
  nightActionTarget = null;
  startTimerCountdown(timerEndsAt);
});

socket.on('night:result', (result) => {
  clearTimerCountdown();
  let msg;
  if (result.killedName) {
    msg = result.healed
      ? `🩺 Доктор спас ${result.killedName} от гибели!`
      : `☠️ Этой ночью убит: ${result.killedName}`;
  } else {
    msg = '🌙 Ночь прошла спокойно — никто не пострадал.';
  }
  $('#night-result-content').textContent = msg;
});

socket.on('detective:result', (targetId, targetName, isMafia) => {
  const verdict = isMafia ? 'МАФИЯ 🔴' : 'Мирный житель 🟢';
  addChat('🔎 Детектив', `${targetName} — ${verdict}`, 'system');
});

// ── Voting ────────────────────────────────────────────
socket.on('voting:start',  (t) => startTimerCountdown(t));
socket.on('voting:update', (votes) => {
  if (roomState) roomState.dayVotes = votes;
  updateVoteCounts(votes);
});

// ── Result ────────────────────────────────────────────
socket.on('result', (eliminatedId, eliminatedName) => {
  clearTimerCountdown();
  const msg = eliminatedName
    ? `⚖️ Выбыл: ${eliminatedName}`
    : '⚖️ Ничья — никто не выбыл.';
  addChat('⚙️ Сервер', msg, 'system');
});

// ── Game over ─────────────────────────────────────────
socket.on('gameover', (winner, reason) => {
  clearTimerCountdown();
  const t  = $('#gameover-title');
  const r  = $('#gameover-reason');
  t.textContent = winner === 'city' ? '🏙 Город победил!' : '🔫 Мафия победила!';
  t.style.color = winner === 'city' ? 'var(--green)' : 'var(--mafia-color)';
  r.textContent = reason;

  // Reveal roles
  const reveal = $('#roles-reveal');
  reveal.innerHTML = '';
  if (roomState) {
    for (const p of roomState.players) {
      const card = document.createElement('div');
      card.className = 'reveal-card';
      card.textContent = `${p.name} ${p.alive ? '✅' : '☠️'}`;
      reveal.appendChild(card);
    }
  }
});

// ── Chat ──────────────────────────────────────────────
socket.on('chat:message', (from, text, tag) => addChat(from, text, tag));

// ── WebRTC ────────────────────────────────────────────
socket.on('rtc:peer-joined', async (peerId, peerName) => {
  peerNames.set(peerId, peerName);
  // joinIndex will be set properly on next room:state; use 999 as temp placeholder
  const existingTile = document.getElementById(`tile-${peerId}`);
  if (!existingTile) addVideoTile(peerId, peerName, false, 999);
  if (myId < peerId) await callPeer(peerId);
});

socket.on('rtc:peer-left', (peerId) => {
  closePeer(peerId);
  peerNames.delete(peerId);
});

socket.on('rtc:offer', async (fromId, offer) => {
  const pc = createPC(fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('rtc:answer', fromId, { type: answer.type, sdp: answer.sdp });
});

socket.on('rtc:answer', async (fromId, answer) => {
  await peers.get(fromId)?.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('rtc:ice', async (fromId, candidate) => {
  try { await peers.get(fromId)?.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
});

// ═══════════════════════════════════════════════════════
//  WEBRTC HELPERS
// ═══════════════════════════════════════════════════════

function createPC(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);
  const pc = new RTCPeerConnection(STUN);
  peers.set(peerId, pc);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = (e) => { if (e.streams[0]) setTileStream(peerId, e.streams[0]); };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('rtc:ice', peerId, e.candidate.toJSON());
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') { pc.close(); peers.delete(peerId); }
  };
  return pc;
}

async function callPeer(peerId) {
  const pc    = createPC(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('rtc:offer', peerId, { type: offer.type, sdp: offer.sdp });
}

function closePeer(peerId) {
  peers.get(peerId)?.close();
  peers.delete(peerId);
  removeTile(peerId);
}

// ═══════════════════════════════════════════════════════
//  GAME RENDER
// ═══════════════════════════════════════════════════════

function renderGame(state) {
  const phase      = state.phase;
  const me         = state.players.find(p => p.id === socket.id);
  const alive      = me?.alive ?? true;

  ensureMyTile();
  updateTilesDead(state);
  sortTilesByJoinIndex();

  // Phase label
  const phaseMap = {
    speaking:    '🗣 Высказывания',
    discussion:  '💬 Обсуждение',
    voting:      '🗳 Голосование',
    nightresult: '🌅 Рассвет',
    night:       '🌙 Ночь',
    gameover:    '🏁 Конец игры',
  };
  $('#game-phase-label').textContent =
    (phaseMap[phase] || phase) + (state.round ? ` · Раунд ${state.round}` : '');

  // Hide all panels
  ['speaking','discussion','night','nightresult','voting','gameover'].forEach(p =>
    $(`#panel-${p}`).classList.add('hidden')
  );
  $('#panel-spectator').classList.add('hidden');

  if (!alive) $('#panel-spectator').classList.remove('hidden');

  if (phase === 'speaking') {
    $('#panel-speaking').classList.remove('hidden');
    renderSpeakingPanel(state);
    if (state.timerEndsAt) startTimerCountdown(state.timerEndsAt);
  } else if (phase === 'discussion') {
    $('#panel-discussion').classList.remove('hidden');
    if (state.timerEndsAt) startTimerCountdown(state.timerEndsAt);
  } else if (phase === 'night') {
    $('#panel-night').classList.remove('hidden');
    renderNightPanel(state);
    if (state.timerEndsAt) startTimerCountdown(state.timerEndsAt);
  } else if (phase === 'nightresult') {
    $('#panel-nightresult').classList.remove('hidden');
    clearTimerCountdown();
    const r = state.nightResult;
    if (r) {
      $('#night-result-content').textContent = r.killedName
        ? (r.healed ? `🩺 Доктор спас ${r.killedName}!` : `☠️ Убит: ${r.killedName}`)
        : '🌙 Ночь прошла спокойно.';
    }
  } else if (phase === 'voting') {
    $('#panel-voting').classList.remove('hidden');
    renderVotingPanel(state);
    if (state.timerEndsAt) startTimerCountdown(state.timerEndsAt);
  } else if (phase === 'gameover') {
    $('#panel-gameover').classList.remove('hidden');
  }
}

// ─── Speaking panel ───────────────────────────────────────────────────────────

function renderSpeakingPanel(state) {
  const order    = state.speakingOrder;
  const curIdx   = state.currentSpeakerIdx;
  const progress = $('#speaking-progress');
  const list     = $('#speaking-order-list');

  progress.textContent = curIdx >= 0
    ? `${curIdx + 1} / ${order.length}`
    : `0 / ${order.length}`;

  list.innerHTML = '';
  order.forEach((id, i) => {
    const p    = state.players.find(p => p.id === id);
    const name = p?.name ?? id;
    const div  = document.createElement('div');
    div.className = 'speak-order-item';
    if (i < curIdx)  div.classList.add('spoke-done');
    if (i === curIdx) div.classList.add('currently-speaking');
    if (i > curIdx)  div.classList.add('waiting');
    div.innerHTML = `
      <span class="speak-num">${i + 1}</span>
      <span class="speak-name">${esc(name)}</span>
      ${i === curIdx ? '<span class="speaking-anim">🎤</span>' : ''}
      ${i < curIdx   ? '<span class="check-mark">✓</span>' : ''}
    `;
    list.appendChild(div);
  });

  // "Your turn" banner
  const speakerId = order[curIdx];
  const myTurn    = speakerId === socket.id;
  $('#your-turn-banner').classList.toggle('hidden', !myTurn);
  isMyTurn = myTurn;
}

function highlightSpeaker(speakerId) {
  $$('.video-tile').forEach(t => t.classList.remove('currently-speaking-tile'));
  const tile = document.getElementById(`tile-${speakerId}`);
  if (tile) tile.classList.add('currently-speaking-tile');
}

// ─── Night panel ──────────────────────────────────────────────────────────────

function renderNightPanel(state) {
  const me = state.players.find(p => p.id === socket.id);
  if (!me?.alive) return;

  const titles = {
    mafia:      '🔫 Мафия — выберите жертву',
    detective:  '🔎 Детектив — кого проверить?',
    doctor:     '🩺 Доктор — кого защитить?',
    prostitute: '💃 Путана — кого отвлечь?',
    civilian:   '😴 Мирный — ждите рассвета',
  };
  const descs = {
    mafia:      'Ваш голос суммируется с голосами сообщников.',
    detective:  'Вы узнаете, мафия ли выбранный игрок.',
    doctor:     'Спасённый не умрёт этой ночью (даже если мафия его выбрала).',
    prostitute: 'Посещённый не сможет использовать своё ночное действие.',
    civilian:   '',
  };

  const role = myRole || 'civilian';
  $('#night-action-title').textContent = titles[role] ?? '🌙 Ночное действие';
  $('#night-action-desc').textContent  = descs[role]  ?? '';
  $('#night-targets').innerHTML        = '';
  $('#night-status').textContent       = '';

  if (role === 'civilian') return;

  let candidates = state.players.filter(p => p.alive);
  if (role === 'mafia') {
    candidates = candidates.filter(p => !myMafiaIds.includes(p.id) && p.id !== socket.id);
  } else {
    if (role !== 'doctor') candidates = candidates.filter(p => p.id !== socket.id);
  }

  for (const p of candidates) {
    const btn = document.createElement('button');
    btn.className   = 'target-btn';
    btn.dataset.id  = p.id;
    btn.textContent = p.name;
    if (nightActionTarget === p.id) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      nightActionTarget = p.id;
      $$('#night-targets .target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      socket.emit('night:action', p.id);
      $('#night-status').textContent = `✅ Выбрано: ${p.name} (ждём остальных…)`;
    });
    $('#night-targets').appendChild(btn);
  }
}

// ─── Voting panel ─────────────────────────────────────────────────────────────

function renderVotingPanel(state) {
  const targets  = $('#voting-targets');
  const me       = state.players.find(p => p.id === socket.id);
  targets.innerHTML = '';

  const alive = state.players.filter(p => p.alive && p.id !== socket.id);
  for (const p of alive) {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.id        = `vote-btn-${p.id}`;
    btn.dataset.id= p.id;
    const vcount  = state.dayVotes?.[p.id] ?? 0;
    btn.textContent = `${p.name} (${vcount} 🗳)`;
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
    const btn  = document.getElementById(`vote-btn-${id}`);
    if (!btn) continue;
    const name = roomState?.players.find(p => p.id === id)?.name ?? id;
    btn.textContent = `${name} (${count} 🗳)`;
  }
}

// ═══════════════════════════════════════════════════════
//  VIDEO TILES
// ═══════════════════════════════════════════════════════

function ensureMyTile() {
  const myJoinIndex = roomState?.players.find(p => p.id === socket.id)?.joinIndex ?? 0;
  const existing = document.getElementById(`tile-${socket.id}`);
  if (!existing) {
    addVideoTile(socket.id, myName, true, myJoinIndex);
  } else {
    existing.dataset.joinIndex = String(myJoinIndex);
  }
  // Always attach local stream to own tile if available and not yet attached
  if (localStream && !gameCamOff) {
    const tile = document.getElementById(`tile-${socket.id}`);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid && !vid.srcObject) {
        setTileStream(socket.id, localStream, true);
      }
    }
  }
}

function addVideoTile(peerId, name, isMe, joinIndex) {
  if (document.getElementById(`tile-${peerId}`)) {
    // Update joinIndex if it changed
    const existing = document.getElementById(`tile-${peerId}`);
    if (joinIndex !== undefined) existing.dataset.joinIndex = String(joinIndex);
    return;
  }
  const tmpl = $('#tmpl-video-tile').content.cloneNode(true);
  const div  = tmpl.querySelector('.video-tile');
  div.id   = `tile-${peerId}`;
  div.dataset.joinIndex = String(joinIndex ?? 999);
  if (isMe) div.classList.add('me-tile');

  div.querySelector('.player-name-tag').textContent = name + (isMe ? ' (Вы)' : '');

  // Avatar fallback
  const avatar = div.querySelector('.no-video-avatar');
  avatar.textContent = name.charAt(0).toUpperCase();

  const vid = div.querySelector('video');
  if (isMe) vid.muted = true;

  // Show avatar initially, hide video
  vid.style.display = 'none';
  avatar.classList.remove('hidden');

  $('#video-grid').appendChild(div);
}

function setTileStream(peerId, stream, muted = false) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (!tile) return;
  const vid    = tile.querySelector('video');
  const avatar = tile.querySelector('.no-video-avatar');
  vid.srcObject = stream;
  if (muted) vid.muted = true;
  vid.style.display = 'block';
  avatar.classList.add('hidden');
  vid.play().catch(() => {});
}

function sortTilesByJoinIndex() {
  const grid  = $('#video-grid');
  const tiles = [...grid.querySelectorAll('.video-tile')];
  tiles.sort((a, b) => Number(a.dataset.joinIndex) - Number(b.dataset.joinIndex));
  tiles.forEach(t => grid.appendChild(t));   // re-append in sorted order
}

function removeTile(peerId) {
  document.getElementById(`tile-${peerId}`)?.remove();
}

function updateTilesDead(state) {
  for (const p of state.players) {
    const tile = document.getElementById(`tile-${p.id}`);
    if (!tile) continue;
    tile.classList.toggle('dead-tile', !p.alive);
    const statusTag = tile.querySelector('.player-status-tag');
    if (statusTag) statusTag.textContent = p.alive ? '' : '☠️';
    tile.querySelector('.dead-overlay').classList.toggle('hidden', p.alive);
  }
}

function markMafiaTile(peerId, show) {
  document.getElementById(`tile-${peerId}`)
    ?.querySelector('.mafia-badge')
    ?.classList.toggle('hidden', !show);
}

// ─── Speaking done button ─────────────────────────────────────────────────────
$('#btn-speaking-done').addEventListener('click', () => {
  if (isMyTurn) {
    socket.emit('speaking:done');
    isMyTurn = false;
    $('#your-turn-banner').classList.add('hidden');
  }
});

// ═══════════════════════════════════════════════════════
//  TIMER
// ═══════════════════════════════════════════════════════

function startTimerCountdown(endsAt) {
  clearTimerCountdown();
  const el = $('#game-timer');
  function tick() {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = left;
    el.classList.toggle('urgent', left <= 10 && left > 0);
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

// ═══════════════════════════════════════════════════════
//  ROLE BADGE
// ═══════════════════════════════════════════════════════

function updateRoleBadge() {
  const el = $('#my-role-badge');
  if (!myRole) { el.textContent = ''; el.className = 'role-badge'; return; }
  el.textContent = roleLabel(myRole);
  el.className   = `role-badge role-${myRole}`;
}

function roleLabel(r) {
  return ({ mafia:'Мафия', detective:'Детектив', doctor:'Доктор',
            prostitute:'Путана', civilian:'Житель' })[r] ?? r;
}

// ═══════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════

function addChat(from, text, tag) {
  const box = $('#chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (tag === 'mafia' ? 'mafia-msg' : tag === 'system' ? 'system-msg' : '');
  if (tag === 'system') {
    div.innerHTML = `<span class="chat-name sys-name">⚙️</span> ${esc(text)}`;
  } else {
    const tag2 = tag === 'mafia' ? ' <span class="mafia-label">[Мафия]</span>' : '';
    div.innerHTML = `<span class="chat-name">${esc(from)}${tag2}:</span> ${esc(text)}`;
  }
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

// ═══════════════════════════════════════════════════════
//  GAME MIC / CAM CONTROLS
// ═══════════════════════════════════════════════════════

let gameMicMuted = false;
let gameCamOff   = false;

$('#btn-game-mic').addEventListener('click', () => {
  if (!localStream) return;
  gameMicMuted = !gameMicMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !gameMicMuted; });
  const btn = $('#btn-game-mic');
  btn.textContent = gameMicMuted ? '🔇' : '🎤';
  btn.classList.toggle('btn-topbar-muted', gameMicMuted);
  btn.title = gameMicMuted ? 'Включить микрофон' : 'Выключить микрофон';
});

$('#btn-game-cam').addEventListener('click', () => {
  if (!localStream) return;
  gameCamOff = !gameCamOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !gameCamOff; });
  const btn  = $('#btn-game-cam');
  btn.textContent = gameCamOff ? '🚫' : '📷';
  btn.classList.toggle('btn-topbar-muted', gameCamOff);
  btn.title = gameCamOff ? 'Включить камеру' : 'Выключить камеру';
  // Update own tile: show/hide avatar
  const myTile = document.getElementById(`tile-${socket.id}`);
  if (myTile) {
    const vid    = myTile.querySelector('video');
    const avatar = myTile.querySelector('.no-video-avatar');
    if (gameCamOff) { vid.style.display = 'none';  avatar.classList.remove('hidden'); }
    else            { vid.style.display = 'block'; avatar.classList.add('hidden'); }
  }
});

// ═══════════════════════════════════════════════════════
//  BACK TO LOBBY
// ═══════════════════════════════════════════════════════

$('#btn-back-lobby').addEventListener('click', () => {
  if (roomState) socket.emit('room:join', roomState.roomId, myName);
});
