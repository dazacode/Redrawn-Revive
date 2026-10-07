import raw from "./voices.json";

export type Voice = {
  country: string;
  language: string;
  gender: string;
  source: string;
  arg: string | string[];
  desc: string;
  polly_engine?: string;
};

export const allVoices = raw.voices as unknown as Record<string, Voice>;
export const languages = raw.languages as Record<string, string>;

export function voiceDesc(id: string): string {
  return allVoices[id]?.desc ?? id;
}
