// Small typed client for the Sauti USSD/SMS bridge.
// The bridge is what actually custody-holds keys for feature-phone voters,
// and it's the source of truth for the community's member list on the
// Onboarding flow.

import { config } from "./config";

export interface BridgeVoter {
  msisdn: string;
  name?: string;
  voterRef?: string;
  memberIndex: number;
  publicKey: string;
  /** true if this row *reused* an existing keypair (same voter, another phone). */
  alias?: boolean;
}

export interface BridgeMembers {
  members: string[];
  root: string;
  count: number;
}

export interface BridgeStatus {
  registered: boolean;
  msisdn: string;
  memberIndex?: number;
  publicKey?: string;
  voterRef?: string;
  /** Every phone number bound to the same keypair as `msisdn`. */
  aliases?: string[];
}

export interface BulkResult {
  ok: boolean;
  mode: "append" | "replace";
  count: number;
  uniqueVoters: number;
  total: number;
  root: string;
  members: string[];
  assignments: BridgeVoter[];
}

export interface LinkResult {
  ok: boolean;
  msisdn: string;
  memberIndex: number;
  publicKey: string;
  aliases: string[];
}

function url(path: string): string {
  return `${config.bridgeUrl}${path}`;
}

async function json<T>(resp: Response): Promise<T> {
  const body = await resp.text();
  let parsed: any;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`Bridge returned non-JSON (${resp.status}): ${body.slice(0, 200)}`);
  }
  if (!resp.ok) {
    throw new Error(parsed?.error ?? `Bridge ${resp.status}`);
  }
  return parsed as T;
}

export async function fetchHealth(): Promise<{ ok: boolean; members: number; root: string }> {
  const r = await fetch(url("/health"));
  return json(r);
}

export async function fetchMembers(): Promise<BridgeMembers> {
  const r = await fetch(url("/members"));
  return json(r);
}

export async function fetchVoterStatus(msisdn: string): Promise<BridgeStatus> {
  const r = await fetch(url(`/voters/status?msisdn=${encodeURIComponent(msisdn)}`));
  return json(r);
}

export async function bulkProvision(
  voters: Array<{ msisdn: string; name?: string; voterRef?: string }>,
  mode: "replace" | "append" = "replace",
): Promise<BulkResult> {
  const r = await fetch(url("/voters/bulk"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voters, mode }),
  });
  return json(r);
}

/** Bind an additional phone number to an already-enrolled voter,
 *  identified either by their `voterRef` (e.g. student number) or by
 *  another `existingMsisdn` already known to belong to them. Both phones
 *  will share one keypair and therefore one vote. */
export async function linkPhone(args: {
  msisdn: string;
  voterRef?: string;
  existingMsisdn?: string;
}): Promise<LinkResult> {
  const r = await fetch(url("/voters/link"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return json(r);
}
