import express, { type Request, type Response } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  getVoter,
  loadMembers,
  loadRegistry,
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
import { readElection, submitVote } from "./soroban.js";
import { Keypair } from "@stellar/stellar-sdk";

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

loadRegistry(config.registryPath);
let members = loadMembers(config.membersPath);

// Rebuild `members` from disk after any operation that rewrites it.
function reloadMembers(): void {
  members = loadMembers(config.membersPath);
}

// Persist members list and its custodial-secret sidecar. This matches the
// on-disk layout produced by `provision.ts init`.
function writeMembersAndSecrets(publicKeys: string[], secrets: string[]) {
  const mp = path.resolve(config.membersPath);
  fs.mkdirSync(path.dirname(mp), { recursive: true });
  fs.writeFileSync(mp, JSON.stringify(publicKeys, null, 2) + "\n");
  const sp = mp + ".secrets.json";
  fs.writeFileSync(sp, JSON.stringify(secrets, null, 2) + "\n");
}

function readSecrets(): string[] {
  const sp = path.resolve(config.membersPath) + ".secrets.json";
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
  res.json({ ok: true, members: members.length, root: computeRoot(members) });
});

// -------------------- Public: read the member list --------------------
//
// GET /members
//   -> { members: [G...], root, count }
//
// Handy for the web admin dashboard so it can pre-fill the registration
// form with whatever the bridge is currently custodying.
app.get("/members", (_req, res) => {
  res.json({
    members,
    root: computeRoot(members),
    count: members.length,
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

// -------------------- USSD --------------------
//
// Africa's Talking sends: sessionId, serviceCode, phoneNumber, text
// `text` accumulates as the session progresses: "" -> "1" -> "1*2"
app.post("/ussd", async (req: Request, res: Response) => {
  const phoneNumber: string = String(req.body?.phoneNumber ?? "");
  const text: string = String(req.body?.text ?? "");
  const parts = text === "" ? [] : text.split("*");
  const msisdn = normalize(phoneNumber);

  res.type("text/plain");

  const voter = getVoter(msisdn);
  if (!voter) {
    return res.send(
      "END This number is not registered. Ask your community admin to register your line with Sauti.",
    );
  }

  // Step 0: prompt for election ID
  if (parts.length === 0) {
    return res.send("CON Enter election ID:");
  }

  const electionId = Number(parts[0]);
  if (Number.isNaN(electionId)) {
    return res.send("END Invalid election ID.");
  }

  let election;
  try {
    election = await readElection(electionId);
  } catch {
    return res.send(`END Election #${electionId} not found.`);
  }

  if (election.closed || Date.now() / 1000 >= election.closesAt) {
    return res.send(`END Election #${electionId} is closed.`);
  }

  // Step 1: show options and prompt for choice
  if (parts.length === 1) {
    const menu = election.options
      .map((o, i) => `${i + 1}. ${o}`)
      .join("\n");
    const q = election.question.slice(0, 60);
    return res.send(`CON ${q}\n${menu}\nReply with option number:`);
  }

  // Step 2: cast the vote
  const choice = Number(parts[1]);
  if (Number.isNaN(choice) || choice < 1 || choice > election.options.length) {
    return res.send("END Invalid option.");
  }

  const now = Date.now();
  const last = lastVoteAt.get(msisdn) ?? 0;
  if (now - last < RATE_LIMIT_MS) {
    return res.send("END Too many attempts, wait a moment and try again.");
  }
  lastVoteAt.set(msisdn, now);

  try {
    const proof = proofForIndex(members, voter.memberIndex);
    await submitVote(voter.secret, electionId, choice - 1, proof);
    return res.send(
      `END Vote recorded for "${election.options[choice - 1]}". Thank you.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.send(`END Vote rejected: ${trim(msg, 120)}`);
  }
});

// -------------------- SMS --------------------
//
// One-shot SMS fallback.
//
// Text format:      VOTE <electionId> <optionNumber>
// Example:          VOTE 3 1
//
// Africa's Talking SMS-in webhook sends {from, text}. Adapt to your
// gateway's field names as needed.
app.post("/sms", async (req: Request, res: Response) => {
  const from: string = String(req.body?.from ?? req.body?.phoneNumber ?? "");
  const text: string = String(req.body?.text ?? req.body?.message ?? "");
  const msisdn = normalize(from);
  const m = text.trim().match(/^\s*VOTE\s+(\d+)\s+(\d+)\s*$/i);

  const reply = (msg: string) => res.type("text/plain").send(msg);

  const voter = getVoter(msisdn);
  if (!voter) return reply("Number not registered for Sauti voting.");
  if (!m) return reply("Format: VOTE <electionId> <optionNumber>");

  const electionId = Number(m[1]);
  const choice = Number(m[2]);

  let election;
  try {
    election = await readElection(electionId);
  } catch {
    return reply(`Election #${electionId} not found.`);
  }
  if (choice < 1 || choice > election.options.length) return reply("Invalid option.");
  if (election.closed || Date.now() / 1000 >= election.closesAt) {
    return reply(`Election #${electionId} is closed.`);
  }

  try {
    const proof = proofForIndex(members, voter.memberIndex);
    await submitVote(voter.secret, electionId, choice - 1, proof);
    return reply(`Vote recorded for "${election.options[choice - 1]}".`);
  } catch (e) {
    return reply(`Rejected: ${trim(e instanceof Error ? e.message : String(e), 140)}`);
  }
});

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
      "\n[sauti-ussd] " + (e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line no-console
    console.error(
      "Set CONTRACT_ID in ussd-bridge/.env (copy .env.example and paste your deployed contract ID).\n",
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`Sauti USSD/SMS bridge on :${config.port}`);
  // eslint-disable-next-line no-console
  console.log(`  contract: ${cid}`);
  // eslint-disable-next-line no-console
  console.log(`  members : ${members.length}`);
});
