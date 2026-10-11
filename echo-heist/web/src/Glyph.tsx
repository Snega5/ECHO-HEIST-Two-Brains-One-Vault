import type { ReactElement } from "react";
// Shape glyphs: drawn, not typed, so they render identically on every device.
// Each has a spoken name so partners can say "triangle" over voice.
export const GLYPH_NAMES = ["circle", "triangle", "square", "diamond", "hexagon", "plus", "star", "ring", "cross", "half-moon"];

const SHAPES: ReactElement[] = [
  <circle key="0" cx="12" cy="12" r="7.5" />,
  <path key="1" d="M12 4 21 20H3Z" />,
  <rect key="2" x="5" y="5" width="14" height="14" />,
  <path key="3" d="M12 3 21 12 12 21 3 12Z" />,
  <path key="4" d="M12 3 20 7.5v9L12 21 4 16.5v-9Z" />,
  <path key="5" d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6Z" />,
  <path key="6" d="M12 2 14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />,
  <g key="7"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /></g>,
  <path key="8" d="M6 6 18 18M18 6 6 18" />,
  <path key="9" d="M4 16a8 8 0 0 1 16 0Z" />,
];

export function Glyph({ id, size = 40, label = false }: { id: number; size?: number; label?: boolean }) {
  return (
    <span className="glyph" role="img" aria-label={GLYPH_NAMES[id]}>
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden>{SHAPES[id]}</svg>
      {label && <small>{GLYPH_NAMES[id]}</small>}
    </span>
  );
}
