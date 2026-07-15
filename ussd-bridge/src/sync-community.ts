// One-shot admin helper: push the bridge's currently-active member
// list up to the on-chain community merkle_root.
//
// Usage:
//   ADMIN_SECRET=S...    (the Freighter secret for the community admin)
//   COMMUNITY_ID=9
//   npx tsx src/sync-community.ts
//
// This bypasses the web app entirely — useful when Freighter's popup
// or its testnet setting is being uncooperative.

import "dotenv/config";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { config } from "./config.js";
import { buildTree } from "./merkle.js";
import { getActive, initLists, pathsForList } from "./lists.js";
import { readFileSync } from "node:fs";

async function main() {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || !secret.startsWith("S")) {
    throw new Error("Set ADMIN_SECRET to a Stellar secret key (starts with S).");
  }
  const idStr = process.env.COMMUNITY_ID;
  if (!idStr) throw new Error("Set COMMUNITY_ID.");
  const communityId = Number(idStr);
  if (!Number.isInteger(communityId) || communityId < 0) {
    throw new Error(`COMMUNITY_ID must be a non-negative integer, got ${idStr}`);
  }

  initLists();
  const active = getActive();
  const paths = pathsForList(active.id);
  const raw = JSON.parse(readFileSync(paths.membersPath, "utf8")) as
    | string[]
    | { members: string[] };
  const members = Array.isArray(raw) ? raw : raw.members;
  if (members.length === 0) throw new Error("Active list has no members");
  const bridgeRoot = buildTree(members).root;
  console.log(`Active list "${active.name}" has ${members.length} members`);
  console.log(`Bridge root  : ${bridgeRoot.toString("hex")}`);

  const server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });
  const contract = new Contract(config.contractId);
  const kp = Keypair.fromSecret(secret);
  console.log(`Signing with : ${kp.publicKey()}`);

  // Sanity: check the admin matches the community record.
  const readTx = new TransactionBuilder(
    { accountId: () => kp.publicKey(), sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any,
    { fee: BASE_FEE, networkPassphrase: config.networkPassphrase },
  )
    .addOperation(contract.call("community", nativeToScVal(communityId, { type: "u32" })))
    .setTimeout(30)
    .build();
  const readSim = await server.simulateTransaction(readTx);
  if (!("result" in readSim) || !readSim.result) {
    console.error(readSim);
    throw new Error("Could not read community");
  }
  const info = scValToNative(readSim.result.retval) as {
    admin: string;
    name: string;
    merkle_root: Uint8Array;
    member_count: number;
  };
  console.log(`On-chain root: ${Buffer.from(info.merkle_root).toString("hex")}`);
  console.log(`On-chain admin: ${info.admin}`);
  if (info.admin !== kp.publicKey()) {
    throw new Error(
      `Admin mismatch. Community #${communityId} is owned by ${info.admin} but you signed with ${kp.publicKey()}.`,
    );
  }
  if (Buffer.from(info.merkle_root).toString("hex") === bridgeRoot.toString("hex")) {
    console.log("Already in sync — nothing to do.");
    return;
  }

  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "update_members",
        nativeToScVal(communityId, { type: "u32" }),
        nativeToScVal(bridgeRoot, { type: "bytes" }),
        nativeToScVal(members.length, { type: "u32" }),
      ),
    )
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(`sendTransaction ERROR: ${JSON.stringify(send.errorResult)}`);
  }
  console.log(`Submitted ${send.hash}`);
  for (let i = 0; i < 30; i++) {
    const st = await server.getTransaction(send.hash);
    if (st.status === "SUCCESS") {
      console.log("SUCCESS — community synced.");
      return;
    }
    if (st.status === "FAILED") {
      console.error(st);
      throw new Error("Transaction failed on-chain.");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for tx confirmation.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

// Silence unused import warning — Address is not needed directly here.
void Address;
