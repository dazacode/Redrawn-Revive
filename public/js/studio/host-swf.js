/**
 * Builds, at runtime and with no compiler, a tiny AS3 "host" SWF that Ruffle runs as the stage compositor.
 *
 * Why: legacy assets (backgrounds, characters, props) are whole SWFs whose artwork is positioned around their own
 * origin and is clipped by their own stage. Rendering each one in a separate Ruffle instance cannot place or scale
 * them freely, and costs one WebGL context + wasm instance each. Instead ONE host SWF (550x310, scaled by Ruffle to
 * the canvas, so output is vector-crisp at any size) loads every asset through `flash.display.Loader` exactly like the
 * original editor does, and JavaScript drives it through ExternalInterface.
 *
 * The AS3 this assembles (class Host extends Sprite):
 *
 *   var objs = {root: this};
 *   add(id, url)        new Loader().load(new URLRequest(url)); addChild(loader); objs[id] = loader
 *   rm(id)              removeChild + unload + delete objs[id]
 *   idx(id, i)          setChildIndex(objs[id], i)
 *   bounds(id)          [x, y, w, h] of objs[id].getBounds(objs[id])   (local, untransformed)
 *   op(id, path, mode, args)
 *        t = objs[id]; walk the dotted `path` (all but the last segment, null-safe);
 *        mode 0: return t[name]   mode 1: t[name] = args[0]   mode 2: return t[name].apply(t, args)
 *
 * Everything else (positions, frames, hit tests via `hitTestPoint`) is composed from op().
 */

const SYMBOL = 'Host';

// ----------------------------------------------------------------------------------------- byte writer
class Bytes {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 255); return this; }
  u16(v) { return this.u8(v).u8(v >> 8); }
  u32(v) { return this.u16(v & 0xffff).u16(v >>> 16); }
  u30(v) {
    v >>>= 0;
    do { let b = v & 127; v >>>= 7; if (v) b |= 128; this.a.push(b); } while (v);
    return this;
  }
  str(s) { const e = new TextEncoder().encode(s); this.u30(e.length); this.a.push(...e); return this; }
  cstr(s) { this.a.push(...new TextEncoder().encode(s), 0); return this; }
  bytes(b) { for (const x of b) this.a.push(x); return this; }
  get length() { return this.a.length; }
  toU8() { return Uint8Array.from(this.a); }
}

// ----------------------------------------------------------------------------------------- constant pool
class Pool {
  constructor() { this.strings = ['']; this.ns = [null]; this.nsets = [null]; this.mn = [null]; this.sIdx = new Map(); this.nIdx = new Map(); this.mIdx = new Map(); }
  s(v) { if (v === '') return 0; let i = this.sIdx.get(v); if (i === undefined) { i = this.strings.push(v) - 1; this.sIdx.set(v, i); } return i; }
  /** Package namespace (kind 0x16) by package name. */
  pkg(name) { const k = 'p' + name; let i = this.nIdx.get(k); if (i === undefined) { i = this.ns.push({ kind: 0x16, name: this.s(name) }) - 1; this.nIdx.set(k, i); } return i; }
  /** QName in package `p`. */
  q(p, name) { const k = p + '::' + name; let i = this.mIdx.get(k); if (i === undefined) { i = this.mn.push({ kind: 0x07, ns: this.pkg(p), name: this.s(name) }) - 1; this.mIdx.set(k, i); } return i; }
  /** MultinameL over the public namespace (runtime name). */
  ml() { let i = this.mIdx.get('ML'); if (i === undefined) { const set = this.nsets.push([this.pkg('')]) - 1; i = this.mn.push({ kind: 0x1b, nsset: set }) - 1; this.mIdx.set('ML', i); } return i; }
  write(w) {
    w.u30(1); // ints
    w.u30(1); // uints
    w.u30(1); // doubles
    w.u30(this.strings.length); for (let i = 1; i < this.strings.length; i++) w.str(this.strings[i]);
    w.u30(this.ns.length); for (let i = 1; i < this.ns.length; i++) w.u8(this.ns[i].kind).u30(this.ns[i].name);
    w.u30(this.nsets.length); for (let i = 1; i < this.nsets.length; i++) { w.u30(this.nsets[i].length); this.nsets[i].forEach((n) => w.u30(n)); }
    w.u30(this.mn.length);
    for (let i = 1; i < this.mn.length; i++) {
      const m = this.mn[i];
      w.u8(m.kind);
      if (m.kind === 0x07) w.u30(m.ns).u30(m.name); else w.u30(m.nsset);
    }
  }
}

// ----------------------------------------------------------------------------------------- code assembler
const OP = {
  label: 0x09, jump: 0x10, iftrue: 0x11, iffalse: 0x12, ifne: 0x14, ifnlt: 0x0c,
  pushnull: 0x20, pushbyte: 0x24, pushtrue: 0x26, pushstring: 0x2c, pop: 0x29, dup: 0x2a, pushscope: 0x30, popscope: 0x1d,
  constructsuper: 0x49, constructprop: 0x4a, callproperty: 0x46, callpropvoid: 0x4f, returnvoid: 0x47, returnvalue: 0x48,
  newobject: 0x55, newarray: 0x56, newclass: 0x58, findpropstrict: 0x5d, getlex: 0x60, setproperty: 0x61, getlocal: 0x62, setlocal: 0x63,
  getproperty: 0x66, initproperty: 0x68, deleteproperty: 0x6a, convert_i: 0x73, decrement: 0x93, inclocal_i: 0xc2, subtract: 0xa1,
  getlocal0: 0xd0, getlocal1: 0xd1, getlocal2: 0xd2, getlocal3: 0xd3, setlocal1: 0xd5, setlocal2: 0xd6, setlocal3: 0xd7,
};
const BRANCH = new Set([OP.jump, OP.iftrue, OP.iffalse, OP.ifne, OP.ifnlt]);

class Code {
  constructor() { this.b = new Bytes(); this.labels = new Map(); this.fix = []; }
  /** op(name, ...u30 args) */
  op(name, ...args) {
    const code = OP[name];
    if (code === undefined) throw new Error('unknown op ' + name);
    this.b.u8(code);
    if (name === 'pushbyte') this.b.u8(args[0]);
    else for (const a of args) this.b.u30(a);
    return this;
  }
  /** Branch to a label (24-bit relative offset from the end of the instruction). */
  br(name, label) {
    this.b.u8(OP[name]);
    this.fix.push({ at: this.b.length, label });
    this.b.u8(0).u8(0).u8(0);
    return this;
  }
  mark(label) { this.labels.set(label, this.b.length); this.b.u8(OP.label); return this; }
  build() {
    const a = this.b.a;
    for (const f of this.fix) {
      const target = this.labels.get(f.label);
      if (target === undefined) throw new Error('missing label ' + f.label);
      const off = target - (f.at + 3);
      a[f.at] = off & 255; a[f.at + 1] = (off >> 8) & 255; a[f.at + 2] = (off >> 16) & 255;
    }
    return Uint8Array.from(a);
  }
}

// ----------------------------------------------------------------------------------------- ABC program
function buildAbc() {
  const P = new Pool();
  const Q = (n) => P.q('', n);
  const fd = (n) => P.q('flash.display', n);
  const N = {
    Sprite: fd('Sprite'), Loader: fd('Loader'), URLRequest: P.q('flash.net', 'URLRequest'),
    EI: P.q('flash.external', 'ExternalInterface'), Object: Q('Object'), Array: Q('Array'), String: Q('String'), int: Q('int'),
    Host: Q(SYMBOL), objs: Q('objs'), add: Q('add'), rm: Q('rm'), idx: Q('idx'), bounds: Q('bounds'), op: Q('op'),
    addCallback: Q('addCallback'), load: Q('load'), addChild: Q('addChild'), removeChild: Q('removeChild'), unload: Q('unload'),
    setChildIndex: Q('setChildIndex'), getBounds: Q('getBounds'), split: Q('split'), apply: Q('apply'),
    length: Q('length'), x: Q('x'), y: Q('y'), width: Q('width'), height: Q('height'),
  };
  const ML = P.ml();
  const methods = []; // {params:[typeIdx], ret, code, locals, stack}
  const m = (params, ret, locals, stack, code) => { methods.push({ params, ret, code: code.build(), locals, stack }); return methods.length - 1; };

  // iinit
  const cInit = new Code();
  cInit.op('getlocal0').op('pushscope').op('getlocal0').op('constructsuper', 0);
  cInit.op('getlocal0').op('newobject', 0).op('setproperty', N.objs);
  cInit.op('getlocal0').op('getproperty', N.objs).op('pushstring', P.s('root')).op('getlocal0').op('setproperty', ML);
  for (const [name, fn] of [['add', N.add], ['rm', N.rm], ['idx', N.idx], ['bounds', N.bounds], ['op', N.op]]) {
    cInit.op('getlex', N.EI).op('pushstring', P.s(name)).op('getlocal0').op('getproperty', fn).op('callpropvoid', N.addCallback, 2);
  }
  cInit.op('returnvoid');
  const iinit = m([], 0, 1, 6, cInit);

  // add(id:String, url:String):void   locals: 1 id, 2 url, 3 loader
  const cAdd = new Code();
  cAdd.op('getlocal0').op('pushscope');
  cAdd.op('findpropstrict', N.Loader).op('constructprop', N.Loader, 0).op('setlocal3');
  cAdd.op('getlocal3').op('findpropstrict', N.URLRequest).op('getlocal2').op('constructprop', N.URLRequest, 1).op('callpropvoid', N.load, 1);
  cAdd.op('getlocal0').op('getlocal3').op('callpropvoid', N.addChild, 1);
  cAdd.op('getlocal0').op('getproperty', N.objs).op('getlocal1').op('getlocal3').op('setproperty', ML);
  cAdd.op('returnvoid');
  const mAdd = m([N.String, N.String], 0, 4, 6, cAdd);

  // rm(id:String):void   locals: 1 id, 2 loader
  const cRm = new Code();
  cRm.op('getlocal0').op('pushscope');
  cRm.op('getlocal0').op('getproperty', N.objs).op('getlocal1').op('getproperty', ML).op('setlocal2');
  cRm.op('getlocal2').br('iffalse', 'end');
  cRm.op('getlocal0').op('getlocal2').op('callpropvoid', N.removeChild, 1);
  cRm.op('getlocal2').op('callpropvoid', N.unload, 0);
  cRm.op('getlocal0').op('getproperty', N.objs).op('getlocal1').op('deleteproperty', ML).op('pop');
  cRm.mark('end').op('returnvoid');
  const mRm = m([N.String], 0, 3, 6, cRm);

  // idx(id:String, i:int):void   locals: 1 id, 2 i, 3 loader
  const cIdx = new Code();
  cIdx.op('getlocal0').op('pushscope');
  cIdx.op('getlocal0').op('getproperty', N.objs).op('getlocal1').op('getproperty', ML).op('setlocal3');
  cIdx.op('getlocal3').br('iffalse', 'end');
  cIdx.op('getlocal0').op('getlocal3').op('getlocal2').op('callpropvoid', N.setChildIndex, 2);
  cIdx.mark('end').op('returnvoid');
  const mIdx = m([N.String, N.int], 0, 4, 6, cIdx);

  // bounds(id:String):Array   locals: 1 id, 2 loader, 3 rect
  const cB = new Code();
  cB.op('getlocal0').op('pushscope');
  cB.op('getlocal0').op('getproperty', N.objs).op('getlocal1').op('getproperty', ML).op('setlocal2');
  cB.op('getlocal2').br('iftrue', 'ok').op('pushnull').op('returnvalue');
  cB.mark('ok').op('getlocal2').op('getlocal2').op('callproperty', N.getBounds, 1).op('setlocal3');
  for (const p of [N.x, N.y, N.width, N.height]) cB.op('getlocal3').op('getproperty', p);
  cB.op('newarray', 4).op('returnvalue');
  const mBounds = m([N.String], N.Array, 4, 8, cB);

  // op(id:String, path:String, mode:int, args:Array):*   locals: 1 id,2 path,3 mode,4 args,5 t,6 parts,7 n,8 i,9 name
  const c = new Code();
  c.op('getlocal0').op('pushscope');
  c.op('getlocal0').op('getproperty', N.objs).op('getlocal1').op('getproperty', ML).op('setlocal', 5);
  c.op('getlocal', 5).br('iftrue', 'has').op('pushnull').op('returnvalue');
  c.mark('has').op('getlocal2').op('pushstring', P.s('.')).op('callproperty', N.split, 1).op('setlocal', 6);
  c.op('getlocal', 6).op('getproperty', N.length).op('decrement').op('convert_i').op('setlocal', 7);
  c.op('pushbyte', 0).op('setlocal', 8);
  c.br('jump', 'cond');
  c.mark('body');
  c.op('getlocal', 5).op('getlocal', 6).op('getlocal', 8).op('getproperty', ML).op('getproperty', ML).op('setlocal', 5);
  c.op('getlocal', 5).br('iftrue', 'step').op('pushnull').op('returnvalue');
  c.mark('step').op('inclocal_i', 8);
  c.mark('cond').op('getlocal', 8).op('getlocal', 7).br('ifnlt', 'walked').br('jump', 'body');
  c.mark('walked');
  c.op('getlocal', 6).op('getlocal', 7).op('getproperty', ML).op('setlocal', 9);
  c.op('getlocal3').op('pushbyte', 0).br('ifne', 'm1');
  c.op('getlocal', 5).op('getlocal', 9).op('getproperty', ML).op('returnvalue');
  c.mark('m1').op('getlocal3').op('pushbyte', 1).br('ifne', 'm2');
  c.op('getlocal', 5).op('getlocal', 9).op('getlocal', 4).op('pushbyte', 0).op('getproperty', ML).op('setproperty', ML);
  c.op('pushtrue').op('returnvalue');
  c.mark('m2').op('getlocal', 5).op('getlocal', 9).op('getproperty', ML).op('getlocal', 5).op('getlocal', 4).op('callproperty', N.apply, 2).op('returnvalue');
  const mOp = m([N.String, N.String, N.int, N.Array], 0, 10, 10, c);

  // class initializer + script initializer
  const cCinit = new Code(); cCinit.op('getlocal0').op('pushscope').op('returnvoid');
  const cinit = m([], 0, 1, 2, cCinit);
  const cScript = new Code();
  cScript.op('getlocal0').op('pushscope').op('getlocal0').op('getlex', N.Sprite).op('pushscope').op('getlex', N.Sprite).op('newclass', 0).op('popscope').op('initproperty', N.Host).op('returnvoid');
  const sinit = m([], 0, 1, 4, cScript);

  const w = new Bytes();
  w.u16(16).u16(46);
  P.write(w);
  // method_info
  w.u30(methods.length);
  for (const mt of methods) { w.u30(mt.params.length).u30(mt.ret); mt.params.forEach((p) => w.u30(p)); w.u30(0).u8(0); }
  w.u30(0); // metadata
  // instances (1)
  w.u30(1);
  w.u30(N.Host).u30(N.Sprite).u8(0).u30(0).u30(iinit);
  const itraits = [
    () => w.u30(N.objs).u8(0).u30(0).u30(0).u30(0), // slot objs:* (slot_id 0, type 0, vindex 0)
    ...[[N.add, mAdd], [N.rm, mRm], [N.idx, mIdx], [N.bounds, mBounds], [N.op, mOp]].map(([n, mi]) => () => w.u30(n).u8(1).u30(0).u30(mi)),
  ];
  w.u30(itraits.length); itraits.forEach((f) => f());
  // classes (1)
  w.u30(cinit).u30(0);
  // scripts (1)
  w.u30(1).u30(sinit).u30(1).u30(N.Host).u8(4).u30(1).u30(0);
  // method bodies
  w.u30(methods.length);
  methods.forEach((mt, i) => {
    w.u30(i).u30(mt.stack).u30(mt.locals).u30(3).u30(6).u30(mt.code.length).bytes(mt.code).u30(0).u30(0);
  });
  return w.toU8();
}

// ----------------------------------------------------------------------------------------- SWF container
function tag(code, body) {
  const w = new Bytes();
  if (body.length < 63) w.u16((code << 6) | body.length); else { w.u16((code << 6) | 63); w.u32(body.length); }
  return w.bytes(body).toU8();
}

/** Pack a RECT of non-negative twips: [0, w, 0, h]. */
function rect(wTw, hTw) {
  const nbits = 16; // 15 magnitude bits + sign
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(nbits, 5); put(0, nbits); put(wTw, nbits); put(0, nbits); put(hTw, nbits);
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return out;
}

/** The uncompressed host SWF bytes for a stage of `w` x `h` pixels. */
export function buildHostSwf(w = 550, h = 310) {
  const abc = new Bytes().u32(0).cstr('host').bytes(buildAbc()).toU8();
  const body = new Bytes();
  body.bytes(rect(w * 20, h * 20)).u16(24 << 8).u16(1);
  body.bytes(tag(69, Uint8Array.of(0x09, 0, 0, 0))); // FileAttributes: AS3 + network
  body.bytes(tag(9, Uint8Array.of(255, 255, 255))); // background (alpha handled by wmode:transparent)
  body.bytes(tag(82, abc));
  body.bytes(tag(76, new Bytes().u16(1).u16(0).cstr(SYMBOL).toU8()));
  body.bytes(tag(1, new Uint8Array(0)));
  body.bytes(tag(0, new Uint8Array(0)));
  const bodyBytes = body.toU8();
  const head = new Bytes().u8(0x46).u8(0x57).u8(0x53).u8(19).u32(8 + bodyBytes.length);
  const out = new Uint8Array(8 + bodyBytes.length);
  out.set(head.toU8(), 0); out.set(bodyBytes, 8);
  return out;
}
