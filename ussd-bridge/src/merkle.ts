// Node-side Merkle util for the USSD bridge. Kept in this file (rather
// than imported from ../../shared/merkle.ts) so the bridge is a
// self-contained deployable. If you change the algorithm here, change
// it in web/src/merkle.ts and the Soroban contract's `verify_proof`
// in the same commit — all three must stay identical.

import { Address } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

export function leafFor(publicKey: string): Buffer {
  const scVal = new Address(publicKey).toScVal();
  return sha256(Buffer.from(scVal.toXDR()));
}

function hashPair(a: Buffer, b: Buffer): Buffer {
  const [first, second] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.concat([first, second]));
}

export interface Tree {
  root: Buffer;
  proofs: Buffer[][];
}

export function buildTree(publicKeys: string[]): Tree {
  if (publicKeys.length === 0) throw new Error("empty member list");
  const leaves = publicKeys.map(leafFor);
  const levels: Buffer[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i];
      const b = i + 1 < cur.length ? cur[i + 1] : cur[i];
      next.push(hashPair(a, b));
    }
    levels.push(next);
  }
  const proofs: Buffer[][] = [];
  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const proof: Buffer[] = [];
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
  return { root: levels[levels.length - 1][0], proofs };
}

export function proofForIndex(members: string[], memberIndex: number): Buffer[] {
  const t = buildTree(members);
  const p = t.proofs[memberIndex];
  if (!p) throw new Error(`No proof for index ${memberIndex}`);
  return p;
}
