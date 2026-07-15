// One-time-password store, in-memory. Keyed by normalized voterRef.
//
// A voter requests an OTP with their ID (voterRef). We SMS the code to
// every phone bound to that ref across every list they appear on. When
// the voter enters the code on the vote page we verify it exactly once
// — a successful verify consumes the record so the same code can't be
// replayed. Codes expire after `config.otp.ttlSec` seconds.
//
// This is deliberately dependency-free (no Redis / no DB). For a
// multi-instance production deployment swap this map for something
// shared, e.g. Redis with SETEX.

import crypto from "node:crypto";
import { config } from "./config.js";

interface OtpRecord {
  code: string;
  expiresAt: number; // epoch ms
  msisdns: string[]; // every phone we tried to reach
  attempts: number;
}

const MAX_ATTEMPTS = 5;
const store = new Map<string, OtpRecord>();

function randomCode(length: number): string {
  const digits = "0123456789";
  let s = "";
  const buf = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) s += digits[buf[i] % 10];
  return s;
}

/** Create (or overwrite) an OTP for `refKey`. Returns the code so the
 *  caller can send it via SMS. */
export function issueOtp(refKey: string, msisdns: string[]): {
  code: string;
  expiresAt: number;
} {
  const code = randomCode(config.otp.length);
  const expiresAt = Date.now() + config.otp.ttlSec * 1000;
  store.set(refKey, { code, expiresAt, msisdns, attempts: 0 });
  return { code, expiresAt };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "no_code" | "expired" | "wrong_code" | "too_many_attempts" };

/** Check `code` against the outstanding OTP for `refKey`. Consumes the
 *  record on success (single-use). Increments attempts on wrong code
 *  and locks out after MAX_ATTEMPTS. */
export function verifyOtp(refKey: string, code: string): VerifyResult {
  const rec = store.get(refKey);
  if (!rec) return { ok: false, reason: "no_code" };
  if (Date.now() > rec.expiresAt) {
    store.delete(refKey);
    return { ok: false, reason: "expired" };
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    store.delete(refKey);
    return { ok: false, reason: "too_many_attempts" };
  }
  if (rec.code !== code) {
    rec.attempts += 1;
    return { ok: false, reason: "wrong_code" };
  }
  store.delete(refKey);
  return { ok: true };
}

/** Mask a phone for display: "+256701234567" -> "+2567•••4567". */
export function maskMsisdn(msisdn: string): string {
  if (msisdn.length <= 8) return msisdn;
  return msisdn.slice(0, 5) + "•••" + msisdn.slice(-4);
}
