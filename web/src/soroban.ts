// Stellar SDK client wrapper. This module talks to the Soroban RPC to
// simulate/submit contract calls and read state.
//
// It intentionally exposes ONE surface (methods like `createElection`,
// `submitVote`, `readElection`) so the UI never touches raw XDR.

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Address,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { config } from "./config";

const server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });

function contract(): Contract {
  return new Contract(config.contractId);
}

function passphrase(): string {
  return config.networkPassphrase || Networks.TESTNET;
}

// ---------- read-only calls (simulate, don't submit) ---------------------

async function simulateRead(op: xdr.Operation): Promise<xdr.ScVal> {
  // Simulation needs *some* source account to build a valid tx envelope,
  // but does not care whether the account exists on-chain or has funds.
  // A fresh random keypair sidesteps a) the network round-trip to
  // getAccount, and b) any risk of a hand-typed strkey with a bad
  // checksum blowing up the very first read the app does.
  const account = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase(),
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  if (!("result" in sim) || !sim.result) {
    throw new Error("Simulation returned no result");
  }
  return sim.result.retval;
}

export interface ElectionInfo {
  id: number;
  communityId: number;
  question: string;
  /** Parsed name/symbol/title extracted from `question`. When the raw
   *  `question` is a plain (legacy) string it becomes `title` and the
   *  other two default to empty. */
  meta: ElectionMeta;
  options: string[];
  opensAt: number;
  closesAt: number;
  closed: boolean;
  tallies: number[];
  totalVotes: number;
  /** Bond locked when this election was created (in the token's smallest unit). */
  bond: bigint;
  /** True once close_election has refunded the bond to the community admin. */
  bondReturned: boolean;
  /** True if the bond was slashed (organiser failed to close in time).
   *  Once slashed, the bond is gone and neither refund nor re-slash is possible. */
  slashed: boolean;
  /** True if the election requires an on-chain proof-of-personhood
   *  attestation from the configured registry before a member may vote.
   *  When true and the voter has no live attestation, `vote` reverts. */
  requirePersonhood: boolean;
}

/** Structured election metadata packed into the on-chain `question`
 *  field. Doing this off-chain-in-a-string keeps us backwards
 *  compatible with the existing contract (no redeploy) while giving
 *  organisers clearly-labelled inputs. */
export interface ElectionMeta {
  /** Long-form name of the ballot — e.g. "Kampala SACCO — 2026 Chair". */
  name: string;
  /** The literal question voters are answering — e.g. "Who leads the SACCO in 2026?". */
  title: string;
}

/** Pack the two fields into a compact JSON blob that fits comfortably
 *  under the Soroban String field limit. Keys are short (`n`/`t`)
 *  to save bytes on chain. */
export function encodeElectionQuestion(m: ElectionMeta): string {
  return JSON.stringify({ n: m.name, t: m.title });
}

/** Best-effort inverse of `encodeElectionQuestion`. Falls back to
 *  treating `raw` as a plain title so any pre-encoding elections still
 *  render sensibly. */
export function decodeElectionQuestion(raw: string): ElectionMeta {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const p = JSON.parse(trimmed) as { n?: unknown; t?: unknown; s?: unknown };
      if (p && (typeof p.n === "string" || typeof p.t === "string")) {
        return {
          name: typeof p.n === "string" ? p.n : "",
          title: typeof p.t === "string" ? p.t : "",
        };
      }
    } catch {
      /* fall through — treat as plain title */
    }
  }
  return { name: "", title: raw };
}

/** Per-candidate metadata packed into each on-chain option string.
 *  On paper ballots in East Africa candidates commonly carry a
 *  picture-symbol (umbrella, watch, bicycle) so voters who don't read
 *  fluently can still pick their person confidently. We keep that
 *  idea: each option is `{ label, symbol }`. */
export interface OptionMeta {
  /** Candidate name / choice label — e.g. "Alice Nakato". */
  label: string;
  /** Short symbol / emoji / party mark — e.g. "☂ Umbrella", "Watch". */
  symbol: string;
  /** Optional 32-byte hex sha256 of the candidate's face photo, as
   *  stored on the bridge's `/photos/:hash` endpoint. Kept small
   *  (~64 chars) to minimise on-chain bytes. */
  photo?: string;
}

/** Encode an option as JSON keyed `l`/`s`/`p`. Plain-label options
 *  (no symbol, no photo) stay as bare strings so we don't waste
 *  on-chain bytes. */
export function encodeOption(o: OptionMeta): string {
  const label = o.label.trim();
  const symbol = o.symbol.trim();
  const photo = (o.photo ?? "").trim().toLowerCase();
  if (!symbol && !photo) return label;
  const payload: { l: string; s?: string; p?: string } = { l: label };
  if (symbol) payload.s = symbol;
  if (photo) payload.p = photo;
  return JSON.stringify(payload);
}

/** Best-effort inverse of `encodeOption`. Handles three formats:
 *   1. New JSON:  `{"l":"Alice","s":"☂"}`
 *   2. Legacy compound: `"☂ Umbrella"` — symbol is the first grapheme
 *      cluster / word before the first space.
 *   3. Plain label with no symbol: `"Alice"`.
 *
 * If a JSON symbol field itself contains a compound like `"☂ Umbrella"`
 * (older organisers picked "emoji + word" defaults), we keep only the
 * short leading glyph so the ballot / poster / dashboard tile renders
 * cleanly at a fixed size.
 */
export function decodeOption(raw: string): OptionMeta {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const p = JSON.parse(trimmed) as { l?: unknown; s?: unknown; p?: unknown };
      if (p && (typeof p.l === "string" || typeof p.s === "string")) {
        const photo =
          typeof p.p === "string" && /^[0-9a-f]{64}$/i.test(p.p.trim())
            ? p.p.trim().toLowerCase()
            : undefined;
        return {
          label: typeof p.l === "string" ? p.l : "",
          symbol: shortSymbol(typeof p.s === "string" ? p.s : ""),
          photo,
        };
      }
    } catch {
      /* fall through — treat as plain label */
    }
  }
  // Legacy "☂ Umbrella" style: if the first token is short and starts
  // with a non-alphanumeric character (emoji, punctuation), treat it
  // as the symbol and the rest as the label.
  const space = trimmed.indexOf(" ");
  if (space > 0 && space <= 4) {
    const head = trimmed.slice(0, space);
    const tail = trimmed.slice(space + 1).trim();
    if (tail && !/^[A-Za-z0-9]/.test(head)) {
      return { label: tail, symbol: head };
    }
  }
  return { label: raw, symbol: "" };
}

// Reduce a possibly-compound symbol like "☂ Umbrella" to just "☂" so
// it fits in the small tile UI. Leaves genuinely short symbols alone.
function shortSymbol(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const space = t.indexOf(" ");
  if (space > 0 && space <= 4 && !/^[A-Za-z0-9]/.test(t)) {
    return t.slice(0, space);
  }
  return t;
}

export interface CommunityInfo {
  id: number;
  admin: string;
  name: string;
  merkleRoot: string; // hex
  memberCount: number;
}

/** On-chain protocol config read from `EVotingContract.config()`. */
export interface ProtocolConfig {
  token: string;
  treasury: string;
  fee: bigint;
  bondMin: bigint;
  /** Seconds after `closes_at` before the bond becomes slashable by
   *  any caller (permissionless keeper reward). */
  slashGracePeriod: number;
}

export async function readConfig(): Promise<ProtocolConfig> {
  const op = contract().call("config");
  const retval = await simulateRead(op);
  const native = scValToNative(retval) as {
    token: string;
    treasury: string;
    fee: bigint | number;
    bond_min: bigint | number;
    slash_grace_period?: bigint | number;
  };
  return {
    token: native.token,
    treasury: native.treasury,
    fee: BigInt(native.fee),
    bondMin: BigInt(native.bond_min),
    slashGracePeriod: Number(native.slash_grace_period ?? 0),
  };
}

export async function readElection(id: number): Promise<ElectionInfo> {
  const op = contract().call("election_info", nativeToScVal(id, { type: "u32" }));
  const retval = await simulateRead(op);
  const native = scValToNative(retval) as {
    community_id: number;
    question: string;
    options: string[];
    opens_at: bigint | number;
    closes_at: bigint | number;
    closed: boolean;
    tallies: number[];
    total_votes: number;
    bond?: bigint | number;
    bond_returned?: boolean;
    slashed?: boolean;
    require_personhood?: boolean;
  };
  return {
    id,
    communityId: Number(native.community_id),
    question: native.question,
    meta: decodeElectionQuestion(native.question),
    options: native.options,
    opensAt: Number(native.opens_at),
    closesAt: Number(native.closes_at),
    closed: native.closed,
    tallies: native.tallies.map((n) => Number(n)),
    totalVotes: Number(native.total_votes),
    bond: BigInt(native.bond ?? 0),
    bondReturned: !!native.bond_returned,
    slashed: !!native.slashed,
    requirePersonhood: !!native.require_personhood,
  };
}

export async function readCommunity(id: number): Promise<CommunityInfo> {
  const op = contract().call("community", nativeToScVal(id, { type: "u32" }));
  const retval = await simulateRead(op);
  const native = scValToNative(retval) as {
    admin: string;
    name: string;
    merkle_root: Uint8Array;
    member_count: number;
  };
  return {
    id,
    admin: native.admin,
    name: native.name,
    merkleRoot: Buffer.from(native.merkle_root).toString("hex"),
    memberCount: Number(native.member_count),
  };
}

export async function readNextElectionId(): Promise<number> {
  const op = contract().call("next_election_id");
  const retval = await simulateRead(op);
  return Number(scValToNative(retval));
}

export async function readNextCommunityId(): Promise<number> {
  const op = contract().call("next_community_id");
  const retval = await simulateRead(op);
  return Number(scValToNative(retval));
}

// ---------- write calls (built here, signed by Freighter, submitted) -----

/**
 * Build a signed-and-submitted transaction. `signXDR` should be
 * Freighter's `signTransaction` (network passphrase pre-filled).
 */
async function submit(
  sourceAddress: string,
  op: xdr.Operation,
  signXDR: (xdr: string, opts: { networkPassphrase: string }) => Promise<{ signedTxXdr: string }>,
): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
  const account = await server.getAccount(sourceAddress);
  let tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase(),
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const { signedTxXdr } = await signXDR(prepared.toXDR(), {
    networkPassphrase: passphrase(),
  });
  const signed = TransactionBuilder.fromXDR(signedTxXdr, passphrase());
  const sendResp = await server.sendTransaction(signed as any);
  if (sendResp.status === "ERROR") {
    throw new Error(`sendTransaction ERROR: ${JSON.stringify(sendResp.errorResult)}`);
  }

  // Poll for final status
  let hash = sendResp.hash;
  for (let i = 0; i < 30; i++) {
    const status = await server.getTransaction(hash);
    if (status.status === "SUCCESS") return status;
    if (status.status === "FAILED")
      throw new Error(`Tx failed: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for transaction");
}

export interface SignFn {
  (xdr: string, opts: { networkPassphrase: string }): Promise<{ signedTxXdr: string }>;
}

export async function registerCommunity(
  admin: string,
  name: string,
  merkleRootHex: string,
  memberCount: number,
  sign: SignFn,
): Promise<number> {
  const root = Buffer.from(
    merkleRootHex.startsWith("0x") ? merkleRootHex.slice(2) : merkleRootHex,
    "hex",
  );
  const op = contract().call(
    "register_community",
    new Address(admin).toScVal(),
    nativeToScVal(name, { type: "string" }),
    nativeToScVal(root, { type: "bytes" }),
    nativeToScVal(memberCount, { type: "u32" }),
  );
  const result = await submit(admin, op, sign);
  return Number(scValToNative(result.returnValue!));
}

/** Replace the on-chain member set for `communityId`. Only the
 *  community's admin can call this. Use after enrolling/removing
 *  voters so that new proofs verify — otherwise vote() will reject
 *  with Error #7 (InvalidProof). Returns the tx hash. */
export async function updateMembers(
  admin: string,
  communityId: number,
  merkleRootHex: string,
  memberCount: number,
  sign: SignFn,
): Promise<string> {
  const root = Buffer.from(
    merkleRootHex.startsWith("0x") ? merkleRootHex.slice(2) : merkleRootHex,
    "hex",
  );
  const op = contract().call(
    "update_members",
    nativeToScVal(communityId, { type: "u32" }),
    nativeToScVal(root, { type: "bytes" }),
    nativeToScVal(memberCount, { type: "u32" }),
  );
  const result = await submit(admin, op, sign);
  return result.txHash ?? "(unknown)";
}

export async function createElection(
  admin: string,
  communityId: number,
  question: string,
  options: string[],
  closesAt: number,
  bond: bigint,
  requirePersonhood: boolean,
  sign: SignFn,
): Promise<number> {
  const op = contract().call(
    "create_election",
    nativeToScVal(communityId, { type: "u32" }),
    nativeToScVal(question, { type: "string" }),
    xdr.ScVal.scvVec(
      options.map((o) => nativeToScVal(o, { type: "string" })),
    ),
    nativeToScVal(closesAt, { type: "u64" }),
    nativeToScVal(bond, { type: "i128" }),
    xdr.ScVal.scvBool(requirePersonhood),
  );
  const result = await submit(admin, op, sign);
  return Number(scValToNative(result.returnValue!));
}

/** Close an election. Refunds the bond to the community admin. Anyone
 *  can call this after the deadline; only the admin can close early. */
export async function closeElection(
  caller: string,
  electionId: number,
  sign: SignFn,
): Promise<void> {
  const op = contract().call(
    "close_election",
    nativeToScVal(electionId, { type: "u32" }),
  );
  await submit(caller, op, sign);
}

/** Extend an election's `closes_at`. Admin-only. `newClosesAt` must be
 *  strictly later than the current deadline. Fails if the election is
 *  already closed or slashed. Does not touch bond, roll or tallies. */
export async function extendElection(
  admin: string,
  electionId: number,
  newClosesAt: number,
  sign: SignFn,
): Promise<void> {
  const op = contract().call(
    "extend_election",
    new Address(admin).toScVal(),
    nativeToScVal(electionId, { type: "u32" }),
    nativeToScVal(newClosesAt, { type: "u64" }),
  );
  await submit(admin, op, sign);
}

/** Slash an overdue election. Callable by ANY signed account after
 *  `closes_at + slashGracePeriod`. The bond is split 50/50 between
 *  the caller (as a keeper reward) and the protocol treasury. Fails
 *  if the bond was already returned or already slashed. */
export async function slashElection(
  caller: string,
  electionId: number,
  sign: SignFn,
): Promise<void> {
  const op = contract().call(
    "slash_election",
    new Address(caller).toScVal(),
    nativeToScVal(electionId, { type: "u32" }),
  );
  await submit(caller, op, sign);
}

/** Read the registry contract address currently wired into the
 *  evoting contract, or null if none is set. Personhood-gated
 *  elections need this to be set. */
export async function readEvotingRegistry(): Promise<string | null> {
  const op = contract().call("registry");
  try {
    const retval = await simulateRead(op);
    const native = scValToNative(retval);
    return (native as string | null) ?? null;
  } catch {
    return null;
  }
}

/** Set (or replace) the registry contract used for personhood
 *  lookups. Requires the treasury address on `Config` to sign. */
export async function setEvotingRegistry(
  treasury: string,
  registryContractId: string,
  sign: SignFn,
): Promise<void> {
  const op = contract().call(
    "set_registry",
    new Address(registryContractId).toScVal(),
  );
  await submit(treasury, op, sign);
}

export async function submitVote(
  voter: string,
  electionId: number,
  optionIndex: number,
  proofHex: string[],
  sign: SignFn,
): Promise<void> {
  const proofScVals = proofHex.map((h) => {
    const clean = h.startsWith("0x") ? h.slice(2) : h;
    const b = Buffer.from(clean, "hex");
    if (b.length !== 32) throw new Error(`Proof node not 32 bytes: ${h}`);
    return xdr.ScVal.scvBytes(b);
  });
  const op = contract().call(
    "vote",
    new Address(voter).toScVal(),
    nativeToScVal(electionId, { type: "u32" }),
    nativeToScVal(optionIndex, { type: "u32" }),
    xdr.ScVal.scvVec(proofScVals),
  );
  await submit(voter, op, sign);
}
