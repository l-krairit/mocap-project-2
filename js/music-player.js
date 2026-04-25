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
  #metadataParserPromise = null;

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
      this.#songs.push({ name, artist: 'Local File', url, file, artwork: null });
      this.#loadArtworkForSong(this.#songs.length - 1);
    }
    this.#emit('libraryChanged');
  }

  addBuiltIn(list) {
    const start = this.#songs.length;
    this.#songs.push(...list.map(song => ({ ...song, artwork: song.artwork ?? null })));
    for (let i = start; i < this.#songs.length; i++) this.#loadArtworkForSong(i);
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
  async #loadArtworkForSong(index) {
    const song = this.#songs[index];
    if (!song || song._artworkRequested || song.artwork) return;

    song._artworkRequested = true;
    try {
      let blob;
      if (song.file) {
        blob = song.file;
      } else if (song.url) {
        const res = await fetch(song.url);
        if (!res.ok) return;
        blob = await res.blob();
      } else {
        return;
      }

      const cover = await this.#extractCoverObjectUrl(blob);
      if (!cover) return;

      song.artwork = cover;
      this.#emit('artworkLoaded', { index });
      if (index === this.#currentIndex) this.#emit('stateChanged');
    } catch {
      // Ignore metadata parsing issues; fallback text stays visible.
    }
  }

  async #extractCoverObjectUrl(blob) {
    const parser = await this.#getMetadataParser();
    if (parser?.parseBlob) {
      try {
        const meta = await parser.parseBlob(blob, { skipPostHeaders: true, duration: false });
        const pic = meta?.common?.picture?.[0];
        if (pic?.data?.length) {
          const mime = pic.format || 'image/jpeg';
          return URL.createObjectURL(new Blob([pic.data], { type: mime }));
        }
      } catch {
        // Fallback parser below handles some MP3s even if generic parser fails.
      }
    }

    const buffer = await blob.arrayBuffer();
    return this.#extractMp3CoverObjectUrl(buffer);
  }

  async #getMetadataParser() {
    if (!this.#metadataParserPromise) {
      this.#metadataParserPromise = import(
        'https://cdn.jsdelivr.net/npm/music-metadata-browser@2.5.10/+esm'
      ).catch(() => null);
    }
    return this.#metadataParserPromise;
  }

  #extractMp3CoverObjectUrl(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 10) return null;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null; // ID3

    const version = bytes[3];
    const tagSize = this.#readSynchsafeInt(bytes, 6);
    const end = Math.min(bytes.length, 10 + tagSize);
    let off = 10;

    while (off + 10 <= end) {
      const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;

      const frameSize = version === 4
        ? this.#readSynchsafeInt(bytes, off + 4)
        : (((bytes[off + 4] << 24) >>> 0) | (bytes[off + 5] << 16) | (bytes[off + 6] << 8) | bytes[off + 7]);
      if (frameSize <= 0) { off += 10; continue; }

      const dataStart = off + 10;
      const dataEnd = dataStart + frameSize;
      if (dataEnd > end) break;

      if (id === 'APIC') {
        const apic = bytes.subarray(dataStart, dataEnd);
        return this.#parseApicFrame(apic);
      }

      off = dataEnd;
    }

    return null;
  }

  #parseApicFrame(apic) {
    if (!apic || apic.length < 8) return null;

    const encoding = apic[0];
    let p = 1;

    const mimeEnd = this.#findNull(apic, p);
    if (mimeEnd < 0) return null;
    const mime = this.#decodeLatin1(apic.subarray(p, mimeEnd)) || 'image/jpeg';
    p = mimeEnd + 1;

    if (p >= apic.length) return null;
    p += 1; // picture type byte

    const descEnd = (encoding === 1 || encoding === 2)
      ? this.#findDoubleNull(apic, p)
      : this.#findNull(apic, p);
    if (descEnd < 0) return null;
    p = descEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);

    if (p >= apic.length) return null;
    const imageBytes = apic.subarray(p);
    const imageType = /^image\//i.test(mime) ? mime : 'image/jpeg';
    const blob = new Blob([imageBytes], { type: imageType });
    return URL.createObjectURL(blob);
  }

  #readSynchsafeInt(bytes, start) {
    if (start + 3 >= bytes.length) return 0;
    return ((bytes[start] & 0x7f) << 21)
      | ((bytes[start + 1] & 0x7f) << 14)
      | ((bytes[start + 2] & 0x7f) << 7)
      | (bytes[start + 3] & 0x7f);
  }

  #findNull(arr, start) {
    for (let i = start; i < arr.length; i++) {
      if (arr[i] === 0) return i;
    }
    return -1;
  }

  #findDoubleNull(arr, start) {
    for (let i = start; i < arr.length - 1; i++) {
      if (arr[i] === 0 && arr[i + 1] === 0) return i;
    }
    return -1;
  }

  #decodeLatin1(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
