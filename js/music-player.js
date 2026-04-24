/**
 * MusicPlayer — Web Audio API-backed player with full gesture control support.
 */
export class MusicPlayer extends EventTarget {
  #audio = new Audio();
  #audioCtx = null;
  #analyser = null;
  #gainNode = null;

  #songs = [];
  #currentIndex = -1;
  #volume = 0.8;
  #speed = 1.0;
  #isPlaying = false;
  #isShuffle = false;
  #liked = new Set();

  // track last known duration for external queries
  #duration = 0;
  #currentTime = 0;

  constructor() {
    super();
    this.#audio.volume = this.#volume;
    this.#audio.crossOrigin = 'anonymous';

    this.#audio.addEventListener('ended', () => this.skip());
    this.#audio.addEventListener('timeupdate', () => {
      this.#currentTime = this.#audio.currentTime;
      this.#duration = isFinite(this.#audio.duration) ? this.#audio.duration : 0;
      this.#emit('timeupdate', { current: this.#currentTime, duration: this.#duration });
    });
    this.#audio.addEventListener('loadedmetadata', () => {
      this.#duration = isFinite(this.#audio.duration) ? this.#audio.duration : 0;
      this.#emit('metadataLoaded', { duration: this.#duration });
    });
    this.#audio.addEventListener('error', (e) => {
      console.error('Audio error', e);
      this.#isPlaying = false;
      this.#emit('stateChanged');
    });
  }

  // ── Getters ────────────────────────────────────────────────
  get analyser()      { return this.#analyser; }
  get isPlaying()     { return this.#isPlaying; }
  get isShuffle()     { return this.#isShuffle; }
  get volume()        { return this.#volume; }
  get speed()         { return this.#speed; }
  get currentSong()   { return this.#songs[this.#currentIndex] ?? null; }
  get currentIndex()  { return this.#currentIndex; }
  get songs()         { return [...this.#songs]; }
  get liked()         { return new Set(this.#liked); }
  get currentTime()   { return this.#currentTime; }
  get duration()      { return this.#duration; }

  // ── Web Audio Context (lazy, requires user gesture) ───────
  #ensureCtx() {
    if (!this.#audioCtx) {
      this.#audioCtx = new AudioContext();
      this.#analyser = this.#audioCtx.createAnalyser();
      this.#analyser.fftSize = 512;
      this.#gainNode = this.#audioCtx.createGain();
      this.#gainNode.gain.value = 1;

      const src = this.#audioCtx.createMediaElementSource(this.#audio);
      src.connect(this.#gainNode);
      this.#gainNode.connect(this.#analyser);
      this.#analyser.connect(this.#audioCtx.destination);
    }
    if (this.#audioCtx.state === 'suspended') this.#audioCtx.resume();
  }

  // ── Library ────────────────────────────────────────────────
  addFiles(fileList) {
    for (const file of fileList) {
      if (!file.type.startsWith('audio/')) continue;
      const url = URL.createObjectURL(file);
      const name = file.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
      this.#songs.push({ name, artist: 'Local File', url, file });
    }
    this.#emit('libraryChanged');
  }

  addBuiltIn(list) {
    this.#songs.push(...list);
    this.#emit('libraryChanged');
  }

  // ── Playback ───────────────────────────────────────────────
  play(index) {
    this.#ensureCtx();
    if (index !== undefined && index !== this.#currentIndex) {
      this.#currentIndex = index;
      const song = this.#songs[index];
      if (!song) return;
      this.#audio.src = song.url;
      this.#audio.load();
    }
    if (this.#currentIndex < 0) return;

    this.#audio.playbackRate = this.#speed;
    this.#audio.volume = this.#volume;
    this.#audio.play().then(() => {
      this.#isPlaying = true;
      this.#emit('stateChanged');
    }).catch(err => console.warn('Play prevented:', err));
  }

  pause() {
    this.#audio.pause();
    this.#isPlaying = false;
    this.#emit('stateChanged');
  }

  stop() {
    this.#audio.pause();
    this.#audio.currentTime = 0;
    this.#isPlaying = false;
    this.#emit('stateChanged');
  }

  playRandom() {
    if (this.#songs.length <= 1) { this.play(0); return; }
    let idx;
    do { idx = Math.floor(Math.random() * this.#songs.length); }
    while (idx === this.#currentIndex);
    this.play(idx);
  }

  togglePlay() {
    if (this.#isPlaying) {
      this.pause();
    } else if (this.#currentIndex >= 0) {
      this.play();
    } else if (this.#songs.length > 0) {
      this.play(0);
    }
  }

  skip() {
    if (!this.#songs.length) return;
    const next = this.#isShuffle
      ? Math.floor(Math.random() * this.#songs.length)
      : (this.#currentIndex + 1) % this.#songs.length;
    this.play(next);
  }

  rewind() {
    if (!this.#songs.length) return;
    if (this.#audio.currentTime > 3) {
      this.#audio.currentTime = 0;
    } else {
      const prev = this.#isShuffle
        ? Math.floor(Math.random() * this.#songs.length)
        : (this.#currentIndex - 1 + this.#songs.length) % this.#songs.length;
      this.play(prev);
    }
  }

  // ── Volume ─────────────────────────────────────────────────
  setVolume(v) {
    this.#volume = Math.max(0, Math.min(1, v));
    this.#audio.volume = this.#volume;
    this.#emit('volumeChanged');
  }

  nudgeVolume(delta) { this.setVolume(this.#volume + delta); }

  // ── Speed ──────────────────────────────────────────────────
  setSpeed(s) {
    this.#speed = Math.max(0.25, Math.min(3, +s.toFixed(2)));
    this.#audio.playbackRate = this.#speed;
    this.#emit('speedChanged');
  }

  nudgeSpeed(delta) { this.setSpeed(this.#speed + delta); }

  // ── Seek ───────────────────────────────────────────────────
  seekBy(seconds) {
    if (!isFinite(this.#audio.duration)) return;
    this.#audio.currentTime = Math.max(0, Math.min(this.#audio.duration, this.#audio.currentTime + seconds));
  }

  seekTo(fraction) {
    if (!isFinite(this.#audio.duration)) return;
    this.#audio.currentTime = fraction * this.#audio.duration;
  }

  // ── Shuffle / Like ─────────────────────────────────────────
  toggleShuffle() {
    this.#isShuffle = !this.#isShuffle;
    this.#emit('shuffleChanged');
  }

  toggleLike() {
    if (this.#currentIndex < 0) return;
    if (this.#liked.has(this.#currentIndex)) {
      this.#liked.delete(this.#currentIndex);
    } else {
      this.#liked.add(this.#currentIndex);
    }
    this.#emit('likedChanged');
  }

  isLiked(index) { return this.#liked.has(index); }

  // ── Internal ───────────────────────────────────────────────
  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
