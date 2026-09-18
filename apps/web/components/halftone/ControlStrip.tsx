import { controlStripModel } from "./charts";
import { INK } from "./screen";

export interface ControlStripProps {
  compact: boolean;
  className?: string;
}

function Registration({ cx }: { cx: number }) {
  return (
    <g stroke={INK.forest} strokeWidth="1.2" fill="none">
      <circle cx={cx} cy="28" r="15" />
      <circle cx={cx} cy="28" r="7" />
      <line x1={cx - 24} y1="28" x2={cx + 24} y2="28" />
      <line x1={cx} y1="4" x2={cx} y2="52" />
    </g>
  );
}

/** A printer's control strip: registration marks and ten tint patches for each plate. */
export function ControlStrip({ compact, className }: ControlStripProps) {
  const strip = controlStripModel(compact);
  return (
    <svg className={className} viewBox={`0 0 ${strip.width} ${strip.height}`} aria-hidden="true">
      {strip.registration.map((x) => (
        <Registration key={x} cx={x} />
      ))}
      {strip.patches.map((p) => {
        const percent = Math.round(p.coverage * 100);
        const labelled = !compact || percent === 10 || percent === 50 || percent === 100;
        return (
          <g key={`${p.ink}-${percent}`}>
            <g transform={`translate(${compact ? p.x.toFixed(1) : p.x} ${p.y})`}>
              <path fill={p.ink === "ochre" ? INK.ochre : INK.forest} d={p.path} />
              <rect
                x=".5"
                y=".5"
                width={p.width - 1}
                height={p.height - 1}
                fill="none"
                stroke={INK.forest}
                strokeOpacity=".35"
              />
            </g>
            {labelled ? (
              <text
                x={compact ? (p.x + p.width / 2).toFixed(1) : p.x + p.width / 2}
                y={compact ? p.y + 48 : 64}
                textAnchor="middle"
                fontSize={compact ? 11 : undefined}
              >
                {percent}%
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
