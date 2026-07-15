// Server-side Soroban client for the USSD bridge. Signs with the
// custodial secret key we hold for each phone number. Same caveat as
// AGENT_BUILD_BRIEF §6: production Sauti would push signing back to
// the user (SIM-based key or callback URL).

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  scValToNative,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "./config.js";

const server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });

function contract(): Contract {
  return new Contract(config.contractId);
}

/** Testnet-only: activate an unfunded custodial account via friendbot.
 *  Voters enrolled by phone get freshly-generated keypairs that don't
 *  yet exist on-chain — the first tx from them errors with
 *  `Account not found`. On testnet we can just ask friendbot to
 *  create + fund the account with 10k XLM. No-op if already funded. */
async function ensureAccountFunded(publicKey: string): Promise<void> {
  try {
    await server.getAccount(publicKey);
    return; // already exists
  } catch {
    // fall through to funding attempt
  }
  const isTestnet = config.networkPassphrase.includes("Test SDF Network");
  if (!isTestnet) {
    throw new Error(
      `Account not found: ${publicKey}. On mainnet the bridge cannot auto-fund; the voter's account must be created and funded manually.`,
    );
  }
  const r = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `friendbot funding failed (${r.status}) for ${publicKey}: ${body.slice(0, 200)}`,
    );
  }
  // Wait for RPC to see the new account. Friendbot returns as soon as
  // horizon has it, but the soroban-rpc index can lag a couple of
  // seconds behind.
  for (let i = 0; i < 15; i++) {
    try {
      await server.getAccount(publicKey);
      return;
    } catch {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  throw new Error(`Funded ${publicKey} via friendbot but RPC still can't see it`);
}

async function submit(kp: Keypair, op: xdr.Operation): Promise<xdr.ScVal | null> {
  await ensureAccountFunded(kp.publicKey());
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(`sendTransaction ERROR: ${JSON.stringify(send.errorResult)}`);
  }
  for (let i = 0; i < 30; i++) {
    const s = await server.getTransaction(send.hash);
    if (s.status === "SUCCESS") return s.returnValue ?? null;
    if (s.status === "FAILED") throw new Error(`tx failed: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for tx");
}

async function simulate(op: xdr.Operation): Promise<xdr.ScVal> {
  // Read-only: sim as a random account we won't actually submit from.
  const dummy = Keypair.random();
  const account = { accountId: () => dummy.publicKey(), sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as unknown as Awaited<
    ReturnType<typeof server.getAccount>
  >;
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate failed: ${sim.error}`);
  }
  if (!("result" in sim) || !sim.result) throw new Error("no sim result");
  return sim.result.retval;
}

export async function readElection(electionId: number): Promise<{
  options: string[];
  closed: boolean;
  closesAt: number;
  totalVotes: number;
  communityId: number;
  question: string;
  tallies: number[];
}> {
  const op = contract().call("election_info", nativeToScVal(electionId, { type: "u32" }));
  const retval = await simulate(op);
  const n = scValToNative(retval) as {
    options: string[];
    closed: boolean;
    closes_at: bigint | number;
    total_votes: number;
    community_id: number;
    question: string;
    tallies: Array<bigint | number>;
  };
  return {
    options: n.options,
    closed: n.closed,
    closesAt: Number(n.closes_at),
    totalVotes: Number(n.total_votes),
    communityId: Number(n.community_id),
    question: n.question,
    tallies: (n.tallies ?? []).map((t) => Number(t)),
  };
}

export async function readCommunity(communityId: number): Promise<{
  admin: string;
  name: string;
  merkleRoot: string;
  memberCount: number;
}> {
  const op = contract().call(
    "community",
    nativeToScVal(communityId, { type: "u32" }),
  );
  const retval = await simulate(op);
  const n = scValToNative(retval) as {
    admin: string;
    name: string;
    merkle_root: Uint8Array | Buffer;
    member_count: number;
  };
  const rootBuf =
    n.merkle_root instanceof Uint8Array
      ? Buffer.from(n.merkle_root)
      : (n.merkle_root as Buffer);
  return {
    admin: n.admin,
    name: n.name,
    merkleRoot: rootBuf.toString("hex"),
    memberCount: Number(n.member_count),
  };
}

export async function submitVote(
  voterSecret: string,
  electionId: number,
  optionIndex: number,
  proof: Buffer[],
): Promise<void> {
  const kp = Keypair.fromSecret(voterSecret);
  const proofScVals = proof.map((p) => xdr.ScVal.scvBytes(p));
  const op = contract().call(
    "vote",
    new (await import("@stellar/stellar-sdk")).Address(kp.publicKey()).toScVal(),
    nativeToScVal(electionId, { type: "u32" }),
    nativeToScVal(optionIndex, { type: "u32" }),
    xdr.ScVal.scvVec(proofScVals),
  );
  await submit(kp, op);
}

/** Has this voter address already cast a ballot in this election?
 *  Used to filter out already-voted elections from the eligible list
 *  before the voter ever picks them, so the wizard doesn't hand them
 *  a dead-end. */
export async function readHasVoted(
  voterPublicKey: string,
  electionId: number,
): Promise<boolean> {
  const op = contract().call(
    "has_voted",
    nativeToScVal(electionId, { type: "u32" }),
    new Address(voterPublicKey).toScVal(),
  );
  const retval = await simulate(op);
  return Boolean(scValToNative(retval));
}

/** How many elections exist. IDs are 0..(next-1). */
export async function readNextElectionId(): Promise<number> {
  const op = contract().call("next_election_id");
  const retval = await simulate(op);
  return Number(scValToNative(retval));
}
