/**
 * app.js — Main orchestration: wires GestureController → MusicPlayer → UI
 */

import { GestureController } from './gesture-controller.js';
import { MusicPlayer }       from './music-player.js';

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const statusDot     = document.querySelector('.status-dot');
const statusText    = $('statusText');
const webcamEl      = $('webcam');
const gestureCanvas = $('gestureCanvas');

const turntable     = $('turntable');
const discTitle     = $('discTitle');
const discSub       = $('discSub');
const trackName     = $('trackName');
const trackArtist   = $('trackArtist');
const shuffleBadge  = $('shuffleBadge');
const likedBadge    = $('likedBadge');
const speedValue    = $('speedValue');
const shuffleValue  = $('shuffleValue');

const currentTimeEl = $('currentTime');
const totalTimeEl   = $('totalTime');
const timelineFill  = $('timelineFill');
const timelineDot   = $('timelineDot');
const timelineBar   = $('timelineBar');

const volFill       = $('volFill');
const volNum        = $('volNum');

const btnPlay       = $('btnPlay');
const btnStop       = $('btnStop');
const btnSkip       = $('btnSkip');
const btnRewind     = $('btnRewind');
const btnSeekFwd    = $('btnSeekFwd');
const btnSeekBack   = $('btnSeekBack');

const songListEl    = $('songList');
const likedListEl   = $('likedList');
const addSongBtn    = $('addSongBtn');
const songFileInput = $('songFileInput');
const searchInput   = $('searchInput');
const dropZone      = $('dropZone');

const toastGesture  = $('toastGesture');
const toastAction   = $('toastAction');
const toastHand     = $('toastHand');
const lhGesture     = $('lhGesture');
const rhGesture     = $('rhGesture');

const visualizer    = $('visualizer');
const vizCtx        = visualizer.getContext('2d');

// ── Built-in songs from /audio folder ────────────────────────────────────────
const BUILT_IN_SONGS = [
  { name: 'Between The Bars', artist: 'Elliott Smith',  url: 'audios/Between The Bars.mp3' },
  { name: 'Fallen Down',      artist: 'Toby Fox',       url: 'audios/Fallen Down.mp3' },
  { name: 'High and Dry',     artist: 'Radiohead',      url: 'audios/Radiohead - High and Dry.mp3' },
];

// ── App state ────────────────────────────────────────────────────────────────
const player = new MusicPlayer();
let gestureCtrl = null;
let toastTimer  = null;
let searchQuery = '';

// ── Startup ──────────────────────────────────────────────────────────────────
async function init() {
  setStatus('Loading gesture model…', 'loading');

  // Preload built-in songs
  player.addBuiltIn(BUILT_IN_SONGS);

  // Wire player events
  player.addEventListener('stateChanged',   onStateChanged);
  player.addEventListener('volumeChanged',  onVolumeChanged);
  player.addEventListener('speedChanged',   onSpeedChanged);
  player.addEventListener('shuffleChanged', onShuffleChanged);
  player.addEventListener('likedChanged',   onLikedChanged);
  player.addEventListener('libraryChanged', renderSongList);
  player.addEventListener('timeupdate',     onTimeUpdate);

  // Button fallbacks
  btnPlay.addEventListener('click',     () => player.togglePlay());
  btnStop.addEventListener('click',     () => player.stop());
  btnSkip.addEventListener('click',     () => player.skip());
  btnRewind.addEventListener('click',   () => player.rewind());
  btnSeekFwd.addEventListener('click',  () => player.seekBy(15));
  btnSeekBack.addEventListener('click', () => player.seekBy(-15));

  // Timeline seek
  timelineBar.addEventListener('click', e => {
    const rect = timelineBar.getBoundingClientRect();
    player.seekTo((e.clientX - rect.left) / rect.width);
  });

  // File upload
  addSongBtn.addEventListener('click', () => songFileInput.click());
  songFileInput.addEventListener('change', e => {
    if (e.target.files.length) player.addFiles(e.target.files);
    songFileInput.value = '';
  });

  // Search
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.toLowerCase();
    renderSongList();
  });

  // Drag and drop
  setupDrop();

  // Initial UI state
  onVolumeChanged();
  onSpeedChanged();
  onShuffleChanged();
  renderSongList();
  requestAnimationFrame(drawVisualizer);

  // MediaPipe
  try {
    gestureCtrl = new GestureController(webcamEl, gestureCanvas);
    await gestureCtrl.initialize();
    setStatus('Starting camera…', 'loading');
    await gestureCtrl.startCamera();
    setStatus('Ready — show a gesture!', 'ready');
    gestureCtrl.addEventListener('gesture',     onGesture);
    gestureCtrl.addEventListener('frameUpdate', onFrameUpdate);
  } catch (err) {
    console.error(err);
    setStatus('Gesture error: ' + err.message, 'error');
  }
}

// ── Gesture handler ───────────────────────────────────────────────────────────
function onGesture({ detail: { action, gesture, handedness } }) {
  showToast(gesture, action, handedness);
  showFlash(ACTION_LABELS[action] ?? action.toUpperCase());

  switch (action) {
    case 'play':          player.togglePlay();    break;
    case 'stop':          player.stop();           break;
    case 'skip':          player.skip();           break;
    case 'rewind':        player.rewind();         break;
    case 'speed_up':      player.nudgeSpeed( 0.25); break;
    case 'speed_down':    player.nudgeSpeed(-0.25); break;
    case 'volume_up':     player.nudgeVolume( 0.03); break;
    case 'volume_down':   player.nudgeVolume(-0.03); break;
    case 'shuffle':       player.playRandom();    break;
    case 'like':          player.toggleLike();    break;
    case 'seek_forward':  player.seekBy( 15);     break;
    case 'seek_backward': player.seekBy(-15);     break;
  }
}

// Live per-frame readout of all detected hands
function onFrameUpdate({ detail: { hands } }) {
  const map = { Left: null, Right: null };
  for (const { gesture, handedness } of hands) map[handedness] = gesture;
  lhGesture.textContent = GESTURE_LABELS[map.Left]  ?? map.Left  ?? '—';
  rhGesture.textContent = GESTURE_LABELS[map.Right] ?? map.Right ?? '—';
}

// ── Player event handlers ─────────────────────────────────────────────────────
function onStateChanged() {
  const playing = player.isPlaying;
  btnPlay.textContent = playing ? '⏸' : '▶';
  turntable.classList.toggle('spinning', playing);

  const song = player.currentSong;
  if (song) {
    trackName.textContent   = song.name;
    trackArtist.textContent = song.artist;
    discTitle.textContent   = song.name.toUpperCase().slice(0, 14);
    discSub.textContent     = song.artist.toUpperCase().slice(0, 12);
  } else {
    trackName.textContent   = 'No Track Selected';
    trackArtist.textContent = '—';
    discTitle.textContent   = 'SELECT';
    discSub.textContent     = 'A TRACK';
  }

  // Highlight active song in list
  document.querySelectorAll('.song-item').forEach((el, i) => {
    el.classList.toggle('active', i === player.currentIndex);
  });

  // Liked badge
  likedBadge.style.display = player.isLiked(player.currentIndex) ? '' : 'none';
}

function onVolumeChanged() {
  const pct = Math.round(player.volume * 100);
  volFill.style.width = pct + '%';
  volNum.textContent  = pct;

  // Clear previous boundary classes
  volFill.classList.remove('at-min', 'at-max');
  if (pct === 0)   { volFill.classList.add('at-min'); showFlash('MUTED'); }
  if (pct === 100) { volFill.classList.add('at-max'); showFlash('MAX VOL'); }
}

function onSpeedChanged() {
  speedValue.textContent = player.speed.toFixed(2) + '×';
}

function onShuffleChanged() {
  const on = player.isShuffle;
  shuffleValue.textContent = on ? 'ON' : 'OFF';
  shuffleValue.classList.toggle('on', on);
  shuffleBadge.textContent = 'SHUFFLE ' + (on ? 'ON' : 'OFF');
  shuffleBadge.classList.toggle('on', on);
}

function onLikedChanged() {
  renderLikedList();
  likedBadge.style.display = player.isLiked(player.currentIndex) ? '' : 'none';
}

function onTimeUpdate({ detail: { current, duration } }) {
  currentTimeEl.textContent = fmtTime(current);
  totalTimeEl.textContent   = fmtTime(duration);
  const pct = duration > 0 ? (current / duration) * 100 : 0;
  timelineFill.style.width = pct + '%';
  timelineDot.style.left   = pct + '%';
}

// ── Song list rendering ───────────────────────────────────────────────────────
function renderSongList() {
  const songs = player.songs;
  const filtered = songs.filter(s =>
    !searchQuery ||
    s.name.toLowerCase().includes(searchQuery) ||
    s.artist.toLowerCase().includes(searchQuery)
  );

  if (!songs.length) {
    songListEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">♪</div>
        <div>Drop songs here or click <strong>＋</strong></div>
        <div class="empty-sub">Supports MP3, WAV, OGG, FLAC</div>
      </div>`;
    return;
  }

  if (!filtered.length) {
    songListEl.innerHTML = `<div class="empty-state"><div class="empty-sub">No tracks match "${escHtml(searchQuery)}"</div></div>`;
    return;
  }

  songListEl.innerHTML = '';
  filtered.forEach((song, filtIdx) => {
    // Map back to original index for play()
    const origIdx = songs.indexOf(song);
    const el = document.createElement('div');
    el.className = 'song-item' + (origIdx === player.currentIndex ? ' active' : '');
    el.innerHTML = `
      <span class="song-index">${origIdx + 1}</span>
      <div class="song-info">
        <div class="song-title">${escHtml(song.name)}</div>
        <div class="song-artist">${escHtml(song.artist)}</div>
      </div>
    `;
    el.addEventListener('click', () => player.play(origIdx));
    songListEl.appendChild(el);
  });
}

function renderLikedList() {
  const liked = player.liked;
  if (!liked.size) {
    likedListEl.innerHTML = '<div class="empty-sub" style="padding:8px 12px">No liked songs yet</div>';
    return;
  }
  likedListEl.innerHTML = '';
  liked.forEach(idx => {
    const song = player.songs[idx];
    if (!song) return;
    const el = document.createElement('div');
    el.className = 'liked-item';
    el.textContent = song.name;
    el.addEventListener('click', () => player.play(idx));
    likedListEl.appendChild(el);
  });
}

// ── Toast + flash ─────────────────────────────────────────────────────────────
function showToast(gesture, action, handedness) {
  toastGesture.textContent = GESTURE_LABELS[gesture] ?? gesture;
  toastAction.textContent  = ACTION_LABELS[action]   ?? action.toUpperCase();
  toastHand.textContent    = handedness ? `${handedness} Hand` : '';
  toastAction.classList.remove('flash');
  void toastAction.offsetWidth; // reflow
  toastAction.classList.add('flash');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastAction.classList.remove('flash');
    toastGesture.textContent = '—';
    toastAction.textContent  = '';
    toastHand.textContent    = '';
  }, 1600);
}

let flashEl = null;
function showFlash(text) {
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.className = 'action-flash';
    document.body.appendChild(flashEl);
  }
  flashEl.textContent = text;
  flashEl.classList.remove('show');
  void flashEl.offsetWidth;
  flashEl.classList.add('show');
}

// ── Visualizer ────────────────────────────────────────────────────────────────
function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);

  visualizer.width  = visualizer.offsetWidth  || 600;
  visualizer.height = visualizer.offsetHeight || 72;
  const W = visualizer.width;
  const H = visualizer.height;

  vizCtx.clearRect(0, 0, W, H);

  const analyser = player.analyser;
  if (!analyser) {
    drawIdleWave(W, H);
    return;
  }

  const bufLen  = analyser.frequencyBinCount;
  const data    = new Uint8Array(bufLen);
  analyser.getByteFrequencyData(data);

  const step  = Math.ceil(bufLen / 80);
  const barW  = Math.ceil(W / (bufLen / step)) - 1;
  let x = 0;

  for (let i = 0; i < bufLen; i += step) {
    const mag = data[i] / 255;
    const bh  = mag * H;
    const hue = 185 + (i / bufLen) * 100; // cyan → purple
    const lit = 45 + mag * 20;
    vizCtx.fillStyle = `hsl(${hue},100%,${lit}%)`;
    vizCtx.fillRect(x, H - bh, barW, bh);
    x += barW + 1;
  }
}

function drawIdleWave(W, H) {
  const bars = 60;
  const bw   = W / bars;
  const t    = Date.now() / 800;
  for (let i = 0; i < bars; i++) {
    const mag = (Math.sin(t + i * 0.35) * 0.5 + 0.5) * 0.28 + 0.04;
    const bh  = mag * H;
    const hue = 185 + (i / bars) * 100;
    vizCtx.fillStyle = `hsl(${hue},100%,38%)`;
    vizCtx.fillRect(i * bw, H - bh, bw - 1, bh);
  }
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────
function setupDrop() {
  const targets = [dropZone, document.body];

  targets.forEach(t => {
    t.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    t.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    t.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('audios/'));
      if (files.length) player.addFiles(files);
    });
  });

  dropZone.addEventListener('click', () => songFileInput.click());
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(msg, state) {
  statusText.textContent = msg;
  statusDot.className    = 'status-dot ' + (state ?? '');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Label maps ────────────────────────────────────────────────────────────────
const GESTURE_LABELS = {
  Open_Palm:    '✋ Open Palm',
  OK:           '👌 OK',
  Pointing_Up:  '☝️ Point Up',
  Pointing_Down:'👇 Point Down',
  Thumb_Right:  '👍→ Thumb Right',
  Thumb_Left:   '←👍 Thumb Left',
  Victory:      '✌️ Victory',
  ILoveYou:     '🤟 I Love You',
  Closed_Fist:  '✊ Fist',
};

const ACTION_LABELS = {
  play:          'PLAY / PAUSE',
  stop:          'STOP',
  skip:          'SKIP →',
  rewind:        '← REWIND',
  speed_up:      'SPEED UP ↑',
  speed_down:    'SPEED DOWN ↓',
  volume_up:     'VOL + ▲',
  volume_down:   'VOL - ▼',
  shuffle:       'RANDOM SONG',
  like:          '♥ LIKED!',
  seek_forward:  '+15 SEC',
  seek_backward: '-15 SEC',
};

// ── Go ────────────────────────────────────────────────────────────────────────
init();
