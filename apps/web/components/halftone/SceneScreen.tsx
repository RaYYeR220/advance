"use client";

import type { ReactNode } from "react";
import { sceneSvg, type SceneId } from "./scenes";
import { useScreen } from "./useScreen";

export interface SceneScreenProps {
  scene: SceneId;
  label: string;
  /** Vector annotations laid over the halftone. */
  children?: ReactNode;
  className?: string;
  screenClassName?: string;
}

/** A lifecycle illustration printed to the size of its box. */
export function SceneScreen({ scene, label, children, className, screenClassName }: SceneScreenProps) {
  const { ref, url } = useScreen<HTMLDivElement>(({ width, height }) => sceneSvg(scene, width, height), scene);
  return (
    <div ref={ref} className={className} role="img" aria-label={label}>
      <div className={screenClassName}>{url ? <img src={url} alt="" decoding="async" /> : null}</div>
      {children}
    </div>
  );
}
