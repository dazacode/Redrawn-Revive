# Development

## Setup

Requires [Bun](https://bun.sh) 1.x.

```sh
bun install
bun run dev        # hot-reloading server on http://127.0.0.1:4343
```

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Server with `--hot` reload. |
| `bun run start` | Server without reload. |
| `bun test` | Runs the suite in `tests/` (`tests/setup.ts` is preloaded via `bunfig.toml`). |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run tts:check` | Probes every TTS provider and prints which ones respond. |
| `bun public/dev/serve.ts` | Static preview of `public/` without the backend; open `http://localhost:5173/?mock`. |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4343` | Listen port. |
| `HOST` | `127.0.0.1` | Listen address. |
| `DATA_DIR` | `./data` | Where `saved/` and `cache/` live. |
| `ASSETS_DIR` | `./server` | Original static game assets. |
| `PUBLIC_DIR` | `./public` | Frontend files. |
| `EDITOR_PAGE` | `/editor.html` | Target of `/go_full`, `/cc`, `/player`. |
| `TTS_PROVIDERS` | `nuance,svox` | `all`, `none`, or a comma-separated provider list. |
| `ISPEECH_API_KEY` | built-in public demo key | Key for the iSpeech provider. |

## Tests

Tests cover the server (`app`, `ids`, `mp3`, `zip-xml`) and the Studio logic (movie XML round-tripping, store, stage math, timeline, themes, assets panel, save API).

Known failure: `studio-swf-audio` "extracts an MP3 from encrypted common sounds" currently fails because the extracted audio starts with an ID3 tag (`0x49`) rather than an MPEG frame sync (`0xFF`). The extraction works, the assertion is too strict.

## Contributing

Open an issue or pull request. Keep the frontend dependency-free (plain ES modules), and add a test with any change to ids, movie XML or the save API.
