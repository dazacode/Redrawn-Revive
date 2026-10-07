# Redrawn Studio: build contract

New HTML/JS video editor at `/studio`, replacing the Flash `go_full.swf` UI. The old editor stays at `/go_full` (link it as "Classic editor").
No framework, no build step: plain ES modules in `public/js/studio/`, CSS in `public/css/studio.css`, page `public/studio.html`.
Reuse `public/css/tokens.css`, `base.css`, `components.css`, `public/js/shell.js` (initShell), `api.js`, `icons.js`. Match the existing site look; this is a modern, polished, dark/light-aware UI, not a Flash lookalike.
Flash assets (SWF) are rendered by Ruffle (self-hosted at `/vendor/ruffle/`, see `public/js/player.js` for the load/config pattern: needs `compatibilityRules:false`, default `wgpu-webgl` renderer, NOT plain `webgl`). Never run more Ruffle instances than needed; pause hidden/offscreen ones.

## Ownership (do not edit files you do not own; ask via your final report)
| Agent | Owns |
|---|---|
| core | `model.js`, `store.js`, `movie-xml.js`, `themes.js`, `ids.js`, `tests/studio-*.test.ts` |
| stage | `stage.js`, `ruffle-pool.js`, `thumbs.js` |
| assets | `assets-panel.js`, `css/studio-assets.css` |
| timeline | `timeline.js`, `audio.js`, `css/studio-timeline.css` |
| shell | `public/studio.html`, `studio.js`, `inspector.js`, `toolbar.js`, `export.js`, `css/studio.css`, route wiring in `src/` for `/studio`, nav link in `shell.js` |

## Data model (core owns; JSDoc typedefs in `model.js`; everyone imports types from there)
```
Movie  { id: string|null, title: string, themeId: string, width: 550, height: 310,
         scenes: Scene[], sounds: SoundClip[], meta: {} }
Scene  { id, duration: ms, bg: Elem|null, chars: Elem[], props: Elem[], bubbles: Bubble[],
         effects: Elem[], camera: {x,y,zoom}|null, transitionOut: string|null }
Elem   { id, assetId: string /* dotted legacy id e.g. "common.Diner_bg.swf" */, x, y, scale, rotation,
         flip: boolean, z: number, action?: string, emotion?: string, start?: ms, end?: ms }
Bubble { id, text, x, y, style, targetId?: string /* char Elem id */, start, end }
SoundClip { id, kind: 'bgmusic'|'voice'|'sfx'|'tts', assetId, start: ms, end: ms, volume: 0..1, text?, voice? }
```
Coordinates are stage pixels in a 550x310 space (origin top-left). Times are ms from scene start (scene clips) or movie start (SoundClip).
`movie-xml.js`: `parseMovieXml(xml:string): Movie`, `serializeMovie(m: Movie): string`. Must round-trip movies the legacy editor saves (see `src/pack.ts`, `src/movies.ts`, `wrapper/`, `data/saved/`); unknown tags are preserved in `meta.raw` and re-emitted. Must be reversible: tests with real/legacy samples.

## store.js
`createStore(initialMovie)` -> `{ get(): State, subscribe(fn): unsub, dispatch(cmd), undo(), redo(), canUndo(), canRedo(), markSaved(), isDirty() }`
State = `{ movie, selection: {sceneId, elemId|null, kind}, playhead: ms (movie-absolute), playing: boolean, zoom }`.
Commands (`{type, ...}`), all undoable unless noted (UI-only types: select, setPlayhead, setPlaying, setZoom):
`addScene{index?, scene?}`, `removeScene{sceneId}`, `duplicateScene`, `moveScene{sceneId,toIndex}`, `setSceneProps{sceneId,patch}`,
`setBackground{sceneId, assetId}`, `addElem{sceneId, kind:'char'|'prop'|'effect', assetId, x?,y?}`, `updateElem{sceneId, elemId, patch}`, `removeElem{sceneId, elemId}`, `reorderElem{...}`,
`addBubble`, `updateBubble`, `removeBubble`, `addSound`, `updateSound`, `removeSound`, `setTitle`, `setTheme`, `loadMovie{movie}` (resets history).
Continuous drags use `{..., coalesce: 'drag-<id>'}` so one drag = one undo step.

## themes.js
`loadThemeList(): Promise<ThemeSummary[]>`, `loadTheme(id): Promise<Theme>`, `assetUrl(assetId, themeId?): string` (maps `common.Diner_bg.swf` to `/store/<storeId>/common/bg/Diner_bg.swf`; storeId from `/ajax/config`; verify against `src/pack.ts`).
`Theme = { id, name, backgrounds: BgAsset[], characters: CharAsset[] /* with actions grouped by category: emotion, action, motion */, props: PropAsset[], sounds: SoundAsset[], effects: [] }`; each asset has `{assetId, name, thumbUrl?: string, tags}`. Cache results in memory.

## stage.js (stage agent)
`createStage(container, { store, themes }) -> Stage` where Stage = `{ play(), pause(), seek(ms), setPlayhead..., hitTest(x,y): {elemId,kind}|null, setTool..., destroy(), thumbnail(assetId, size): Promise<Blob|string> }`.
Renders the current scene of `store.get()` at 550x310 scaled to fit (crisp, integer-ish scaling; no letterbox artifacts), via Ruffle instances from `ruffle-pool.js` (pooled, max ~12 live, reuse across assets, pause offscreen). Interactive editing overlay (selection box, drag to move, corner handles to scale/rotate, flip, delete key) dispatching `updateElem` with coalescing. Plays the movie: scene durations, character actions, bubbles, sound sync via `audio.js` clock (`audio.js` exports `createAudioEngine(store) -> {play(fromMs), pause(), seek(ms), onTime(cb)}`; stage consumes it).
`thumbs.js`: `getAssetThumb(assetId, kind): Promise<string /*object/data URL*/>`: uses same-named JPG/PNG if present beside the SWF, else renders the SWF's first/representative frame with Ruffle offscreen and caches in memory + IndexedDB. Must be throttled (concurrency 2) and never block the UI.

## assets-panel.js (assets agent)
`mountAssetsPanel(el, { store, themes, stage }) -> { destroy }`: left sidebar with tabs Backgrounds / Characters / Props / Text & Speech / Music & Sound / Effects, theme switcher, search, virtualized thumbnail grid (thousands of items), lazy thumbs via `thumbs.js`, click or drag onto the stage to add (`setBackground` / `addElem`), character picker shows actions/emotions, loading skeletons and empty states.

## timeline.js (timeline agent)
`mountTimeline(el, { store, stage, audio }) -> { destroy }`: bottom panel: scene strip (thumbnails, drag-reorder, add/duplicate/delete, per-scene duration drag), tracks for voice/music/sfx with waveforms or bars (drag, trim, volume), playhead scrubbing, zoom, play/pause/loop controls with keyboard (space, arrows, J/K/L). Text-to-speech dialog calling `POST /goapi/getTextToSpeechVoices` and `/goapi/convertTextToSoundAsset` (see `src/routes/legacy.ts` for request and response shape), upload audio via `/upload_asset`.

## shell (shell agent)
`studio.html` + `studio.js`: layout grid (top toolbar, left assets panel, center stage, right inspector, bottom timeline), responsive down to ~1100px, panels resizable and collapsible, saves layout to localStorage (try/catch). Boots: parse `?movieId=`, `loadMovie` from `/movies/<id>.xml` or new empty movie, `presave` via `api.presaveMovie`, autosave debounce (respect prefs.autosave), Save -> `POST /goapi/saveMovie` (check exact fields in `src/routes/legacy.ts`: base64 zip `body_zip` built via the same structure `src/pack.ts` produces, or use a simpler JSON/XML endpoint if one exists; add one in `src/routes/app.ts` if needed with tests), title editing, undo/redo buttons, preview full-screen, export (download movie XML/zip), keyboard shortcuts overlay, unsaved-changes guard, toasts. `inspector.js`: context-sensitive properties for selection (position, scale, rotation, flip, layer, action/emotion pickers, bubble text/style, sound volume, scene duration/transition/camera). Register the route `/studio` in the backend and add "Studio" plus a "Classic editor" link.

## Quality bar (all agents)
- Polished: consistent spacing, tokens, hover/focus/active/disabled states, empty/loading/error states, keyboard accessible, `prefers-reduced-motion` respected, dark and light themes. No emoji icons: use `icons.js` (add icons there only via a request to shell; otherwise inline SVG).
- Performance: no layout thrash, rAF-batched rendering, virtualized lists, no leaked listeners (every mount returns `destroy`).
- Code: match existing public/js style (ES modules, JSDoc, no deps, no build step). Bun backend code in TypeScript, strict. Add tests under `tests/` for pure logic (store, movie-xml, themes mapping, thumbs cache keys); run `bun test` and `bun run typecheck`; keep them green.
- Do not git commit. Do not modify the legacy editor, `wrapper/`, `spike/`, or other agents' files.
- Final report (under 300 words): files created, public API as implemented (deviations from this contract), what is verified vs untested, open issues.
