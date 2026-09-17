import type { ReactNode } from "react";
import { SceneScreen } from "@/components/halftone/SceneScreen";
import type { SceneId } from "@/components/halftone/scenes";
import { cx } from "@/lib/cx";
import styles from "./FoldOut.module.css";

export interface FoldOutPanel {
  scene: SceneId;
  /** What the illustration shows, for readers who cannot see it. */
  sceneLabel: string;
  /** Vector labels drawn over the illustration, in a 100 by 100 viewBox. */
  annotations?: ReactNode;
  title: string;
  body: string;
  /** The contract or SDK call behind this step. */
  call: string;
}

export interface FoldOutProps {
  panels: readonly FoldOutPanel[];
  className?: string;
}

/**
 * A numbered sequence of illustrated panels, printed side by side like a
 * gatefold with crease marks between them; stacks on single-column layouts.
 */
export function FoldOut({ panels, className }: FoldOutProps) {
  return (
    <ol className={cx(styles.fold, className)}>
      {panels.map((panel, i) => (
        <li key={panel.title} className={styles.panel}>
          <SceneScreen scene={panel.scene} label={panel.sceneLabel} className={styles.scene} screenClassName={styles.screen}>
            <svg className={styles.overlay} viewBox="0 0 100 100" aria-hidden="true">
              {panel.annotations}
            </svg>
          </SceneScreen>
          <div className={styles.step}>
            <div className={styles.stepHead}>
              <span className={styles.number}>{i + 1}</span>
              <h3 className={styles.title}>{panel.title}</h3>
            </div>
            <p>{panel.body}</p>
            <p className={styles.call}>{panel.call}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Class for serif labels inside panel annotations. */
export const annotationSerif = styles.serif;
