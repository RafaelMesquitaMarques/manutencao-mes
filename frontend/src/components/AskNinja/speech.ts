import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../store/authStore';
import { usePlantStore } from '../../store/plantStore';

// Same i18n-language → BCP-47 mapping as useSpeechDictation, so the ninja
// hears and speaks the same locale.
export const LOCALE: Record<string, string> = {
  en: 'en-US',
  fr: 'fr-CA',
  es: 'es-ES',
};

/** Flatten a markdown chat answer into plain speakable prose. */
export function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^[|\s:-]+$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/---+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ── Voice preference (per app language) ────────────────────────────────────
// The OS ships whatever voices it ships — the browser default per locale is
// arbitrary (feminine Amélie for fr-CA, a masculine voice for en-US…), so the
// user can pin one; stored as {lang: voiceURI} in localStorage.

const VOICE_PICK_KEY = 'kaizo_tts_voice';

function readVoicePicks(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(VOICE_PICK_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function getPreferredVoiceURI(lang: string): string | null {
  return readVoicePicks()[lang] ?? null;
}

export function setPreferredVoice(lang: string, voiceURI: string | null) {
  const picks = readVoicePicks();
  if (voiceURI) picks[lang] = voiceURI;
  else delete picks[lang];
  localStorage.setItem(VOICE_PICK_KEY, JSON.stringify(picks));
}

// ── Premium voice (ElevenLabs via backend proxy) ────────────────────────────
// Stored in the same per-language pick map: 'elevenlabs' = the server's default
// voice; 'elevenlabs:<voice_id>' = a specific voice from the account.

export const ELEVEN_VOICE_URI = 'elevenlabs';

export const elevenUriFor = (voiceId: string) => `${ELEVEN_VOICE_URI}:${voiceId}`;

export function isElevenUri(uri: string | null): uri is string {
  return !!uri && (uri === ELEVEN_VOICE_URI || uri.startsWith(`${ELEVEN_VOICE_URI}:`));
}

const elevenIdFrom = (uri: string): string | undefined => {
  const i = uri.indexOf(':');
  return i === -1 ? undefined : uri.slice(i + 1) || undefined;
};

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = useAuthStore.getState().token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const plantId = usePlantStore.getState().activePlantId;
  if (plantId) headers['X-Plant-Id'] = plantId;
  return headers;
}

// Cached per page load — the key doesn't appear/disappear mid-session.
let elevenAvailable: boolean | null = null;
let elevenProbe: Promise<boolean> | null = null;

export function checkElevenLabs(): Promise<boolean> {
  if (elevenAvailable != null) return Promise.resolve(elevenAvailable);
  elevenProbe ??= (async () => {
    try {
      const res = await fetch('/api/intelligence/tts/status', { headers: authHeaders() });
      if (res.ok) {
        elevenAvailable = Boolean((await res.json()).available);
        return elevenAvailable;
      }
    } catch {
      /* fall through */
    }
    // Transient failure (expired token, backend booting…): report false NOW but
    // leave the cache empty so a later mount probes again.
    elevenProbe = null;
    return false;
  })();
  return elevenProbe;
}

/** Whether the premium (ElevenLabs) voice option should be offered. */
export function useElevenLabsAvailable(): boolean {
  const [avail, setAvail] = useState(elevenAvailable === true);
  useEffect(() => {
    let on = true;
    checkElevenLabs().then((v) => { if (on) setAvail(v); });
    return () => { on = false; };
  }, []);
  return avail;
}

// Short recurring phrases (fillers, greeting) replay constantly — keep their
// audio for the session so repeats don't even hit the network. The backend has
// a matching cross-user cache, so first-plays per phrase cost credits once.
const ttsBlobCache = new Map<string, Blob>();
const TTS_BLOB_CACHE_MAX = 64;
const TTS_CACHEABLE_CHARS = 120;

async function fetchTtsAudio(
  text: string, lang: string, voiceId?: string, signal?: AbortSignal,
): Promise<Blob | null> {
  const cacheKey = text.length <= TTS_CACHEABLE_CHARS ? `${voiceId ?? ''}|${lang}|${text}` : null;
  if (cacheKey) {
    const hit = ttsBlobCache.get(cacheKey);
    if (hit) return hit;
  }
  try {
    const res = await fetch('/api/intelligence/tts', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text, language: lang, ...(voiceId ? { voice_id: voiceId } : {}) }),
      signal,
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (cacheKey) {
      ttsBlobCache.set(cacheKey, blob);
      if (ttsBlobCache.size > TTS_BLOB_CACHE_MAX) {
        const oldest = ttsBlobCache.keys().next().value;
        if (oldest) ttsBlobCache.delete(oldest);
      }
    }
    return blob;
  } catch {
    return null;
  }
}

export interface ElevenVoice { voice_id: string; name: string }

let elevenVoices: ElevenVoice[] | null = null;
let elevenVoicesProbe: Promise<ElevenVoice[]> | null = null;

/** The configured account's ElevenLabs voices; fetched lazily when `active`. */
export function useElevenVoices(active: boolean): ElevenVoice[] {
  const [list, setList] = useState<ElevenVoice[]>(elevenVoices ?? []);
  useEffect(() => {
    if (!active) return;
    let on = true;
    elevenVoicesProbe ??= (async () => {
      try {
        const res = await fetch('/api/intelligence/tts/voices', { headers: authHeaders() });
        if (res.ok) {
          elevenVoices = ((await res.json()).voices ?? []) as ElevenVoice[];
          return elevenVoices;
        }
      } catch {
        /* fall through */
      }
      elevenVoicesProbe = null; // transient — retry on next open
      return [];
    })();
    elevenVoicesProbe.then((v) => { if (on) setList(v); });
    return () => { on = false; };
  }, [active]);
  return list;
}

// Android reports 'fr_CA'; normalize before comparing.
const normLang = (l: string) => l.replace('_', '-').toLowerCase();

/** The voice to speak with right now: the user's pick, else the locale default. */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const wanted = getPreferredVoiceURI(lang);
  // Premium URIs are not real system voices — fall through to the default.
  if (wanted && !isElevenUri(wanted)) {
    const v = voices.find((x) => x.voiceURI === wanted);
    if (v) return v;
  }
  const locale = normLang(LOCALE[lang] ?? LOCALE.en);
  return (
    voices.find((v) => normLang(v.lang) === locale) ??
    voices.find((v) => normLang(v.lang).startsWith(lang)) ??
    null
  );
}

/** Installed voices for the app language, exact-locale matches first. */
export function useVoicesForLang(lang: string): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const locale = normLang(LOCALE[lang] ?? LOCALE.en);
    const load = () => {
      const matching = window.speechSynthesis.getVoices()
        .filter((v) => normLang(v.lang).startsWith(lang));
      matching.sort(
        (a, b) =>
          Number(normLang(b.lang) === locale) - Number(normLang(a.lang) === locale) ||
          a.name.localeCompare(b.name),
      );
      setVoices(matching);
    };
    load(); // list may already be populated — or arrive via voiceschanged
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, [lang]);
  return voices;
}

// Chrome silently drops utterances longer than ~15s of audio; queueing
// sentence-sized chunks back-to-back avoids that without resume() timers.
function toChunks(text: string, max = 220): string[] {
  const sentences = (text.match(/[^.!?…\n]+[.!?…]*/g) ?? [text])
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > max) { chunks.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
    while (cur.length > max) { chunks.push(cur.slice(0, max)); cur = cur.slice(max).trim(); }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

interface PremiumItem {
  text: string;
  voiceId?: string;
  blob?: Promise<Blob | null>;
}

/**
 * Text-to-speech for the ninja. Two engines behind one interface:
 * - browser speechSynthesis (free, offline) — the default;
 * - ElevenLabs via the backend proxy, when the user picked the premium voice —
 *   sentence chunks are fetched as MP3s and played in order (next chunk
 *   prefetches while the current one plays); ANY failure flips the session
 *   back to the browser engine so the ninja never goes silent.
 * `speak` replaces ongoing speech; `enqueue` appends PLAIN text (streaming).
 */
export function useSpeechSynthesis(lang: string) {
  const [speaking, setSpeaking] = useState(false);
  // Bumped on every stop so events from cancelled utterances are ignored.
  const genRef = useRef(0);
  // Browser utterances still pending in the CURRENT generation.
  const leftRef = useRef(0);
  // Once the owning component unmounts, no straggler callback (an in-flight
  // stream delta, a late fallback) may ever start speech again.
  const disposedRef = useRef(false);
  // Premium pipeline state.
  const queueRef = useRef<PremiumItem[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pumpingRef = useRef(false);
  const premiumFailedRef = useRef(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  // Engine chosen at the FIRST enqueue of a generation and held for all of it —
  // changing the voice pick (or the availability probe resolving) mid-answer
  // must never have both engines speaking the same answer at once.
  const engineLockRef = useRef<{ gen: number; premium: boolean } | null>(null);

  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  // Some engines populate the voice list asynchronously; touching it early
  // lets the first speak() call find a matching voice. Also resolve whether
  // the premium proxy is configured, so enqueue can route synchronously.
  useEffect(() => {
    if (supported) window.speechSynthesis.getVoices();
    void checkElevenLabs();
  }, [supported]);

  const maybeIdle = useCallback((gen: number) => {
    if (genRef.current !== gen) return;
    if (leftRef.current <= 0 && queueRef.current.length === 0 && !audioRef.current) {
      setSpeaking(false);
    }
  }, []);

  const stop = useCallback(() => {
    genRef.current += 1;
    leftRef.current = 0;
    queueRef.current = [];
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    // Pausing fires 'pause' on the element; playBlob resolves on it because
    // the generation no longer matches.
    audioRef.current?.pause();
    audioRef.current = null;
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const speakChunksViaBrowser = useCallback((chunks: string[]) => {
    if (!supported || disposedRef.current || !chunks.length) return;
    const gen = genRef.current;
    const locale = LOCALE[lang] ?? LOCALE.en;
    // Resolved per call, so a new pick applies from the next sentence on.
    const voice = pickVoice(lang);

    leftRef.current += chunks.length;
    const done = () => {
      if (genRef.current !== gen) return;
      leftRef.current -= 1;
      maybeIdle(gen);
    };
    setSpeaking(true);
    for (const chunk of chunks) {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = locale;
      if (voice) u.voice = voice;
      u.rate = 1.04;
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.speak(u);
    }
  }, [lang, supported, maybeIdle]);

  // Resolves 'error' on decode/playback failure so pump can fall back to the
  // browser engine — a swallowed error would discard the whole answer silently.
  const playBlob = useCallback((blob: Blob, gen: number) => new Promise<'ok' | 'error'>((resolve) => {
    if (disposedRef.current || genRef.current !== gen) { resolve('ok'); return; }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audioRef.current = audio;
    const finish = (status: 'ok' | 'error') => {
      URL.revokeObjectURL(url);
      if (audioRef.current === audio) audioRef.current = null;
      resolve(status);
    };
    audio.onended = () => finish('ok');
    audio.onerror = () => finish('error');
    // stop() pauses us after bumping the generation — treat that as finished
    // (a natural end also pauses, but `finish` resolving twice is harmless).
    audio.onpause = () => { if (genRef.current !== gen) finish('ok'); };
    audio.play().catch(() => finish('error'));
  }), []);

  // Degrade to the browser engine for the rest of the session, re-speaking the
  // chunks premium never delivered. Also re-locks the CURRENT generation to the
  // browser engine so later sentences of this same answer don't re-queue premium.
  const failPremium = useCallback((gen: number, texts: string[]) => {
    premiumFailedRef.current = true;
    engineLockRef.current = { gen, premium: false };
    queueRef.current = [];
    speakChunksViaBrowser(texts);
  }, [speakChunksViaBrowser]);

  // The generation is re-read every iteration: when stop()+enqueue supersede us
  // mid-fetch (new question, speak() during playback), the SAME pump run must
  // carry on with the rebuilt queue — a bare return here would strand it (the
  // superseding enqueue's pump call bailed on pumpingRef).
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (!disposedRef.current && queueRef.current.length) {
        const gen = genRef.current;
        const item = queueRef.current[0];
        item.blob ??= fetchTtsAudio(item.text, lang, item.voiceId, fetchAbortRef.current?.signal);
        const blob = await item.blob;
        if (disposedRef.current) return;
        if (genRef.current !== gen) continue; // superseded — queue was rebuilt
        queueRef.current.shift();
        if (blob) {
          // Prefetch the following sentence while this one plays.
          const next = queueRef.current[0];
          if (next) next.blob ??= fetchTtsAudio(next.text, lang, next.voiceId, fetchAbortRef.current?.signal);
          const status = await playBlob(blob, gen);
          if (disposedRef.current) return;
          if (genRef.current !== gen) continue;
          if (status === 'error') {
            // Undecodable audio / blocked playback — same degradation as a
            // failed fetch, and the failed chunk is re-spoken, not dropped.
            failPremium(gen, [item.text, ...queueRef.current.map((i) => i.text)]);
            return;
          }
        } else {
          // Quota out / key gone / network — degrade for the whole session.
          failPremium(gen, [item.text, ...queueRef.current.map((i) => i.text)]);
          return;
        }
      }
    } finally {
      pumpingRef.current = false;
      maybeIdle(genRef.current);
    }
  }, [lang, playBlob, failPremium, maybeIdle]);

  // Append already-plain text to the queue without cancelling what's speaking.
  const enqueue = useCallback((plain: string) => {
    if (disposedRef.current) return;
    const chunks = toChunks(plain);
    if (!chunks.length) return;
    const gen = genRef.current;
    const pick = getPreferredVoiceURI(lang);
    let premium: boolean;
    if (engineLockRef.current?.gen === gen) {
      premium = engineLockRef.current.premium;
    } else {
      premium =
        elevenAvailable === true &&
        !premiumFailedRef.current &&
        isElevenUri(pick);
      engineLockRef.current = { gen, premium };
    }
    if (premium) {
      const voiceId = isElevenUri(pick) ? elevenIdFrom(pick) : undefined;
      fetchAbortRef.current ??= new AbortController();
      queueRef.current.push(...chunks.map((text) => ({ text, voiceId })));
      setSpeaking(true);
      void pump();
    } else {
      speakChunksViaBrowser(chunks);
    }
  }, [lang, pump, speakChunksViaBrowser]);

  const speak = useCallback((text: string) => {
    if (disposedRef.current) return;
    stop();
    enqueue(stripMarkdownForSpeech(text));
  }, [stop, enqueue]);

  // Which engine is (or would be) doing the talking right now — the voice-mode
  // stall reconciler must only second-guess the browser engine.
  const getEngine = useCallback((): 'premium' | 'browser' => (
    queueRef.current.length || audioRef.current ? 'premium' : 'browser'
  ), []);

  // Live "is anything audible or pending on EITHER engine" check — for
  // decisions made right after an await, where React state would be stale.
  const isActive = useCallback((): boolean => {
    if (queueRef.current.length || audioRef.current) return true;
    if (leftRef.current > 0) return true;
    if (supported) {
      const s = window.speechSynthesis;
      if (s.speaking || s.pending) return true;
    }
    return false;
  }, [supported]);

  // Never leave the ninja talking after the chat unmounts. The flag is reset
  // on (re)mount — StrictMode runs setup→cleanup→setup, and without the reset
  // the cleanup's `disposed` would silence the hook forever in dev.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stop();
    };
  }, [stop]);

  return { supported, speaking, speak, enqueue, stop, getEngine, isActive };
}
