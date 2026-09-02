import { apiPost } from './client';

/** JSON body of a successful POST /convert (speech-to-speech voice change). */
export interface ConvertResult {
  id: string;
  /** Backend-relative path (`/audio/<take>.wav`) — prefix with `API` to play. */
  audio_url: string;
  /** What the ASR heard in the source clip (the re-synthesized script). */
  text: string;
  duration_s: number;
  gen_time_s: number;
}

/**
 * Convert a spoken clip into an existing voice profile's voice.
 * Multipart: `audio` (source clip), `profile_id`, `match_duration` ('1'|'0').
 */
export async function convertSpeech(formData: FormData): Promise<ConvertResult> {
  return apiPost<ConvertResult>('/convert', formData);
}
