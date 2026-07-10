import { useCallback, useEffect, useRef, useState } from 'react';

// The Web Speech API is not in the standard DOM typings — minimal local shapes.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: SpeechRecognitionEventLike) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}
interface SpeechRecognitionEventLike {
  results: { length: number } & Record<number, Record<number, { transcript: string }>>;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | undefined {
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

// Map the app's i18n language (en/fr/es) to a BCP-47 speech locale.
const LOCALE: Record<string, string> = {
  en: 'en-US',
  fr: 'fr-CA',
  es: 'es-ES',
};

/**
 * Browser-native voice dictation (free, no tokens, no server). Each final
 * transcript chunk is delivered via `onTranscript`; the caller decides how to
 * append it. `supported` is false when the browser lacks the Web Speech API.
 */
export function useSpeechDictation(
  onTranscript: (chunk: string) => void,
  lang: string,
) {
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // How many result entries we've already emitted this session. `event.results`
  // is cumulative under continuous mode, so without this we'd re-emit (and thus
  // duplicate) every earlier phrase on each new result.
  const processedRef = useRef(0);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;

  const supported = typeof window !== 'undefined' && !!getCtor();

  // Stop any active recognition when the component using the hook unmounts.
  useEffect(() => () => recognitionRef.current?.stop(), []);

  const toggle = useCallback(() => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }
    const Ctor = getCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = LOCALE[lang] ?? LOCALE.en;
    recognition.continuous = true;
    recognition.interimResults = false;
    processedRef.current = 0;
    recognition.onresult = (event) => {
      const chunk = Array.from(
        { length: event.results.length - processedRef.current },
        (_, i) => event.results[processedRef.current + i][0].transcript,
      ).join(' ').trim();
      processedRef.current = event.results.length;
      if (chunk) cbRef.current(chunk);
    };
    recognition.onend = () => setIsRecording(false);
    recognition.start();
    recognitionRef.current = recognition;
    setIsRecording(true);
  }, [isRecording, lang]);

  return { supported, isRecording, toggle };
}
