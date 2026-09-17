import Link from "next/link";
import styles from "./Masthead.module.css";

export interface MastheadLink {
  label: string;
  href: string;
  /** Dropped from the single-column layout to keep the nav on one line. */
  optional?: boolean;
}

export interface MastheadProps {
  links: readonly MastheadLink[];
}

/** Wordmark and primary navigation above a full-width rule. */
export function Masthead({ links }: MastheadProps) {
  return (
    <header className={styles.head}>
      <Link className={styles.wordmark} href="/" aria-label="Advance, home">
        Advance
      </Link>
      <nav className={styles.nav} aria-label="Primary">
        <ul className={styles.list}>
          {links.map((link) => (
            <li key={link.label} className={link.optional ? styles.optional : undefined}>
              {link.href.startsWith("/") ? (
                <Link className={styles.link} href={link.href}>
                  {link.label}
                </Link>
              ) : (
                <a className={styles.link} href={link.href}>
                  {link.label}
                </a>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
