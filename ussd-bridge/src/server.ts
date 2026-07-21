import express, { type Request, type Response } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import {
  getVoter,
  loadMembers,
  normalize,
  normalizeRef,
  findByRef,
  phonesForRef,
  phonesForMemberIndex,
  upsertVoter,
  listVoters,
  clearVoters,
  type VoterRecord,
} from "./registry.js";
import { buildTree, proofForIndex } from "./merkle.js";
import { readCommunity, readElection, readHasVoted, readNextElectionId, submitVote } from "./soroban.js";
import { Keypair } from "@stellar/stellar-sdk";
import {
  initLists,
  getActive,
  getIndex,
  pathsForList,
  createList,
  activateList,
  deleteList,
  renameList,
  listsWithCounts,
  getListCommunity,
  setListCommunity,
  findVoterAcrossLists,
  findVoterByPhoneAcrossLists,
} from "./lists.js";
import { issueOtp, maskMsisdn, verifyOtp } from "./otp.js";
import { sendSms } from "./sms.js";

// ---------------------------------------------------------------------------
// Sauti USSD/SMS bridge
//
// Africa's Talking (and every USSD gateway I've touched) POSTs the current
// session state to a webhook and expects a plain-text response that STARTS
// with `CON ` (continue — show and expect more input) or `END ` (terminate
// the session with a final message). We honour that convention exactly.
//
// SMS is a much simpler happy-path fallback: one POST -> we parse the
// message body, cast the vote, and return a confirmation string. Wire it
// to any SMS-in webhook (AT, Twilio, a raw modem).
// ---------------------------------------------------------------------------

// In-memory rate limit: msisdn -> last vote timestamp.
// Blunt but sufficient for the demo's anti-Sybil narrative.
const lastVoteAt = new Map<string, number>();
const RATE_LIMIT_MS = 5_000;

// Short-lived session tokens issued by /otp/verify so the frontend can
// take the user through election-picking without re-entering the code.
const otpSession = new Map<string, { ref: string; expiresAt: number }>();

// Voter lists (each with its own members + registry). Sets the initial
// active list, migrating legacy single-file data on first boot.
initLists();
const __init = activateList(getIndex().activeId);
let members = __init.members;

// Return the disk paths for the currently-active list. Any endpoint
// that reads or rewrites members / secrets should call this instead of
// hard-coding config.membersPath.
function currentPaths(): { registryPath: string; membersPath: string } {
  return pathsForList(getActive().id);
}

// Rebuild `members` from disk after any operation that rewrites it.
function reloadMembers(): void {
  members = loadMembers(currentPaths().membersPath);
}

// Persist members list and its custodial-secret sidecar for the active list.
function writeMembersAndSecrets(publicKeys: string[], secrets: string[]) {
  const mp = path.resolve(currentPaths().membersPath);
  fs.mkdirSync(path.dirname(mp), { recursive: true });
  fs.writeFileSync(mp, JSON.stringify(publicKeys, null, 2) + "\n");
  const sp = mp + ".secrets.json";
  fs.writeFileSync(sp, JSON.stringify(secrets, null, 2) + "\n");
}

function readSecrets(): string[] {
  const sp = path.resolve(currentPaths().membersPath) + ".secrets.json";
  if (!fs.existsSync(sp)) return [];
  return JSON.parse(fs.readFileSync(sp, "utf8")) as string[];
}

function computeRoot(publicKeys: string[]): string {
  if (publicKeys.length === 0) return "";
  return buildTree(publicKeys).root.toString("hex");
}

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Basic liveness/health
app.get("/health", (_req, res) => {
  const active = getActive();
  res.json({
    ok: true,
    members: members.length,
    root: computeRoot(members),
    activeList: { id: active.id, name: active.name },
  });
});

// -------------------- Public: read the member list --------------------
//
// GET /members
//   -> { members: [G...], root, count }
//
// Handy for the web admin dashboard so it can pre-fill the registration
// form with whatever the bridge is currently custodying.
app.get("/members", (_req, res) => {
  const active = getActive();
  res.json({
    members,
    root: computeRoot(members),
    count: members.length,
    activeList: { id: active.id, name: active.name },
  });
});

// -------------------- Voter self-check --------------------
//
// GET /voters/status?msisdn=+2567...
//   -> { registered, memberIndex?, publicKey? }
//
// A voter (or admin acting on their behalf) types their phone number and
// the bridge confirms whether their line is enrolled. We NEVER return the
// custodial secret over the wire.
app.get("/voters/status", (req: Request, res: Response) => {
  const msisdn = String(req.query.msisdn ?? "");
  if (!msisdn) return res.status(400).json({ error: "msisdn required" });
  const v = getVoter(msisdn);
  if (!v) return res.json({ registered: false, msisdn: normalize(msisdn) });
  return res.json({
    registered: true,
    msisdn: normalize(msisdn),
    memberIndex: v.memberIndex,
    publicKey: v.publicKey,
    voterRef: v.voterRef,
    // Every phone bound to the same custodial keypair as this one.
    // A voter with two SIMs will see both listed here.
    aliases: phonesForMemberIndex(v.memberIndex),
  });
});

// -------------------- Admin/registration --------------------
//
// POST /voters
//   body: { msisdn, memberIndex, secret? }
//
// Provision a voter: bind an msisdn to a Stellar keypair. If `secret`
// is not provided, we generate one. In production the phone number ->
// key binding would be a trusted onboarding flow (SIM-based key, SACCO
// admin identity check, etc.).
app.post("/voters", (req: Request, res: Response) => {
  const { msisdn, memberIndex, secret } = req.body ?? {};
  if (!msisdn || memberIndex === undefined) {
    return res.status(400).json({ error: "msisdn and memberIndex required" });
  }
  const idx = Number(memberIndex);
  if (Number.isNaN(idx) || idx < 0 || idx >= members.length) {
    return res.status(400).json({ error: `memberIndex out of range (0..${members.length - 1})` });
  }
  const kp = secret ? Keypair.fromSecret(secret) : Keypair.random();
  if (kp.publicKey() !== members[idx]) {
    return res.status(400).json({
      error: "Provisioned key does not match the community's member list at that index",
      expected: members[idx],
      got: kp.publicKey(),
    });
  }
  const rec: VoterRecord = {
    publicKey: kp.publicKey(),
    secret: kp.secret(),
    memberIndex: idx,
  };
  upsertVoter(msisdn, rec);
  res.json({ ok: true, publicKey: rec.publicKey });
});

// -------------------- Admin: bulk provisioning --------------------
//
// POST /voters/bulk
//   body: { voters: [{ msisdn, name?, voterRef? }, ...], mode?: "append" | "replace" }
//
// One-shot enrolment for a community. For every distinct `voterRef` in
// the batch (or a bare msisdn when no ref is given) we generate a fresh
// Stellar keypair and add it to the community's member list. If a voter
// supplies the SAME `voterRef` twice (e.g. their work SIM and personal
// SIM), BOTH phones are bound to the SAME keypair and member index —
// the smart contract dedupes by wallet address so they can still only
// vote once.
//
// A `voterRef` is typically a national ID number, student number, or a
// SACCO membership number. It is normalized to strip whitespace / case
// so trivial typos still de-duplicate. It is stored locally on the
// bridge only and never written on-chain.
//
//   mode = "replace" (default): overwrite the current members.json + secrets
//   mode = "append":            add to the current list, preserving indices
//                               and honouring existing voterRef bindings.
//
// SECURITY: the custodial secrets are written to disk and never returned
// in the response. In production this endpoint would be behind admin auth
// (org login, mTLS, etc.) — see AGENT_BUILD_BRIEF.md §6.
app.post("/voters/bulk", (req: Request, res: Response) => {
  const voters: Array<{ msisdn?: string; name?: string; voterRef?: string }> = Array.isArray(
    req.body?.voters,
  )
    ? req.body.voters
    : [];
  const mode = (req.body?.mode as string) ?? "replace";
  if (voters.length === 0) {
    return res.status(400).json({ error: "voters array required" });
  }
  const bad = voters.findIndex((v) => !v || !v.msisdn || typeof v.msisdn !== "string");
  if (bad >= 0) {
    return res.status(400).json({ error: `voter[${bad}] missing msisdn` });
  }
  // De-dup by normalized msisdn within the incoming batch (a single phone
  // can't be listed twice — that's a data entry error).
  const seenPhones = new Set<string>();
  for (const v of voters) {
    const n = normalize(v.msisdn as string);
    if (seenPhones.has(n)) return res.status(400).json({ error: `duplicate msisdn ${n}` });
    seenPhones.add(n);
  }

  let publicKeys: string[];
  let secrets: string[];
  // Map normalized voterRef -> memberIndex used within this run.
  // Seeded with existing bindings in append mode.
  const refToIndex = new Map<string, number>();

  if (mode === "append") {
    publicKeys = [...members];
    secrets = readSecrets();
    if (secrets.length !== publicKeys.length) {
      return res.status(500).json({
        error:
          "Cannot append: bridge does not have secrets for all existing members. Use mode=replace.",
      });
    }
    // Seed refToIndex with existing (ref -> memberIndex) mappings from the
    // registry so a second phone for the same person reuses their slot.
    for (const rec of listVoters()) {
      if (rec.voterRef) refToIndex.set(rec.voterRef, rec.memberIndex);
    }
  } else {
    publicKeys = [];
    secrets = [];
    // Fresh community: wipe stale phone bindings so old memberIndex
    // pointers don't leak into the new list.
    clearVoters();
  }

  const assignments: Array<{
    msisdn: string;
    name?: string;
    voterRef?: string;
    memberIndex: number;
    publicKey: string;
    /** true if this row *reused* an existing keypair (same person, another phone). */
    alias: boolean;
  }> = [];

  for (const v of voters) {
    const rawRef = typeof v.voterRef === "string" ? v.voterRef.trim() : "";
    const ref = rawRef ? normalizeRef(rawRef) : "";
    let memberIndex: number;
    let publicKey: string;
    let secret: string;
    let alias = false;

    if (ref && refToIndex.has(ref)) {
      // Second (or third...) phone for a person already in the community.
      // Bind this msisdn to the same keypair and member index.
      memberIndex = refToIndex.get(ref) as number;
      publicKey = publicKeys[memberIndex];
      secret = secrets[memberIndex];
      alias = true;
    } else {
      // New voter — new keypair, new member slot.
      const kp = Keypair.random();
      memberIndex = publicKeys.length;
      publicKeys.push(kp.publicKey());
      secrets.push(kp.secret());
      publicKey = kp.publicKey();
      secret = kp.secret();
      if (ref) refToIndex.set(ref, memberIndex);
    }

    upsertVoter(v.msisdn as string, {
      publicKey,
      secret,
      memberIndex,
      voterRef: ref || undefined,
    });

    assignments.push({
      msisdn: normalize(v.msisdn as string),
      name: v.name,
      voterRef: ref || undefined,
      memberIndex,
      publicKey,
      alias,
    });
  }

  writeMembersAndSecrets(publicKeys, secrets);
  reloadMembers();

  res.json({
    ok: true,
    mode,
    count: assignments.length,
    uniqueVoters: publicKeys.length,
    total: publicKeys.length,
    root: computeRoot(publicKeys),
    members: publicKeys,
    assignments,
  });
});

// -------------------- Admin: link a second phone to an existing voter -----
//
// POST /voters/link
//   body: { msisdn, voterRef }   OR   { msisdn, existingMsisdn }
//
// Binds `msisdn` to the same keypair (and therefore same on-chain
// identity, same one vote) as an existing voter, identified either by
// their voterRef or by another phone number already bound to them. Idempotent.
app.post("/voters/link", (req: Request, res: Response) => {
  const msisdn = String(req.body?.msisdn ?? "").trim();
  const voterRef = String(req.body?.voterRef ?? "").trim();
  const existingMsisdn = String(req.body?.existingMsisdn ?? "").trim();
  if (!msisdn) return res.status(400).json({ error: "msisdn required" });
  if (!voterRef && !existingMsisdn) {
    return res.status(400).json({ error: "voterRef or existingMsisdn required" });
  }

  let source: VoterRecord | undefined;
  if (voterRef) source = findByRef(voterRef);
  if (!source && existingMsisdn) source = getVoter(existingMsisdn);
  if (!source) {
    return res.status(404).json({ error: "No existing voter matches the given ref/msisdn" });
  }

  // If the new msisdn is already bound to a DIFFERENT voter, that would
  // be a merge — refuse and require an admin override instead of quietly
  // reassigning votes.
  const already = getVoter(msisdn);
  if (already && already.memberIndex !== source.memberIndex) {
    return res.status(409).json({
      error:
        "This phone is already bound to a different voter. Remove that binding first before linking.",
      currentMemberIndex: already.memberIndex,
    });
  }

  upsertVoter(msisdn, {
    publicKey: source.publicKey,
    secret: source.secret,
    memberIndex: source.memberIndex,
    voterRef: source.voterRef,
  });

  res.json({
    ok: true,
    msisdn: normalize(msisdn),
    memberIndex: source.memberIndex,
    publicKey: source.publicKey,
    aliases: phonesForMemberIndex(source.memberIndex),
  });
});

// -------------------- Admin: list bound voters --------------------
//
// GET /voters
//   -> { voters: [{ msisdn, memberIndex, publicKey, voterRef? }] }
//
// Never returns custodial secrets.
app.get("/voters", (_req, res) => {
  res.json({ voters: listVoters() });
});

// -------------------- Admin: remove a single voter -------------------
//
// DELETE /voters/:msisdn
//
// Removes one msisdn from the active list. Behaviour depends on whether
// the phone was the last one bound to its keypair:
//   * If other phones share the same memberIndex (aliases), we JUST
//     unbind this msisdn from the registry — the keypair and slot stay.
//   * If it was the sole holder of that slot, we compact members[] and
//     secrets[] (drop the slot, shift indices above it down by one) and
//     update the remaining voters' memberIndex to match. Existing
//     surviving keypairs are preserved.
//
// Regenerates the Merkle root, so the community must be re-registered
// on-chain before the next ballot referencing this roll. The web UI
// warns the organiser accordingly.
app.delete("/voters/:msisdn", (req: Request, res: Response) => {
  const target = normalize(String(req.params.msisdn ?? ""));
  if (!target) return res.status(400).json({ error: "msisdn required" });
  const victim = getVoter(target);
  if (!victim) return res.status(404).json({ error: "voter not found" });

  const all = listVoters();
  const sharingSlot = all.filter((v) => v.memberIndex === victim.memberIndex);

  if (sharingSlot.length > 1) {
    // Simple case: just remove this msisdn's binding. Slot stays.
    const secrets = readSecrets();
    // Registry already holds one entry per msisdn; overwrite by
    // clearing and rewriting all except the target msisdn.
    const survivors = all.filter((v) => normalize(v.msisdn) !== target);
    clearVoters();
    for (const s of survivors) {
      upsertVoter(s.msisdn, {
        publicKey: s.publicKey,
        secret: secrets[s.memberIndex] ?? "",
        memberIndex: s.memberIndex,
        voterRef: s.voterRef,
      });
    }
    return res.json({
      ok: true,
      mode: "unbind-alias",
      removed: target,
      total: members.length,
      root: computeRoot(members),
    });
  }

  // Full removal: compact the slot out of members[] and secrets[].
  const oldMembers = [...members];
  const oldSecrets = readSecrets();
  const dropIdx = victim.memberIndex;
  const newMembers = oldMembers.filter((_, i) => i !== dropIdx);
  const newSecrets = oldSecrets.filter((_, i) => i !== dropIdx);

  // Rebuild registry: keep every voter except the target, shifting
  // memberIndex > dropIdx down by one.
  const survivors = all.filter((v) => normalize(v.msisdn) !== target);
  clearVoters();
  for (const s of survivors) {
    const newIdx = s.memberIndex > dropIdx ? s.memberIndex - 1 : s.memberIndex;
    upsertVoter(s.msisdn, {
      publicKey: newMembers[newIdx] ?? s.publicKey,
      secret: newSecrets[newIdx] ?? "",
      memberIndex: newIdx,
      voterRef: s.voterRef,
    });
  }

  writeMembersAndSecrets(newMembers, newSecrets);
  reloadMembers();

  res.json({
    ok: true,
    mode: "compact-slot",
    removed: target,
    total: members.length,
    root: computeRoot(members),
  });
});

// -------------------- Voter lists (folders) --------------------
//
// Multiple named rolls can coexist on the bridge. One is "active" at a
// time and drives every existing endpoint (/members, /voters, USSD, SMS).
// Switching active reloads the registry + members in place — no restart.
app.get("/lists", (_req, res) => {
  res.json({ activeId: getIndex().activeId, lists: listsWithCounts() });
});

app.post("/lists", (req: Request, res: Response) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const created = createList(name);
    if (req.body?.activate) {
      const r = activateList(created.id);
      members = r.members;
    }
    res.json({ ok: true, list: created, activeId: getIndex().activeId });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/lists/:id/activate", (req: Request, res: Response) => {
  try {
    const r = activateList(String(req.params.id));
    members = r.members;
    res.json({
      ok: true,
      active: r.list,
      count: members.length,
      root: computeRoot(members),
    });
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.patch("/lists/:id", (req: Request, res: Response) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const updated = renameList(String(req.params.id), name);
    res.json({ ok: true, list: updated });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/lists/:id", (req: Request, res: Response) => {
  try {
    const result = deleteList(String(req.params.id));
    // If we deleted the active list, activateList already flipped in
    // deleteList()'s index update — but we still need to reload the
    // in-memory members[] to reflect the new active list.
    const r = activateList(result.activeId);
    members = r.members;
    res.json({
      ok: true,
      deleted: result.deleted,
      activeId: result.activeId,
      count: members.length,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// -------------------- Community binding ------------------------------------
//
// Bind a voter list to an on-chain community id, so later election
// queries can filter to only the elections a given voter is eligible
// for. Called by the web after a successful register_community, and
// available for manual re-binding via the CLI if needed.
//
// GET  /lists/:id/community        -> { listId, communityId | null }
// POST /lists/:id/community { communityId } -> { ok, listId, communityId }
app.get("/lists/:id/community", (req: Request, res: Response) => {
  const id = String(req.params.id);
  res.json({ listId: id, communityId: getListCommunity(id) });
});

app.post("/lists/:id/community", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const cid = Number(req.body?.communityId);
  if (!Number.isInteger(cid) || cid < 0) {
    return res.status(400).json({ error: "communityId must be a non-negative integer" });
  }
  try {
    setListCommunity(id, cid);
    res.json({ ok: true, listId: id, communityId: cid });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// -------------------- Voter self-check: list my phones ---------------------
//
// GET /voters/aliases?msisdn=+2567...
//   -> { memberIndex, phones: [ ... ], voterRef? }
//
// If the caller's phone is enrolled, list every other phone bound to
// the same voter. Handy for "I have 3 SIMs — did I remember to link
// them all?" and for the confirmation card on /my-status.
app.get("/voters/aliases", (req: Request, res: Response) => {
  const msisdn = String(req.query.msisdn ?? "");
  if (!msisdn) return res.status(400).json({ error: "msisdn required" });
  const v = getVoter(msisdn);
  if (!v) return res.json({ registered: false, msisdn: normalize(msisdn), phones: [] });
  return res.json({
    registered: true,
    msisdn: normalize(msisdn),
    memberIndex: v.memberIndex,
    voterRef: v.voterRef,
    phones: phonesForMemberIndex(v.memberIndex),
    refPhones: v.voterRef ? phonesForRef(v.voterRef) : [],
  });
});

// -------------------- Web: JSON vote-by-phone endpoint --------------------
//
// POST /vote
//   body: { msisdn, electionId, optionIndex }
//   -> { ok, election: { id, question, choice, tallies, totalVotes } }
//
// The custodial-key equivalent of /sms, but returning JSON so the web
// app can invoke it too. Same rate limit + validation. Uses the voter's
// custodial secret stored on the bridge to sign the Soroban vote tx —
// no wallet needed on the voter's device.
app.post("/vote", async (req: Request, res: Response) => {
  const msisdn = normalize(String(req.body?.msisdn ?? ""));
  const electionId = Number(req.body?.electionId);
  const optionIndex = Number(req.body?.optionIndex);
  if (!msisdn) return res.status(400).json({ error: "msisdn required" });
  if (!Number.isInteger(electionId) || electionId < 0) {
    return res.status(400).json({ error: "electionId must be a non-negative integer" });
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0) {
    return res.status(400).json({ error: "optionIndex must be a non-negative integer" });
  }

  const voter = getVoter(msisdn);
  if (!voter) {
    return res.status(404).json({
      error: `Phone number ${msisdn} is not enrolled in the active list.`,
    });
  }

  // Cheap anti-spam: same phone can't vote twice within RATE_LIMIT_MS.
  const now = Date.now();
  const last = lastVoteAt.get(msisdn) ?? 0;
  if (now - last < RATE_LIMIT_MS) {
    return res.status(429).json({ error: "Slow down: try again in a few seconds." });
  }

  let election;
  try {
    election = await readElection(electionId);
  } catch (e) {
    return res.status(404).json({ error: `Election #${electionId} not found.` });
  }
  if (optionIndex >= election.options.length) {
    return res.status(400).json({ error: "optionIndex out of range" });
  }
  if (election.closed || Date.now() / 1000 >= election.closesAt) {
    return res.status(400).json({ error: `Election #${electionId} is closed.` });
  }

  // Preflight: verify the bridge's active member list matches the
  // community this election belongs to. If not, the contract will
  // reject with InvalidProof (Error #7) — but we can give a much more
  // actionable message here.
  let localRoot: string;
  try {
    localRoot = buildTree(members).root.toString("hex");
  } catch (e) {
    return res.status(500).json({
      error: `Bridge cannot build a Merkle root from the active list: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }
  let community;
  try {
    community = await readCommunity(election.communityId);
  } catch (e) {
    return res.status(400).json({
      error: `Cannot read community #${election.communityId} on-chain: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }
  if (community.merkleRoot.toLowerCase() !== localRoot.toLowerCase()) {
    return res.status(409).json({
      error:
        `The active voter list does not match community #${election.communityId} on-chain. ` +
        `The organiser must either switch the bridge to the list that was used when this ` +
        `community was registered, or call update_members to sync the on-chain root to the ` +
        `current list.`,
      onChainRoot: community.merkleRoot,
      bridgeRoot: localRoot,
      communityId: election.communityId,
      activeListMemberCount: members.length,
      onChainMemberCount: community.memberCount,
    });
  }

  try {
    const proof = proofForIndex(members, voter.memberIndex);
    await submitVote(voter.secret, electionId, optionIndex, proof);
    lastVoteAt.set(msisdn, now);
    const after = await readElection(electionId).catch(() => election);
    return res.json({
      ok: true,
      election: {
        id: electionId,
        question: after.question,
        choice: after.options[optionIndex],
        tallies: after.tallies,
        totalVotes: after.totalVotes,
      },
    });
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

// -------------------- ID-first voting flow --------------------
//
// The preferred voter-facing flow is:
//   1. voter enters national ID / student number ("voterRef")
//   2. we SMS a one-time code to every phone bound to that ref
//   3. voter enters the code and picks an election from a list of
//      those they're eligible for
//   4. we sign+submit on their behalf using the custodial key
//
// This is a big UX win over "type your election ID" and "type your
// phone number" separately: voters know their ID by heart, don't
// need to remember an election number, and get a fresh code every
// vote for phishing resistance.

/** Detect whether the supplied identifier is a phone number rather
 *  than a national/student ID. Phones enter as `+2567…` or plain
 *  digits — anything that is a leading `+` followed by digits, or is
 *  purely digits (>=7 of them), we treat as a phone. */
function looksLikePhone(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/^\+\d{6,}$/.test(t)) return true;
  if (/^\d{7,}$/.test(t)) return true;
  return false;
}

/** Resolve either a phone number OR a voterRef to a set of voter hits.
 *  Returns a `{ hits, key }` pair where `key` is the normalised token
 *  used as the OTP lookup key (so `/otp/verify` and `/vote/by-ref`
 *  need to use the same normalisation as `/otp/request`). */
function resolveVoter(
  rawIdentifier: string,
): { hits: ReturnType<typeof findVoterAcrossLists>; key: string; kind: "phone" | "ref" } {
  if (looksLikePhone(rawIdentifier)) {
    const key = normalize(rawIdentifier);
    return { hits: findVoterByPhoneAcrossLists(key), key, kind: "phone" };
  }
  const key = normalizeRef(rawIdentifier);
  return { hits: findVoterAcrossLists(key), key, kind: "ref" };
}

/** POST /otp/request { voterRef } -> issue OTP and SMS it.
 *  `voterRef` may be either the enrolled voter ID (national/student
 *  number) or a registered phone number in E.164 form. */
app.post("/otp/request", async (req: Request, res: Response) => {
  const rawRef = String(req.body?.voterRef ?? "").trim();
  if (!rawRef) return res.status(400).json({ error: "voterRef required" });
  const { hits, key: ref, kind } = resolveVoter(rawRef);
  if (hits.length === 0) {
    const noun = kind === "phone" ? "phone number" : "ID";
    return res.status(404).json({
      error: `No voter enrolled with ${noun} "${rawRef}". Ask your organiser to enrol you first.`,
    });
  }
  const allMsisdns = Array.from(new Set(hits.flatMap((h) => h.msisdns)));
  if (allMsisdns.length === 0) {
    return res.status(400).json({
      error: "Your enrolment has no phone numbers. Ask your organiser to add one for OTP delivery.",
    });
  }
  const { code, expiresAt } = issueOtp(ref, allMsisdns);
  const message = `Sauti verification code: ${code}. Valid for ${Math.round(
    config.otp.ttlSec / 60,
  )} min. Do not share.`;
  // Fire off to every registered phone. We surface the FIRST provider
  // error but always return ok=true so the voter still gets a chance
  // to enter the code from whichever phone did receive it.
  const results = await Promise.all(allMsisdns.map((m) => sendSms(m, message)));
  const anyProviderError = results.find((r) => !r.ok && !r.devMode);
  const anySent = results.some((r) => r.ok);
  const devMode = results.every((r) => r.devMode);
  const body: Record<string, unknown> = {
    ok: anySent || devMode,
    sentTo: allMsisdns.map(maskMsisdn),
    expiresAt,
    devMode,
  };
  if (config.otp.devEcho || devMode) body.devCode = code;
  if (anyProviderError && !anySent) {
    body.ok = false;
    body.error = anyProviderError.error;
  }
  return res.status(body.ok ? 200 : 502).json(body);
});

/** POST /otp/verify { voterRef, code } -> confirm without consuming.
 *  We keep verify+vote in a single call (/vote/by-ref) so the token
 *  isn't consumed in a separate step, but a preview endpoint is
 *  useful for the web UI's "next" button. */
app.post("/otp/verify", (req: Request, res: Response) => {
  const rawRef = String(req.body?.voterRef ?? "").trim();
  const code = String(req.body?.code ?? "").trim();
  if (!rawRef || !code) {
    return res.status(400).json({ error: "voterRef and code required" });
  }
  // Peek: we can't check without consuming from the store, so we
  // instead answer "does this code look valid right now?" by
  // temporarily re-issuing on success is wrong. Simpler: just return
  // 200 iff verifyOtp succeeds AND we re-issue immediately with the
  // same code so /vote/by-ref can still consume it. But that races.
  //
  // Actual behaviour: this endpoint consumes the OTP; the client
  // must then pass a fresh { voterRef, verifiedAt } through subsequent
  // calls. Simpler still: SKIP the preview and let /vote/by-ref do
  // the verify+vote together. We keep this endpoint for parity with
  // the UI, but mark the code as "used" and issue a short-lived
  // session token instead.
  const r = verifyOtp(resolveVoter(rawRef).key, code);
  if (!r.ok) return res.status(400).json({ error: r.reason });
  // Issue a session token (30s) that /vote/by-ref accepts in lieu of
  // a fresh code. Reusing the OTP store with a longer TTL keeps the
  // whole thing dependency-free.
  const session = crypto.randomBytes(16).toString("hex");
  otpSession.set(session, {
    ref: resolveVoter(rawRef).key,
    expiresAt: Date.now() + 60_000,
  });
  return res.json({ ok: true, session, expiresIn: 60 });
});

/** GET /voter/:ref/elections -> all elections this voter can vote in. */
app.get("/voter/:ref/elections", async (req: Request, res: Response) => {
  const rawRef = String(req.params.ref ?? "");
  const ref = normalizeRef(rawRef);
  const hits = findVoterAcrossLists(ref);
  if (hits.length === 0) {
    return res.status(404).json({ error: `No voter enrolled with ID "${rawRef}".` });
  }
  const communityIds = new Set(
    hits.map((h) => h.communityId).filter((c): c is number => c !== null),
  );
  const unboundLists = hits.filter((h) => h.communityId === null).map((h) => h.listName);

  let next: number;
  try {
    next = await readNextElectionId();
  } catch (e) {
    return res.status(502).json({
      error: `Cannot read elections from chain: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }

  const now = Date.now() / 1000;
  const out: Array<{
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
  }> = [];
  // Simple sequential fetch — election counts are small in practice.
  for (let id = 0; id < next; id++) {
    let info;
    try {
      info = await readElection(id);
    } catch {
      continue;
    }
    if (!communityIds.has(info.communityId)) continue;
    const owningHit = hits.find((h) => h.communityId === info.communityId);
    if (!owningHit) continue;
    // Filter out elections this voter has already cast in — the
    // contract's has_voted check would reject a second attempt anyway,
    // but hiding it up front keeps the wizard clean.
    try {
      if (await readHasVoted(owningHit.publicKey, id)) continue;
    } catch {
      /* be forgiving — if has_voted lookup fails, show the election
         and let the contract be the final gate on cast. */
    }
    out.push({
      electionId: id,
      communityId: info.communityId,
      listId: owningHit.listId,
      listName: owningHit.listName,
      question: info.question,
      options: info.options,
      closesAt: info.closesAt,
      closed: info.closed,
      totalVotes: info.totalVotes,
      open: !info.closed && now < info.closesAt,
    });
  }
  return res.json({
    voterRef: ref,
    elections: out,
    unboundLists,
  });
});

/** POST /vote/by-ref { voterRef, code|session, electionId, optionIndex }
 *  Voter-facing vote endpoint. Verifies OTP (or session token from
 *  /otp/verify), locates the voter's custodial secret, and submits. */
app.post("/vote/by-ref", async (req: Request, res: Response) => {
  const rawRef = String(req.body?.voterRef ?? "").trim();
  const code = String(req.body?.code ?? "").trim();
  const session = String(req.body?.session ?? "").trim();
  const electionId = Number(req.body?.electionId);
  const optionIndex = Number(req.body?.optionIndex);
  if (!rawRef) return res.status(400).json({ error: "voterRef required" });
  if (!Number.isInteger(electionId) || electionId < 0) {
    return res.status(400).json({ error: "electionId must be a non-negative integer" });
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0) {
    return res.status(400).json({ error: "optionIndex must be a non-negative integer" });
  }
  const { hits, key: ref } = resolveVoter(rawRef);

  // Verify OTP (either fresh code or short session token)
  if (session) {
    const s = otpSession.get(session);
    if (!s || s.ref !== ref || Date.now() > s.expiresAt) {
      return res.status(401).json({ error: "Session expired. Request a new code." });
    }
    otpSession.delete(session);
  } else if (code) {
    const v = verifyOtp(ref, code);
    if (!v.ok) return res.status(401).json({ error: `code ${v.reason}` });
  } else {
    return res.status(400).json({ error: "code or session required" });
  }

  if (hits.length === 0) return res.status(404).json({ error: "voter no longer found" });

  // Find on-chain election
  let election;
  try {
    election = await readElection(electionId);
  } catch {
    return res.status(404).json({ error: `Election #${electionId} not found.` });
  }
  if (optionIndex >= election.options.length) {
    return res.status(400).json({ error: "optionIndex out of range" });
  }
  if (election.closed || Date.now() / 1000 >= election.closesAt) {
    return res.status(400).json({ error: `Election #${electionId} is closed.` });
  }

  // Pick the hit whose community matches this election.
  const owning = hits.find((h) => h.communityId === election.communityId);
  if (!owning) {
    return res.status(403).json({
      error: `You are not enrolled in the community that owns election #${electionId}.`,
    });
  }

  // Preflight: bridge list root must match on-chain community root.
  try {
    const community = await readCommunity(owning.communityId!);
    const localRoot = buildTree(owning.members).root.toString("hex");
    if (localRoot.toLowerCase() !== community.merkleRoot.toLowerCase()) {
      return res.status(409).json({
        error:
          `The voter list "${owning.listName}" is out of sync with community #${owning.communityId} on-chain. ` +
          `Ask the organiser to call update_members (Register community → Sync existing community).`,
        onChainRoot: community.merkleRoot,
        bridgeRoot: localRoot,
      });
    }
  } catch (e) {
    return res.status(400).json({
      error: `Cannot verify community #${owning.communityId} on-chain: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }

  try {
    const proof = proofForIndex(owning.members, owning.memberIndex);
    await submitVote(owning.secret, electionId, optionIndex, proof);
    const after = await readElection(electionId).catch(() => election);
    return res.json({
      ok: true,
      election: {
        id: electionId,
        question: after.question,
        choice: after.options[optionIndex],
        tallies: after.tallies,
        totalVotes: after.totalVotes,
      },
    });
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

// -------------------- (feature-phone USSD/SMS removed) --------------------
// The original build included /ussd and /sms endpoints for basic-phone
// voting via Africa's Talking. That channel proved too expensive to
// operate for the pilot (per-session USSD fees + telco integration
// paperwork), so we now route every phone-based voter through the web
// "Vote with phone" flow (POST /vote above), which uses the same
// custodial-key mechanism without the telco middleman.

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

app.listen(config.port, () => {
  let cid: string;
  try {
    cid = config.contractId;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "\n[sauti-bridge] " + (e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line no-console
    console.error(
      "Set CONTRACT_ID in ussd-bridge/.env (copy .env.example and paste your deployed contract ID).\n",
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`Sauti bridge on :${config.port}`);
  // eslint-disable-next-line no-console
  console.log(`  contract: ${cid}`);
  // eslint-disable-next-line no-console
  console.log(`  members : ${members.length}`);
});
