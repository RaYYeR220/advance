import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export interface ActionProps {
  href: string;
  children: ReactNode;
  className?: string;
  /** Route links only; `false` skips loading the destination ahead of a click. */
  prefetch?: boolean;
}

function Anchor({ href, className, children, prefetch }: ActionProps) {
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={className} prefetch={prefetch}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

/** Solid forest button that turns ochre on hover. */
export function ButtonLink({ className, ...props }: ActionProps) {
  return <Anchor {...props} className={cx("button", className)} />;
}

/** Underlined text link that fills with ochre on hover. */
export function TextLink({ className, ...props }: ActionProps) {
  return <Anchor {...props} className={cx("text-link", className)} />;
}
