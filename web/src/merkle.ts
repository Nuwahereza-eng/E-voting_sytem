// Browser Merkle tree utility. MUST stay algorithmically identical to
// `shared/merkle.ts` (Node) and the Rust contract's `verify_proof`:
//
//   leaf   = sha256(xdr(ScVal::Address(voter)))
//   parent = sha256(sort([a, b])[0] || sort([a, b])[1])

import { Address } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Copy into an ArrayBuffer-backed view so crypto.subtle's BufferSource
  // typing is happy (SharedArrayBuffer is not allowed).
  const copy = new Uint8Array(data);
  const h = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return new Uint8Array(h);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

export async function leafFor(publicKey: string): Promise<Uint8Array> {
  const scVal = new Address(publicKey).toScVal();
  const xdrBytes = new Uint8Array(scVal.toXDR());
  return sha256(xdrBytes);
}

async function hashPair(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const [first, second] = cmp(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(concat(first, second));
}

export interface BrowserTree {
  root: Uint8Array;
  leaves: Uint8Array[];
  proofs: Uint8Array[][]; // proofs[i] is for member i
}

export async function buildTree(publicKeys: string[]): Promise<BrowserTree> {
  if (publicKeys.length === 0) {
    throw new Error("Cannot build Merkle tree over empty member list");
  }
  const leaves: Uint8Array[] = [];
  for (const pk of publicKeys) leaves.push(await leafFor(pk));

  const levels: Uint8Array[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i];
      const b = i + 1 < cur.length ? cur[i + 1] : cur[i];
      next.push(await hashPair(a, b));
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1][0];

  const proofs: Uint8Array[][] = [];
  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const proof: Uint8Array[] = [];
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

export function toHex(u: Uint8Array): string {
  return Buffer.from(u).toString("hex");
}

export async function proofForMember(
  members: string[],
  memberKey: string,
): Promise<{ root: string; proof: string[] } | null> {
  const idx = members.indexOf(memberKey);
  if (idx === -1) return null;
  const tree = await buildTree(members);
  return {
    root: toHex(tree.root),
    proof: tree.proofs[idx].map(toHex),
  };
}
