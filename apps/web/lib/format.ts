/**
 * Number and identifier formatting shared by every page. All output is
 * locale-fixed (en-US grouping) so server and client renders match.
 */

const grouped0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const grouped2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const clock = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${value}`);
}

function withSign(negative: boolean, body: string): string {
  return negative ? `-${body}` : body;
}

export interface UsdOptions {
  /** `true` always prints cents, `false` never does, `"auto"` prints them only for fractional amounts. */
  cents?: boolean | "auto";
}

/** `$312`, `$241.80`, `$4,180`; `{ cents: true }` gives `$1.00`. */
export function formatUsd(value: number, { cents = "auto" }: UsdOptions = {}): string {
  assertFinite(value, "USD amount");
  const abs = Math.abs(value);
  const showCents = cents === "auto" ? !Number.isInteger(abs) : cents;
  const body = showCents ? grouped2.format(abs) : grouped0.format(Math.round(abs));
  const isZero = showCents ? body === "0.00" : body === "0";
  return withSign(value < 0 && !isZero, `$${body}`);
}

/** A price held in whole cents, printed as dollars: `84` gives `$0.84`. */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) throw new RangeError(`cents must be an integer, got ${cents}`);
  return formatUsd(cents / 100, { cents: true });
}

/** `31204` gives `31,204`. */
export function formatInteger(value: number): string {
  assertFinite(value, "integer");
  return grouped0.format(Math.round(value));
}

/** Block heights, grouped: `18,204,113`. Accepts bigint so chain data never loses precision. */
export function formatBlock(block: number | bigint): string {
  if (typeof block === "number") {
    if (!Number.isSafeInteger(block) || block < 0) {
      throw new RangeError(`block must be a non-negative integer, got ${block}`);
    }
    return grouped0.format(block);
  }
  if (block < 0n) throw new RangeError(`block must be non-negative, got ${block}`);
  return block.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface UsdcOptions {
  unit?: boolean;
}

/** `900` gives `900.00 USDC`, as a receipt prints it. */
export function formatUsdc(value: number, { unit = true }: UsdcOptions = {}): string {
  assertFinite(value, "USDC amount");
  const body = grouped2.format(value);
  return unit ? `${body} USDC` : body;
}

/** A repayment cap multiple, without the multiplication sign: `1.19`. */
export function formatMultiple(value: number): string {
  assertFinite(value, "multiple");
  return value.toFixed(2);
}

/** A ratio as a whole percent, without the sign: `0.65` gives `65`. */
export function formatPercent(ratio: number): string {
  assertFinite(ratio, "ratio");
  return String(Math.round(ratio * 100));
}

export interface ShortOptions {
  head?: number;
  tail?: number;
}

function shorten(hex: string, head: number, tail: number): string {
  const lower = hex.toLowerCase();
  return `${lower.slice(0, 2 + head)}…${lower.slice(-tail)}`;
}

/** `0x3f2c…9e11`. Throws on anything that is not a 20-byte hex address. */
export function shortAddress(address: string, { head = 4, tail = 4 }: ShortOptions = {}): string {
  if (!HEX_ADDRESS.test(address)) throw new TypeError(`not an address: ${address}`);
  return shorten(address, head, tail);
}

/** `0x5e1d…a94c`. Throws on anything that is not a 32-byte hex hash. */
export function shortHash(hash: string, { head = 4, tail = 4 }: ShortOptions = {}): string {
  if (!HEX_HASH.test(hash)) throw new TypeError(`not a transaction hash: ${hash}`);
  return shorten(hash, head, tail);
}

/** The first bytes of an address, used as a note series name: `0x3f2c`. */
export function addressPrefix(address: string, length = 4): string {
  if (!HEX_ADDRESS.test(address)) throw new TypeError(`not an address: ${address}`);
  return address.slice(0, 2 + length).toLowerCase();
}

export function isAddress(value: string): value is `0x${string}` {
  return HEX_ADDRESS.test(value);
}

export function isTxHash(value: string): value is `0x${string}` {
  return HEX_HASH.test(value);
}

/** Money already expressed as micro-USD (1e6 == $1) — the underwriting engine's unit for
 * every dollar figure in an evidence bundle (and USDC-wei, which happens to share the same
 * scale) — converted to a plain USD number ready for `formatUsd`. */
export function microUsdToUsd(value: bigint): number {
  return Number(value) / 1_000_000;
}

/** A duration in whole seconds as a short label: `1_260_000` gives `"14d 14h"`, `7_200` gives
 * `"2h"`, `90` gives `"1m"`, `0` gives `"0m"`. Never negative — a caller past its deadline
 * should clamp to `0` before formatting, not rely on this to hide a negative runway. */
export function formatDuration(seconds: number): string {
  assertFinite(seconds, "duration");
  if (seconds < 0) throw new RangeError(`duration must not be negative, got ${seconds}`);
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** A unix-seconds timestamp as a fixed UTC clock reading, e.g. `"14:32 UTC"` — deterministic
 * regardless of the server's or the viewer's local timezone, so a client component that
 * formats a live-polled timestamp never mismatches its own server-rendered first paint. */
export function formatClock(timestampSeconds: number): string {
  assertFinite(timestampSeconds, "timestamp");
  return `${clock.format(new Date(timestampSeconds * 1000))} UTC`;
}
