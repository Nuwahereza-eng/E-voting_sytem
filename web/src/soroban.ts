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
}

/** Encode an option as JSON keyed `l`/`s`. Plain-label options (no
 *  symbol) stay as bare strings so we don't waste on-chain bytes. */
export function encodeOption(o: OptionMeta): string {
  const label = o.label.trim();
  const symbol = o.symbol.trim();
  if (!symbol) return label;
  return JSON.stringify({ l: label, s: symbol });
}

/** Best-effort inverse of `encodeOption`. */
export function decodeOption(raw: string): OptionMeta {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const p = JSON.parse(trimmed) as { l?: unknown; s?: unknown };
      if (p && (typeof p.l === "string" || typeof p.s === "string")) {
        return {
          label: typeof p.l === "string" ? p.l : "",
          symbol: typeof p.s === "string" ? p.s : "",
        };
      }
    } catch {
      /* fall through — treat as plain label */
    }
  }
  return { label: raw, symbol: "" };
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
}

export async function readConfig(): Promise<ProtocolConfig> {
  const op = contract().call("config");
  const retval = await simulateRead(op);
  const native = scValToNative(retval) as {
    token: string;
    treasury: string;
    fee: bigint | number;
    bond_min: bigint | number;
  };
  return {
    token: native.token,
    treasury: native.treasury,
    fee: BigInt(native.fee),
    bondMin: BigInt(native.bond_min),
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
