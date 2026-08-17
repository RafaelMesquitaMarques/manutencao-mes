import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, AudioWaveform, Loader2, MessageSquare, Mic, MicOff, Play, Send, Settings2, Sparkles, Volume2, VolumeX, X } from 'lucide-react';
import {
  askIntelligence, askIntelligenceStream, AskStreamServerError, type ChatMessage,
} from '../../api/intelligence';
import { useAuthStore } from '../../store/authStore';
import { useSpeechDictation } from '../../hooks/useSpeechDictation';
import {
  ELEVEN_VOICE_URI, elevenUriFor, getPreferredVoiceURI, setPreferredVoice, stripMarkdownForSpeech,
  useElevenLabsAvailable, useElevenVoices, useSpeechSynthesis, useVoicesForLang,
} from './speech';
import { startUtterance, utteranceSupported, type UtteranceSession } from './voice';
import VoiceOrb, { type VoiceOrbState } from './VoiceOrb';
import Markdown from '../ui/MiniMarkdown';

// One shared preference: once the user mutes/unmutes the ninja anywhere, it
// sticks everywhere. Unset = voice on only in the hud (Jarvis) variant.
const VOICE_PREF_KEY = 'kaizo_ask_ninja_voice';

// Accent/punctuation-insensitive form for comparing an utterance against what
// the ninja itself just said (echo detection).
const normEcho = (s: string) => s
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

interface AskNinjaChatProps {
  language: string;
  /** 'card' = glass card on the Intelligence page; 'hud' = holographic panel opened from the Home ninja. */
  variant?: 'card' | 'hud';
  /** Renders a close button and enables Escape-to-close (overlay usage). */
  onClose?: () => void;
  autoFocus?: boolean;
  /** "Hey Ninja" wake-word toggle state + handler (hud variant; owned by HomePage). */
  wakeEnabled?: boolean;
  onToggleWake?: () => void;
  /** Open straight into the hands-free voice conversation (wake-word entry). */
  autoVoice?: boolean;
}

type StreamStatus = { kind: 'thinking' } | { kind: 'tool'; name: string } | null;

/** Conversational Q&A over the platform's live data (tool-use agent). */
export default function AskNinjaChat({
  language, variant = 'card', onClose, autoFocus, wakeEnabled, onToggleWake, autoVoice,
}: AskNinjaChatProps) {
  const { t } = useTranslation();
  const isHud = variant === 'hud';
  // Suggested prompts — translated, so they follow the platform language.
  const exampleQs = [
    t('intelligence.example1', 'Compare IMA 04 with IMA 05'),
    t('intelligence.example2', 'Which machine broke down the most in the last 7 days?'),
    t('intelligence.example3', 'Which machine has the best availability rate?'),
  ];
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live streaming state: text of the in-progress answer + a status chip.
  const [streamText, setStreamText] = useState('');
  const [streamStatus, setStreamStatus] = useState<StreamStatus>(null);
  const [voiceOn, setVoiceOn] = useState<boolean>(() => {
    const saved = localStorage.getItem(VOICE_PREF_KEY);
    return saved != null ? saved === '1' : variant === 'hud';
  });
  // Mirror for in-flight stream callbacks: muting mid-answer must silence the
  // REST of the answer, not just the sentence currently playing.
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  // Voice picker: which system voice speaks in the current app language.
  const [showVoicePick, setShowVoicePick] = useState(false);
  const voices = useVoicesForLang(language);
  const premiumAvailable = useElevenLabsAvailable();
  // Account voices fetched only when the picker is actually open.
  const elevenVoices = useElevenVoices(showVoicePick && premiumAvailable);
  const [voicePick, setVoicePick] = useState<string>(() => getPreferredVoiceURI(language) ?? '');
  useEffect(() => {
    setVoicePick(getPreferredVoiceURI(language) ?? '');
  }, [language]);
  // One controller per send(); aborted on unmount so closing the panel stops
  // the SSE read loop (and with it any further TTS) and frees the backend.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  // Imperative in-flight flag (NOT a state mirror: send()'s finally clears it
  // synchronously, before React re-renders). The voice loop consults it so the
  // mic can never open while a question is still being answered.
  const busyFlagRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Streaming TTS bookkeeping: full text of the current turn + how much of it
  // has already been handed to the speech queue.
  const streamRef = useRef({ text: '', spoken: 0 });

  // ── Voice-conversation mode (hands-free loop) ────────────────────────────
  // Greet exactly like the Home hero: nickname when set, else first name.
  const authUser = useAuthStore((s) => s.user);
  const greetName =
    (authUser?.nickname ?? '').trim() ||
    ((authUser?.name ?? '').trim().split(/\s+/)[0] || authUser?.email || '');
  const [voiceMode, setVoiceMode] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoiceOrbState>('greeting');
  const [interim, setInterim] = useState('');
  const [greetText, setGreetText] = useState('');
  const voiceModeRef = useRef(false);
  voiceModeRef.current = voiceMode;
  const utterRef = useRef<UtteranceSession | null>(null);
  const idleRoundsRef = useRef(0);
  // What the ninja last said out loud — an "utterance" contained in it is the
  // mic catching our own voice tail, not the user.
  const lastSpokenRef = useRef('');
  // True once TTS actually started for the current greeting/answer, so the
  // falling edge of tts.speaking is a real "finished talking" signal.
  const sawSpeechRef = useRef(false);

  const tts = useSpeechSynthesis(language);
  const dictation = useSpeechDictation(
    (chunk) => setInput((v) => (v ? `${v} ${chunk}` : chunk)),
    language,
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy, streamText, streamStatus]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const toggleVoice = () => {
    setVoiceOn((v) => {
      const next = !v;
      localStorage.setItem(VOICE_PREF_KEY, next ? '1' : '0');
      if (!next) tts.stop();
      return next;
    });
  };

  // Last markdown-safe sentence boundary in `s`, or -1. A terminator only
  // counts when followed by whitespace, so "3.5" is never split mid-number —
  // the tail is flushed at stream end anyway.
  const lastBoundary = (s: string): number => {
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const ch = s[i];
      if (ch === '\n') return i + 1;
      if ((ch === '.' || ch === '!' || ch === '?' || ch === '…') && /\s/.test(s[i + 1] ?? '')) return i + 1;
    }
    return -1;
  };

  // Hand completed sentences of the in-progress turn to the speech queue.
  const speakNewSentences = (flush: boolean) => {
    const st = streamRef.current;
    const pending = st.text.slice(st.spoken);
    if (!pending) return;
    const upto = flush ? pending.length : lastBoundary(pending);
    if (upto <= 0) return;
    st.spoken += upto;
    const fragment = stripMarkdownForSpeech(pending.slice(0, upto));
    if (fragment) tts.enqueue(fragment);
  };

  // Whether the CURRENT moment wants spoken output — read live (not captured)
  // so muting mid-answer or leaving voice mode takes effect immediately.
  const wantSpeech = () => voiceModeRef.current || voiceOnRef.current;

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    if (dictation.isRecording) dictation.toggle();
    tts.stop();
    setError(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const next: ChatMessage[] = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setBusy(true);
    busyFlagRef.current = true;
    setStreamText('');
    setStreamStatus(null);
    streamRef.current = { text: '', spoken: 0 };
    // Spoken conversations get short, natural answers that offer details on
    // request; the text chat keeps the full report style.
    const mode = voiceModeRef.current ? 'voice' as const : 'text' as const;
    // Conversational fillers: while the agent is off fetching data (the dead
    // air right after a tool round), the ninja says a short line so the wait
    // feels alive. The phrases are short and cached (browser + backend), so
    // each costs ElevenLabs credits once per voice, then replays free.
    let fillersSpoken = 0;
    let fillerTimer: ReturnType<typeof setTimeout> | undefined;
    const speakFiller = () => {
      fillerTimer = undefined;
      if (!voiceModeRef.current || !wantSpeech()) return;
      if (fillersSpoken >= 2 || streamRef.current.text) return;
      fillersSpoken += 1;
      const pick = 1 + Math.floor(Math.random() * 5);
      tts.enqueue(stripMarkdownForSpeech(t(`hud.filler${pick}`)));
      // If the search drags on, one more line — then silence until the answer.
      fillerTimer = setTimeout(speakFiller, 9000);
    };
    try {
      const res = await askIntelligenceStream(next, language, {
        onDelta: (chunk) => {
          const st = streamRef.current;
          st.text += chunk;
          setStreamText(st.text);
          // Text is flowing — drop any stale "consulting…" chip (same-ref
          // return when already null keeps React from re-rendering).
          setStreamStatus((s) => (s ? null : s));
          if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = undefined; }
          if (wantSpeech()) speakNewSentences(false);
        },
        onTool: (name) => setStreamStatus({ kind: 'tool', name }),
        onStatus: (phase) => {
          if (phase === 'thinking') setStreamStatus((s) => s ?? { kind: 'thinking' });
        },
        onRound: () => {
          // Turn ended in a tool call: the streamed text was preliminary.
          streamRef.current = { text: '', spoken: 0 };
          setStreamText('');
          tts.stop();
          // The agent just went off to fetch data — the longest silent window.
          speakFiller();
        },
      }, ac.signal, mode);
      if (wantSpeech()) speakNewSentences(true);
      setMessages((m) => [...m, { role: 'assistant', content: res.answer }]);
      if (voiceModeRef.current) lastSpokenRef.current = res.answer;
    } catch (streamErr: unknown) {
      tts.stop();
      if (ac.signal.aborted) {
        // Panel closed (or a newer question superseded this one) — nothing to
        // report, and absolutely no fallback re-run of the agent.
        return;
      }
      if (streamErr instanceof AskStreamServerError) {
        setError(streamErr.message);
        // A silent return to listening reads as a bug — say what happened.
        if (voiceModeRef.current && wantSpeech()) {
          lastSpokenRef.current = t('hud.voiceError');
          tts.speak(lastSpokenRef.current);
        }
      } else {
        // Transport-level failure (proxy cut, older backend…) — fall back to
        // the plain endpoint rather than losing the question, and SAY so: the
        // retry doubles the wait and dead silence feels broken.
        try {
          if (voiceModeRef.current && wantSpeech()) tts.speak(t('hud.retrying'));
          const res = await askIntelligence(next, language, mode);
          setMessages((m) => [...m, { role: 'assistant', content: res.answer }]);
          if (voiceModeRef.current) lastSpokenRef.current = res.answer;
          if (wantSpeech()) tts.speak(res.answer);
        } catch (e: unknown) {
          const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
          setError(detail ?? t('intelligence.askError', 'Request failed. Please try again.'));
          if (voiceModeRef.current && wantSpeech()) {
            lastSpokenRef.current = t('hud.voiceError');
            tts.speak(lastSpokenRef.current);
          }
        }
      }
    } finally {
      if (fillerTimer) clearTimeout(fillerTimer);
      busyFlagRef.current = false;
      setBusy(false);
      setStreamText('');
      setStreamStatus(null);
    }
  };

  // ── Voice-conversation loop ──────────────────────────────────────────────
  // The functions live in refs so async callbacks (utterance promises, TTS
  // edges) always run the latest render's closure — never a stale one.
  const startListeningRef = useRef<() => void>(() => {});
  const voiceSendRef = useRef<(q: string) => void>(() => {});

  const exitVoice = useCallback(() => {
    utterRef.current?.stop();
    utterRef.current = null;
    tts.stop();
    setVoiceMode(false);
    setInterim('');
  }, [tts]);

  const enterVoice = () => {
    if (dictation.isRecording) dictation.toggle();
    setError(null);
    setVoiceMode(true);
  };

  startListeningRef.current = () => {
    if (!voiceModeRef.current) return;
    // Never open the mic while a question is in flight: a filler's falling
    // edge (or any stale timer) opening it would start silent idle rounds
    // that dissolve the spirit and ABORT the answer mid-fetch.
    if (busyFlagRef.current) return;
    utterRef.current?.stop();
    setInterim('');
    setVoicePhase('listening');
    if (!utteranceSupported()) { exitVoice(); return; }
    const session = startUtterance(language, (text) => setInterim(text));
    utterRef.current = session;
    session.result.then(({ text, confidence }) => {
      if (!voiceModeRef.current || utterRef.current !== session) return;
      const q = text.trim();
      // Noise gates: a low-confidence transcript is ambient noise misheard as
      // speech; 1-2 characters is junk; and an utterance contained in what the
      // ninja itself just said is our own voice tail. All count as silence —
      // intentional short replies ("oui") pass because they score high.
      const lowConfidence = confidence != null && confidence < 0.5;
      const junk = q.length <= 2;
      const echo = q.length >= 8 && normEcho(lastSpokenRef.current).includes(normEcho(q));
      if (!q || lowConfidence || junk || echo) {
        // Silence. Listen again, but give up after ~4 empty rounds so the mic
        // doesn't stay hot forever.
        idleRoundsRef.current += 1;
        if (idleRoundsRef.current >= 4) {
          // The spirit dissipates entirely: on Home the overlay must CLOSE,
          // not fall back to the chat window — "Hey Ninja" only listens while
          // the panel is closed, so leaving it open would kill the wake word
          // until the user found the X button.
          if (isHud && onClose) onClose();
          else exitVoice();
        } else {
          startListeningRef.current();
        }
        return;
      }
      idleRoundsRef.current = 0;
      voiceSendRef.current(q);
    });
  };

  voiceSendRef.current = async (q: string) => {
    setVoicePhase('thinking');
    await send(q);
    if (!voiceModeRef.current) return;
    // If nothing is audible or pending on EITHER engine (error, empty or
    // already-finished answer), reopen the mic now; otherwise the tts falling
    // edge does it. isActive covers premium playback too — probing only
    // window.speechSynthesis here would open the mic under the ninja's own
    // ElevenLabs voice and transcribe it as the next question.
    if (!tts.isActive()) startListeningRef.current();
  };

  // Entering voice mode: spoken greeting, then listen.
  useEffect(() => {
    if (!voiceMode) return;
    idleRoundsRef.current = 0;
    sawSpeechRef.current = false;
    setVoicePhase('greeting');
    const greeting = t('hud.voiceGreeting', { name: greetName });
    setGreetText(greeting);
    lastSpokenRef.current = greeting;
    if (tts.supported) tts.speak(greeting);
    else startListeningRef.current();
    return () => {
      utterRef.current?.stop();
      utterRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode]);

  // Phase transitions driven by the TTS state: thinking→speaking when audio
  // starts; greeting/speaking→listening on its falling edge (with a short gap
  // so the mic doesn't catch the ninja's own voice tail). FILLERS are the trap
  // here: they are speech played while the request is still running with no
  // answer text yet — if they advanced the machine, their falling edge would
  // open the mic mid-fetch, silent idle rounds would dissolve the spirit, and
  // the unmount would ABORT the in-flight answer ("filler then nothing" bug).
  useEffect(() => {
    if (!voiceMode) return;
    if (tts.speaking) {
      const isFiller = busyFlagRef.current && !streamRef.current.text;
      if (!isFiller) {
        sawSpeechRef.current = true;
        if (voicePhase === 'thinking') setVoicePhase('speaking');
      }
      return;
    }
    if (sawSpeechRef.current && (voicePhase === 'greeting' || voicePhase === 'speaking')) {
      sawSpeechRef.current = false;
      const id = setTimeout(() => startListeningRef.current(), 250);
      return () => clearTimeout(id);
    }
    // busy/streamText are re-run triggers: speech can flow seamlessly from a
    // filler into the answer with no falling edge in between — the effect must
    // re-evaluate `isFiller` when the answer text starts (or the send settles),
    // or the phase machine would never see the answer being spoken.
  }, [tts.speaking, voicePhase, voiceMode, streamText, busy]);

  // Watchdog: a wedged speech engine must never strand the conversation.
  useEffect(() => {
    if (!voiceMode || (voicePhase !== 'greeting' && voicePhase !== 'speaking')) return;
    const id = setTimeout(() => {
      tts.stop();
      startListeningRef.current();
    }, 45000);
    return () => clearTimeout(id);
  }, [voiceMode, voicePhase, tts]);

  // Engines can silently drop queued utterances (no user activation, Chrome's
  // stuck-paused bug): the hook then believes it is talking while the global
  // synthesizer sits idle. Reconcile — 3s of real idleness = speech finished.
  // Only second-guess the BROWSER engine: premium (ElevenLabs) playback never
  // touches speechSynthesis, so it would always look "idle" here.
  useEffect(() => {
    if (!voiceMode || !tts.speaking) return;
    let idleTicks = 0;
    const id = setInterval(() => {
      if (tts.getEngine() === 'premium') { idleTicks = 0; return; }
      const s = window.speechSynthesis;
      if (s && (s.speaking || s.pending)) { idleTicks = 0; return; }
      idleTicks += 1;
      if (idleTicks >= 3) tts.stop(); // falling edge advances the phase
    }, 1000);
    return () => clearInterval(id);
  }, [voiceMode, tts.speaking, tts]);

  // Wake word opened the panel — greet by voice immediately.
  const autoVoiced = useRef(false);
  useEffect(() => {
    if (autoVoice && !autoVoiced.current) {
      autoVoiced.current = true;
      enterVoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoVoice]);

  // Shown in the voice window while the finished answer is still being spoken
  // (streamText is cleared when the request settles).
  const lastAssistantText = [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';

  // The spirit has no focusable input — catch Escape at the window level so it
  // can always be dismissed from the keyboard while the voice mode is open.
  useEffect(() => {
    if (!voiceMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (onClose ?? exitVoice)();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [voiceMode, onClose, exitVoice]);

  // On Home, the voice mode is not a window — the ninja "materializes" as a
  // frameless entity floating over the page (the card variant keeps its frame).
  const spirit = isHud && voiceMode;

  const voiceReadout = (
    <>
      {voicePhase === 'greeting' && (
        <p className="text-cyan-200 text-sm">{greetText}</p>
      )}
      {voicePhase === 'listening' && (
        interim
          ? <p className="text-gray-200 text-sm italic">{interim}</p>
          : <p className="text-cyan-400/80 text-[11px] font-mono uppercase tracking-widest">{t('hud.listening')}</p>
      )}
      {voicePhase === 'thinking' && !streamText && (
        <p className="text-gray-400 text-sm flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          {streamStatus?.kind === 'tool'
            ? t('intelligence.usingTool', { tool: streamStatus.name })
            : t('intelligence.thinking', 'Analyzing the data…')}
        </p>
      )}
      {(voicePhase === 'speaking' || (voicePhase === 'thinking' && streamText)) && (
        <div className={`text-left text-sm ${spirit ? 'rounded-xl bg-[#050d18]/80 backdrop-blur-sm px-4 py-2.5' : ''}`}>
          <Markdown text={streamText || lastAssistantText} />
        </div>
      )}
      {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
    </>
  );

  return (
    <div
      className={spirit
        ? 'relative'
        : isHud
          ? 'rounded-2xl border border-cyan-400/40 bg-[#081423]/95 backdrop-blur-md shadow-[0_0_32px_rgba(34,211,238,0.22)] p-4'
          : 'glass-card p-5'}
      onKeyDown={onClose ? (e) => { if (e.key === 'Escape') onClose(); } : undefined}
    >
      {!spirit && (
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isHud ? 'bg-cyan-500/15' : 'bg-violet-500/15'}`}>
            <Sparkles size={16} className={isHud ? 'text-cyan-300' : 'text-violet-300'} />
          </div>
          <div className="min-w-0">
            {isHud ? (
              <h2 className="text-cyan-200 font-semibold text-sm font-mono tracking-widest uppercase flex items-center gap-2">
                Ninja
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300 tracking-normal">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {t('hud.online')}
                </span>
              </h2>
            ) : (
              <h2 className="text-white font-semibold text-sm">{t('intelligence.askTitle', 'Ask the data')}</h2>
            )}
            <p className="text-gray-500 text-[11px] truncate">
              {t('intelligence.askHint', 'Natural-language questions about machines, KPIs, tickets, parts…')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {voiceMode ? (
            <button onClick={exitVoice} title={t('hud.exitVoice')} aria-label={t('hud.exitVoice')}
              className="p-1.5 rounded-lg text-cyan-300 hover:text-cyan-200 transition-colors">
              <AudioWaveform size={15} />
            </button>
          ) : (
            <>
              {utteranceSupported() && tts.supported && (
                <button onClick={enterVoice} title={t('hud.voiceMode')} aria-label={t('hud.voiceMode')}
                  className="p-1.5 rounded-lg text-gray-600 hover:text-cyan-300 transition-colors">
                  <AudioWaveform size={15} />
                </button>
              )}
              {isHud && onToggleWake && (
                <button
                  onClick={onToggleWake}
                  title={t('hud.heyNinja')}
                  aria-label={t('hud.heyNinja')}
                  aria-pressed={wakeEnabled}
                  className={`p-1.5 rounded-lg transition-colors ${
                    wakeEnabled ? 'text-emerald-300 hover:text-emerald-200' : 'text-gray-600 hover:text-gray-400'
                  }`}
                >
                  <AudioLines size={15} />
                </button>
              )}
              {tts.supported && (
                <button
                  onClick={toggleVoice}
                  title={t('intelligence.voiceReplies')}
                  aria-label={t('intelligence.voiceReplies')}
                  aria-pressed={voiceOn}
                  className={`p-1.5 rounded-lg transition-colors ${
                    voiceOn
                      ? `text-cyan-300 hover:text-cyan-200${tts.speaking ? ' animate-pulse' : ''}`
                      : 'text-gray-600 hover:text-gray-400'
                  }`}
                >
                  {voiceOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </button>
              )}
              {tts.supported && voices.length > 0 && (
                <button
                  onClick={() => setShowVoicePick((v) => !v)}
                  title={t('intelligence.voicePick')}
                  aria-label={t('intelligence.voicePick')}
                  aria-expanded={showVoicePick}
                  className={`p-1.5 rounded-lg transition-colors ${
                    showVoicePick ? 'text-cyan-300' : 'text-gray-600 hover:text-gray-400'
                  }`}
                >
                  <Settings2 size={15} />
                </button>
              )}
              {messages.length > 0 && (
                <button onClick={() => { tts.stop(); setMessages([]); setError(null); }} disabled={busy}
                  className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40 px-1">
                  {t('intelligence.clearChat', 'Clear')}
                </button>
              )}
            </>
          )}
          {onClose && (
            <button onClick={onClose} aria-label={t('common.close')}
              className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 transition-colors">
              <X size={15} />
            </button>
          )}
        </div>
      </div>
      )}

      {!voiceMode && showVoicePick && tts.supported && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[11px] text-gray-500 flex-shrink-0">{t('intelligence.voicePick')}</span>
          <select
            value={voicePick}
            onChange={(e) => {
              setVoicePick(e.target.value);
              setPreferredVoice(language, e.target.value || null);
            }}
            className="flex-1 min-w-0 bg-[#0d1421] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-cyan-500/50"
          >
            <option value="">{t('intelligence.voiceAuto')}</option>
            {premiumAvailable && (
              elevenVoices.length ? (
                <optgroup label={t('intelligence.voicePremium')}>
                  {elevenVoices.map((v) => (
                    <option key={v.voice_id} value={elevenUriFor(v.voice_id)}>{v.name}</option>
                  ))}
                </optgroup>
              ) : (
                <option value={ELEVEN_VOICE_URI}>{t('intelligence.voicePremium')}</option>
              )
            )}
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
            ))}
          </select>
          <button
            onClick={() => tts.speak(t('intelligence.voiceSample'))}
            title={t('intelligence.voiceTest')}
            aria-label={t('intelligence.voiceTest')}
            className="flex items-center justify-center w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:text-cyan-300 transition-colors flex-shrink-0"
          >
            <Play size={12} />
          </button>
        </div>
      )}

      {voiceMode && !spirit && (
        <div className="flex flex-col items-center pt-3 pb-1">
          <VoiceOrb state={voicePhase} />
          <div className="mt-3 w-full min-h-[3.25rem] max-h-40 overflow-y-auto text-center px-1">
            {voiceReadout}
          </div>
        </div>
      )}

      {spirit && (
        <div className="flex flex-col items-center w-full pt-2 pb-1">
          {/* Aura — the entity materializes out of a dark halo + cyan glow. */}
          <div
            className="absolute left-1/2 -translate-x-1/2 -top-16 w-[460px] h-[460px] rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(4,11,20,0.9) 0%, rgba(4,11,20,0.6) 45%, rgba(4,11,20,0) 72%)' }}
          />
          <div className="absolute left-1/2 -translate-x-1/2 top-8 w-64 h-64 rounded-full bg-cyan-400/10 blur-3xl pointer-events-none" />
          <div className="relative">
            <VoiceOrb state={voicePhase} size={200} />
          </div>
          <div className="relative mt-4 w-full max-w-sm min-h-[3rem] max-h-44 overflow-y-auto text-center px-2">
            {voiceReadout}
          </div>
          <div className="relative flex items-center gap-3 mt-5">
            <button
              onClick={exitVoice}
              title={t('hud.exitVoice')}
              aria-label={t('hud.exitVoice')}
              className="flex items-center justify-center w-10 h-10 rounded-full border border-white/10 bg-white/[0.05] backdrop-blur text-gray-300 hover:text-white hover:bg-white/[0.12] transition-colors"
            >
              <MessageSquare size={16} />
            </button>
            {onClose && (
              <button
                onClick={onClose}
                aria-label={t('common.close')}
                className="flex items-center justify-center w-10 h-10 rounded-full border border-white/10 bg-white/[0.05] backdrop-blur text-gray-300 hover:text-white hover:bg-white/[0.12] transition-colors"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      {!voiceMode && messages.length > 0 && (
        <div ref={scrollRef} className={`${isHud ? 'max-h-[21rem]' : 'max-h-[26rem]'} overflow-y-auto space-y-3 mb-3 pr-1`}>
          {messages.map((m, i) => (
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] bg-blue-600/20 border border-blue-500/25 rounded-2xl rounded-br-sm px-3.5 py-2 text-sm text-blue-50 whitespace-pre-wrap">{m.content}</div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[90%] bg-white/[0.03] border border-white/[0.06] rounded-2xl rounded-bl-sm px-3.5 py-2">
                  <Markdown text={m.content} />
                </div>
              </div>
            )
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="max-w-[90%] bg-white/[0.03] border border-white/[0.06] rounded-2xl rounded-bl-sm px-3.5 py-2">
                {streamText ? (
                  <>
                    <Markdown text={streamText} />
                    {streamStatus?.kind === 'tool' && (
                      <div className="flex items-center gap-2 text-gray-500 text-xs mt-1.5">
                        <Loader2 size={12} className="animate-spin" />
                        {t('intelligence.usingTool', { tool: streamStatus.name })}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-gray-400 text-sm">
                    <Loader2 size={14} className="animate-spin" />
                    {streamStatus?.kind === 'tool'
                      ? t('intelligence.usingTool', { tool: streamStatus.name })
                      : t('intelligence.thinking', 'Analyzing the data…')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!voiceMode && messages.length === 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {exampleQs.map((ex) => (
            <button key={ex} onClick={() => send(ex)} disabled={busy}
              className="text-xs text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-full px-3 py-1.5 transition-colors disabled:opacity-40">
              {ex}
            </button>
          ))}
        </div>
      )}

      {!voiceMode && error && <p className="text-red-400 text-xs mb-2">{error}</p>}

      {!voiceMode && (
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
          rows={1}
          placeholder={t('intelligence.askPlaceholder', 'e.g. Compare IMA 04 with IMA 05')}
          disabled={busy}
          className={`flex-1 resize-none bg-[#0d1421] border border-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none max-h-32 ${isHud ? 'focus:border-cyan-500/50' : 'focus:border-violet-500/50'}`}
        />
        {dictation.supported && (
          <button
            onClick={dictation.toggle}
            disabled={busy}
            title={dictation.isRecording ? t('intelligence.stopDictation') : t('intelligence.dictate')}
            aria-label={dictation.isRecording ? t('intelligence.stopDictation') : t('intelligence.dictate')}
            className={`flex items-center justify-center w-10 h-10 rounded-xl border flex-shrink-0 transition-colors disabled:opacity-40 ${
              dictation.isRecording
                ? 'bg-red-500/20 border-red-500/50 text-red-300 animate-pulse'
                : 'bg-white/[0.04] border-white/[0.08] text-gray-400 hover:text-gray-200'
            }`}
          >
            {dictation.isRecording ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
        <button onClick={() => send(input)} disabled={busy || !input.trim()}
          className={`flex items-center justify-center w-10 h-10 rounded-xl text-white disabled:opacity-40 flex-shrink-0 ${isHud ? 'bg-cyan-600 hover:bg-cyan-500' : 'bg-violet-600 hover:bg-violet-500'}`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
      )}
    </div>
  );
}
