import { cx } from "@/lib/cx";
import styles from "./GraduationBadge.module.css";

export interface GraduationBadgeProps {
  live: boolean;
  graduated: boolean;
  className?: string;
}

/** Live / graduated / failed-to-graduate, read straight off the auction — never a status this
 * page infers on its own. */
export function GraduationBadge({ live, graduated, className }: GraduationBadgeProps) {
  const label = live ? "Live" : graduated ? "Graduated" : "Failed to graduate";
  return <span className={cx(styles.badge, live && styles.live, !live && graduated && styles.graduated, className)}>{label}</span>;
}
