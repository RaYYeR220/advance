import { INK } from "./screen";

export interface SealProps {
  className?: string;
}

const ROSETTE = Array.from({ length: 18 }, (_, k) => k * 10);
const BEADS = Array.from({ length: 36 }, (_, k) => {
  const a = (k * Math.PI) / 18;
  return { cx: (50 + Math.cos(a) * 47).toFixed(2), cy: (50 + Math.sin(a) * 47).toFixed(2) };
});

/** Guilloche seal: an ochre rosette, a beaded rim and the monogram. */
export function Seal({ className }: SealProps) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
      {ROSETTE.map((deg) => (
        <ellipse
          key={deg}
          cx="50"
          cy="50"
          rx="44"
          ry="15"
          transform={`rotate(${deg} 50 50)`}
          fill="none"
          stroke={INK.ochre}
          strokeWidth=".9"
        />
      ))}
      {BEADS.map((b) => (
        <circle key={`${b.cx},${b.cy}`} cx={b.cx} cy={b.cy} r="1.4" fill={INK.forest} />
      ))}
      <circle cx="50" cy="50" r="24" fill={INK.forest} />
      <circle cx="50" cy="50" r="20" fill="none" stroke={INK.ochre} strokeWidth="1" />
      <text x="50" y="61" textAnchor="middle" fontSize="31" fill={INK.paper} style={{ fontFamily: "var(--display)" }}>
        A
      </text>
    </svg>
  );
}
