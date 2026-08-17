import { useMemo } from 'react';
import type { ReactNode } from 'react';

/** Minimal markdown renderer for AI-generated text (##/###, **bold**, - lists). */
export default function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.split('\n');
    const out: ReactNode[] = [];
    let list: string[] = [];
    const flushList = (key: string) => {
      if (list.length) {
        out.push(
          <ul key={key} className="list-disc pl-5 space-y-1 my-2 text-gray-300 text-sm">
            {list.map((li, i) => <li key={i}>{inline(li)}</li>)}
          </ul>,
        );
        list = [];
      }
    };
    const inline = (s: string): ReactNode => {
      // **bold** segments
      const parts = s.split(/(\*\*[^*]+\*\*)/g);
      return parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**')
          ? <strong key={i} className="text-white font-semibold">{p.slice(2, -2)}</strong>
          : <span key={i}>{p}</span>,
      );
    };
    lines.forEach((raw, idx) => {
      const line = raw.trimEnd();
      if (/^###\s+/.test(line)) { flushList(`l${idx}`); out.push(<h4 key={idx} className="text-sm font-semibold text-gray-200 mt-4 mb-1">{inline(line.replace(/^###\s+/, ''))}</h4>); }
      else if (/^##\s+/.test(line)) { flushList(`l${idx}`); out.push(<h3 key={idx} className="text-base font-bold text-white mt-5 mb-2 flex items-center gap-2"><span className="w-1 h-4 bg-blue-500 rounded-full" />{inline(line.replace(/^##\s+/, ''))}</h3>); }
      else if (/^#\s+/.test(line)) { flushList(`l${idx}`); out.push(<h2 key={idx} className="text-lg font-bold text-white mb-2">{inline(line.replace(/^#\s+/, ''))}</h2>); }
      else if (/^[-*]\s+/.test(line)) { list.push(line.replace(/^[-*]\s+/, '')); }
      else if (line === '' || line === '---') { flushList(`l${idx}`); }
      else { flushList(`l${idx}`); out.push(<p key={idx} className="text-sm text-gray-300 leading-relaxed my-1.5">{inline(line)}</p>); }
    });
    flushList('last');
    return out;
  }, [text]);
  return <div className="max-w-none">{blocks}</div>;
}
