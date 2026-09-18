"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { cx } from "@/lib/cx";
import { COMPACT_QUERY, REDUCED_MOTION_QUERY, useElementSize, useMediaQuery, useSvgUrl } from "./hooks";
import {
  LOUPE_SCREEN_RATIO,
  framingFor,
  likenessFromSeed,
  portraitCell,
  portraitPlates,
  type PortraitFraming,
  type PortraitPlates,
} from "./portrait";
import styles from "./HalftonePortrait.module.css";

export interface HalftonePortraitProps {
  /** Agent address; the same address always prints the same agent. */
  seed: string;
  framing: PortraitFraming;
  /** Accessible description of the likeness. */
  label: string;
  /** Hovering shows the portrait through a coarser screen inside a loupe. */
  lens?: boolean;
  className?: string;
}

function Plates({ plates, className }: { plates: PortraitPlates | null; className?: string }) {
  const ochre = useSvgUrl(plates?.ochre ?? null);
  const forest = useSvgUrl(plates?.forest ?? null);
  if (!ochre || !forest) return null;
  return (
    <div className={cx(styles.layer, className)}>
      <img className={cx(styles.plate, styles.inkOchre)} src={ochre} alt="" decoding="async" draggable={false} />
      <img className={cx(styles.plate, styles.inkForest)} src={forest} alt="" decoding="async" draggable={false} />
    </div>
  );
}

const LOUPE_MAX_RADIUS = 150;
const LOUPE_EASE = 0.18;

/** A halftone likeness that fills its positioned parent and prints itself in on first paint. */
export function HalftonePortrait({ seed, framing, label, lens = false, className }: HalftonePortraitProps) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const compact = useMediaQuery(COMPACT_QUERY);
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const [printed, setPrinted] = useState(false);

  const likeness = useMemo(() => likenessFromSeed(seed), [seed]);
  const crop = framingFor(framing, compact);
  const fine = useMemo(() => {
    if (!size) return null;
    const cell = portraitCell(size.width);
    return portraitPlates({ likeness, width: size.width, height: size.height, framing: crop, cell });
  }, [likeness, size, crop]);
  const coarse = useMemo(() => {
    if (!size || !lens) return null;
    const cell = portraitCell(size.width) * LOUPE_SCREEN_RATIO;
    return portraitPlates({ likeness, width: size.width, height: size.height, framing: crop, cell });
  }, [likeness, size, crop, lens]);

  useEffect(() => {
    if (!fine || printed) return;
    if (reduced) {
      setPrinted(true);
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPrinted(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [fine, printed, reduced]);

  const loupe = useRef({ target: 0, radius: 0, frame: 0 });
  useEffect(() => {
    const state = loupe.current;
    return () => cancelAnimationFrame(state.frame);
  }, []);

  const tick = () => {
    const el = ref.current;
    const state = loupe.current;
    if (!el) return;
    state.radius += (state.target - state.radius) * (reduced ? 1 : LOUPE_EASE);
    if (Math.abs(state.target - state.radius) < 0.5) state.radius = state.target;
    el.style.setProperty("--r", `${state.radius.toFixed(1)}px`);
    state.frame = state.radius !== state.target ? requestAnimationFrame(tick) : 0;
  };

  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const box = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${(event.clientX - box.left).toFixed(1)}px`);
    el.style.setProperty("--my", `${(event.clientY - box.top).toFixed(1)}px`);
  };

  const lensHandlers = lens
    ? {
        onPointerEnter: (event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === "touch") return;
          follow(event);
          loupe.current.target = Math.min(LOUPE_MAX_RADIUS, event.currentTarget.clientWidth * 0.24);
          if (!loupe.current.frame) loupe.current.frame = requestAnimationFrame(tick);
        },
        onPointerMove: follow,
        onPointerLeave: () => {
          loupe.current.target = 0;
          if (!loupe.current.frame) loupe.current.frame = requestAnimationFrame(tick);
        },
      }
    : {};

  return (
    <div
      ref={ref}
      className={cx(styles.portrait, lens && styles.lens, printed && styles.printed, className)}
      role="img"
      aria-label={label}
      data-printed={printed || undefined}
      {...lensHandlers}
    >
      <Plates plates={fine} className={styles.fine} />
      {lens ? <Plates plates={coarse} className={styles.coarse} /> : null}
      {lens ? <div className={styles.loupe} aria-hidden="true" /> : null}
    </div>
  );
}
