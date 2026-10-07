import type { Voice } from "./voices.ts";

/**
 * Text-to-speech providers. All of the legacy ones scrape public demo endpoints of third-party
 * sites, so any of them can disappear. Each provider throws on failure; callers turn that into a
 * clean error response. Run `bun run tts:check` to see which still respond.
 */
export interface TtsProvider {
  id: string;
  /** Synthesize mp3 audio. Must throw (never hang) on failure. */
  synth(voice: Voice, text: string): Promise<Uint8Array>;
}

export class TtsError extends Error {}

const TIMEOUT_MS = 20_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function http(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": UA, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new TtsError(`${new URL(url).host} responded ${res.status}`);
  return res;
}

async function bytes(url: string, init?: RequestInit): Promise<Uint8Array> {
  return new Uint8Array(await (await http(url, init)).arrayBuffer());
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

const arg = (v: Voice) => (Array.isArray(v.arg) ? v.arg.join(",") : v.arg);
const form = (o: Record<string, string | number | boolean>) =>
  new URLSearchParams(Object.entries(o).map(([k, v]): [string, string] => [k, String(v)])).toString();

const polly: TtsProvider = {
  id: "polly",
  async synth(voice, text) {
    const home = await http("https://voicemaker.in/");
    const res = await http("https://voicemaker.in/voice/standard", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookiesOf(home),
        "csrf-token": "",
        origin: "https://voicemaker.in",
        referer: "https://voicemaker.in/",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify({
        Engine: voice.polly_engine,
        Provider: "ai101",
        OutputFormat: "mp3",
        VoiceId: arg(voice),
        LanguageCode: `${voice.language}-${voice.country}`,
        SampleRate: "22050",
        effect: "default",
        master_VC: "advanced",
        speed: "0",
        master_volume: "0",
        pitch: "0",
        Text: text,
        TextType: "text",
        fileName: "",
      }),
    });
    const json = (await res.json()) as { path?: string };
    if (!json.path) throw new TtsError("voicemaker returned no file");
    return bytes(`https://voicemaker.in${json.path.replace(".", "")}`);
  },
};

const nuance: TtsProvider = {
  id: "nuance",
  synth: (voice, text) =>
    bytes(`https://voicedemo.codefactoryglobal.com/generate_audio.asp?${form({ voice_name: arg(voice), speak_text: text })}`),
};

const cepstral: TtsProvider = {
  id: "cepstral",
  async synth(voice, text) {
    const home = await http("https://www.cepstral.com/en/demos");
    const q = form({ voiceText: text, voice: arg(voice), createTime: 666, rate: 170, pitch: 1, sfx: "none" });
    const res = await http(`https://www.cepstral.com/demos/createAudio.php?${q}`, {
      headers: { Cookie: cookiesOf(home) },
    });
    const json = (await res.json()) as { mp3_loc?: string };
    if (!json.mp3_loc) throw new TtsError("cepstral returned no file");
    return bytes(`https://www.cepstral.com${json.mp3_loc}`);
  },
};

const vocalware: TtsProvider = {
  id: "vocalware",
  synth(voice, text) {
    const [eid, lid, vid] = voice.arg as string[];
    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(`${eid}${lid}${vid}${text}1mp35883747uetivb9tb8108wfj`);
    const q = form({
      EID: eid!, LID: lid!, VID: vid!, TXT: text, EXT: "mp3", IS_UTF8: 1, ACC: 5883747, cache_flag: 3,
      CS: hasher.digest("hex"),
    });
    return bytes(`https://cache-a.oddcast.com/tts/gen.php?${q}`, {
      headers: { Referer: "https://www.oddcast.com/", Origin: "https://www.oddcast.com" },
    });
  },
};

const watson: TtsProvider = {
  id: "watson",
  synth: (voice, text) =>
    bytes(
      `https://text-to-speech-demo.ng.bluemix.net/api/v3/synthesize?${form({
        text, voice: arg(voice), download: true, accept: "audio/mp3",
      })}`,
    ),
};

const acapela: TtsProvider = {
  id: "acapela",
  async synth(voice, text) {
    const res = await http("https://acapela-box.com/AcaBox/dovaas.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: "AcaBoxLogged=logged; AcaBoxUsername=goaniwrap; acabox=92s39r5vu676g5ekqehbu2o0f2; AcaBoxFirstname=Keegan",
        Origin: "https://acapela-box.com",
        Referer: "https://acapela-box.com/AcaBox/index.php",
      },
      body: form({ text, voice: arg(voice), listen: 1, format: "MP3", codecMP3: 1, spd: 180, vct: 100, byline: 0, ts: 666 }),
    });
    const json = (await res.json()) as { snd_url?: string };
    if (!json.snd_url) throw new TtsError("acapela returned no file");
    return bytes(json.snd_url);
  },
};

const acapelaOld: TtsProvider = {
  id: "acapelaOld",
  synth: (voice, text) =>
    bytes(
      `https://voice.reverso.net/RestPronunciation.svc/v1/output=json/GetVoiceStream/voiceName=${encodeURIComponent(
        arg(voice),
      )}?${form({ inputText: Buffer.from(text).toString("base64") })}`,
    ),
};

const svox: TtsProvider = {
  id: "svox",
  synth: (voice, text) =>
    bytes(
      `https://api.ispeech.org/api/rest?${form({
        apikey: process.env.ISPEECH_API_KEY || "e3a4477c01b482ea5acc6ed03b1f419f",
        action: "convert", format: "mp3", voice: arg(voice), speed: 0, text, version: "0.2.99",
      })}`,
    ),
};

const wavenet: TtsProvider = {
  id: "wavenet",
  async synth(voice, text) {
    const res = await http("https://texttospeechapi.wideo.co/api/wideo-text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://texttospeech.wideo.co",
        Referer: "https://texttospeech.wideo.co/",
      },
      body: JSON.stringify({ data: { text, speed: 1, voice: arg(voice) } }),
    });
    const json = (await res.json()) as { url?: string };
    if (!json.url) throw new TtsError("wideo returned no file");
    return bytes(json.url);
  },
};

const readloud: TtsProvider = {
  id: "readloud",
  async synth(voice, text) {
    const res = await http(`https://readloud.net${arg(voice)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ but1: text, butS: 0, butP: 0, butPauses: 0, but: "Submit" }),
    });
    const html = await res.text();
    const m = /\/tmp\/[^"'\s<>]+?\.mp3/.exec(html);
    if (!m) throw new TtsError("readloud returned no file");
    return bytes(`https://readloud.net${m[0]}`);
  },
};

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const cereproc: TtsProvider = {
  id: "cereproc",
  async synth(voice, text) {
    const res = await http("https://www.cereproc.com/themes/benchpress/livedemo.php", {
      method: "POST",
      headers: {
        "content-type": "text/xml",
        origin: "https://www.cereproc.com",
        referer: "https://www.cereproc.com/en/products/voices",
        "x-requested-with": "XMLHttpRequest",
        cookie: "Drupal.visitor.liveDemo=666",
      },
      body: `<speakExtended key='666'><voice>${xmlText(arg(voice))}</voice><text>${xmlText(text)}</text><audioFormat>mp3</audioFormat></speakExtended>`,
    });
    const body = await res.text();
    const m = /https:\/\/cerevoice\.s3\.amazonaws\.com\/[^"'\s<>]+?\.mp3/.exec(body);
    if (!m) throw new TtsError("cereproc returned no file");
    return bytes(m[0]);
  },
};

/** Legacy voiceforge voices needed a local PHP proxy (vfproxy); not supported. */
const voiceforge: TtsProvider = {
  id: "voiceforge",
  async synth() {
    throw new TtsError("voiceforge needs the legacy PHP proxy, which is not supported");
  },
};

export const providers: Record<string, TtsProvider> = Object.fromEntries(
  [polly, nuance, cepstral, vocalware, watson, acapela, acapelaOld, svox, wavenet, readloud, cereproc, voiceforge].map((p) => [p.id, p]),
);
