import fs from "node:fs";
import path from "node:path";

export interface VoterRecord {
  publicKey: string; // G...
  secret: string; // S... — custodial, hackathon simplification
  memberIndex: number; // index into the community's member list
  voterRef?: string; // normalized identity string (national ID, student number, ...)
  lastSeen?: number; // epoch seconds
}

export type Registry = Record<string /* msisdn e.g. +2567... */, VoterRecord>;

let cache: Registry | null = null;
let cachePath = "";

export function loadRegistry(filepath: string): Registry {
  cachePath = path.resolve(filepath);
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "{}\n");
  }
  const raw = fs.readFileSync(cachePath, "utf8");
  cache = JSON.parse(raw) as Registry;
  return cache;
}

export function getVoter(msisdn: string): VoterRecord | undefined {
  if (!cache) throw new Error("Registry not loaded");
  return cache[normalize(msisdn)];
}

export function upsertVoter(msisdn: string, rec: VoterRecord): void {
  if (!cache) throw new Error("Registry not loaded");
  cache[normalize(msisdn)] = rec;
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
}

/** Wipe all voter bindings. Used by /voters/bulk in `replace` mode so
 *  that a fresh community doesn't inherit stale msisdn->memberIndex
 *  mappings from a previous community. */
export function clearVoters(): void {
  if (!cache) throw new Error("Registry not loaded");
  for (const k of Object.keys(cache)) delete cache[k];
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
}

/** Find the first voter record with this `voterRef`, if any.
 *  Used to detect "same person, another phone" — every msisdn bound
 *  to that ref gets the same keypair and member index, and the contract
 *  dedupes votes by wallet address so the person still votes once. */
export function findByRef(ref: string): VoterRecord | undefined {
  if (!cache) throw new Error("Registry not loaded");
  const norm = normalizeRef(ref);
  for (const rec of Object.values(cache)) {
    if (rec.voterRef && rec.voterRef === norm) return rec;
  }
  return undefined;
}

/** Return all phones bound to a specific voterRef. */
export function phonesForRef(ref: string): string[] {
  if (!cache) throw new Error("Registry not loaded");
  const norm = normalizeRef(ref);
  return Object.entries(cache)
    .filter(([, r]) => r.voterRef === norm)
    .map(([msisdn]) => msisdn);
}

/** Return all phones bound to a specific memberIndex. */
export function phonesForMemberIndex(idx: number): string[] {
  if (!cache) throw new Error("Registry not loaded");
  return Object.entries(cache)
    .filter(([, r]) => r.memberIndex === idx)
    .map(([msisdn]) => msisdn);
}

/** Public listing (never leaks the custodial secret). */
export function listVoters(): Array<{
  msisdn: string;
  memberIndex: number;
  publicKey: string;
  voterRef?: string;
}> {
  if (!cache) throw new Error("Registry not loaded");
  return Object.entries(cache).map(([msisdn, r]) => ({
    msisdn,
    memberIndex: r.memberIndex,
    publicKey: r.publicKey,
    voterRef: r.voterRef,
  }));
}

/** Normalize to E.164-ish: strip spaces, keep leading `+`. */
export function normalize(msisdn: string): string {
  return msisdn.trim().replace(/[^\d+]/g, "");
}

/** Normalize a voter reference. Case-insensitive, whitespace-collapsed.
 *  A student number "csc/2023/001" and " CSC / 2023 / 001 " should match. */
export function normalizeRef(ref: string): string {
  return ref.trim().replace(/\s+/g, "").toLowerCase();
}

export function loadMembers(filepath: string): string[] {
  const p = path.resolve(filepath);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "[]\n");
  }
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as string[];
}
