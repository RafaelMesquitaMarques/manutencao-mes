import { LOCALE } from './speech';

// Minimal Web Speech shapes (not in standard DOM typings).
interface UttRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: UttRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
}
interface UttAltLike { transcript: string; confidence?: number }
type UttResultLike = { isFinal?: boolean } & Record<number, UttAltLike | undefined>;
interface UttRecognitionEventLike {
  results: { length: number } & Record<number, UttResultLike>;
}
type UttRecognitionCtor = new () => UttRecognitionLike;

function getCtor(): UttRecognitionCtor | undefined {
  const win = window as unknown as {
    SpeechRecognition?: UttRecognitionCtor;
    webkitSpeechRecognition?: UttRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

export const utteranceSupported = () => typeof window !== 'undefined' && !!getCtor();

export interface UtteranceResult {
  /** Full transcript ('' on silence, error, or stop()). */
  text: string;
  /** Recognizer confidence of the FINAL transcript (0–1), or null when the
   * engine gave no usable signal (some platforms report 0/none). */
  confidence: number | null;
}

export interface UtteranceSession {
  result: Promise<UtteranceResult>;
  /** Abort listening; the promise resolves with empty text. */
  stop: () => void;
}

/**
 * Voice-conversation turn: listen for ONE utterance and resolve when the user
 * stops talking. Non-continuous recognition gives us end-of-speech detection
 * for free — the engine finalizes and fires onend after a short silence.
 */
export function startUtterance(lang: string, onInterim?: (text: string) => void): UtteranceSession {
  let stopped = false;
  let rec: UttRecognitionLike | null = null;

  const result = new Promise<UtteranceResult>((resolve) => {
    const Ctor = getCtor();
    if (!Ctor) { resolve({ text: '', confidence: null }); return; }
    const r = new Ctor();
    rec = r;
    r.lang = LOCALE[lang] ?? LOCALE.en;
    r.continuous = false;
    r.interimResults = true;
    let transcript = '';
    let confidence: number | null = null;
    r.onresult = (event) => {
      let text = '';
      let confSum = 0;
      let confN = 0;
      for (let i = 0; i < event.results.length; i += 1) {
        const res = event.results[i];
        const alt = res?.[0];
        text += alt?.transcript ?? '';
        // Only FINAL results carry meaningful confidence; 0 is a known
        // "no signal" quirk on some platforms, not a real score.
        if (res?.isFinal && typeof alt?.confidence === 'number' && alt.confidence > 0) {
          confSum += alt.confidence;
          confN += 1;
        }
      }
      transcript = text.trim();
      if (confN) confidence = confSum / confN;
      if (transcript) onInterim?.(transcript);
    };
    // 'no-speech' & friends end the session; onend always follows.
    r.onerror = () => {};
    r.onend = () => resolve(stopped ? { text: '', confidence: null } : { text: transcript, confidence });
    try {
      r.start();
    } catch {
      resolve({ text: '', confidence: null });
    }
  });

  return {
    result,
    stop: () => {
      stopped = true;
      try { rec?.stop(); } catch { /* already stopped */ }
    },
  };
}
