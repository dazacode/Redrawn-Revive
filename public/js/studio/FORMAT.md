# Legacy movie XML: what is known, what is inferred

No real saved movie exists in this repository (`data/saved/` only holds a character). The format below was
reverse-engineered from: `src/pack.ts` / `src/movies.ts` (what the server reads), `wrapper/data/parse.js`,
the theme XML in `data/themes/*.xml` (the composite backgrounds show the exact scene-element shape) and the
string constants of `go_full.swf` / `player.swf` (decompressed with zlib; constant-pool names such as `adelay`,
`mdelay`, `sfile`, `trimStart`, `fadein`, `bubbleAsset`, `effectAsset`, `aTran`, `face`, `index`).
**Verified** = the server code or a theme file reads or shows it. **Inferred** = seen only as a constant name
or reasoned. The round trip never depends on inferred details: unknown content is carried through untouched.

## Document

```
<film copyable="0" duration="SECONDS" published="0">      verified: duration (movies.ts movieMeta), rest inferred
  <meta><title><![CDATA[..]]></title> ...other tags kept verbatim </meta>   verified: title (movies.ts)
  <scene id="SCENE-0" adelay="FRAMES" [mdelay=".."]> ...children... </scene>*
  <sound id="SOUND-0"> film-level audio, see below </sound>*                verified: pack.ts reads film-level <sound>
  <asset id="s-0-1.mp3">BASE64</asset>*      embedded uploads/TTS audio (pack.ts / unpackMovie); xml assets are escaped text
  <cc_char file_name='ugc.char.C-0-1.xml' ...>..</cc_char>*   embedded custom characters (pack.ts embedCharacter)
  <thumb>BASE64 PNG</thumb>                  last child (extractThumb)
</film>
```

`film@duration` is seconds (sum of scene durations). `scene@adelay` is the scene length in frames at 24 fps
(inferred: constant `XML_ATTRIBUTE_ADELAY = "adelay"`; the numbers make sense as frames). `mdelay` is
preserved but unused. Scenes without `adelay` share the leftover film duration equally.

## Scene children (verified tags: bg, prop, char, effect/effectAsset, bubbleAsset from `pack.ts`)

Every asset element has `id` (`BG-0`, `CHARACTER-1`, `PROP-2`, `EFFECT-3`, `BUBBLE-4`; legacy style
`PREFIX-N`) and `index` (z-order, `compareSceneXmlZorder`; higher is in front). Transform children are the
ones used by theme composites: `x`, `y`, `xscale`, `yscale`, `face` (`1` normal, `-1` flipped), `rotation` (degrees).

| Tag | Content |
|---|---|
| `<bg>` | `<file>theme.name.swf</file>`; usually no transform (full bleed) |
| `<prop>` | `<file>`, transform |
| `<effect>` / `<effectAsset>` | `<file>`, transform (new effects are written as `effectAsset`) |
| `<char>` | `<action>theme.charId.action.swf</action>` (the action id carries char and current action; CC characters use `ugc.C-..` ids, `.xml` actions are character documents), transform, optional `<head><file>`, `<prop><file>` (pack.ts) and more (kept verbatim) |
| `<bubbleAsset>` | `<x>`,`<y>` anchor + `<bubble x y w h rotate type hasTail><body rgb linergb tailx taily/><text rgb font size align bold italic>TEXT</text></bubble>` (shape from theme `<bubble>` definitions; `text@font` verified by pack.ts) |
| `<trans>` | transition to the next scene (inferred; shape unknown, handled as `<trans><file>id</file></trans>` or text/attr) |
| anything else | preserved verbatim, in place (`scene.meta.raw`) |

Bubble `type` values in themes: `BLANK, BLANKTAIL, BOOM, CLOUD, ELLIPSE, HEART, RECTANGULAR, ROUNDRECTANGULAR`.
Model `bubble.style` is that value lower-cased. Effect types in themes: `ANIME, ZOOM, EARTHQUAKE, FADING, ...`
(zoom/pan are effects in the legacy format, so `scene.camera` has no legacy counterpart and is a Redrawn extension).

## Sound (film level)

`<sound id>` with `<sfile>` (`theme.name.swf|mp3` for store sounds, `ugc.<file>` for uploads/TTS; verified),
`<start>`, `<stop>` (frames, movie-absolute; inferred from constants `XML_NODE_NAME_START_FRAME/STOP_FRAME`),
`<trimStart>`, `<trimEnd>`, `<fadein dur vol/>`, `<fadeout dur vol/>` (kept verbatim) and, for TTS,
`<ttsdata><text/><voice/></ttsdata>` (verified, pack.ts). Theme sound `subtype` is `bgmusic | soundeffect | tribeofnoise`.

## Coordinate space (important, inferred from data)

Composite background props in `data/themes` span x ~ 0..640 (median 323) and y ~ 0..360. The legacy logical
stage is therefore **640x360**, not 550x310. The model uses 550x310 as the contract says: x and y are
multiplied by `LEGACY_K = 550/640` on load and divided on save; `scale` is left as-is (1 = native SWF size, so
the stage draws a SWF at `native * scale * LEGACY_K`). Setting `LEGACY_K = 1` in `model.js` disables it.
Unchanged values keep their original text on save, so no float drift.

## Redrawn extensions (unknown attributes are ignored by the Flash editor)

`rstart`/`rstop` (ms from scene start) on elements and bubbles, `rtarget` (the char's XML id) on `bubbleAsset`,
`rvolume` (0..1) and `rkind` (`bgmusic|voice|sfx|tts`) on `<sound>`, `<camera x y zoom/>` in a scene.
Without `rkind`, kind is inferred (ttsdata -> tts, id contains MUSIC/VOICE, else sfx).

## Model mapping and round trip

* Each parsed element keeps its XML node in `meta.node`; save clones it and patches only values that differ
  (numeric comparison with a 1e-6 tolerance), so unknown children, attribute order and number formatting survive.
* Film-level layout (`meta.layout`) and scene child order (`scene.meta.layout`) are replayed on save; new
  elements are appended (bg first, others by `z`).
* On save ids are legacy-style and unique (`PREFIX-N`); original ids are reused when still unique.
* `char.action` is the file part of the action id (`stand.swf`); setting it rewrites `<action>`. `emotion`
  is UI-only (emotions are ordinary actions of category `emotion`; set `action` to one) and is not saved.
* Not preserved: XML comments, processing instructions, original attribute quote style, empty-tag spelling.
* Asset files in `server/store` are obfuscated (first bytes are not `CWS/FWS`); the legacy SWFs decrypt them.
