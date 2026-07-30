// Small typed client for the Sauti voter bridge (custodial keys +
// list management + phone-based voting).
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
  activeList?: { id: string; name: string };
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

export interface EnrolledVoter {
  msisdn: string;
  memberIndex: number;
  publicKey: string;
  voterRef?: string;
}

/** Full public listing of enrolled voters. Never leaks custodial secrets. */
export async function fetchAllVoters(): Promise<EnrolledVoter[]> {
  const r = await fetch(url("/voters"));
  const body = await json<{ voters: EnrolledVoter[] }>(r);
  return body.voters;
}

/** Remove a single voter from the active list. If the voter shares
 *  their custodial key with other phones (aliases) only this msisdn is
 *  unbound. Otherwise the slot is compacted and remaining indices
 *  shift down — surviving keypairs are preserved. Returns the fresh
 *  member count and Merkle root. */
export async function deleteVoter(msisdn: string): Promise<{
  ok: true;
  mode: "unbind-alias" | "compact-slot";
  removed: string;
  total: number;
  root: string;
}> {
  const r = await fetch(url(`/voters/${encodeURIComponent(msisdn)}`), {
    method: "DELETE",
  });
  return json(r);
}

// -------------------- Voter lists (folders) --------------------

export interface VoterList {
  id: string;
  name: string;
  createdAt: number;
  memberCount: number;
  active: boolean;
  communityId?: number | null;
}

export async function fetchLists(): Promise<{ activeId: string; lists: VoterList[] }> {
  const r = await fetch(url("/lists"));
  return json(r);
}

export async function createList(name: string, activate = true): Promise<{
  list: Omit<VoterList, "memberCount" | "active">;
  activeId: string;
}> {
  const r = await fetch(url("/lists"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, activate }),
  });
  const body = await json<{
    ok: true;
    list: Omit<VoterList, "memberCount" | "active">;
    activeId: string;
  }>(r);
  return { list: body.list, activeId: body.activeId };
}

export async function activateList(id: string): Promise<{
  active: { id: string; name: string };
  count: number;
  root: string;
}> {
  const r = await fetch(url(`/lists/${encodeURIComponent(id)}/activate`), {
    method: "POST",
  });
  return json(r);
}

export async function renameList(id: string, name: string): Promise<{ list: VoterList }> {
  const r = await fetch(url(`/lists/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return json(r);
}

export async function deleteList(id: string): Promise<{
  deleted: { id: string; name: string };
  activeId: string;
  count: number;
}> {
  const r = await fetch(url(`/lists/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  return json(r);
}

/** Vote using the custodial key held by the bridge for `msisdn`. The
 *  bridge looks up the voter's Stellar keypair, builds the Merkle proof
 *  from the active list, and submits the transaction. Returns the
 *  fresh tally for immediate UI feedback. */
export async function voteByPhone(args: {
  msisdn: string;
  electionId: number;
  optionIndex: number;
}): Promise<{
  ok: true;
  election: {
    id: number;
    question: string;
    choice: string;
    tallies: number[];
    totalVotes: number;
  };
}> {
  const r = await fetch(url("/vote"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
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

// -------------------- Community binding (list -> on-chain community) -----

/** Read which on-chain community a voter list is bound to. Returns
 *  `communityId: null` if the list has never been registered on-chain. */
export async function getListCommunity(listId: string): Promise<{
  listId: string;
  communityId: number | null;
}> {
  const r = await fetch(url(`/lists/${encodeURIComponent(listId)}/community`));
  return json(r);
}

/** Read a specific list's members + Merkle root WITHOUT changing the
 *  active list. Used by the community-sync flow so it always hashes the
 *  roll bound to that community, not whatever list happens to be active. */
export async function fetchListMembers(listId: string): Promise<{
  listId: string;
  members: string[];
  root: string;
  count: number;
}> {
  const r = await fetch(url(`/lists/${encodeURIComponent(listId)}/members`));
  return json(r);
}

/** Persist the mapping "this voter list == on-chain community #N".
 *  Call this immediately after a successful register_community so the
 *  ID-first voting flow can filter elections by community. */
export async function bindListCommunity(
  listId: string,
  communityId: number,
): Promise<{ ok: true; listId: string; communityId: number }> {
  const r = await fetch(url(`/lists/${encodeURIComponent(listId)}/community`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ communityId }),
  });
  return json(r);
}

// -------------------- ID-first (OTP) voting ------------------------------

export interface OtpRequestResult {
  ok: boolean;
  sentTo: string[]; // masked phones e.g. "+2567•••4567"
  expiresAt: number;
  devMode: boolean;
  devCode?: string; // only returned when the bridge has no SMS credentials
  providerStatuses?: Array<{
    to: string;
    ok: boolean;
    provider: string;
    status?: string;
    error?: string;
  }>;
  error?: string;
}

/** Ask the bridge to SMS a one-time code to every phone bound to
 *  `voterRef`. On dev builds (no AT creds) the plaintext code comes
 *  back in `devCode` for testing. */
export async function requestOtp(voterRef: string): Promise<OtpRequestResult> {
  const r = await fetch(url("/otp/request"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voterRef }),
  });
  return json(r);
}

export interface VoterElection {
  electionId: number;
  communityId: number;
  listId: string;
  listName: string;
  question: string;
  options: string[];
  closesAt: number;
  closed: boolean;
  totalVotes: number;
  open: boolean;
}

/** List every election this voter is eligible to vote in, across every
 *  community they're enrolled in. `unboundLists` names any lists that
 *  the voter is on but which haven't been bound to an on-chain
 *  community — those elections can't appear here yet. */
export async function fetchVoterElections(voterRef: string): Promise<{
  voterRef: string;
  elections: VoterElection[];
  unboundLists: string[];
}> {
  const r = await fetch(url(`/voter/${encodeURIComponent(voterRef)}/elections`));
  return json(r);
}

/** Cast a vote using ID + OTP. The bridge verifies the code, finds
 *  the voter's custodial keypair (in whichever list holds the community
 *  that owns this election) and submits the transaction. */
export async function voteByRef(args: {
  voterRef: string;
  code: string;
  electionId: number;
  optionIndex: number;
}): Promise<{
  ok: true;
  election: {
    id: number;
    question: string;
    choice: string;
    tallies: number[];
    totalVotes: number;
  };
}> {
  const r = await fetch(url("/vote/by-ref"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return json(r);
}

// -------------------- Candidate photos ------------------------------------

/** Absolute URL to a candidate photo previously returned by
 *  {@link uploadCandidatePhoto}. Returns `null` if `hash` is empty. */
export function candidatePhotoUrl(hash: string | undefined | null): string | null {
  if (!hash) return null;
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
  return url(`/photos/${hash}`);
}

/** Upload a candidate photo to the bridge. Returns the sha256 hash to
 *  embed in the on-chain option JSON. Accepts jpeg/png/webp up to
 *  512 KB. Callers should compress client-side before uploading. */
export async function uploadCandidatePhoto(
  file: Blob,
): Promise<{ hash: string; ext: string; size: number; url: string }> {
  const mime = file.type || "image/jpeg";
  const r = await fetch(url("/photos"), {
    method: "POST",
    headers: { "content-type": mime },
    body: file,
  });
  return json(r);
}

// -------------------- Multilingual ballot translation --------------------

export interface SupportedLanguage {
  code: string;
  label: string;
}

/** List the languages Sunbird+the bridge support for ballot translation. */
export async function fetchLanguages(): Promise<{
  languages: SupportedLanguage[];
  sunbirdConfigured: boolean;
}> {
  const r = await fetch(url("/languages"));
  return json(r);
}

export interface BallotTranslation {
  question: string;
  options: string[];
  sourceHash: string;
  updatedAt: number;
}

/** Translate an election's ballot into a target language. The bridge
 *  caches results, so calling this twice for the same target is cheap.
 *  Passing `source` lets the caller feed pre-decoded labels (avoids
 *  translating JSON metadata blobs). */
export async function translateBallot(args: {
  electionId: number;
  target: string;
  source?: { question: string; options: string[] };
}): Promise<{
  electionId: number;
  lang: string;
  translation: BallotTranslation;
  sunbirdConfigured: boolean;
}> {
  const r = await fetch(url("/translate/ballot"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return json(r);
}

/** Translate a batch of arbitrary UI strings into a target language.
 *  The bridge caches per (target, text), so repeated interface strings
 *  are only translated once. Returns translations aligned to `texts`. */
export async function translateTexts(
  target: string,
  texts: string[],
): Promise<{ target: string; translations: string[] }> {
  const r = await fetch(url("/translate/text"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, texts }),
  });
  return json(r);
}

// -------------------- Anomaly / audit notes --------------------

export interface AnomalyNote {
  level: "info" | "warn" | "alert";
  title: string;
  detail: string;
}

export interface AnomalyReport {
  electionId: number;
  loggedVotes: number;
  onChainTotal: number;
  coverage: number;
  notes: AnomalyNote[];
}

export async function fetchAnomalies(electionId: number): Promise<AnomalyReport> {
  const r = await fetch(url(`/anomalies/${electionId}`));
  return json(r);
}

// -------------------- Voice IVR simulation (demo) --------------------

export interface VoiceSimulateResult {
  ok: boolean;
  choice?: string;
  match?: { index: number; confidence: number; label: string };
  tallies?: number[];
  error?: string;
}

/** Dev endpoint: run the voice IVR pipeline (matcher + submit) with a
 *  text transcript instead of a real recorded call. Handy for demos. */
export async function simulateVoiceVote(args: {
  callerNumber: string;
  electionId: number;
  transcript: string;
  lang?: string;
}): Promise<VoiceSimulateResult> {
  const r = await fetch(url("/voice/simulate"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return json(r);
}
