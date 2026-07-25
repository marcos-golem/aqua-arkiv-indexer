/**
 * Address normalisation shared by the QueryApi implementation and the HTTP layer. Kept as one
 * small file rather than duplicated in both places, since "addresses are lowercase throughout
 * this codebase" (docs/SDK-SURFACE.md) is a rule every read boundary has to enforce itself —
 * nothing upstream guarantees callers already did it.
 */

import type { Addr } from '../types.js';

const ADDR_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** True if `s` is a well-formed 20-byte hex address (case-insensitive). */
export function isAddrLike(s: string): boolean {
  return ADDR_PATTERN.test(s);
}

/** Lowercases an address-like string. Caller is responsible for shape validation first
 * (via {@link isAddrLike}) when the input is untrusted, e.g. an HTTP query param. */
export function toLowerAddr(s: string): Addr {
  return s.toLowerCase() as Addr;
}

/**
 * Canonical form of a token pair: both lowercased, then ordered, so `(A, B)` and `(B, A)` always
 * produce the same query. Mirrors how `StrategyAttestation.tokens` itself is stored sorted
 * (src/types.ts) — this is the read-side half of that same convention.
 */
export function normalizePair(a: string, b: string): readonly [Addr, Addr] {
  const x = toLowerAddr(a);
  const y = toLowerAddr(b);
  return x <= y ? [x, y] : [y, x];
}
