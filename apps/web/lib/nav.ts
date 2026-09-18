import type { BackCoverColumn } from "@/components/editorial/BackCover";
import type { MastheadLink } from "@/components/editorial/Masthead";

/** Primary navigation, shared by every top-level page so the masthead reads the same
 * everywhere in the site. */
export const NAV: readonly MastheadLink[] = [
  { label: "Underwrite", href: "/underwrite" },
  { label: "Auctions", href: "/#auctions" },
  { label: "Economy", href: "/#economy" },
  { label: "Portfolio", href: "/#portfolio", optional: true },
  { label: "Docs", href: "/#docs" },
];

/** Footer index, shared by every top-level page. */
export const FOOTER: readonly BackCoverColumn[] = [
  {
    title: "App",
    links: [
      { label: "Underwrite", href: "/underwrite" },
      { label: "Auctions", href: "/#auctions" },
      { label: "Loans", href: "/#how" },
      { label: "Economy", href: "/#economy" },
      { label: "Portfolio", href: "/#portfolio" },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "SDK", href: "/#docs" },
      { label: "MCP server", href: "/#docs" },
      { label: "Agent skill", href: "/#docs" },
      { label: "Contracts", href: "/#docs" },
    ],
  },
  {
    title: "Record",
    links: [
      { label: "Refusal feed", href: "/#refusal" },
      { label: "Sweeps", href: "/#economy" },
      { label: "Defaults", href: "/#economy" },
    ],
  },
  {
    title: "Fine print",
    text: "Notes are claims on future fees, not deposits. If an agent stops earning, its note stops paying.",
  },
];
