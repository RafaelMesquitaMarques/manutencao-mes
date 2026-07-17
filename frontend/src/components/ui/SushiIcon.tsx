// Brand icon for the Yokogawa Sushi sensors (user-supplied artwork in
// public/sushi-icon.svg — a raster-in-SVG, so it renders as an <img> rather
// than an inline path like the lucide icons it sits next to).
export default function SushiIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src="/sushi-icon.svg"
      width={size}
      height={size}
      className={`inline-block select-none ${className}`}
      alt=""
      draggable={false}
    />
  );
}
