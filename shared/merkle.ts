// Merkle tree utility — MUST stay bit-for-bit compatible with the
// Soroban contract's Merkle verification in
// `soroban-evoting/contracts/evoting/src/lib.rs`.
//
//   leaf   = sha256(xdr(ScVal::Address(voter)))
//   parent = sha256(sort([a, b])[0] || sort([a, b])[1])
//   root   = repeat until one node remains
//
// If the algorithm here drifts from the Rust contract, no vote from
// any channel will verify. Keep them in lockstep.

import { Address, xdr } from "@stellar/stellar-sdk";
import { createHash } from "crypto";

export type Hex32 = Buffer; // exactly 32 bytes

export function sha256(data: Buffer): Hex32 {
  return createHash("sha256").update(data).digest();
}

/** Compute the contract-compatible leaf hash for a Stellar address (G...). */
export function leafFor(publicKey: string): Hex32 {
  const scVal = new Address(publicKey).toScVal();
  const xdrBuf = Buffer.from(scVal.toXDR());
  return sha256(xdrBuf);
}

/** Lexicographic-sort-then-hash pair, matching the contract. */
export function hashPair(a: Hex32, b: Hex32): Hex32 {
  const [first, second] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.concat([first, second]));
}

export interface Tree {
  root: Hex32;
  leaves: Hex32[];
  /** proofs[i] is the Merkle proof for leaves[i]. */
  proofs: Hex32[][];
}

/** Build a Merkle tree from a list of Stellar public keys. */
export function buildTree(publicKeys: string[]): Tree {
  if (publicKeys.length === 0) {
    throw new Error("Cannot build Merkle tree over an empty member list");
  }
  const leaves = publicKeys.map(leafFor);
  // levels[0] = leaves; each subsequent level halves (dup last on odd)
  const levels: Hex32[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Hex32[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i];
      const b = i + 1 < cur.length ? cur[i + 1] : cur[i];
      next.push(hashPair(a, b));
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1][0];

  const proofs: Hex32[][] = [];
  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const proof: Hex32[] = [];
    let idx = leafIdx;
    for (let l = 0; l < levels.length - 1; l++) {
      const lvl = levels[l];
      const siblingIdx =
        idx % 2 === 0 ? (idx + 1 < lvl.length ? idx + 1 : idx) : idx - 1;
      proof.push(lvl[siblingIdx]);
      idx = Math.floor(idx / 2);
    }
    proofs.push(proof);
  }
  return { root, leaves, proofs };
}

export function verifyProof(
  publicKey: string,
  proof: Hex32[],
  root: Hex32,
): boolean {
  let current = leafFor(publicKey);
  for (const sibling of proof) {
    current = hashPair(current, sibling);
  }
  return Buffer.compare(current, root) === 0;
}

/** Encode a 32-byte hash as a hex string (no 0x prefix). */
export function toHex(b: Hex32): string {
  return b.toString("hex");
}

/** Parse a hex string (with or without 0x) into a Buffer. */
export function fromHex(s: string): Hex32 {
  const clean = s.startsWith("0x") ? s.slice(2) : s;
  const buf = Buffer.from(clean, "hex");
  if (buf.length !== 32) {
    throw new Error(`Expected 32-byte hex, got ${buf.length} bytes`);
  }
  return buf;
}
