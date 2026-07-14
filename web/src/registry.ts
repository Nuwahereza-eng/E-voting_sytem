// Read-only client for the SautiRegistry contract. Used by /verify to
// show a "verified organiser" badge.
//
// If VITE_REGISTRY_ID is not set, all lookups return null and the UI
// just doesn't render a badge (the election still verifies on its own
// terms — the registry is a trust *hint*, not a gate).

import {
  BASE_FEE,
  Contract,
  Address,
  Keypair,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "./config";

export interface Attestation {
  orgName: string;
  admin: string;
  metadataUrl: string;
  attestedAt: number;
  revoked: boolean;
}

const server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });

async function simulate(op: xdr.Operation): Promise<xdr.ScVal> {
  const dummy = Keypair.random();
  const account = {
    accountId: () => dummy.publicKey(),
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  } as unknown as Awaited<ReturnType<typeof server.getAccount>>;
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

/**
 * Look up an attestation for (evoting_contract, community_id). Returns
 * null if the registry is disabled, the entry does not exist, or the
 * attestation has been revoked.
 */
export async function lookupAttestation(
  evotingContractId: string,
  communityId: number,
): Promise<Attestation | null> {
  if (!config.registryId) return null;
  const registry = new Contract(config.registryId);
  const op = registry.call(
    "get",
    new Address(evotingContractId).toScVal(),
    nativeToScVal(communityId, { type: "u32" }),
  );
  try {
    const retval = await simulate(op);
    const n = scValToNative(retval) as {
      org_name: string;
      admin: string;
      metadata_url: string;
      attested_at: bigint | number;
      revoked: boolean;
    };
    if (n.revoked) return null;
    return {
      orgName: n.org_name,
      admin: n.admin,
      metadataUrl: n.metadata_url,
      attestedAt: Number(n.attested_at),
      revoked: n.revoked,
    };
  } catch {
    // Contract returns NotAttested; treat as "no badge."
    return null;
  }
}
