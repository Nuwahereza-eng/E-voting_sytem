// Server-side Soroban client for the USSD bridge. Signs with the
// custodial secret key we hold for each phone number. Same caveat as
// AGENT_BUILD_BRIEF §6: production Sauti would push signing back to
// the user (SIM-based key or callback URL).

import {
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

async function submit(kp: Keypair, op: xdr.Operation): Promise<xdr.ScVal | null> {
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
  };
  return {
    options: n.options,
    closed: n.closed,
    closesAt: Number(n.closes_at),
    totalVotes: Number(n.total_votes),
    communityId: Number(n.community_id),
    question: n.question,
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
