"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Callout, CalloutLeaders, CalloutList } from "@/components/editorial/Callout";
import { leaderLine, placeLabel, type Box, type Segment } from "@/components/editorial/callout-geometry";
import { Folio } from "@/components/editorial/Folio";
import { COMPACT_QUERY, useElementSize, useMediaQuery } from "@/components/halftone/hooks";
import { HalftonePortrait } from "@/components/halftone/HalftonePortrait";
import {
  HERO_FRAMING,
  framingFor,
  likenessFromSeed,
  portraitAnchors,
  portraitMapper,
  type AnchorName,
} from "@/components/halftone/portrait";
import styles from "./HeroSpread.module.css";

export interface HeroCallout {
  title: string;
  body: string;
  /** The part of the likeness the pin points at. */
  anchor: AnchorName;
  /** Preferred top-left corner of the label, as fractions of the figure. */
  labelAt: { x: number; y: number };
}

export interface HeroFigureProps {
  seed: string;
  portraitLabel: string;
  calloutsLabel: string;
  callouts: readonly HeroCallout[];
  caption: ReactNode;
  folio: number;
}

interface Layout {
  pins: { x: number; y: number }[];
  labels: Box[] | null;
  lines: Segment[];
}

/** The hero likeness with its reading callouts and caption. */
export function HeroFigure({ seed, portraitLabel, calloutsLabel, callouts, caption, folio }: HeroFigureProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const size = useElementSize(frameRef);
  const compact = useMediaQuery(COMPACT_QUERY);
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [layout, setLayout] = useState<Layout | null>(null);
  const anchors = useMemo(() => portraitAnchors(likenessFromSeed(seed)), [seed]);

  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) setFontsLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!size) return;
    const mapper = portraitMapper(framingFor(HERO_FRAMING, compact), size.width, size.height);
    const pins = callouts.map((c) => {
      const [x, y] = mapper.toBox(...anchors[c.anchor]);
      return { x, y };
    });
    if (compact) {
      setLayout({ pins, labels: null, lines: [] });
      return;
    }
    const labels = callouts.map((c, i) => {
      const el = labelRefs.current[i];
      return placeLabel(c.labelAt, { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 }, size);
    });
    const lines = pins.flatMap((pin, i) => {
      const box = labels[i];
      const line = box ? leaderLine(pin, box) : null;
      return line ? [line] : [];
    });
    setLayout({ pins, labels, lines });
  }, [size, compact, anchors, callouts, fontsLoaded]);

  return (
    <figure className={styles.figure}>
      <div ref={frameRef} className={styles.frame}>
        <HalftonePortrait seed={seed} framing={HERO_FRAMING} label={portraitLabel} lens />
      </div>
      <CalloutLeaders
        className={styles.leaders}
        width={size?.width ?? 0}
        height={size?.height ?? 0}
        lines={layout?.lines ?? []}
      />
      <CalloutList label={calloutsLabel}>
        {callouts.map((c, i) => (
          <Callout
            key={c.title}
            number={i + 1}
            title={c.title}
            anchor={{ x: anchors[c.anchor][0], y: anchors[c.anchor][1] }}
            labelAt={c.labelAt}
            pin={layout?.pins[i] ?? null}
            label={layout?.labels?.[i] ?? null}
            labelRef={(el) => {
              labelRefs.current[i] = el;
            }}
          >
            {c.body}
          </Callout>
        ))}
      </CalloutList>
      <figcaption className={styles.caption}>
        <p>{caption}</p>
        <Folio page={folio} className={styles.captionFolio} />
      </figcaption>
    </figure>
  );
}
