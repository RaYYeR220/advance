"use client";

import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { INK } from "@/components/halftone/screen";
import { cx } from "@/lib/cx";
import styles from "./ApplyTabs.module.css";

export interface CodeLine {
  text: string;
  comment?: boolean;
  /** A fragment of `text` to underline in ochre. */
  stress?: string;
}

export interface MarginNote {
  /** 1-based line the note points at. */
  line: number;
  text: string;
}

export interface ApplyTab {
  id: string;
  label: string;
  lines: readonly CodeLine[];
  notes: readonly MarginNote[];
}

export interface ApplyTabsProps {
  label: string;
  tabs: readonly ApplyTab[];
}

function Line({ line }: { line: CodeLine }) {
  const at = line.stress ? line.text.indexOf(line.stress) : -1;
  return (
    <span className={cx(styles.line, line.comment && styles.comment)}>
      {at < 0 || !line.stress ? (
        line.text
      ) : (
        <>
          {line.text.slice(0, at)}
          <span className={styles.stress}>{line.stress}</span>
          {line.text.slice(at + line.stress.length)}
        </>
      )}
    </span>
  );
}

/** Code galleys for each way an agent can apply, with hand-drawn margin notes. */
export function ApplyTabs({ label, tabs }: ApplyTabsProps) {
  const base = useId();
  const [selected, setSelected] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (index: number, focus: boolean) => {
    setSelected(index);
    if (focus) buttons.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + last) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    select(next, true);
  };

  return (
    <>
      <div className={styles.tabs} role="tablist" aria-label={label}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="tab"
            className={styles.tab}
            id={`${base}-tab-${tab.id}`}
            aria-selected={i === selected}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => select(i, false)}
            onKeyDown={(event) => onKeyDown(event, i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={styles.galley}>
        {tabs.map((tab, i) => (
          <div
            key={tab.id}
            className={styles.panel}
            role="tabpanel"
            id={`${base}-panel-${tab.id}`}
            aria-labelledby={`${base}-tab-${tab.id}`}
            tabIndex={0}
            hidden={i !== selected}
          >
            <pre>
              <code>
                {tab.lines.map((line, n) => (
                  <Line key={n} line={line} />
                ))}
              </code>
            </pre>
            <ol className={styles.marks} aria-label="Margin notes">
              {tab.notes.map((note) => (
                <li key={note.line} style={{ "--ln": note.line } as CSSProperties}>
                  <svg viewBox="0 0 34 24" aria-hidden="true">
                    <path
                      d="M2 12 C 10 2, 22 2, 30 10 M24 5 L31 10 L24 15"
                      fill="none"
                      stroke={INK.ochre}
                      strokeWidth="2.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span>{note.text}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </>
  );
}
