import './VoiceOrb.css';

export type VoiceOrbState = 'greeting' | 'listening' | 'thinking' | 'speaking';

/** Animated hologram orb — the visual heart of the voice-conversation mode. */
export default function VoiceOrb({ state, size = 132 }: { state: VoiceOrbState; size?: number }) {
  // The greeting is spoken, so it animates like speaking.
  const cls = state === 'greeting' ? 'speaking' : state;
  return (
    <div className={`vorb vorb-${cls}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 132 132" width={size} height={size}>
        <defs>
          <clipPath id="vorb-clip">
            <circle cx="66" cy="66" r="40" />
          </clipPath>
          <radialGradient id="vorb-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0.55" stopColor="rgba(34,211,238,0.16)" />
            <stop offset="1" stopColor="rgba(34,211,238,0)" />
          </radialGradient>
        </defs>
        <circle cx="66" cy="66" r="64" fill="url(#vorb-glow)" />
        <circle className="vorb-r1" cx="66" cy="66" r="60" fill="none" stroke="rgba(103,232,249,.35)" strokeWidth="1.5" strokeDasharray="4 6" />
        <circle className="vorb-r2" cx="66" cy="66" r="50" fill="none" stroke="rgba(34,211,238,.5)" strokeWidth="1" strokeDasharray="30 14 8 14" />
        <circle className="vorb-r3" cx="66" cy="66" r="45" fill="none" stroke="rgba(94,234,212,.28)" strokeWidth="5" strokeDasharray="1.5 6" />
        <image
          className="vorb-core"
          href="/core-hud.png"
          x="26"
          y="26"
          width="80"
          height="80"
          clipPath="url(#vorb-clip)"
          preserveAspectRatio="xMidYMid slice"
        />
        <circle className="vorb-pulse" cx="66" cy="66" r="42" fill="none" strokeWidth="1.5" />
      </svg>
    </div>
  );
}
