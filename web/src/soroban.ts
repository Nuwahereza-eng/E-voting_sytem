// Stellar SDK client wrapper. This module talks to the Soroban RPC to
// simulate/submit contract calls and read state.
//
// It intentionally exposes ONE surface (methods like `createElection`,
// `submitVote`, `readElection`) so the UI never touches raw XDR.

import {
  BASE_FEE,
  Contract,
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
  // For read-only calls we still need an account (source) — use the
  // system dummy account. Simulation does not require a real signer.
  const dummy = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
  const account = await server.getAccount(dummy).catch(async () => {
    // Fallback: build a fresh Account object at seq=0 for pure simulation
    return { accountId: () => dummy, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as unknown as Awaited<
      ReturnType<typeof server.getAccount>
    >;
  });
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
