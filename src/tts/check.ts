/** Probe every TTS provider once: `bun run tts:check`. */
import { mp3Duration } from "../mp3.ts";
import { providers } from "./providers.ts";
import { allVoices } from "./voices.ts";

export type ProbeResult = { provider: string; voice: string; ok: boolean; ms: number; detail: string };

export async function probe(providerId: string, text = "Hello, this is a test."): Promise<ProbeResult> {
  const entry = Object.entries(allVoices).find(([, v]) => v.source === providerId);
  const started = performance.now();
  if (!entry) return { provider: providerId, voice: "-", ok: false, ms: 0, detail: "no voices defined" };
  const [id, voice] = entry;
  try {
    const mp3 = await providers[providerId]!.synth(voice, text);
    const seconds = mp3Duration(mp3);
    return {
      provider: providerId, voice: id, ok: seconds > 0, ms: Math.round(performance.now() - started),
      detail: seconds > 0 ? `${mp3.length} bytes, ${seconds.toFixed(2)}s` : `not mp3 (${mp3.length} bytes)`,
    };
  } catch (e) {
    return { provider: providerId, voice: id, ok: false, ms: Math.round(performance.now() - started), detail: String(e instanceof Error ? e.message : e) };
  }
}

export async function probeAll(): Promise<ProbeResult[]> {
  return Promise.all(Object.keys(providers).map((p) => probe(p)));
}

if (import.meta.main) {
  const results = await probeAll();
  for (const r of results) console.log(`${r.ok ? "OK  " : "DEAD"} ${r.provider.padEnd(11)} ${r.voice.padEnd(12)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} providers respond`);
}
