import { useEffect, useRef, useState } from 'react';

// Minimal Web Speech shapes (not in standard DOM typings) — same approach as
// useSpeechDictation, plus onerror which the wake listener needs for retry.
interface WakeRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: WakeRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
}
interface WakeAltLike { transcript: string; confidence?: number }
type WakeResultLike = { isFinal?: boolean } & Record<number, WakeAltLike | undefined>;
interface WakeRecognitionEventLike {
  resultIndex: number;
  results: { length: number } & Record<number, WakeResultLike>;
}
type WakeRecognitionCtor = new () => WakeRecognitionLike;

function getCtor(): WakeRecognitionCtor | undefined {
  const win = window as unknown as {
    SpeechRecognition?: WakeRecognitionCtor;
    webkitSpeechRecognition?: WakeRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

const LOCALE: Record<string, string> = {
  en: 'en-US',
  fr: 'fr-CA',
  es: 'es-ES',
};

// "Hey Ninja" as the recognizers actually transcribe it across en/fr/es
// ("hé ninja", "et ninja", "oye ninja"…), or "ninja" alone as the whole phrase.
const WAKE_RE = /\b(?:hey|hé|he|eh|ei|et|ok|okay|oye|ey)[\s,]*ninja\b/i;
const BARE_RE = /^\s*ninja[\s.!?]*$/i;

// Permanent failures — stop retrying instead of hammering a denied mic.
const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

/**
 * Hands-free wake word: keeps a continuous speech recognizer running while
 * `enabled` and fires `onWake` when the user says "Hey Ninja". The recognizer
 * is stopped whenever `enabled` goes false — callers must disable it while the
 * chat's dictation mic is active (browsers allow one recognizer at a time).
 */
export function useWakeWord(enabled: boolean, lang: string, onWake: () => void) {
  const [listening, setListening] = useState(false);
  // Why the mic is NOT live, when it should be — surfaced in the standby chip
  // so a silently-denied permission is visible instead of a dead feature.
  const [blocked, setBlocked] = useState<false | 'permission' | 'insecure'>(false);
  const cbRef = useRef(onWake);
  cbRef.current = onWake;
  const supported = typeof window !== 'undefined' && !!getCtor();

  useEffect(() => {
    if (!enabled) return;
    // Web Speech recognition only works on secure origins (https / localhost).
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setBlocked('insecure');
      return;
    }
    const Ctor = getCtor();
    if (!Ctor) return;
    setBlocked(false); // every (re)arm is a fresh chance

    let disposed = false;
    let fatal = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rec: WakeRecognitionLike | null = null;

    const startRec = () => {
      if (disposed || fatal) return;
      const r = new Ctor();
      rec = r;
      r.lang = LOCALE[lang] ?? LOCALE.en;
      r.continuous = true;
      r.interimResults = true;
      const startedAt = Date.now();
      let woke = false;
      r.onresult = (event) => {
        failures = 0;
        if (woke) return;
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const res = event.results[i];
          const alt = res?.[0];
          const transcript = alt?.transcript ?? '';
          // The full "hey ninja" phrase is specific enough to trust even on
          // interim results (fast). A bare "ninja" is looser — nearby chatter
          // could contain it — so it needs a FINAL result and, when the engine
          // gives a score, decent confidence.
          const phrase = WAKE_RE.test(transcript);
          const bare =
            !phrase &&
            BARE_RE.test(transcript) &&
            res?.isFinal === true &&
            (typeof alt?.confidence !== 'number' || alt.confidence <= 0 || alt.confidence >= 0.6);
          if (phrase || bare) {
            woke = true;
            r.stop();
            cbRef.current();
            return;
          }
        }
      };
      r.onerror = (event) => {
        if (event.error && FATAL_ERRORS.has(event.error)) {
          fatal = true;
          setListening(false);
          setBlocked('permission');
        }
      };
      // Chrome ends continuous recognition after silence — restart with a
      // small backoff so a broken mic/service can't hot-loop. A session that
      // LIVED a while is the normal silence cycle, not a failure: restart it
      // fast, or the growing backoff opens multi-second deaf gaps in which a
      // real "Hey Ninja" is simply missed.
      r.onend = () => {
        setListening(false);
        if (disposed || fatal || woke) return;
        if (Date.now() - startedAt > 5000) failures = 0;
        else failures += 1;
        timer = setTimeout(startRec, 400 * Math.min(Math.max(failures, 1), 8));
      };
      try {
        r.start();
        setListening(true);
      } catch {
        // Another recognizer is active (dictation) — retry shortly.
        timer = setTimeout(startRec, 1500);
      }
    };

    startRec();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      try { rec?.stop(); } catch { /* already stopped */ }
      setListening(false);
    };
  }, [enabled, lang]);

  return { supported, listening: enabled && listening, blocked: enabled ? blocked : false };
}
