/**
 * Statistical anomaly detection over the bridge vote log.
 *
 * All heuristics are simple, transparent and rule-based on purpose — we
 * want the "Audit notes" panel to be defensible ("we saw X because Y")
 * rather than an opaque ML score. Signals we surface today:
 *
 *   1. Time bursts     — many votes in a short window (script/mass-vote)
 *   2. Index clusters  — a run of consecutive memberIndex values voting
 *                        the same option in sequence (organiser batch)
 *   3. One-sided bias  — a single option receiving > 95% with N>=10
 *   4. Off-hours vote  — > 40% of votes cast between 00:00–05:00 local
 *
 * Each note carries a level (info | warn | alert) so the UI can style.
 * If the local vote log is empty (e.g. bridge restarted, election closed
 * before this feature shipped) we return an informational note and no
 * alerts — absence of evidence isn't evidence.
 */

import { getVotesForElection, type VoteLogEntry } from "./voteLog.js";
import { readElection } from "./soroban.js";

export type NoteLevel = "info" | "warn" | "alert";

export interface AnomalyNote {
  level: NoteLevel;
  title: string;
  detail: string;
}

export interface AnomalyReport {
  electionId: number;
  loggedVotes: number;
  onChainTotal: number;
  coverage: number; // loggedVotes / onChainTotal (0..1)
  notes: AnomalyNote[];
}

const BURST_WINDOW_MS = 60_000; // 1 minute
const BURST_THRESHOLD = 5; // >=5 votes in 60s
const CLUSTER_THRESHOLD = 4; // >=4 consecutive memberIndex on same option
const NIGHT_START_H = 0;
const NIGHT_END_H = 5;
const NIGHT_MIN_TOTAL = 10;
const NIGHT_RATIO = 0.4;
const BIAS_MIN_TOTAL = 10;
const BIAS_RATIO = 0.95;

export async function analyzeElection(
  electionId: number,
): Promise<AnomalyReport> {
  const votes = getVotesForElection(electionId);
  let onChainTotal = votes.length;
  try {
    const info = await readElection(electionId);
    onChainTotal = info.totalVotes;
  } catch {
    // election not readable — proceed with local-only.
  }
  const coverage =
    onChainTotal > 0 ? Math.min(1, votes.length / onChainTotal) : 1;

  const notes: AnomalyNote[] = [];

  if (votes.length === 0) {
    notes.push({
      level: "info",
      title: "No local vote log",
      detail:
        "The bridge did not record any votes for this election. Anomaly checks require the local vote log.",
    });
    return { electionId, loggedVotes: 0, onChainTotal, coverage, notes };
  }

  if (coverage < 0.5 && onChainTotal >= 5) {
    notes.push({
      level: "info",
      title: "Partial vote log",
      detail: `Only ${votes.length} of ${onChainTotal} on-chain votes were routed through this bridge. Findings below cover the logged subset only.`,
    });
  }

  addBurstNotes(votes, notes);
  addIndexClusterNotes(votes, notes);
  addOneSidedNotes(votes, notes);
  addOffHoursNotes(votes, notes);

  if (
    notes.length === 0 ||
    notes.every((n) => n.level === "info")
  ) {
    notes.push({
      level: "info",
      title: "No anomalies detected",
      detail: `Reviewed ${votes.length} logged votes across ${new Set(
        votes.map((v) => v.memberIndex),
      ).size} distinct member indexes.`,
    });
  }

  return { electionId, loggedVotes: votes.length, onChainTotal, coverage, notes };
}

function addBurstNotes(votes: VoteLogEntry[], notes: AnomalyNote[]): void {
  const sorted = [...votes].sort((a, b) => a.timestamp - b.timestamp);
  let maxCount = 0;
  let maxStart = 0;
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (
      j < sorted.length &&
      sorted[j].timestamp - sorted[i].timestamp <= BURST_WINDOW_MS
    ) {
      j++;
    }
    const c = j - i;
    if (c > maxCount) {
      maxCount = c;
      maxStart = sorted[i].timestamp;
    }
  }
  if (maxCount >= BURST_THRESHOLD) {
    notes.push({
      level: "warn",
      title: `Burst of ${maxCount} votes in one minute`,
      detail: `Highest-density window started at ${new Date(
        maxStart,
      ).toISOString()}. Bursts can indicate scripted voting or a fair rush after an announcement — inspect voter channels.`,
    });
  }
}

function addIndexClusterNotes(
  votes: VoteLogEntry[],
  notes: AnomalyNote[],
): void {
  // Look at votes in submission order and check for runs of ascending
  // memberIndex where the same option was chosen.
  const sorted = [...votes].sort((a, b) => a.timestamp - b.timestamp);
  let run = 1;
  let bestRun = 1;
  let bestOption = -1;
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1];
    const c = sorted[i];
    if (
      c.memberIndex === p.memberIndex + 1 &&
      c.optionIndex === p.optionIndex &&
      c.timestamp - p.timestamp < 5 * 60_000
    ) {
      run += 1;
      if (run > bestRun) {
        bestRun = run;
        bestOption = c.optionIndex;
      }
    } else {
      run = 1;
    }
  }
  if (bestRun >= CLUSTER_THRESHOLD) {
    notes.push({
      level: "alert",
      title: `${bestRun} consecutive voters chose option #${bestOption}`,
      detail:
        "Consecutive memberIndex values voting the same option in quick succession can suggest one operator submitting on behalf of multiple voters.",
    });
  }
}

function addOneSidedNotes(
  votes: VoteLogEntry[],
  notes: AnomalyNote[],
): void {
  if (votes.length < BIAS_MIN_TOTAL) return;
  const counts = new Map<number, number>();
  for (const v of votes) {
    counts.set(v.optionIndex, (counts.get(v.optionIndex) ?? 0) + 1);
  }
  let topOpt = -1;
  let topCount = 0;
  for (const [opt, c] of counts) {
    if (c > topCount) {
      topCount = c;
      topOpt = opt;
    }
  }
  const ratio = topCount / votes.length;
  if (ratio >= BIAS_RATIO) {
    notes.push({
      level: "warn",
      title: `Option #${topOpt} holds ${(ratio * 100).toFixed(1)}%`,
      detail:
        "A near-unanimous split is unusual for a real vote and worth spot-checking. Could reflect a genuine consensus, an unopposed candidate, or coordinated voting.",
    });
  }
}

function addOffHoursNotes(
  votes: VoteLogEntry[],
  notes: AnomalyNote[],
): void {
  if (votes.length < NIGHT_MIN_TOTAL) return;
  let night = 0;
  for (const v of votes) {
    const h = new Date(v.timestamp).getUTCHours();
    if (h >= NIGHT_START_H && h < NIGHT_END_H) night += 1;
  }
  const ratio = night / votes.length;
  if (ratio >= NIGHT_RATIO) {
    notes.push({
      level: "warn",
      title: `${(ratio * 100).toFixed(0)}% of votes cast overnight`,
      detail: `${night} of ${votes.length} votes landed between 00:00 and 05:00 UTC. Real elections rarely see this concentration in the small hours.`,
    });
  }
}
