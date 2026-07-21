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
  Networks,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { config } from "./config";
import type { SignFn } from "./soroban";

export interface Attestation {
  orgName: string;
  admin: string;
  metadataUrl: string;
  attestedAt: number;
  revoked: boolean;
}

/** An authorised issuer of personhood attestations. */
export interface AttesterInfo {
  address: string;
  name: string;
  url: string;
  addedAt: number;
  deauthorized: boolean;
}

/** A personhood attestation. `subject` is the Stellar address that has
 *  been bound to a real, unique human by `attester`. */
export interface PersonEntry {
  subject: string;
  attester: string;
  /** 32-byte hex string, opaque. `sha256(offchain_id || attester_salt)`. */
  nullifier: string;
  scheme: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

const server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });

function passphrase(): string {
  return config.networkPassphrase || Networks.TESTNET;
}

function registryContract(): Contract {
  if (!config.registryId) {
    throw new Error(
      "Registry contract not configured. Set VITE_REGISTRY_ID in your .env.",
    );
  }
  return new Contract(config.registryId);
}

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

/** Sign + submit a write op on the registry, mirroring soroban.ts:submit. */
async function submit(
  sourceAddress: string,
  op: xdr.Operation,
  signXDR: SignFn,
): Promise<void> {
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, {
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
  let hash = sendResp.hash;
  for (let i = 0; i < 30; i++) {
    const status = await server.getTransaction(hash);
    if (status.status === "SUCCESS") return;
    if (status.status === "FAILED")
      throw new Error(`Tx failed: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for transaction");
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
  const op = registryContract().call(
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

// ---------- Proof-of-personhood --------------------------------------------

/** Read the on-chain curator address. */
export async function readCurator(): Promise<string | null> {
  if (!config.registryId) return null;
  try {
    const op = registryContract().call("curator");
    const retval = await simulate(op);
    return scValToNative(retval) as string;
  } catch {
    return null;
  }
}

/** Read metadata for a specific attester. Null if the address is not
 *  (or was never) an attester. */
export async function readAttesterInfo(
  attester: string,
): Promise<AttesterInfo | null> {
  if (!config.registryId) return null;
  try {
    const op = registryContract().call(
      "attester_info",
      new Address(attester).toScVal(),
    );
    const retval = await simulate(op);
    const n = scValToNative(retval) as {
      name: string;
      url: string;
      added_at: bigint | number;
      deauthorized: boolean;
    };
    return {
      address: attester,
      name: n.name,
      url: n.url,
      addedAt: Number(n.added_at),
      deauthorized: n.deauthorized,
    };
  } catch {
    return null;
  }
}

/** Boolean: is this address on the authorised-attesters list (and not
 *  revoked)? Uses the contract's own `is_attester` view. */
export async function isAttester(attester: string): Promise<boolean> {
  if (!config.registryId) return false;
  try {
    const op = registryContract().call(
      "is_attester",
      new Address(attester).toScVal(),
    );
    const retval = await simulate(op);
    return scValToNative(retval) as boolean;
  } catch {
    return false;
  }
}

/** Boolean: has this address been attested as a real, unique human
 *  by any currently-authorised attester, and is the attestation still
 *  live (not revoked, not expired)? */
export async function isPerson(subject: string): Promise<boolean> {
  if (!config.registryId) return false;
  try {
    const op = registryContract().call(
      "is_person",
      new Address(subject).toScVal(),
    );
    const retval = await simulate(op);
    return scValToNative(retval) as boolean;
  } catch {
    return false;
  }
}

/** Full personhood record for a subject, or null if none exists. */
export async function readPersonInfo(
  subject: string,
): Promise<PersonEntry | null> {
  if (!config.registryId) return null;
  try {
    const op = registryContract().call(
      "person_info",
      new Address(subject).toScVal(),
    );
    const retval = await simulate(op);
    const n = scValToNative(retval) as {
      subject: string;
      attester: string;
      nullifier: Uint8Array;
      scheme: string;
      issued_at: bigint | number;
      expires_at: bigint | number;
      revoked: boolean;
    };
    return {
      subject: n.subject,
      attester: n.attester,
      nullifier: Buffer.from(n.nullifier).toString("hex"),
      scheme: n.scheme,
      issuedAt: Number(n.issued_at),
      expiresAt: Number(n.expires_at),
      revoked: n.revoked,
    };
  } catch {
    return null;
  }
}

// ---------- write calls ----------------------------------------------------

/** Curator adds a new attester (or re-activates a previously
 *  deauthorised one and refreshes their name/url). */
export async function authorizeAttester(
  curator: string,
  attester: string,
  name: string,
  url: string,
  sign: SignFn,
): Promise<void> {
  const op = registryContract().call(
    "authorize_attester",
    new Address(attester).toScVal(),
    nativeToScVal(name, { type: "string" }),
    nativeToScVal(url, { type: "string" }),
  );
  await submit(curator, op, sign);
}

/** Curator revokes an attester. Existing entries stay on-chain for
 *  audit but `is_person` will start returning false for all of them. */
export async function deauthorizeAttester(
  curator: string,
  attester: string,
  sign: SignFn,
): Promise<void> {
  const op = registryContract().call(
    "deauthorize_attester",
    new Address(attester).toScVal(),
  );
  await submit(curator, op, sign);
}

/**
 * Attester binds a Stellar `subject` address to a real, unique human.
 *
 * `nullifierHex` must be a 32-byte hex string (64 hex chars, optional
 * `0x` prefix). It should be `sha256(offchain_id || attester_salt)` so
 * the same human always maps to the same nullifier for a given
 * attester, letting the contract reject a second address trying to
 * double-register the same identity.
 *
 * `expiresAt` is a unix timestamp (seconds) and MUST be in the future.
 */
export async function attestPerson(
  attester: string,
  subject: string,
  nullifierHex: string,
  scheme: string,
  expiresAt: number,
  sign: SignFn,
): Promise<void> {
  const cleanHex = nullifierHex.startsWith("0x")
    ? nullifierHex.slice(2)
    : nullifierHex;
  const buf = Buffer.from(cleanHex, "hex");
  if (buf.length !== 32) {
    throw new Error(
      `Nullifier must be 32 bytes (got ${buf.length}). Use sha256 hex.`,
    );
  }
  const op = registryContract().call(
    "attest_person",
    new Address(attester).toScVal(),
    new Address(subject).toScVal(),
    xdr.ScVal.scvBytes(buf),
    nativeToScVal(scheme, { type: "string" }),
    nativeToScVal(expiresAt, { type: "u64" }),
  );
  await submit(attester, op, sign);
}

/** Revoke a personhood attestation. Callable by the original issuing
 *  attester OR the curator. */
export async function revokePerson(
  caller: string,
  subject: string,
  sign: SignFn,
): Promise<void> {
  const op = registryContract().call(
    "revoke_person",
    new Address(caller).toScVal(),
    new Address(subject).toScVal(),
  );
  await submit(caller, op, sign);
}

/**
 * Convenience: hash an off-chain identifier + an attester salt to
 * produce a stable, opaque nullifier. NEVER put the raw identifier
 * (NIN, phone, email) on-chain; put its salted hash.
 *
 * The salt is what makes nullifiers unlinkable across attesters — a
 * NIRA attester and a biometric attester derive different nullifiers
 * for the same human, so an observer of the chain can't merge them
 * into one global identity graph.
 */
export async function computeNullifier(
  offchainId: string,
  attesterSalt: string,
): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${offchainId}:${attesterSalt}`);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(hashBuf).toString("hex");
}
