import { chromium } from "playwright-core";
import fs from "fs";
// usage: node drive2.mjs <query> <stepsfile.json>   steps: [{wait:ms},{click:[x,y]},{shot:name},{key:'a'},{type:'..'},{dialog:'accept'}]
const [,, query, stepsFile] = process.argv;
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const pg = await ctx.newPage();
const noise = /AudioContext|fpdownload|Stream Error|Failing over|stub\.rs|ERR_FAILED|Access to fetch/;
pg.on('console', m => { const t = m.text().replace(/%c/g,'').replace(/ color: .*/,'').slice(0,300); if (!noise.test(t)) console.log(`[${m.type()}] ${t}`); });
pg.on('pageerror', e => console.log('[pageerror] ' + e.message));
pg.on('dialog', d => { console.log('[dialog] ' + d.message()); d.accept(); });
pg.on('response', r => { const u = r.url(); if (!/\/(animation|store|static|ruffle|ruffle-nightly)\//.test(u) && !u.endsWith('clientlog')) console.log(`[net] ${r.status()} ${r.request().method()} ${u.replace('http://localhost:4680','')}`); });
await pg.goto('http://localhost:4680/test?' + query, { waitUntil: 'commit', timeout: 600000 }); pg.setDefaultTimeout(600000);
for (const s of steps) {
  if (s.wait) await pg.waitForTimeout(s.wait);
  if (s.click) { await pg.mouse.click(s.click[0], s.click[1]); }
  if (s.move) await pg.mouse.move(s.move[0], s.move[1]);
  if (s.key) await pg.keyboard.press(s.key);
  if (s.type) await pg.keyboard.type(s.type, { delay: 50 });
  if (s.shot) { const t0=Date.now(); await pg.screenshot({ path: s.shot, timeout: 600000 }); console.log('screenshot took', Date.now()-t0); console.log('shot ' + s.shot); }
  if (s.eval) console.log('eval:', await pg.evaluate(s.eval));
}
await b.close();
