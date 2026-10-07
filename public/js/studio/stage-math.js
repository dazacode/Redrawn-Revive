/**
 * Pure geometry/timing helpers for the stage (no DOM, no Ruffle). Unit-tested in tests/studio-stage.test.ts.
 *
 * Conventions: stage space is 550x310 px, origin top-left, y down. An element is drawn by placing its SWF's own
 * origin at (x, y) and applying  scaleX = (flip ? -1 : 1) * scale * LEGACY_K,  scaleY = scale * LEGACY_K,  then
 * rotation (degrees, clockwise) about that origin. `local bounds` are [x, y, w, h] of the SWF content in its own
 * unscaled coordinates (what Loader.getBounds(loader) reports).
 */
import { LEGACY_K, STAGE_W, STAGE_H, FPS } from './model.js';

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 20;

/** Fit a stage of aspect w:h inside cw x ch with whole-pixel size and centred whole-pixel offset. */
export function fitView(cw, ch, w = STAGE_W, h = STAGE_H) {
  if (!(cw > 0) || !(ch > 0)) return { x: 0, y: 0, w: 0, h: 0, k: 0 };
  const k0 = Math.min(cw / w, ch / h);
  const vw = Math.max(1, Math.floor(w * k0));
  const vh = Math.max(1, Math.round((vw * h) / w));
  return { x: Math.floor((cw - vw) / 2), y: Math.floor((ch - vh) / 2), w: vw, h: vh, k: vw / w };
}

const rad = (deg) => (deg * Math.PI) / 180;

/** Effective drawn scale factors of an element ([sx, sy], sx negative when flipped). */
export function drawScale(elem, k = LEGACY_K) {
  const s = (elem.scale ?? 1) * k;
  return [elem.flip ? -s : s, s];
}

/** Map a point in an element's local space to stage space. */
export function localToStage(elem, lx, ly, k = LEGACY_K) {
  const [sx, sy] = drawScale(elem, k);
  const a = rad(elem.rotation ?? 0), c = Math.cos(a), s = Math.sin(a);
  const px = lx * sx, py = ly * sy;
  return [elem.x + px * c - py * s, elem.y + px * s + py * c];
}

/** Inverse of localToStage. */
export function stageToLocal(elem, x, y, k = LEGACY_K) {
  const [sx, sy] = drawScale(elem, k);
  const a = rad(elem.rotation ?? 0), c = Math.cos(a), s = Math.sin(a);
  const dx = x - elem.x, dy = y - elem.y;
  const px = dx * c + dy * s, py = -dx * s + dy * c;
  return [px / (sx || 1e-9), py / (sy || 1e-9)];
}

/** Oriented bounding box corners in stage space: [tl, tr, br, bl] of local bounds [x,y,w,h]. */
export function orientedBox(elem, b, k = LEGACY_K) {
  const [x, y, w, h] = b;
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([lx, ly]) => localToStage(elem, lx, ly, k));
}

/** Stage-space centre of local bounds. */
export function boxCenter(elem, b, k = LEGACY_K) {
  return localToStage(elem, b[0] + b[2] / 2, b[1] + b[3] / 2, k);
}

/** Point in convex quad (any winding). */
export function inQuad(q, px, py) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
    const cr = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cr !== 0) {
      const sg = cr > 0 ? 1 : -1;
      if (sign && sg !== sign) return false;
      sign = sg;
    }
  }
  return true;
}

/** Area of a quad (shoelace), for "smallest box wins" picking. */
export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

/**
 * Patch that scales an element by `factor` while keeping the stage-space centre of its bounds fixed.
 * @returns {{scale:number, x:number, y:number}}
 */
export function scaleAboutCenter(elem, b, factor, k = LEGACY_K) {
  const scale = clamp((elem.scale ?? 1) * factor, MIN_SCALE, MAX_SCALE);
  const [cx, cy] = boxCenter(elem, b, k);
  const next = { ...elem, scale };
  const [nx, ny] = boxCenter(next, b, k);
  return { scale, x: round2(elem.x + (cx - nx)), y: round2(elem.y + (cy - ny)) };
}

/** Patch that rotates an element to `rotation` degrees keeping the stage-space centre of its bounds fixed. */
export function rotateAboutCenter(elem, b, rotation, k = LEGACY_K) {
  const [cx, cy] = boxCenter(elem, b, k);
  const next = { ...elem, rotation };
  const [nx, ny] = boxCenter(next, b, k);
  return { rotation: round2(normDeg(rotation)), x: round2(elem.x + (cx - nx)), y: round2(elem.y + (cy - ny)) };
}

/** Flip horizontally about the centre of the bounds. */
export function flipAboutCenter(elem, b, k = LEGACY_K) {
  const [cx, cy] = boxCenter(elem, b, k);
  const next = { ...elem, flip: !elem.flip };
  const [nx, ny] = boxCenter(next, b, k);
  return { flip: next.flip, x: round2(elem.x + (cx - nx)), y: round2(elem.y + (cy - ny)) };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const round2 = (v) => Math.round(v * 100) / 100;
export const normDeg = (d) => { let r = d % 360; if (r > 180) r -= 360; if (r <= -180) r += 360; return r; };

/** Angle in degrees of the vector (dx, dy), 0 = pointing right, clockwise positive (y down). */
export const angleDeg = (dx, dy) => (Math.atan2(dy, dx) * 180) / Math.PI;

/**
 * 1-based timeline frame for an element `ms` after it started.
 * @param {number} ms          time since the element's action started
 * @param {{total:number, loop:boolean, fps?:number}} o
 */
export function frameAt(ms, { total, loop, fps = FPS }) {
  if (!(total > 1)) return 1;
  const f = Math.floor(Math.max(0, ms) * fps / 1000);
  if (loop) return (f % total) + 1;
  return Math.min(total, f + 1);
}

/** Camera: map an element placement through {x,y,zoom} (centre of view at cx,cy in scene space). */
export function applyCamera(p, cam, w = STAGE_W, h = STAGE_H) {
  if (!cam || !(cam.zoom > 0)) return p;
  const z = cam.zoom;
  const cx = cam.x ?? w / 2, cy = cam.y ?? h / 2;
  if (z === 1 && cx === w / 2 && cy === h / 2) return p;
  return { ...p, x: (p.x - cx) * z + w / 2, y: (p.y - cy) * z + h / 2, scale: p.scale * z };
}

/** Is `t` (ms from scene start) inside an element's optional [start, end) window? */
export function inWindow(elem, t) {
  if (elem.start != null && t < elem.start) return false;
  if (elem.end != null && elem.end > 0 && t >= elem.end) return false;
  return true;
}

/**
 * Speech bubble geometry in its own pixel box (0,0,w,h) plus an optional tail target given in the same box
 * coordinates (may lie outside the box). Returns an SVG path `d`.
 * @param {'talk'|'think'|'shout'|'whisper'|string} style
 */
export function bubblePath(style, w, h, tail) {
  const r = Math.min(18, h / 2, w / 2);
  const tailPath = tail ? tailTriangle(w, h, tail) : null;
  if (style === 'think') return `${ellipsePath(w / 2, h / 2, w / 2, h / 2)}`;
  if (style === 'shout') return burstPath(w, h, tail);
  const body = `M${r},0H${w - r}Q${w},0 ${w},${r}V${h - r}Q${w},${h} ${w - r},${h}H${r}Q0,${h} 0,${h - r}V${r}Q0,0 ${r},0Z`;
  return tailPath ? `${body}${tailPath}` : body;
}

function ellipsePath(cx, cy, rx, ry) {
  return `M${cx - rx},${cy}a${rx},${ry} 0 1,0 ${rx * 2},0a${rx},${ry} 0 1,0 ${-rx * 2},0Z`;
}

/** Small triangle anchored on the bubble edge nearest the target. */
export function tailTriangle(w, h, [tx, ty]) {
  const cx = w / 2, cy = h / 2;
  const dx = tx - cx, dy = ty - cy;
  const horizontal = Math.abs(dx) / (w / 2) > Math.abs(dy) / (h / 2);
  const half = Math.min(10, (horizontal ? h : w) / 4);
  if (horizontal) {
    const ex = dx > 0 ? w : 0;
    const ay = clamp(cy + dy * 0.25, half + 4, h - half - 4);
    return `M${ex},${ay - half}L${tx},${ty}L${ex},${ay + half}Z`;
  }
  const ey = dy > 0 ? h : 0;
  const ax = clamp(cx + dx * 0.25, half + 4, w - half - 4);
  return `M${ax - half},${ey}L${tx},${ty}L${ax + half},${ey}Z`;
}

function burstPath(w, h, tail) {
  const n = 14, cx = w / 2, cy = h / 2;
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const k = i % 2 ? 0.8 : 1.04;
    pts.push(`${(cx + Math.cos(a) * (w / 2) * k).toFixed(1)},${(cy + Math.sin(a) * (h / 2) * k).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z${tail ? tailTriangle(w, h, tail) : ''}`;
}

/** Small circles of a thought bubble leading to the target: [{x,y,r}]. */
export function thoughtDots(w, h, [tx, ty]) {
  const sx = w / 2, sy = h;
  return [0.3, 0.55, 0.78].map((f, i) => ({ x: sx + (tx - sx) * f, y: sy + (ty - sy) * f, r: 7 - i * 2 }));
}
