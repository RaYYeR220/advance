# Accessibility Audit

**Generated**: 2026-09-18
**Platform / framework**: Web — Next.js 16 App Router (React 19), TypeScript, CSS Modules
**Target standard**: WCAG 2.2 Level AA
**Legal scope**: No market signals in the codebase (no locale/currency targeting); WCAG 2.2 AA taken as the common baseline (ADA, EAA, Section 508 all converge on it).

Scope: `apps/web`, focused on the surfaces added for `/economy`, `/portfolio`, `/docs`, the shared `Masthead` nav, and the wallet forms (`components/wallet/*`). Pre-existing, already-reviewed pages (`/`, `/underwrite`, `/auctions`, `/loans/[loanId]`) were spot-checked for the same classes of issue but not re-audited line by line.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 3 (all fixed) |
| Medium   | 1 (fixed) |
| Low      | 2 (left, documented) |
| **Total**| 6     |

Conformance snapshot (static): no Level A failures found in the audited surface; three AA-level issues found and fixed in the new code, one pre-existing AA gap identified and consciously left (see Low-2).

## High (fixed)

### H-1. Live ticker re-announced its entire visible list on every poll
- **WCAG**: 4.1.3 Status Messages (AA)
- **Impact**: Screen-reader users on `/economy` would have the whole 12-row activity list re-read to them every 15 seconds, indefinitely, whether or not anything actually changed — a serious, repeated interruption to reading the rest of the page.
- **Location**: `apps/web/components/economy/EventTicker.tsx` (was: `<ul aria-live="polite">` wrapping all rows)
- **What's wrong**: `aria-live="polite"` was set on the container of the whole rendered list, not on a targeted region, so any re-render (even an unchanged list) is a live-region update candidate for most screen readers.
- **Fix applied**: Moved `aria-live="polite"` onto a separate, visually-hidden (`sr-only`) paragraph that only updates its text when the newest entry's id actually changes; the visible `<ul>` itself no longer carries `aria-live`. Screen-reader users now hear one short line ("Escrow harvest, $70.00") only when something new happens, and can still read the full list on demand.

### H-2. Informational text set in `--forest-60` fails contrast on paper/stock
- **WCAG**: 1.4.3 Contrast (Minimum) (AA)
- **Impact**: Low-vision users reading the "Runway applies to active loans only" note on `/economy` agent cards, and the "Not published yet" label on `/docs`, would see text at roughly **3.37:1** against the paper background — below the 4.5:1 minimum for normal-size text (these are 13.5px, not "large text").
- **Location**: `apps/web/components/economy/EconomyIndex.module.css:110` (`.cardNote`), `apps/web/components/docs/DocsIndex.module.css:190` (`.docUnavailable`)
- **What's wrong**: `color: var(--forest-60)` (`rgba(23,63,53,0.6)`) on `--paper`/`--stock` computes to ~3.37:1 — the token's only other existing uses in the codebase are for genuinely decorative text (a code-sample comment) and `::placeholder` text, both held to a lower bar; using it for real informational copy was a new, higher-stakes use.
- **Fix applied**: Changed both to `var(--forest-70)` (the token already used everywhere else in the app for meta/caption text), which computes to ~4.83:1 — passes AA. No new token introduced; reused the established "meta text" color.

### H-3. Full 42-character addresses set as link text on `/docs`
- **WCAG**: 2.4.4 Link Purpose (In Context) (AA, borderline) / general screen-reader usability
- **Impact**: Screen readers would spell out or character-chunk a full `0x…` address for every contract link, and at 390px the raw address forced awkward wrapping — a real usability barrier for AT users and a deviation from the app's own established convention (every other page shortens addresses for display and keeps the full value only in the `href`).
- **Location**: `apps/web/components/docs/DocsIndex.tsx` (`ChainRow`, hub/underwriter/owner address links)
- **Fix applied**: Link text now uses `shortAddress()` (matching `CardSpendFeed`, `AuctionsIndex`, etc.), with the full address kept in `href` (unchanged) and added as a `title` attribute for sighted users who want to inspect it.

## Medium (fixed)

### M-1. `formatDate`-adjacent client formatting could have mismatched server/client timezone
- **WCAG**: not a WCAG criterion directly, but a correctness/robustness issue that would surface as flaky hydration warnings and, if it fired, as an accessibility-relevant "text changes unexpectedly" symptom.
- **Location**: `apps/web/components/economy/EventTicker.tsx` (client component formatting live-polled timestamps)
- **What's wrong**: A naive `toLocaleTimeString()` without a fixed `timeZone` would format differently on the server (build/render host, typically UTC) than in the viewer's browser, causing the first client render to disagree with the server-rendered HTML.
- **Fix applied**: Added `formatClock()` to `lib/format.ts`, pinned to `timeZone: "UTC"`, used by the ticker. Deterministic regardless of where it runs.

## Low (consciously left)

### L-1. `.eyebrow` category labels use `--ochre-ink` at 13.5px bold, below the "large text" threshold
- **WCAG**: 1.4.3 Contrast (Minimum) (AA)
- **Impact**: Low-vision users reading the small "EVERY AGENT, LIVE" / "YOUR LENDING BOOK" / "QUICKSTART" eyebrow labels get ~3.45:1, below the 4.5:1 normal-text minimum (it only clears the 3:1 large-text/UI-component threshold the project's own `contrast.test.ts` validates it against).
- **Location**: every page's `.eyebrow` class (e.g. `apps/web/components/economy/EconomyIndex.module.css:12`, and identically in `components/loans/LoanDetail.module.css`, `components/auctions/AuctionsIndex.module.css`, `components/underwrite/*`, present since the landing page shipped).
- **Why left**: This is a site-wide, already-reviewed design-system choice (`--ochre-ink` for "informational ochre text", per the design brief), not something introduced by this task's new pages — I reused the exact existing pattern rather than inventing a new one, per "no new visual language." The eyebrow text is always immediately followed by a large, high-contrast `<h1>`/`<h2>` restating the same context, so the practical information loss for a low-vision reader is small (the eyebrow is a category label, not unique content). Fixing it site-wide (recoloring or resizing every `.eyebrow` across ~10 already-reviewed files) is a design-system change outside this task's scope and risks contradicting the locked visual language. Flagging here rather than fixing silently.

### L-2. Fenced code blocks (`/docs`) scroll horizontally but aren't independently focusable
- **WCAG**: 2.1.1 Keyboard (A) — best-practice extension, not a strict failure here since the page itself doesn't require the scroll for 1.4.10 Reflow (code samples are a recognized exception)
- **Location**: `apps/web/components/docs/DocsIndex.tsx` (`<pre className={styles.pre}>`), `apps/web/components/docs/Markdown.tsx` (`<pre>`)
- **Why left**: Keyboard users can still select/copy the text; only wide lines that overflow the box need mouse/trackpad scrolling to view fully, and the same un-focusable-`<pre>` pattern already exists in the reviewed `ApplyTabs` component on the landing page. Adding `tabIndex={0}` to every `<pre>` would be a one-line improvement but is inconsistent with the existing precedent and was left for a follow-up rather than introducing a new pattern unilaterally.

## Verify manually

- **Dynamic wallet modal focus trap** (`DynamicContextProvider`'s auth flow, `components/wallet/DynamicProvider.tsx`): focus management inside the third-party wallet-connect modal is controlled by `@dynamic-labs/sdk-react-core`, outside this codebase — verify with a real screen reader that focus enters and returns correctly around `setShowAuthFlow(true)`.
- **Reading order at 390px** on `/economy`'s card grid and `/portfolio`'s claim rows — static analysis confirms DOM order matches visual order (no CSS `order`/absolute repositioning), but confirm with a screen reader pass.
- **Zoom to 400%** on `/docs`'s deployment address table and the claims-ledger markdown tables — confirm no clipped content.
- **Live-region announcement cadence** on `/economy` (H-1's fix) — confirm with an actual screen reader that the single-line announcement reads sensibly and doesn't queue up stale announcements during a long session.

## Passed checks

- **Images/icons**: `HalftonePortrait` renders as `role="img"` with a real `aria-label` built from a short address (`components/economy/AgentCard.tsx`); decorative plates (`<img alt="">`) correctly hidden. Folio/RunningHead decorative numerals are `aria-hidden="true"`.
- **Forms**: every text input in `BidForm`/`DisabledBidForm`/`DisabledPortfolio` uses an implicit `<label><span>…</span><input/></label>` association — no orphaned inputs.
- **Structure**: `/economy`, `/portfolio`, `/docs`, `/docs/[slug]` all render exactly one `<h1>` with no skipped heading levels (verified by e2e assertions in `e2e/economy.spec.ts`, `e2e/portfolio.spec.ts`, `e2e/docs.spec.ts`, matching the pattern already used for `/auctions`, `/loans/[loanId]`).
- **Landmarks**: `<nav aria-label="Primary">` / `<nav aria-label="Footer">`; skip link present on every new page (`<a class="skip-link" href="#main">`).
- **Current-route indication**: `Masthead` now marks the active top-level nav link with `aria-current="page"` (not color alone — also an underline treatment), reachable at both viewports (the "Portfolio" link intentionally drops from the compact masthead below 860px per the existing `optional` nav pattern, but stays reachable via the footer).
- **Errors**: wallet-flow errors use `role="alert"` (`BidForm`, `PortfolioIsland`) so failures are announced without requiring focus to move.
- **Reduced motion**: `EventTicker` never animates row entry/exit; `HalftonePortrait`'s print-in animation already respects `prefers-reduced-motion` (pre-existing).
- **Tables**: markdown tables render `<th scope="col">` (`components/docs/Markdown.tsx`).

## Next steps

1. None outstanding at Critical/High — all three fixed in this pass.
2. Consider, in a follow-up with design sign-off: either resize `.eyebrow` to qualify as WCAG "large text" (≥18.66px bold) or darken `--ochre-ink` further, site-wide (L-1).
3. Optional polish: `tabIndex={0}` on scrollable `<pre>` code blocks (L-2).

---

*This is a static code audit, not a full conformance evaluation. Some criteria require manual testing with assistive technology. For a binding conformance claim (VPAT/ACR) or legal certainty, engage an accessibility specialist.*
