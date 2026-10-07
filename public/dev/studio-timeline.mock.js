// DEV HARNESS for the studio timeline: real store + audio engine, mocked stage and server endpoints.
//   bun public/dev/serve.ts 5173   ->   http://localhost:5173/dev/studio-timeline.html[?empty][&theme=dark|light][&w=900][&h=300]
import { createStore } from '/js/studio/store.js';
import { createMovie, createScene, createSound } from '/js/studio/model.js';
import { createAudioEngine } from '/js/studio/audio.js';
import { mountTimeline } from '/js/studio/timeline.js';

const q = new URLSearchParams(location.search);
if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme');
if (q.get('w')) document.body.style.width = `${q.get('w')}px`;
if (q.get('h')) document.documentElement.style.setProperty('--h', `${q.get('h')}px`);

// ---------------------------------------------------------------- synthetic audio (22.05 kHz mono WAV)
const SR = 22050;
function wav(seconds, kind, seed = 1) {
  const n = Math.floor(seconds * SR);
  const pcm = new Int16Array(n);
  let s = seed * 9301;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    if (kind === 'voice') {
      const word = Math.floor(t * 3.3 + seed);
      const wt = (t * 3.3 + seed) % 1;
      const env = Math.sin(Math.PI * Math.min(1, wt * 1.25)) * (word % 5 === 4 ? 0.1 : 1);
      v = env * (0.5 * Math.sin(2 * Math.PI * (140 + 40 * Math.sin(word)) * t) + 0.25 * Math.sin(2 * Math.PI * 420 * t) + 0.1 * (rnd() - 0.5));
    } else if (kind === 'music') {
      const beat = (t * 2) % 1;
      const chord = [220, 277, 330, 392][Math.floor(t / 2) % 4];
      v = (0.25 + 0.25 * Math.pow(1 - beat, 2)) * (Math.sin(2 * Math.PI * chord * t) + 0.5 * Math.sin(2 * Math.PI * chord * 1.5 * t)) * (0.7 + 0.3 * Math.sin(t * 0.7));
    } else {
      v = Math.exp(-t * 7) * (rnd() - 0.5) * 2 * (1 + Math.sin(t * 90));
    }
    pcm[i] = Math.max(-1, Math.min(1, v * 0.8)) * 32767;
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------- mocked server
const blobs = new Map(); // assetId -> Uint8Array
const spec = { a1: ['voice', 3.1, 1], a2: ['voice', 4.4, 2], a3: ['voice', 2.2, 3], m1: ['music', 28, 4], s1: ['sfx', 1.4, 5], s2: ['sfx', 2.2, 6], slow: ['sfx', 2, 7] };
const realFetch = window.fetch.bind(window);
let ttsCount = 0;
window.fetch = async (url, init) => {
  const u = typeof url === 'string' ? url : url.url;
  const path = new URL(u, location.href).pathname;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  if (path.startsWith('/assets/')) {
    const id = decodeURIComponent(path.split('/').pop());
    if (id === 'slow') await delay(2500);
    if (id === 'missing') return new Response('nope', { status: 404 });
    const b = blobs.get(id) ?? (spec[id] ? wav(spec[id][1], spec[id][0], spec[id][2]) : null);
    if (!b) return new Response('nope', { status: 404 });
    blobs.set(id, b);
    return new Response(b, { headers: { 'Content-Type': 'audio/wav' } });
  }
  if (path === '/goapi/getTextToSpeechVoices') {
    await delay(300);
    return new Response('<?xml version="1.0"?><voices><language id="en" desc="English"><voice id="kate" desc="Kate" sex="F" demo-url="" country="US" plus="N"/><voice id="paul" desc="Paul" sex="M" demo-url="" country="US" plus="N"/></language><language id="es" desc="Spanish"><voice id="lola" desc="Lola" sex="F" demo-url="" country="ES" plus="N"/></language></voices>');
  }
  if (path === '/goapi/convertTextToSoundAsset') {
    await delay(900);
    const p = new URLSearchParams(String(init.body));
    if ((p.get('text') || '').includes('fail')) return new Response('1<error><code>ERR</code></error>');
    const id = `tts${++ttsCount}-tts.mp3`;
    const secs = Math.max(1.2, Math.min(9, (p.get('text') || '').length / 14));
    blobs.set(id, wav(secs, 'voice', 10 + ttsCount));
    return new Response(`0<response><asset><id>${id}</id><enc_asset_id>${id}</enc_asset_id><type>sound</type><subtype>tts</subtype><title>[Kate] ${p.get('text')}</title><duration>${Math.round(secs * 1000)}</duration></asset></response>`);
  }
  if (path === '/upload_asset') {
    const f = init.body.get('import');
    const id = `up${Date.now()}${f.name.replace(/[^\w.]/g, '')}`;
    blobs.set(id, new Uint8Array(await f.arrayBuffer()));
    return new Response(id);
  }
  return realFetch(url, init);
};

// ---------------------------------------------------------------- movie
function demoMovie() {
  const bgs = ['mock.diner', 'mock.park', null, 'mock.office'];
  const durs = [3000, 4500, 2500, 6000];
  return createMovie({
    id: 'mock1', title: 'Harness demo',
    scenes: durs.map((duration, i) => createScene({ duration, bg: bgs[i] ? { id: `bg${i}`, assetId: bgs[i], x: 275, y: 155, scale: 1, rotation: 0, flip: false, z: 0 } : null, transitionOut: i === 1 ? 'fade' : null })),
    sounds: [
      createSound({ id: 'v1', kind: 'tts', assetId: 'ugc.a1', start: 200, end: 3300, volume: 1, text: 'Welcome to the diner, please take a seat.' }),
      createSound({ id: 'v2', kind: 'voice', assetId: 'ugc.a2', start: 3600, end: 8000, volume: 0.8 }),
      createSound({ id: 'v3', kind: 'tts', assetId: 'ugc.a3', start: 7000, end: 9200, volume: 0.9, text: 'Overlapping line' }),
      createSound({ id: 'm1', kind: 'bgmusic', assetId: 'ugc.m1', start: 0, end: 16500, volume: 0.45 }),
      createSound({ id: 'f1', kind: 'sfx', assetId: 'ugc.s1', start: 1500, end: 2900, volume: 1 }),
      createSound({ id: 'f2', kind: 'sfx', assetId: 'ugc.s2', start: 5200, end: 7400, volume: 0.7 }),
      createSound({ id: 'f3', kind: 'sfx', assetId: 'common.laugh_4.swf', start: 9500, end: 12000, volume: 1 }),
      createSound({ id: 'f4', kind: 'sfx', assetId: 'ugc.missing', start: 12500, end: 14000, volume: 1 }),
      createSound({ id: 'f5', kind: 'sfx', assetId: 'ugc.slow', start: 14200, end: 16200, volume: 1 }),
    ],
  });
}

const store = createStore(q.has('empty') ? createMovie({ id: 'mock1' }) : demoMovie());
const audio = createAudioEngine(store);

const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const stage = {
  async thumbnail(assetId) {
    const h = hue(assetId);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 55% 62%)"/><stop offset="1" stop-color="hsl(${(h + 50) % 360} 50% 38%)"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><rect x="0" y="62" width="160" height="28" fill="hsl(${h} 30% 25% / .6)"/><circle cx="110" cy="34" r="12" fill="hsl(${h} 80% 85% / .8)"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  },
};

const tl = mountTimeline(document.getElementById('timeline'), { store, stage, audio });
window.h = { store, audio, tl };

// stage placeholder shows what a stage would follow
const info = document.getElementById('stage-info');
store.subscribe((s) => { info.textContent = `playhead ${Math.round(s.playhead)} ms, playing ${s.playing}, selection ${s.selection.kind ?? '-'}:${s.selection.elemId ?? s.selection.sceneId ?? '-'}`; });
store.subscribe((s, c) => {
  if (c && c.type !== 'setPlayhead') {
    const l = document.getElementById('log');
    l.textContent = `${c.type}${c.coalesce ? ` (${c.coalesce})` : ''}\n${l.textContent}`.split('\n').slice(0, 4).join('\n');
  }
});

document.querySelector('.h-top').addEventListener('click', (e) => {
  const a = e.target.closest('[data-h]')?.dataset.h;
  if (a === 'theme') { const d = document.documentElement; d.dataset.theme = (d.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark'; }
  if (a === 'undo') store.undo();
  if (a === 'redo') store.redo();
  if (a === 'empty') store.dispatch({ type: 'loadMovie', movie: createMovie({ id: 'mock1' }) });
  if (a === 'demo') store.dispatch({ type: 'loadMovie', movie: demoMovie() });
  e.target.blur();
});
