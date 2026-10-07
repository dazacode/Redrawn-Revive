# Spike: Ruffle vs. the legacy SWFs

Throwaway experiments for deciding whether [Ruffle](https://ruffle.rs) can run GoAnimate's `go_full.swf`, `cc.swf` and `player.swf` in a modern browser.

- `server.ts`: minimal server that serves a SWF through a given Ruffle build.
- `drive.mjs`, `drive2.mjs`: Playwright scripts that replay the click sequences in `steps*.json`.
- `*.png`: screenshots captured by those runs (character creator and full editor).
- `pub/`: the test page.

Not part of the product. The two large Ruffle builds this spike used (`ruffle/`, `ruffle-nightly/`, about 30 MB each) are git-ignored; the shipped copy is `public/vendor/ruffle`. To rerun, install deps with `bun install` here and point the scripts at a Ruffle build.
