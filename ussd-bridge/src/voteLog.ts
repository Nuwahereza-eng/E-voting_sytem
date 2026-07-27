/**
 * Local vote log.
 *
 * The Soroban contract only exposes aggregate tallies per election, not
 * per-vote metadata. To enable anomaly detection and audit-note UI we
 * append every successful bridge-submitted vote to a JSON file with:
 *
 *   { electionId, listId, memberIndex, optionIndex, timestamp, channel }
 *
 * timestamp is ms epoch on the bridge host. channel is one of
 * "web" | "voice" | "phone". This log is best-effort — a vote submitted
 * directly by a voter's wallet (bypassing the bridge) will not appear,
 * but every custodial vote does.
 */

import fs from "node:fs";
import path from "node:path";

const LOG_PATH = process.env.VOTE_LOG_PATH ?? "./data/votes-log.json";

export type VoteChannel = "web" | "voice" | "phone" | "unknown";

export interface VoteLogEntry {
  electionId: number;
  listId: string | null;
  memberIndex: number;
  optionIndex: number;
  timestamp: number;
  channel: VoteChannel;
}

let cache: VoteLogEntry[] | null = null;

function load(): VoteLogEntry[] {
  if (cache) return cache;
  if (!fs.existsSync(LOG_PATH)) {
    cache = [];
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    cache = Array.isArray(raw) ? (raw as VoteLogEntry[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist(): void {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(cache ?? [], null, 2));
}

export function appendVote(entry: VoteLogEntry): void {
  const log = load();
  log.push(entry);
  persist();
}

export function getVotesForElection(electionId: number): VoteLogEntry[] {
  return load().filter((e) => e.electionId === electionId);
}
