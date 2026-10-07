# HTTP API

Every response carries permissive CORS headers. Default address: `http://127.0.0.1:4343`.

## Redrawn API (used by the new frontend)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version }` liveness check. |
| GET | `/ajax/config` | Client configuration for the frontend. |
| GET | `/ajax/movie/list` | Saved movies with metadata. |
| GET | `/ajax/movie/presave`, `/ajax/movie/open` | Editor save and open handshakes. |
| POST | `/api/movies/save` | Save a movie from the Studio. |
| DELETE | `/api/movies/:id` | Delete a movie (also `GET /deleteMovie/:id`). |
| GET | `/studio` | The HTML Studio editor. |
| GET | `/api/tts/providers` | Which TTS providers are enabled and reachable. |
| GET | `/cc`, `/cc_browser`, `/go_full`, `/player` | Editor pages, served from `EDITOR_PAGE` (default `/editor.html`). |

## Legacy GoAnimate API (used by the Flash SWFs)

| Area | Paths |
| --- | --- |
| Themes | `POST /goapi/getThemeList`, `/goapi/getTheme` |
| Characters | `POST /goapi/getCCPreMadeCharacters`, `/goapi/getCcCharCompositionXml`, `/goapi/saveCCCharacter`, `/upload_character`; `GET /characters/:file`, `/go/character_creator/...` |
| Assets | `GET/POST /goapi/getUserAssets`, `/goapi/getUserAssetsXml`, `/api_v2/assets/team`, `/api_v2/assets/shared`; `POST /goapi/getAsset`, `/goapi/getAssetEx`, `/upload_asset`; `GET /assets/:movieId/:assetId` |
| Movies | `POST /goapi/saveMovie`, `/goapi/getMovie`, `/goapi/saveTemplate`, `/upload_movie`; `GET /movies/:file`, `/movieList`, `/meta/:id`, `/movie_thumbs/:file`, `/starter_thumbs/:file` |
| Text to speech | `POST /goapi/getTextToSpeechVoices`, `/goapi/convertTextToSoundAsset` |
| Misc | `POST /goapi/heartbeat/v1`, `/goapi/getUserWatermarks`, `/goapi/getMovieInfo`; `GET /crossdomain.xml`, `/goapi/getAssetTags`, `/stock_thumbs/:file` |

The authoritative list is `src/routes/legacy.ts` and `src/routes/app.ts`.
