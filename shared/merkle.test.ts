import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { buildTree, verifyProof, leafFor, toHex } from "./merkle";

test("buildTree + verifyProof — every member proof verifies", () => {
  const keys = Array.from({ length: 7 }, () => Keypair.random().publicKey());
  const tree = buildTree(keys);
  for (let i = 0; i < keys.length; i++) {
    assert.equal(verifyProof(keys[i], tree.proofs[i], tree.root), true);
  }
});

test("verifyProof — outsider is rejected", () => {
  const keys = Array.from({ length: 4 }, () => Keypair.random().publicKey());
  const tree = buildTree(keys);
  const outsider = Keypair.random().publicKey();
  // Give the outsider member 0's proof — should fail.
  assert.equal(verifyProof(outsider, tree.proofs[0], tree.root), false);
});

test("leafFor is deterministic", () => {
  const k = Keypair.random().publicKey();
  assert.equal(toHex(leafFor(k)), toHex(leafFor(k)));
});
