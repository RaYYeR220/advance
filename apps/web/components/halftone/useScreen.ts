"use client";

import { useMemo, useRef } from "react";
import { useElementSize, useSvgUrl, type Size } from "./hooks";

/**
 * Measures a box and prints a halftone into it. `key` must change whenever
 * anything `print` reads other than the size changes; the markup is cached on
 * size and key, and handed back as an object URL.
 */
export function useScreen<T extends HTMLElement>(print: (size: Size) => string, key: string) {
  const ref = useRef<T>(null);
  const size = useElementSize(ref);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const svg = useMemo(
    () => (width && height ? print({ width, height }) : null),
    // print is fully described by key and the measured size
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [width, height, key],
  );
  const url = useSvgUrl(svg);
  return { ref, size, url };
}
