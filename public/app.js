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
const iceBuffer   = new Map();   // peerId → RTCIceCandidateInit[] (buffered before remoteDesc)

// ────────────────────── helpers ──────────────────────
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// Cleanup on page close
window.addEventListener('beforeunload', () => {
  for (const [, pc] of peers) {
    pc.close();
  }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

function showScreen(name) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
  // Move the shared video grid into the correct slot
  const grid = document.getElementById('video-grid');
  if (name === 'lobby') {
    const slot = document.getElementById('lobby-grid-slot');
    if (slot && grid) slot.appendChild(grid);
  } else if (name === 'game') {
    const slot = document.getElementById('game-grid-slot');
    if (slot && grid) slot.appendChild(grid);
  }
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

    // Add tracks to any PCs that were created before localStream was ready
    // Wait a bit to ensure PCs are in stable state
    await new Promise(r => setTimeout(r, 200));
    
    for (const [peerId, pc] of peers) {
      if (pc.connectionState === 'closed') continue;
      const senders = pc.getSenders();
      let added = false;
      localStream.getTracks().forEach(t => {
        if (!senders.find(s => s.track === t)) {
          pc.addTrack(t, localStream);
          added = true;
        }
      });
      // Renegotiate if we added tracks
      if (added && socket.id < peerId) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('rtc:offer', peerId, { type: offer.type, sdp: offer.sdp });
        } catch (err) {
          console.error('Renegotiation failed:', err);
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
//  JOIN SCREEN
// ═══════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', async () => {
  const p = new URLSearchParams(location.search).get('room');
  if (p) $('#inp-room').value = p.toUpperCase();
  ['#inp-name','#inp-room'].forEach(s =>
    $(s).addEventListener('keyup', e => { if (e.key === 'Enter') $('#btn-join').click(); })
  );

  // Auto-rejoin if we were in a room before refresh
  const savedRoom = localStorage.getItem('mafia-room');
  const savedName = localStorage.getItem('mafia-name');
  if (savedRoom && savedName) {
    myName = savedName;
    // Start media first
    await startLocalMedia();
    // Then rejoin
    socket.emit('room:join', savedRoom, savedName);
    console.log('Auto-rejoining room:', savedRoom);
  }
});

$('#btn-join').addEventListener('click', async () => {
  const name   = $('#inp-name').value.trim();
  let   roomId = $('#inp-room').value.trim().toUpperCase();
  if (!name) { showErr('join-error', 'Введите ваше имя.'); return; }
  if (!roomId) roomId = Math.random().toString(36).slice(2, 7).toUpperCase();

  myName = name;
  
  // Save to localStorage for auto-rejoin on refresh
  localStorage.setItem('mafia-room', roomId);
  localStorage.setItem('mafia-name', name);
  
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

$('#btn-leave-lobby').addEventListener('click', () => {
  // Clear saved room data
  localStorage.removeItem('mafia-room');
  localStorage.removeItem('mafia-name');
  // Disconnect and reload to join screen
  location.reload();
});

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

socket.on('connect', () => { 
  myId = socket.id;
  console.log('Connected:', socket.id);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
});

socket.on('reconnect', () => {
  console.log('Reconnected to server');
  // All peer connections are likely stale, close them
  for (const [peerId, pc] of peers) {
    pc.close();
  }
  peers.clear();
  iceBuffer.clear();
  
  // Auto-rejoin room if we were in one
  const savedRoom = localStorage.getItem('mafia-room');
  const savedName = localStorage.getItem('mafia-name');
  if (savedRoom && savedName && myName) {
    socket.emit('room:join', savedRoom, savedName);
    console.log('Re-joining room after reconnect:', savedRoom);
  }
});

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
  
  // Remove tiles and close connections for players no longer in the room
  const knownIds = new Set(state.players.map(p => p.id));
  $$('.video-tile').forEach(tile => {
    const id = tile.id.replace('tile-', '');
    if (id && !knownIds.has(id)) {
      tile.remove();
      // Clean up peer connection if it exists
      if (peers.has(id)) {
        peers.get(id)?.close();
        peers.delete(id);
        iceBuffer.delete(id);
        peerNames.delete(id);
      }
    }
  });
  
  // Sort all tiles in DOM by joinIndex
  sortTilesByJoinIndex();

  if (state.phase === 'lobby' || state.phase === 'gameover') {
    if (state.phase === 'lobby') {
      showScreen('lobby');
      renderLobby(state);
      ensureMyTile();
      sortTilesByJoinIndex();
      // wire lobby cam preview (own small preview in right column)
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
  // Auto-mute everyone except current speaker
  if (speakerId !== socket.id) {
    autoMicMuted = true;
    applyMicState();
  }
});

socket.on('speaking:your-turn', (timerEndsAt) => {
  isMyTurn = true;
  autoMicMuted = false;
  applyMicState();
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
  autoMicMuted = false;
  applyMicState();
  startTimerCountdown(timerEndsAt);
});

// ── Night ─────────────────────────────────────────────
socket.on('night:start', (timerEndsAt) => {
  autoMicMuted = false;
  applyMicState();
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
  const verdict  = isMafia ? 'МАФИЯ 🔴' : 'Мирный житель 🟢';
  const guessed  = isMafia ? '✅ Угадал! Это мафия!' : '❌ Не угадал — мирный житель';
  addChat('🔎 Детектив', `${guessed} (${targetName} — ${verdict})`, 'system');

  // Show prominent popup
  const popup = $('#detective-popup');
  const inner = popup.querySelector('.detective-popup-inner');
  $('#detective-popup-text').textContent = `${targetName} — ${verdict}`;
  inner.classList.remove('mafia-yes', 'mafia-no');
  inner.classList.add(isMafia ? 'mafia-yes' : 'mafia-no');
  popup.classList.remove('hidden');
  clearTimeout(window._detectivePopupTimer);
  window._detectivePopupTimer = setTimeout(() => popup.classList.add('hidden'), 7000);
  $('#detective-popup-close').onclick = () => popup.classList.add('hidden');
});

// ── Voting ────────────────────────────────────────────
socket.on('voting:start',  (t) => { autoMicMuted = false; applyMicState(); startTimerCountdown(t); });
socket.on('voting:update', (votes, voterMap) => {
  if (roomState) roomState.dayVotes = votes;
  updateVoteCounts(votes, voterMap ?? {});
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
  // Only the peer with the lower ID initiates the call to avoid duplicate connections
  if (socket.id && socket.id < peerId) {
    // Small delay to ensure both sides are ready
    await new Promise(r => setTimeout(r, 100));
    if (!peers.has(peerId)) await callPeer(peerId);
  }
});

socket.on('rtc:peer-left', (peerId) => {
  closePeer(peerId);
  peerNames.delete(peerId);
});

socket.on('rtc:offer', async (fromId, offer) => {
  try {
    const existingPC = peers.get(fromId);
    // Handle glare: if both peers send offer simultaneously, lower ID wins
    if (existingPC && existingPC.signalingState !== 'stable') {
      if (socket.id < fromId) {
        // We are polite peer, accept the incoming offer
        await existingPC.setRemoteDescription(new RTCSessionDescription(offer));
      } else {
        // Ignore incoming offer, our offer takes precedence
        return;
      }
    } else {
      const pc = createPC(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
    }
    await flushIceBuffer(fromId);
    const pc = peers.get(fromId);
    if (!pc) return;
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('rtc:answer', fromId, { type: answer.type, sdp: answer.sdp });
  } catch (err) {
    console.error('rtc:offer error:', err);
  }
});

socket.on('rtc:answer', async (fromId, answer) => {
  try {
    const pc = peers.get(fromId);
    if (!pc) return;
    if (pc.signalingState !== 'have-local-offer') {
      console.warn('Received answer in wrong state:', pc.signalingState);
      return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    await flushIceBuffer(fromId);
  } catch (err) {
    console.error('rtc:answer error:', err);
  }
});

socket.on('rtc:ice', async (fromId, candidate) => {
  const pc = peers.get(fromId);
  if (!pc || !pc.remoteDescription) {
    // buffer until remote description is set
    const buf = iceBuffer.get(fromId) ?? [];
    buf.push(candidate);
    iceBuffer.set(fromId, buf);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    // Ignore errors for stale candidates
    if (err.name !== 'OperationError') console.error('ICE error:', err);
  }
});

// ═══════════════════════════════════════════════════════
//  WEBRTC HELPERS
// ═══════════════════════════════════════════════════════

async function flushIceBuffer(peerId) {
  const pc   = peers.get(peerId);
  const bufs = iceBuffer.get(peerId);
  if (!pc || !bufs || bufs.length === 0) return;
  iceBuffer.delete(peerId);
  for (const c of bufs) {
    try {
      if (pc.connectionState !== 'closed') {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      }
    } catch (err) {
      // Ignore errors for stale candidates
      if (err.name !== 'OperationError') console.error('ICE buffer flush error:', err);
    }
  }
}

function createPC(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);
  const pc = new RTCPeerConnection(STUN);
  peers.set(peerId, pc);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  
  pc.ontrack = (e) => {
    if (e.streams[0]) {
      const tile = document.getElementById(`tile-${peerId}`);
      const vid = tile?.querySelector('video');
      // Only update if stream changed or not set
      if (vid && vid.srcObject !== e.streams[0]) {
        setTileStream(peerId, e.streams[0]);
      }
    }
  };
  
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('rtc:ice', peerId, e.candidate.toJSON());
  };
  
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      console.log('ICE failed for', peerId, '- restarting...');
      pc.restartIce();
    }
  };
  
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      const wasConnected = pc.connectionState === 'disconnected';
      pc.close();
      peers.delete(peerId);
      iceBuffer.delete(peerId);
      // retry call if we are the designated initiator, and connection existed
      if (socket.id && socket.id < peerId) {
        const delay = wasConnected ? 2000 : 3000;
        setTimeout(() => {
          // Only retry if peer still exists and we don't have an active connection
          if (peerNames.has(peerId) && !peers.has(peerId)) {
            callPeer(peerId).catch(() => {});
          }
        }, delay);
      }
    }
  };
  return pc;
}

async function callPeer(peerId) {
  // Don't create duplicate connections
  if (peers.has(peerId)) return;
  const pc = createPC(peerId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc:offer', peerId, { type: offer.type, sdp: offer.sdp });
  } catch (err) {
    console.error('callPeer failed:', err);
    peers.delete(peerId);
    iceBuffer.delete(peerId);
  }
}

function closePeer(peerId) {
  peers.get(peerId)?.close();
  peers.delete(peerId);
  iceBuffer.delete(peerId);
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

  // Build reverse map: targetId → [voterName, ...]
  const voterMap  = state._voterMap || {};
  const votersByTarget = {};
  for (const [voterId, targetId] of Object.entries(voterMap)) {
    const vname = state.players.find(p => p.id === voterId)?.name ?? voterId;
    (votersByTarget[targetId] = votersByTarget[targetId] || []).push(vname);
  }
  const myVoteTarget = voterMap[socket.id] ?? null;

  const alive = state.players.filter(p => p.alive && p.id !== socket.id);
  for (const p of alive) {
    const wrap = document.createElement('div');
    wrap.className = 'vote-candidate';
    wrap.id        = `vote-wrap-${p.id}`;

    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.id        = `vote-btn-${p.id}`;
    btn.dataset.id= p.id;
    const vcount  = state.dayVotes?.[p.id] ?? 0;
    btn.textContent = `${p.name} (${vcount} 🗳)`;
    if (myVoteTarget === p.id) btn.classList.add('selected');
    if (!me?.alive) { btn.disabled = true; btn.classList.add('dead'); }
    btn.addEventListener('click', () => {
      if (myVoteTarget === p.id) {
        // cancel vote
        socket.emit('day:unvote');
        btn.classList.remove('selected');
      } else {
        $$('#voting-targets .target-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        socket.emit('day:vote', p.id);
      }
    });
    wrap.appendChild(btn);

    // Voter names list
    const vnames = document.createElement('div');
    vnames.className = 'voter-names';
    vnames.id        = `voter-names-${p.id}`;
    const voters = votersByTarget[p.id] || [];
    vnames.textContent = voters.length ? `↑ ${voters.join(', ')}` : '';
    wrap.appendChild(vnames);
    targets.appendChild(wrap);
  }
}

function updateVoteCounts(votes, voterMap) {
  // Build reverse map: targetId → [voterName, ...]
  const votersByTarget = {};
  if (voterMap && roomState) {
    for (const [voterId, targetId] of Object.entries(voterMap)) {
      const vname = roomState.players.find(p => p.id === voterId)?.name ?? voterId;
      (votersByTarget[targetId] = votersByTarget[targetId] || []).push(vname);
    }
    roomState._voterMap = voterMap;
  }
  const myVoteTarget = (voterMap && voterMap[socket.id]) ?? null;

  for (const [id, count] of Object.entries(votes)) {
    const btn  = document.getElementById(`vote-btn-${id}`);
    if (!btn) continue;
    const name = roomState?.players.find(p => p.id === id)?.name ?? id;
    btn.textContent = `${name} (${count} 🗳)`;
    btn.classList.toggle('selected', myVoteTarget === id);
    const vnEl = document.getElementById(`voter-names-${id}`);
    if (vnEl) {
      const voters = votersByTarget[id] || [];
      vnEl.textContent = voters.length ? `↑ ${voters.join(', ')}` : '';
    }
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
let autoMicMuted = false;   // auto-muted when it's not your speaking turn
let gameCamOff   = false;

function applyMicState() {
  const muted = gameMicMuted || autoMicMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  const btn = $('#btn-game-mic');
  if (!btn) return;
  btn.textContent = muted ? '🔇' : '🎤';
  btn.classList.toggle('btn-topbar-muted', muted);
  if (autoMicMuted && !gameMicMuted) {
    btn.title = 'Авто-выкл (нажмите чтобы включить)';
  } else {
    btn.title = muted ? 'Включить микрофон' : 'Выключить микрофон';
  }
}

$('#btn-game-mic').addEventListener('click', () => {
  if (!localStream) return;
  if (autoMicMuted && !gameMicMuted) {
    // override auto-mute: user explicitly wants to speak
    autoMicMuted = false;
  } else {
    gameMicMuted = !gameMicMuted;
  }
  applyMicState();
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
