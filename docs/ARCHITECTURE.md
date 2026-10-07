# Architecture

Redrawn's Bun backend is a small, dependency-light HTTP server that emulates the GoAnimate "LVM" API the legacy Flash SWFs talk to, plus a modern HTML/JS frontend served from the same process.

```
 Browser ──► Bun.serve (src/index.ts)
              └─ handle() (src/app.ts)
                  ├─ Router  ─► routes/legacy.ts   GoAnimate API the SWFs call (/goapi/*, /upload_*, ...)
                  │          └► routes/app.ts      Redrawn's own JSON API (/api/*, /ajax/*, /studio)
                  └─ static  ─► public/  (frontend)  then  server/  (original game assets)
```

## Request pipeline

`src/app.ts` runs every request through the same steps:

1. `OPTIONS` is answered immediately with permissive CORS headers.
2. The router tries API routes first.
3. If nothing matched and the method is `GET`/`HEAD`, `serveStatic` looks in `public/` and then in `server/`.
4. Anything thrown is caught and returned as a legacy-style failure payload. The handler never throws.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Starts `Bun.serve`, creates data folders, migrates legacy `wrapper/_SAVED` data once (never overwrites). |
| `src/config.ts` | All settings and directory locations. Environment overrides live here. |
| `src/router.ts`, `src/http.ts` | Tiny router (string, `:param` and regex routes) and request context helpers. |
| `src/routes/legacy.ts` | Endpoints the Flash SWFs expect: themes, characters, assets, movies, TTS. |
| `src/routes/app.ts` | Endpoints for the new frontend: health, config, movie list/save/delete, TTS provider status. |
| `src/pack.ts`, `src/zip.ts`, `src/xml.ts` | Building the zip-and-XML payloads the SWFs consume. |
| `src/movies.ts`, `src/characters.ts`, `src/storage.ts` | Saved movies and characters on disk. |
| `src/ids.ts` | Asset and movie id parsing and formatting. |
| `src/cache.ts`, `src/fonts.ts`, `src/sessions.ts` | Response cache, font lookups, per-session state. |
| `src/mp3.ts` | MP3 frame parsing used to measure TTS clip duration. |
| `src/tts/` | Text-to-speech providers, the voice catalogue, and a probe script. |

## Directories

| Directory | Contents | In git? |
| --- | --- | --- |
| `data/themes`, `data/premade` | Theme and pre-made character XML. | yes |
| `data/saved` | Your movies, characters and uploads. | **no** (ignored) |
| `data/cache` | Generated cache. | **no** (ignored) |
| `public/` | The new frontend: dashboard, character browser, editor shell, the HTML Studio, vendored Ruffle. | yes |
| `server/` | Original GoAnimate static assets (SWFs, store, stock characters, thumbnails). | yes |
| `spike/` | Experiments used to evaluate Ruffle (Flash emulation) against the legacy SWFs. See `spike/README.md`. | yes (minus large duplicate builds) |

`DATA_DIR`, `ASSETS_DIR` and `PUBLIC_DIR` environment variables relocate the three roots.

## Frontend

`public/` is plain ES modules with no build step. Flash assets are rendered by [Ruffle](https://ruffle.rs), self-hosted under `public/vendor/ruffle`. The HTML video editor lives in `public/js/studio/`; its design contract and the reverse-engineered movie XML format are documented in `public/js/studio/CONTRACT.md` and `public/js/studio/FORMAT.md`.

## Text to speech

`src/tts/providers.ts` defines one adapter per upstream demo service. Most of those services have since disappeared, so only providers that answered the last probe are enabled by default (`nuance`, `svox`). Run `bun run tts:check` to probe every provider, and set `TTS_PROVIDERS` to `all`, `none`, or a comma-separated list to override. `GET /api/tts/providers` reports the live state.
