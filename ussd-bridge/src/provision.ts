#!/usr/bin/env tsx
// Quick provisioning CLI.
//   tsx src/provision.ts init 5       -> generate 5 keypairs, write to data/members.json
//   tsx src/provision.ts assign <msisdn> <memberIndex>
//                                     -> bind an msisdn to a generated key
//   tsx src/provision.ts root         -> print the Merkle root over data/members.json

import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { config } from "./config.js";
import { buildTree } from "./merkle.js";
import { loadRegistry, upsertVoter } from "./registry.js";

const [cmd, ...args] = process.argv.slice(2);

function writeMembers(members: string[]) {
  const p = path.resolve(config.membersPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(members, null, 2) + "\n");
}

function readMembers(): string[] {
  const p = path.resolve(config.membersPath);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8")) as string[];
}

/** Also write a sidecar secrets file so the bridge can custody sign. */
function writeSecrets(secrets: string[]) {
  const p = path.resolve(config.membersPath) + ".secrets.json";
  fs.writeFileSync(p, JSON.stringify(secrets, null, 2) + "\n");
  console.log(`Wrote ${p} — KEEP THIS PRIVATE. Hackathon simplification.`);
}

function readSecrets(): string[] {
  const p = path.resolve(config.membersPath) + ".secrets.json";
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8")) as string[];
}

if (cmd === "init") {
  const n = Number(args[0] ?? 5);
  const kps = Array.from({ length: n }, () => Keypair.random());
  writeMembers(kps.map((k) => k.publicKey()));
  writeSecrets(kps.map((k) => k.secret()));
  const tree = buildTree(kps.map((k) => k.publicKey()));
  console.log(`Generated ${n} members. Merkle root:`);
  console.log(tree.root.toString("hex"));
} else if (cmd === "assign") {
  const [msisdn, idxStr] = args;
  if (!msisdn || !idxStr) {
    console.error("usage: assign <msisdn> <memberIndex>");
    process.exit(1);
  }
  const idx = Number(idxStr);
  const members = readMembers();
  const secrets = readSecrets();
  if (idx < 0 || idx >= members.length) {
    console.error(`memberIndex out of range 0..${members.length - 1}`);
    process.exit(1);
  }
  loadRegistry(config.registryPath);
  upsertVoter(msisdn, {
    publicKey: members[idx],
    secret: secrets[idx],
    memberIndex: idx,
  });
  console.log(`Bound ${msisdn} -> member #${idx} (${members[idx]})`);
} else if (cmd === "root") {
  const members = readMembers();
  const tree = buildTree(members);
  console.log(tree.root.toString("hex"));
} else {
  console.error(
    [
      "Sauti provisioning CLI",
      "  init <n>              generate n keypairs -> members.json + members.json.secrets.json",
      "  assign <msisdn> <idx> bind an msisdn to member index",
      "  root                  print the Merkle root over members.json",
    ].join("\n"),
  );
  process.exit(1);
}
