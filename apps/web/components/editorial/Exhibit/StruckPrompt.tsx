"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { REDUCED_MOTION_QUERY } from "@/components/halftone/hooks";
import { INK } from "@/components/halftone/screen";
import { cx } from "@/lib/cx";
import styles from "./Exhibit.module.css";

export interface StruckPromptProps {
  /** Exhibit line above the rule, e.g. "Exhibit A. The instruction it found". */
  label: string;
  /** The refused instruction, quoted as found. */
  children: ReactNode;
  /** What happened to it. */
  caption: ReactNode;
  className?: string;
}

/**
 * An instruction an agent was fed, struck through by hand once it scrolls into
 * view, with a proofreader's delete mark in the margin.
 */
export function StruckPrompt({ label, children, caption, className }: StruckPromptProps) {
  const ref = useRef<HTMLElement>(null);
  const [struck, setStruck] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia(REDUCED_MOTION_QUERY).matches;
    if (reduced || !("IntersectionObserver" in window)) {
      setStruck(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setStruck(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <figure ref={ref} className={cx(styles.prompt, struck && styles.struck, className)} data-struck={struck || undefined}>
      <p className={styles.label}>{label}</p>
      <blockquote className={styles.quote}>
        <p>
          <span className={styles.strike}>{children}</span>
        </p>
      </blockquote>
      <svg className={styles.mark} viewBox="0 0 80 80" aria-hidden="true">
        <path
          d="M8 58 C 22 60, 40 40, 44 22 C 47 8, 30 6, 27 20 C 24 34, 44 44, 58 40 C 66 38, 70 44, 66 52 C 62 60, 52 58, 54 50"
          fill="none"
          stroke={INK.ochre}
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
      <figcaption className={styles.caption}>{caption}</figcaption>
    </figure>
  );
}
