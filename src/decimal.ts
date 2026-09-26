/**
 * Exact decimal arithmetic on strings, for guardrail checks only. Amounts are never
 * converted to floating point.
 */

const DECIMAL = /^\d+(\.\d+)?$/;

export function isDecimal(s: string): boolean {
  return DECIMAL.test(s);
}

interface Scaled {
  int: bigint;
  scale: number;
}

function parse(s: string): Scaled {
  if (!isDecimal(s)) throw new Error(`not a decimal: ${s}`);
  const [whole = "0", frac = ""] = s.split(".");
  return { int: BigInt(whole + frac), scale: frac.length };
}

function format({ int, scale }: Scaled): string {
  const neg = int < 0n;
  let digits = (neg ? -int : int).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    const whole = digits.slice(0, -scale);
    const frac = digits.slice(-scale).replace(/0+$/, "");
    digits = frac ? `${whole}.${frac}` : whole;
  }
  return (neg ? "-" : "") + digits;
}

function align(a: Scaled, b: Scaled): [bigint, bigint] {
  const scale = Math.max(a.scale, b.scale);
  return [a.int * 10n ** BigInt(scale - a.scale), b.int * 10n ** BigInt(scale - b.scale)];
}

export function normalizeDecimal(s: string): string {
  return format(parse(s));
}

export function isPositiveDecimal(s: string): boolean {
  return isDecimal(s) && parse(s).int > 0n;
}

export function isZero(s: string): boolean {
  return isDecimal(s) && parse(s).int === 0n;
}

/** -1, 0 or 1. */
export function compare(a: string, b: string): number {
  const [x, y] = align(parse(a), parse(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export function add(a: string, b: string): string {
  const pa = parse(a);
  const pb = parse(b);
  const [x, y] = align(pa, pb);
  return format({ int: x + y, scale: Math.max(pa.scale, pb.scale) });
}

export function sub(a: string, b: string): string {
  const pa = parse(a);
  const pb = parse(b);
  const [x, y] = align(pa, pb);
  return format({ int: x - y, scale: Math.max(pa.scale, pb.scale) });
}

export function mul(a: string, b: string): string {
  const pa = parse(a);
  const pb = parse(b);
  return format({ int: pa.int * pb.int, scale: pa.scale + pb.scale });
}

export function max(a: string, b: string): string {
  return compare(a, b) >= 0 ? a : b;
}

export function min(a: string, b: string): string {
  return compare(a, b) <= 0 ? a : b;
}
