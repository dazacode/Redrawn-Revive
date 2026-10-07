import { mp3Duration } from "../mp3.ts";
import { providers, TtsError } from "./providers.ts";
import { allVoices, type Voice } from "./voices.ts";

export { TtsError } from "./providers.ts";

/**
 * Providers that answered when last probed (2026-10-06, `bun run tts:check`). All the others scrape
 * third-party demo endpoints that are gone, so their voices are hidden from the voice list.
 * Override with TTS_PROVIDERS=all, none, or a comma separated list of provider ids.
 */
const DEFAULT_ENABLED = new Set<string>(["nuance", "svox"]);

export function enabledProviders(): Set<string> {
  const env = process.env.TTS_PROVIDERS?.trim();
  if (env === "none") return new Set();
  if (env === "all") return new Set(Object.keys(providers).filter((p) => p !== "voiceforge"));
  if (env) return new Set(env.split(",").map((s) => s.trim()).filter((s) => s in providers));
  return new Set(DEFAULT_ENABLED);
}

export function enabledVoices(): Record<string, Voice> {
  const on = enabledProviders();
  return Object.fromEntries(Object.entries(allVoices).filter(([, v]) => on.has(v.source)));
}

export async function synthesize(voiceId: string, text: string): Promise<{ mp3: Uint8Array; seconds: number }> {
  const voice = allVoices[voiceId];
  if (!voice) throw new TtsError(`unknown voice ${JSON.stringify(voiceId)}`);
  const provider = providers[voice.source];
  if (!provider || !enabledProviders().has(voice.source)) throw new TtsError(`provider ${voice.source} is unavailable`);
  if (!text.trim()) throw new TtsError("empty text");
  const mp3 = await provider.synth(voice, text);
  const seconds = mp3Duration(mp3);
  if (!seconds) throw new TtsError(`provider ${voice.source} did not return valid mp3 audio`);
  return { mp3, seconds };
}
