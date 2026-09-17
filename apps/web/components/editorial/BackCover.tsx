import type { ReactNode } from "react";
import { ButtonLink } from "./Action";
import { Folio } from "./Folio";
import styles from "./BackCover.module.css";

export interface BackCoverColumn {
  title: string;
  links?: readonly { label: string; href: string }[];
  text?: string;
}

export interface BackCoverProps {
  pitch: string;
  action: { label: string; href: string; prefetch?: boolean };
  columns: readonly BackCoverColumn[];
  imprint: ReactNode;
  page: number;
}

/** Site footer set as a back cover: oversized wordmark, one call to action and the index. */
export function BackCover({ pitch, action, columns, imprint, page }: BackCoverProps) {
  return (
    <footer className={styles.back}>
      <div className={styles.top}>
        <p className={styles.mark} aria-hidden="true">
          Advance
        </p>
        <div className={styles.cta}>
          <p>{pitch}</p>
          <ButtonLink href={action.href} prefetch={action.prefetch}>
            {action.label}
          </ButtonLink>
        </div>
      </div>
      <nav className={styles.nav} aria-label="Footer">
        {columns.map((column) => (
          <div key={column.title}>
            <h3>{column.title}</h3>
            {column.links ? (
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            ) : null}
            {column.text ? <p>{column.text}</p> : null}
          </div>
        ))}
      </nav>
      <div className={styles.base}>
        <span>{imprint}</span>
        <Folio page={page} />
      </div>
    </footer>
  );
}
