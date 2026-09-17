"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

/** Single-column layout: spreads collapse to one page below this width. */
export const COMPACT_QUERY = "(max-width: 860px)";
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export interface Size {
  width: number;
  height: number;
}

/** Rounded content-box size of an element; resizes settle for `delay` ms before updating. */
export function useElementSize(ref: RefObject<HTMLElement | null>, delay = 180): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const width = Math.round(el.clientWidth);
      const height = Math.round(el.clientHeight);
      setSize((prev) =>
        prev && prev.width === width && prev.height === height ? prev : width && height ? { width, height } : null,
      );
    };
    read();
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, delay);
    });
    observer.observe(el);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref, delay]);
  return size;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** An object URL for an SVG document, revoked when the markup changes or the component unmounts. */
export function useSvgUrl(svg: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!svg) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [svg]);
  return url;
}
