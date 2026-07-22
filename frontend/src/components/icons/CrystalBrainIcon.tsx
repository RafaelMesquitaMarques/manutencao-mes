// Crystal ball with a brain inside — lucide-style custom icon (24×24 grid,
// stroke = currentColor) for the Predictive Health module. The brain is the
// official lucide Brain scaled to 46% around (12, 10) (hemispheres + center
// sulcus only — the small outer notches turn to noise at this size); it gets a
// thinner stroke so it stays readable inside the 2px ball outline at 18px.
// Measured, not eyeballed: at 50%+ the lobe corners fuse with the ball's inner
// edge (stroke reaches r≈6.4 vs inner edge 6.45) — keep max ink radius ≤5.95.
export default function CrystalBrainIcon({
  size = 24,
  className,
}: {
  size?: number | string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* ball */}
      <circle cx="12" cy="10" r="7.5" />
      {/* stand (legs meet the ball exactly at y=17.2 → x=12±2.1) */}
      <path d="M 9.9 17.2 L 7.9 20.9 H 16.1 L 14.1 17.2" />
      {/* brain */}
      <g strokeWidth="1.5">
        <path d="M 12 6.78 a 1.38 1.38 0 1 0 -2.76 0.06 a 1.84 1.84 0 0 0 -1.16 2.65 a 1.84 1.84 0 0 0 0.26 3.03 A 1.84 1.84 0 1 0 12 12.76 Z" />
        <path d="M 12 6.78 a 1.38 1.38 0 1 1 2.76 0.06 a 1.84 1.84 0 0 1 1.16 2.65 a 1.84 1.84 0 0 1 -0.26 3.03 A 1.84 1.84 0 1 1 12 12.76 Z" />
        <path d="M 13.38 10.46 a 2.07 2.07 0 0 1 -1.38 -1.84 a 2.07 2.07 0 0 1 -1.38 1.84" />
      </g>
    </svg>
  );
}
