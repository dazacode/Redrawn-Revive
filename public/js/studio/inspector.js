// Studio inspector: context-sensitive properties for the current selection.
import { icon } from '../icons.js';
import { esc } from '../shell.js';
import { findScene, findElem, sceneStart, movieDuration, MIN_SCENE_MS } from './model.js';

export const BUBBLE_STYLES = [['ellipse', 'Speech'], ['roundrectangular', 'Rounded box'], ['rectangular', 'Box'], ['cloud', 'Thought cloud'], ['boom', 'Shout'], ['heart', 'Heart'], ['blanktail', 'No box, with tail'], ['blank', 'Text only']];
const KIND_LABEL = { scene: 'Scene', bg: 'Background', char: 'Character', prop: 'Prop', effect: 'Effect', bubble: 'Speech bubble', sound: 'Sound' };

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const assetName = (id) => String(id || '').split('.').slice(-2, -1)[0]?.replace(/[_-]+/g, ' ') || String(id || '');

/**
 * Field descriptors: [key, label, kind, opts]. `get`/`set` convert between model units and UI units.
 * kind: number | range | text | area | select | seg | toggle
 */
const T = {
  x: { label: 'X', unit: 'px', step: 1 },
  y: { label: 'Y', unit: 'px', step: 1 },
  scale: { label: 'Scale', unit: '%', step: 1, min: 5, max: 800, get: (v) => round(v * 100, 0), set: (v) => v / 100 },
  rotation: { label: 'Rotation', unit: '°', step: 1, get: (v) => round(v, 1) },
  start: { label: 'Start', unit: 's', step: 0.1, min: 0, get: (v) => round((v ?? 0) / 1000, 2), set: (v) => Math.round(v * 1000) },
  end: { label: 'End', unit: 's', step: 0.1, min: 0, get: (v) => round((v ?? 0) / 1000, 2), set: (v) => Math.round(v * 1000) },
};

/**
 * @param {HTMLElement} el
 * @param {{store: any, themes?: any}} o
 */
export function mountInspector(el, { store, themes }) {
  let key = '';
  let body;
  let ctx = null; // { kind, scene, obj }
  let groups = []; // character action groups for the current char
  let alive = true;

  el.innerHTML = `<div class="st-insp-head"><h2></h2></div><div class="st-insp-body" tabindex="-1"></div>`;
  const head = el.querySelector('.st-insp-head');
  body = el.querySelector('.st-insp-body');

  function current(s) {
    const sel = s.selection || {};
    const scene = findScene(s.movie, sel.sceneId) || s.movie.scenes[0] || null;
    if (!scene) return null;
    if (sel.kind === 'sound') {
      const obj = s.movie.sounds.find((x) => x.id === sel.elemId);
      if (obj) return { kind: 'sound', scene, obj };
    } else if (sel.kind === 'bubble') {
      const obj = scene.bubbles.find((x) => x.id === sel.elemId);
      if (obj) return { kind: 'bubble', scene, obj };
    } else if (sel.elemId) {
      const f = findElem(scene, sel.elemId);
      if (f) return { kind: f.kind, scene, obj: f.elem };
    }
    return { kind: 'scene', scene, obj: scene };
  }

  // ---- dispatch adapters (one place to adapt to the store's command shapes) ----
  function patch(field, value, coalesce = true) {
    const { kind, scene, obj } = ctx;
    const c = coalesce ? { coalesce: `insp-${obj.id}-${field}` } : {};
    const p = { [field]: value };
    if (kind === 'scene') store.dispatch({ type: 'setSceneProps', sceneId: scene.id, patch: p, ...c });
    else if (kind === 'bubble') store.dispatch({ type: 'updateBubble', sceneId: scene.id, bubbleId: obj.id, patch: p, ...c });
    else if (kind === 'sound') store.dispatch({ type: 'updateSound', soundId: obj.id, patch: p, ...c });
    else store.dispatch({ type: 'updateElem', sceneId: scene.id, elemId: obj.id, patch: p, ...c });
  }

  function remove() {
    const { kind, scene, obj } = ctx;
    if (kind === 'scene') store.dispatch({ type: 'removeScene', sceneId: scene.id });
    else if (kind === 'bubble') store.dispatch({ type: 'removeBubble', sceneId: scene.id, bubbleId: obj.id });
    else if (kind === 'sound') store.dispatch({ type: 'removeSound', soundId: obj.id });
    else store.dispatch({ type: 'removeElem', sceneId: scene.id, elemId: obj.id });
    if (kind !== 'scene') store.dispatch({ type: 'select', sceneId: scene.id, elemId: null, kind: 'scene' });
  }

  function layer(to) {
    store.dispatch({ type: 'reorderElem', sceneId: ctx.scene.id, elemId: ctx.obj.id, to });
  }

  // ---- rendering ----
  const field = (f, spec, value) => {
    const id = `i-${f}`;
    const unit = spec.unit ? `<span class="sr-only"> (${spec.unit})</span>` : '';
    return `<div class="st-field"><label for="${id}">${spec.label}${unit}</label>
      <input class="st-in" id="${id}" data-f="${f}" type="number" step="${spec.step ?? 1}" ${spec.min != null ? `min="${spec.min}"` : ''} ${spec.max != null ? `max="${spec.max}"` : ''} value="${value}"></div>`;
  };
  const val = (f) => { const s = T[f]; const v = ctx.obj[f]; return s.get ? s.get(v) : round(num(v), 2); };
  const nums = (...fs) => `<div class="st-row">${fs.map((f) => field(f, T[f], val(f))).join('')}</div>`;
  const sect = (title, html) => `<div class="st-sect">${title ? `<h3>${title}</h3>` : ''}${html}</div>`;
  const select = (f, label, opts, value) => `<div class="st-field"><label for="i-${f}">${label}</label><select class="st-in" id="i-${f}" data-f="${f}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === (value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const rangeField = (f, label, value, min, max, step) => `<div class="st-field"><label for="i-${f}">${label}</label><div class="st-range"><input type="range" data-f="${f}" data-mirror="i-${f}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}"><input class="st-in" id="i-${f}" data-f="${f}" data-mirror="range" type="number" min="${min}" max="${max}" step="${step}" value="${value}"></div></div>`;

  function layerButtons() {
    return `<div class="st-btns">
      <button type="button" class="btn btn-sm" data-do="front" title="Bring to front">${icon('front')}Front</button>
      <button type="button" class="btn btn-sm" data-do="back" title="Send to back">${icon('back')}Back</button>
      <button type="button" class="btn btn-sm" data-do="flip" aria-pressed="${!!ctx.obj.flip}" title="Flip horizontally">${icon('flip')}Flip</button></div>`;
  }

  function actionPickers() {
    if (!groups.length) return '';
    return groups.map((g) => sect(esc(g.label), `<div class="st-chips">${g.items.map((it) => `<button type="button" class="st-chip" data-action="${esc(it.assetId)}" data-group="${esc(g.field)}" aria-pressed="${currentAction(ctx.obj) === it.assetId}">${esc(it.name)}</button>`).join('')}</div>`)).join('');
  }

  function bodyHtml() {
    const { kind, scene, obj } = ctx;
    const s = store.get();
    if (kind === 'scene') {
      const idx = s.movie.scenes.indexOf(scene);
      const total = movieDuration(s.movie);
      return sect('Timing', `<div class="st-field"><label for="i-duration">Duration<span class="sr-only"> (seconds)</span></label>
          <div class="st-range"><input type="range" data-f="duration" min="${MIN_SCENE_MS / 1000}" max="30" step="0.1" value="${round(scene.duration / 1000, 1)}" aria-label="Scene duration">
          <input class="st-in" id="i-duration" data-f="duration" type="number" min="${MIN_SCENE_MS / 1000}" step="0.1" value="${round(scene.duration / 1000, 1)}"></div></div>
          <p class="st-asset-id">Scene ${idx + 1} of ${s.movie.scenes.length}, starts at ${round(sceneStart(s.movie, scene.id) / 1000, 1)}s. Video length ${round(total / 1000, 1)}s.</p>`)
        + (scene.transitionOut ? sect('Transition', select('transitionOut', 'Transition to next scene', [['', 'None'], [scene.transitionOut, assetName(scene.transitionOut)]], scene.transitionOut)) : sect('Transition', '<p class="st-asset-id">Add transition effects from the Effects tab; they play inside the scene they are placed in.</p>'))
        + sect('Camera', `<div class="st-seg" role="group" aria-label="Camera"><button type="button" data-do="cam-off" aria-pressed="${!scene.camera}">Static</button><button type="button" data-do="cam-on" aria-pressed="${!!scene.camera}">Custom</button></div>
          ${scene.camera ? `<div class="st-row">${field('cam.x', { label: 'X', unit: 'px' }, round(scene.camera.x, 0))}${field('cam.y', { label: 'Y', unit: 'px' }, round(scene.camera.y, 0))}</div>
          ${rangeField('cam.zoom', 'Zoom', round(scene.camera.zoom, 2), 1, 4, 0.05)}` : ''}`)
        + sect('', `<div class="st-btns"><button type="button" class="btn btn-sm" data-do="dup">Duplicate scene</button><button type="button" class="btn btn-sm st-danger" data-do="remove" ${s.movie.scenes.length < 2 ? 'disabled' : ''}>${icon('trash')}Delete</button></div>`);
    }
    if (kind === 'bg') {
      return sect('Background', `<p class="st-asset-id">${esc(assetName(obj.assetId))}</p><p class="st-asset-id">Pick another background in the Backgrounds tab to replace it.</p>`);
    }
    if (kind === 'bubble') {
      return sect('Text', `<div class="st-field"><label for="i-text">Speech</label><textarea class="st-in" id="i-text" data-f="text" rows="3" placeholder="What are they saying?">${esc(obj.text)}</textarea></div>
          ${select('style', 'Style', BUBBLE_STYLES.some(([v]) => v === obj.style) ? BUBBLE_STYLES : [...BUBBLE_STYLES, [obj.style, obj.style]], obj.style)}`)
        + sect('Position', nums('x', 'y'))
        + sect('Timing', nums('start', 'end'))
        + sect('', `<button type="button" class="btn btn-sm st-danger" data-do="remove">${icon('trash')}Delete bubble</button>`);
    }
    if (kind === 'sound') {
      const label = obj.kind === 'tts' || obj.kind === 'voice' ? 'Voice' : obj.kind === 'bgmusic' ? 'Music' : 'Sound effect';
      return sect(label, `<p class="st-asset-id">${esc(obj.text || assetName(obj.assetId))}</p>
          ${rangeField('volume', 'Volume', Math.round(num(obj.volume, 1) * 100), 0, 100, 1)}`)
        + sect('Timing', `<div class="st-row">${field('start', T.start, T.start.get(obj.start))}${field('end', T.end, T.end.get(obj.end))}</div>`)
        + sect('', `<button type="button" class="btn btn-sm st-danger" data-do="remove">${icon('trash')}Delete clip</button>`);
    }
    // char / prop / effect
    return sect('Transform', `${nums('x', 'y')}${nums('scale', 'rotation')}`)
      + sect('Arrange', layerButtons())
      + (kind === 'char' ? actionPickers() : '')
      + (kind === 'effect' ? sect('Timing', nums('start', 'end')) : '')
      + sect('', `<p class="st-asset-id" title="${esc(obj.assetId)}">${esc(assetName(obj.assetId))}</p><button type="button" class="btn btn-sm st-danger" data-do="remove">${icon('trash')}Delete ${kind}</button>`);
  }

  function title() {
    if (ctx.kind === 'scene') return `Scene ${store.get().movie.scenes.indexOf(ctx.scene) + 1}`;
    if (ctx.kind === 'bubble') return ctx.obj.text ? `“${ctx.obj.text.slice(0, 24)}”` : 'Speech bubble';
    if (ctx.kind === 'sound') return ctx.obj.text?.slice(0, 28) || assetName(ctx.obj.assetId);
    return assetName(ctx.obj.assetId);
  }

  function build() {
    head.innerHTML = `<div><div class="kind">${KIND_LABEL[ctx.kind]}</div><h2>${esc(title())}</h2></div>`;
    body.innerHTML = bodyHtml();
  }

  /** Write current model values into inputs that are not being edited. */
  function sync() {
    const h2 = head.querySelector('h2'); if (h2 && h2.textContent !== title()) h2.textContent = title();
    const { kind, obj, scene } = ctx;
    for (const input of body.querySelectorAll('[data-f]')) {
      if (input === document.activeElement) continue;
      const f = input.dataset.f;
      let v;
      if (f.startsWith('cam.')) v = scene.camera?.[f.slice(4)];
      else if (kind === 'scene' && f === 'duration') v = round(scene.duration / 1000, 1);
      else if (kind === 'sound' && f === 'volume') v = Math.round(num(obj.volume, 1) * 100);
      else if (T[f] && (kind !== 'sound' || f === 'start' || f === 'end')) v = T[f].get ? T[f].get(obj[f]) : round(num(obj[f]), 2);
      else v = obj[f];
      if (v == null) continue;
      if (String(input.value) !== String(v)) input.value = v;
    }
    body.querySelectorAll('[data-do=flip]').forEach((b) => b.setAttribute('aria-pressed', String(!!obj.flip)));
    body.querySelectorAll('.st-chip').forEach((b) => b.setAttribute('aria-pressed', String(currentAction(obj) === b.dataset.action)));
  }

  async function loadGroups(elem, themeId) {
    groups = [];
    if (!themes?.loadTheme) return;
    try {
      const themeName = String(elem.assetId).split('.')[0];
      if (themeName === 'ugc') return;
      const th = await themes.loadTheme(themeName || themeId).catch(() => null);
      groups = charGroups(th, elem);
    } catch { groups = []; }
  }

  function update() {
    if (!alive) return;
    const s = store.get();
    const next = current(s);
    if (!next) { body.innerHTML = ''; return; }
    ctx = next;
    const k = `${ctx.kind}:${ctx.obj.id}:${ctx.kind === 'scene' ? s.movie.scenes.length + (ctx.scene.camera ? 'c' : '') : ''}`;
    if (k !== key) {
      key = k;
      groups = [];
      build();
      if (ctx.kind === 'char') {
        const want = k;
        loadGroups(ctx.obj, s.movie.themeId).then(() => { if (alive && key === want && groups.length) { ctx = current(store.get()) || ctx; build(); } });
      }
    } else if (ctx.kind === 'scene' && !!ctx.scene.camera !== !!body.querySelector('[data-f="cam.x"]')) { build(); }
    sync();
  }

  // ---- events ----
  const onInput = (e) => {
    const t = e.target; const f = t.dataset?.f; if (!f || !ctx) return;
    if (t.dataset.mirror) { // range <-> number twins
      const twin = t.type === 'range' ? body.querySelector(`input.st-in[data-f="${f}"]`) : body.querySelector(`input[type=range][data-f="${f}"]`);
      if (twin && twin !== t) twin.value = t.value;
    }
    if (f === 'duration' && t.type === 'range') { const n = body.querySelector('input.st-in[data-f="duration"]'); if (n) n.value = t.value; }
    if (f === 'duration' && t.type === 'number') { const r = body.querySelector('input[type=range][data-f="duration"]'); if (r) r.value = t.value; }
    const raw = t.value;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.type === 'text') {
      patch(f, f === 'transitionOut' ? (raw || null) : raw);
      return;
    }
    if (raw === '' || !Number.isFinite(Number(raw))) return;
    const n = Number(raw);
    if (f.startsWith('cam.')) {
      patch('camera', { ...ctx.scene.camera, [f.slice(4)]: n });
    } else if (f === 'duration') {
      patch('duration', Math.max(MIN_SCENE_MS, Math.round(n * 1000)));
    } else if (f === 'volume') {
      patch('volume', Math.min(1, Math.max(0, n / 100)));
    } else patch(f, T[f]?.set ? T[f].set(n) : n);
  };
  const onClick = (e) => {
    const chip = e.target.closest('.st-chip');
    if (chip && ctx) { patch(chip.dataset.group, chip.dataset.action, false); return; }
    const b = e.target.closest('[data-do]'); if (!b || !ctx) return;
    switch (b.dataset.do) {
      case 'front': case 'back': layer(b.dataset.do); break;
      case 'flip': patch('flip', !ctx.obj.flip, false); break;
      case 'remove': remove(); break;
      case 'dup': store.dispatch({ type: 'duplicateScene', sceneId: ctx.scene.id }); break;
      case 'cam-on': patch('camera', ctx.scene.camera || { x: 275, y: 155, zoom: 1.5 }, false); break;
      case 'cam-off': patch('camera', null, false); break;
    }
  };
  // Number fields: Escape / Enter leave the field so shortcuts work again.
  const onKey = (e) => { if (e.key === 'Enter' && e.target.matches('input')) e.target.blur(); };
  body.addEventListener('input', onInput);
  body.addEventListener('change', onInput);
  body.addEventListener('click', onClick);
  body.addEventListener('keydown', onKey);
  const unsub = store.subscribe(update);
  update();

  return { destroy() { alive = false; unsub(); el.replaceChildren(); } };
}

/** The action id a char element currently plays (explicit, else the one embedded in its assetId). */
export const currentAction = (e) => e.action ?? String(e.assetId).split('.').slice(2).join('.');

/**
 * Character action groups from a loaded theme (themes.js: char.actions = {emotion[], action[], motion[]}).
 * Every pick sets `elem.action` (the legacy <action> id); emotions are actions of the face category.
 * @returns {{label: string, field: 'action', items: {assetId: string, name: string}[]}[]}
 */
export function charGroups(theme, elem) {
  const [, charId] = String(elem.assetId).split('.');
  const ch = (theme?.characters || []).find((c) => c.id === charId);
  if (!ch?.actions) return [];
  const labels = { emotion: 'Emotion', action: 'Action', motion: 'Motion' };
  return Object.entries(ch.actions).filter(([, l]) => l?.length)
    .map(([cat, list]) => ({ label: labels[cat] || cat, field: 'action', items: list.map((a) => ({ assetId: a.id, name: a.name })) }));
}
