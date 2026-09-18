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
  /** The current route's pathname (e.g. `/auctions/12`), for marking the matching nav link
   * `aria-current="page"`. Omitted on pages with no matching top-level section (the landing
   * page itself). */
  current?: string;
}

/** A `link` is current for `pathname` if it's an exact match or `pathname` is nested under it
 * (`/auctions` matches `/auctions/12`) — never a bare prefix match, so `/underwrite` doesn't
 * light up for a path like `/underwrite-something` that merely starts the same way. */
function isCurrent(href: string, pathname: string | undefined): boolean {
  if (!pathname || !href.startsWith("/")) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Wordmark and primary navigation above a full-width rule. */
export function Masthead({ links, current }: MastheadProps) {
  return (
    <header className={styles.head}>
      <Link className={styles.wordmark} href="/" aria-label="Advance, home">
        Advance
      </Link>
      <nav className={styles.nav} aria-label="Primary">
        <ul className={styles.list}>
          {links.map((link) => {
            const active = isCurrent(link.href, current);
            return (
              <li key={link.label} className={link.optional ? styles.optional : undefined}>
                {link.href.startsWith("/") ? (
                  <Link className={styles.link} href={link.href} aria-current={active ? "page" : undefined}>
                    {link.label}
                  </Link>
                ) : (
                  <a className={styles.link} href={link.href}>
                    {link.label}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
