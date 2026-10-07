/**
 * Redrawn Studio audio engine: Web Audio playback of the movie's SoundClips plus the master clock.
 *
 *   const audio = createAudioEngine(store);
 *   audio.play(fromMs?)  audio.pause()  audio.seek(ms)  audio.onTime((ms, playing) => ...)
 *
 * The engine is the single source of truth for time while playing. It mirrors the clock into the store
 * (`setPlayhead` every animation frame, `setPlaying` on transitions), so the stage can either subscribe to
 * the store or call `onTime`. It also follows the store: an external `setPlaying` / `setPlayhead`
 * (toolbar, keyboard, inspector...) starts, stops or seeks the audio.
 *
 * Clip fields used (see model.js): start/end (movie-absolute ms), volume, assetId. Optional extension:
 * `clip.offset` (ms into the source audio, written by the timeline when the clip's left edge is trimmed).
 * Flash (.swf) store sounds are unpacked by swf-audio.js (RC4 decrypt + embedded MP3/PCM extraction) and then
 * decoded like any other file. Only files that cannot be unpacked (unknown encryption key) end as "unsupported".
 *
 * Extras for the timeline UI: probe()/info() (duration + waveform peaks), onAssets(), setLoop(), setMuted(),
 * setMasterVolume(), resolveUrl(), time().
 */
import { movieDuration } from './model.js';
import { loadSwfAudio } from './swf-audio.js';

/** Waveform resolution: peak buckets per second of source audio. */
export const PEAK_RATE = 100;
const MAX_PROBES = 3;
const FADE = 0.008; // click-free clip edges, seconds

/**
 * @typedef {'loading'|'ready'|'error'|'unsupported'} AudioStatus
 * @typedef {Object} AudioInfo
 * @property {AudioStatus} status
 * @property {number} duration      ms of source audio (0 until known)
 * @property {Float32Array|null} peaks   0..1 max-abs per 1/PEAK_RATE s
 * @property {string} [error]
 */

/** Pure: can we try to load this asset? (Flash store sounds go through swf-audio.js.) */
export function isDecodable(assetId) {
  return !!assetId;
}

/** Pure: is this a Flash store sound? */
export function isSwfAsset(assetId) {
  return /\.swf$/i.test(assetId ?? '');
}

/** Pure: movie-absolute scene boundaries. [{id, start, end}] */
export function sceneOffsets(movie) {
  let t = 0;
  return movie.scenes.map((s) => {
    const o = { id: s.id, start: t, end: t + s.duration };
    t += s.duration;
    return o;
  });
}

/** Pure: reduce decoded channels to max-abs peaks at PEAK_RATE. */
export function computePeaks(channels, sampleRate) {
  const len = channels[0]?.length ?? 0;
  const bucket = Math.max(1, Math.floor(sampleRate / PEAK_RATE));
  const n = Math.max(1, Math.ceil(len / bucket));
  const peaks = new Float32Array(n);
  let top = 0;
  for (const ch of channels) {
    for (let b = 0; b < n; b++) {
      const a = b * bucket, e = Math.min(len, a + bucket);
      let m = peaks[b];
      for (let i = a; i < e; i++) { const v = ch[i] < 0 ? -ch[i] : ch[i]; if (v > m) m = v; }
      peaks[b] = m;
      if (m > top) top = m;
    }
  }
  if (top > 0) for (let b = 0; b < n; b++) peaks[b] /= top; // normalise so quiet voice clips still read
  return peaks;
}

/** Pure: signature of everything that affects scheduling (volume excluded). */
function layoutSig(sounds) {
  return sounds.map((c) => `${c.id}|${c.assetId}|${c.start}|${c.end}|${c.offset ?? 0}|${c.kind}`).join(';');
}

/**
 * @param {{get():any, subscribe(fn:Function):Function, dispatch(cmd:any):void}} store
 * @param {{ resolveUrl?: (assetId:string, movie:any)=>string|Promise<string>, fetch?: typeof fetch }} [opts]
 */
export function createAudioEngine(store, opts = {}) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const doFetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));

  /** @type {AudioContext|null} */ let ctx = null;
  /** @type {GainNode|null} */ let master = null;
  let masterVol = 1, muted = false, loop = false;
  let playing = false;
  let pos = 0;             // movie ms at clockBase
  let clockBase = 0;       // clock seconds when pos was taken
  let usingCtx = false;
  let raf = 0;
  let destroyed = false;
  let lastWritten = -1;    // last playhead we pushed into the store
  const timeCbs = new Set();
  const assetCbs = new Set();
  /** @type {Map<string, {src: AudioBufferSourceNode, gain: GainNode, clipId: string}>} */
  const live = new Map();
  /** @type {Map<string, {info: AudioInfo, buffer: AudioBuffer|null, promise: Promise<void>|null}>} */
  const cache = new Map();
  const queue = [];
  let active = 0;

  // ---------------------------------------------------------------- urls / probing
  let themesMod = null;
  const loadThemes = () => (themesMod ??= import('./themes.js').catch(() => ({})));

  async function resolveUrl(assetId) {
    const movie = store.get().movie;
    if (opts.resolveUrl) return opts.resolveUrl(assetId, movie);
    const m = /^ugc\.(.+)$/.exec(assetId);
    if (m) {
      const mid = movie.id || movie.meta?.presaveId || '';
      return `/assets/${encodeURIComponent(mid)}/${encodeURIComponent(m[1])}`;
    }
    const t = await loadThemes();
    if (typeof t.assetUrl === 'function') return t.assetUrl(assetId, movie.themeId, { kind: 'sound' });
    return `/assets/${encodeURIComponent(movie.id || '')}/${encodeURIComponent(assetId)}`;
  }

  const keyFor = (assetId) => {
    const m = store.get().movie;
    return /^ugc\./.test(assetId) ? `${m.id || m.meta?.presaveId || ''}:${assetId}` : assetId;
  };

  const emitAssets = () => assetCbs.forEach((cb) => { try { cb(); } catch (e) { console.error(e); } });

  function entryFor(assetId) {
    const key = keyFor(assetId);
    let e = cache.get(key);
    if (!e) {
      e = { info: { status: isDecodable(assetId) ? 'loading' : 'unsupported', duration: 0, peaks: null }, buffer: null, promise: null };
      cache.set(key, e);
    }
    return e;
  }

  async function decode(buf) {
    const Off = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    const dec = ctx ?? new Off(1, 1, 44100);
    return dec.decodeAudioData(buf);
  }

  async function runProbe(assetId, e) {
    try {
      const url = await resolveUrl(assetId);
      let ab;
      if (isSwfAsset(assetId)) {
        const a = await loadSwfAudio(url, doFetch);
        ab = a.bytes.buffer.slice(a.bytes.byteOffset, a.bytes.byteOffset + a.bytes.byteLength);
      } else {
        const res = await doFetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ab = await res.arrayBuffer();
      }
      const buffer = await decode(ab);
      e.buffer = buffer;
      const chans = [];
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
      e.info = { status: 'ready', duration: Math.round(buffer.duration * 1000), peaks: computePeaks(chans, buffer.sampleRate) };
    } catch (err) {
      e.info = {
        status: err?.unsupported ? 'unsupported' : 'error', duration: 0, peaks: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function pump() {
    while (active < MAX_PROBES && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => { active--; pump(); });
    }
  }

  /** Start (or join) loading an asset. Resolves when decoded (never rejects). */
  function probe(assetId) {
    const e = entryFor(assetId);
    if (e.info.status === 'unsupported' || e.info.status === 'ready') return Promise.resolve(e.info);
    if (!e.promise) {
      e.promise = new Promise((resolve) => {
        queue.push(async () => {
          await runProbe(assetId, e);
          e.promise = null;
          emitAssets();
          if (playing && !destroyed) reschedule();
          resolve(e.info);
        });
        pump();
      });
    }
    return e.promise.then(() => e.info);
  }

  /** Retry a failed asset (e.g. after the movie got its id). */
  function retry(assetId) {
    const e = entryFor(assetId);
    if (e.info.status === 'error') { e.info = { status: 'loading', duration: 0, peaks: null }; emitAssets(); }
    return probe(assetId);
  }

  const info = (assetId) => entryFor(assetId).info;

  function probeAll() {
    for (const c of store.get().movie.sounds) {
      const e = entryFor(c.assetId);
      if (e.info.status === 'loading' && !e.promise) probe(c.assetId);
    }
  }

  // ---------------------------------------------------------------- clock
  function ensureCtx() {
    if (ctx || !AC) return ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = muted ? 0 : masterVol;
      master.connect(ctx.destination);
    } catch { ctx = null; }
    return ctx;
  }

  const clockNow = () => (usingCtx && ctx ? ctx.currentTime : performance.now() / 1000);

  /** Current movie time in ms. */
  function time() {
    if (!playing) return pos;
    return Math.max(pos, Math.min(endMs(), pos + (clockNow() - clockBase) * 1000));
  }

  const endMs = () => movieDuration(store.get().movie);

  function rebase(ms) {
    usingCtx = !!ctx && ctx.state === 'running';
    pos = ms;
    clockBase = clockNow();
  }

  // ---------------------------------------------------------------- scheduling
  function stopAll() {
    for (const { src, gain } of live.values()) {
      try { gain.gain.cancelScheduledValues(0); src.onended = null; src.stop(); } catch { /* already stopped */ }
      try { src.disconnect(); gain.disconnect(); } catch { /* noop */ }
    }
    live.clear();
  }

  function schedule(fromMs) {
    stopAll();
    if (!ctx || !master || !usingCtx) return;
    const t0 = ctx.currentTime + 0.03; // small lead so the first clip is never late
    clockBase = t0; // movie time `fromMs` maps to ctx time t0
    pos = fromMs;
    for (const c of store.get().movie.sounds) {
      const e = cache.get(keyFor(c.assetId));
      if (!e?.buffer || c.end <= fromMs || c.end <= c.start) continue;
      const begin = Math.max(c.start, fromMs);
      const when = t0 + (begin - fromMs) / 1000;
      const bufOff = ((c.offset ?? 0) + (begin - c.start)) / 1000;
      const want = (c.end - begin) / 1000;
      const remain = e.buffer.duration - bufOff;
      const loopIt = c.kind === 'bgmusic' && want > remain && e.buffer.duration > 0.2;
      if (!loopIt && remain <= 0) continue;
      const dur = loopIt ? want : Math.min(want, remain);
      const src = ctx.createBufferSource();
      src.buffer = e.buffer;
      if (loopIt) src.loop = true;
      const gain = ctx.createGain();
      const vol = clamp01(c.volume ?? 1);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(vol, when + FADE);
      gain.gain.setValueAtTime(vol, Math.max(when + FADE, when + dur - FADE));
      gain.gain.linearRampToValueAtTime(0, when + dur);
      src.connect(gain).connect(master);
      try {
        if (loopIt) src.start(when, bufOff % e.buffer.duration);
        else src.start(when, Math.max(0, bufOff), dur);
        if (loopIt) src.stop(when + dur);
      } catch { continue; }
      const rec = { src, gain, clipId: c.id };
      src.onended = () => { if (live.get(c.id) === rec) live.delete(c.id); };
      live.set(c.id, rec);
    }
  }

  let resched = 0;
  function reschedule() {
    if (!playing) return;
    clearTimeout(resched);
    resched = setTimeout(() => { if (playing && !destroyed) schedule(time()); }, 40);
  }

  /** Cheap live volume update (no reschedule). */
  function applyVolumes() {
    if (!ctx) return;
    for (const c of store.get().movie.sounds) {
      const r = live.get(c.id);
      if (!r) continue;
      const g = r.gain.gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setTargetAtTime(clamp01(c.volume ?? 1), ctx.currentTime, 0.015);
    }
  }

  // ---------------------------------------------------------------- transport
  function emit() {
    const t = time();
    timeCbs.forEach((cb) => { try { cb(t, playing); } catch (e) { console.error(e); } });
  }

  function writeStore(t, force = false) {
    const r = Math.round(t);
    if (!force && r === lastWritten) return;
    lastWritten = r;
    store.dispatch({ type: 'setPlayhead', ms: r, playhead: r, value: r });
  }

  function tick() {
    raf = 0;
    if (!playing || destroyed) return;
    const t = time();
    const end = endMs();
    if (t >= end - 0.5) {
      if (loop && end > 0) {
        seekInternal(0, true);
      } else {
        pos = end;
        stopPlayback();
        writeStore(end, true);
        emit();
        return;
      }
    } else {
      writeStore(t);
      emit();
    }
    raf = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    if (!playing) return;
    playing = false;
    clearTimeout(resched);
    stopAll();
    if (raf) cancelAnimationFrame(raf), raf = 0;
    if (ctx?.state === 'running') ctx.suspend?.().catch(() => {});
    if (store.get().playing) store.dispatch({ type: 'setPlaying', playing: false, value: false });
  }

  function seekInternal(ms, keepPlaying, quiet = false) {
    const end = endMs();
    const t = Math.max(0, Math.min(end, ms));
    if (playing && keepPlaying) {
      rebase(t);
      schedule(t);
    } else {
      pos = t;
    }
    if (quiet) lastWritten = Math.round(t); else writeStore(t, true);
    emit();
  }

  function play(fromMs) {
    if (destroyed) return;
    const end = endMs();
    if (end <= 0) return;
    let from = fromMs ?? store.get().playhead ?? 0;
    if (from >= end - 10) from = 0; // pressing play at the very end restarts
    if (playing) { seekInternal(from, true); return; }
    ensureCtx();
    playing = true;
    probeAll();
    const wake = ctx && ctx.state !== 'running' ? ctx.resume?.() : null;
    if (ctx?.state === 'running') {
      usingCtx = true; schedule(from);
    } else {
      usingCtx = false; rebase(from);
      wake?.then(() => { if (playing && !destroyed && ctx.state === 'running') { usingCtx = true; schedule(time()); } }).catch(() => {});
    }
    // schedule() sets pos/clockBase itself when the ctx is running
    if (!usingCtx) rebase(from);
    writeStore(from, true);
    if (!store.get().playing) store.dispatch({ type: 'setPlaying', playing: true, value: true });
    if (!raf) raf = requestAnimationFrame(tick);
    emit();
  }

  function pause() {
    if (!playing) return;
    pos = time();
    stopPlayback();
    writeStore(pos, true);
    emit();
  }

  function seek(ms) {
    if (destroyed) return;
    seekInternal(ms, true);
  }

  // ---------------------------------------------------------------- follow the store
  let prevSig = '';
  let prevVols = '';
  const unsub = store.subscribe(() => {
    if (destroyed) return;
    const s = store.get();
    // external transport changes
    if (s.playing && !playing) { play(s.playhead); }
    else if (!s.playing && playing) { pause(); }
    else if (Math.abs(s.playhead - lastWritten) > 1) {
      // someone else moved the playhead; only treat it as a seek if it is not just a stage echo
      if (!playing || Math.abs(s.playhead - time()) > 120) seekInternal(s.playhead, true, true);
    }
    // clip edits
    const sig = layoutSig(s.movie.sounds);
    if (sig !== prevSig) { prevSig = sig; probeAll(); reschedule(); }
    const vols = s.movie.sounds.map((c) => c.volume).join(',');
    if (vols !== prevVols) { prevVols = vols; applyVolumes(); }
  });
  prevSig = layoutSig(store.get().movie.sounds);
  prevVols = store.get().movie.sounds.map((c) => c.volume).join(',');
  pos = store.get().playhead || 0;
  lastWritten = Math.round(pos);
  probeAll();

  const onVis = () => { /* keep playing in background; the clock is the audio clock */ };
  document.addEventListener('visibilitychange', onVis);

  function applyMaster() { if (master) master.gain.setTargetAtTime(muted ? 0 : masterVol, ctx.currentTime, 0.01); }

  return {
    play, pause, seek, time,
    toggle() { playing ? pause() : play(); },
    isPlaying: () => playing,
    /** cb(ms, playing) on every frame while playing and on every seek/pause. Returns unsubscribe. */
    onTime(cb) { timeCbs.add(cb); return () => timeCbs.delete(cb); },
    onAssets(cb) { assetCbs.add(cb); return () => assetCbs.delete(cb); },
    probe, retry, info, resolveUrl,
    sceneOffsets: () => sceneOffsets(store.get().movie),
    duration: endMs,
    setLoop(v) { loop = !!v; },
    getLoop: () => loop,
    setMuted(v) { muted = !!v; applyMaster(); },
    isMuted: () => muted,
    setMasterVolume(v) { masterVol = clamp01(v); applyMaster(); },
    getMasterVolume: () => masterVol,
    destroy() {
      destroyed = true;
      unsub();
      clearTimeout(resched);
      if (raf) cancelAnimationFrame(raf);
      if (playing) { playing = false; if (store.get().playing) store.dispatch({ type: 'setPlaying', playing: false, value: false }); }
      stopAll();
      document.removeEventListener('visibilitychange', onVis);
      timeCbs.clear(); assetCbs.clear(); queue.length = 0;
      ctx?.close?.().catch(() => {});
      ctx = null;
    },
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
