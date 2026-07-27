/**
 * Voice IVR voting via Africa's Talking Voice API + Sunbird STT.
 *
 * Flow (real telephony):
 *   1. Voter dials the AT Voice number.
 *   2. AT posts to POST /voice/answer with { callerNumber, sessionId, isActive:"1" }.
 *      We look up the caller phone in our voter registry, greet them in
 *      their preferred language, and respond with a <Record> XML dial
 *      plan.
 *   3. When the recording is done AT re-posts to /voice/answer with
 *      { recordingUrl }. We fetch the audio, transcribe it via Sunbird,
 *      match the transcript to a candidate label, and submit a vote via
 *      the existing bridge submission path.
 *
 * For local demos without a phone number, POST /voice/simulate takes a
 * text transcript and exercises the same matcher + submission path.
 *
 * All heavy work (STT, candidate matching, vote submission) is factored
 * into small pure functions so this module is testable in isolation.
 */

import type { Request, Response } from "express";
import { config } from "./config.js";
import { transcribe, type LangCode, isSupportedLang } from "./sunbird.js";
import { readElection, submitVote } from "./soroban.js";
import { buildTree, proofForIndex } from "./merkle.js";
import {
  findVoterByPhoneAcrossLists,
  type VoterHit,
} from "./lists.js";
import { readCommunity } from "./soroban.js";
import { appendVote } from "./voteLog.js";

// -----------------------------------------------------------------------
// Candidate matching
// -----------------------------------------------------------------------

/** Lowercase, strip diacritics, collapse whitespace, drop punctuation. */
function normaliseWord(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic Levenshtein distance (iterative, O(m*n)). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const dist = levenshtein(a, b);
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - dist / max;
}

export interface MatchResult {
  index: number;
  confidence: number;
  label: string;
}

/**
 * Match a transcript to the best candidate label.
 * Strategy: 3-way score = max(fullString, tokenOverlap, digitMatch) so
 * "I choose John" matches "John Doe" and "option two" matches option
 * index 1. Returns { index: -1 } if nothing scores above 0.4.
 */
export function matchCandidate(
  transcript: string,
  options: string[],
): MatchResult {
  const norm = normaliseWord(transcript);
  if (!norm) return { index: -1, confidence: 0, label: "" };

  // Digit shortcut: "option two" / "number 3" / "two" / "2".
  const digitFromText = parseSpokenNumber(norm);
  if (digitFromText !== null && digitFromText >= 1 && digitFromText <= options.length) {
    return {
      index: digitFromText - 1,
      confidence: 0.99,
      label: options[digitFromText - 1],
    };
  }

  let best: MatchResult = { index: -1, confidence: 0, label: "" };
  for (let i = 0; i < options.length; i++) {
    const label = normaliseWord(options[i]);
    if (!label) continue;
    const full = similarity(norm, label);
    // Token score: fraction of label tokens present in transcript.
    const labelTokens = label.split(" ").filter(Boolean);
    const transcriptTokens = new Set(norm.split(" "));
    const overlap =
      labelTokens.length > 0
        ? labelTokens.filter((t) => transcriptTokens.has(t)).length /
          labelTokens.length
        : 0;
    // Substring bonus.
    const sub = norm.includes(label) || label.includes(norm) ? 0.9 : 0;
    const score = Math.max(full, overlap, sub);
    if (score > best.confidence) {
      best = { index: i, confidence: score, label: options[i] };
    }
  }
  if (best.confidence < 0.4) return { index: -1, confidence: best.confidence, label: "" };
  return best;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

function parseSpokenNumber(norm: string): number | null {
  // Pure digit anywhere.
  const digitMatch = norm.match(/\b(\d{1,2})\b/);
  if (digitMatch) return Number(digitMatch[1]);
  for (const tok of norm.split(" ")) {
    if (NUMBER_WORDS[tok]) return NUMBER_WORDS[tok];
  }
  return null;
}

// -----------------------------------------------------------------------
// Vote submission from voice
// -----------------------------------------------------------------------

export interface CastVoiceVoteInput {
  callerNumber: string;
  electionId: number;
  transcript: string;
  language?: LangCode;
}

export interface CastVoiceVoteResult {
  ok: boolean;
  match?: MatchResult;
  choice?: string;
  error?: string;
  tallies?: number[];
}

/**
 * Look up caller, pick the eligible list for this election, match the
 * transcript to a candidate, and submit. Returns a structured result the
 * IVR handler can turn into TTS.
 */
export async function castVoiceVote(
  input: CastVoiceVoteInput,
): Promise<CastVoiceVoteResult> {
  const callerKey = normalisePhone(input.callerNumber);
  if (!callerKey) return { ok: false, error: "invalid_caller" };

  const hits = findVoterByPhoneAcrossLists(callerKey);
  if (hits.length === 0) return { ok: false, error: "voter_not_found" };

  let election;
  try {
    election = await readElection(input.electionId);
  } catch {
    return { ok: false, error: "election_not_found" };
  }
  if (election.closed || Date.now() / 1000 >= election.closesAt) {
    return { ok: false, error: "election_closed" };
  }

  const owning = hits.find(
    (h: VoterHit) => h.communityId === election.communityId,
  );
  if (!owning) return { ok: false, error: "not_eligible" };

  const match = matchCandidate(input.transcript, election.options);
  if (match.index < 0) return { ok: false, error: "no_match", match };

  // Root preflight — same as web /vote path.
  try {
    const community = await readCommunity(owning.communityId!);
    const localRoot = buildTree(owning.members).root.toString("hex");
    if (localRoot.toLowerCase() !== community.merkleRoot.toLowerCase()) {
      return { ok: false, error: "roll_out_of_sync" };
    }
  } catch {
    return { ok: false, error: "community_read_failed" };
  }

  try {
    const proof = proofForIndex(owning.members, owning.memberIndex);
    await submitVote(owning.secret, input.electionId, match.index, proof);
    appendVote({
      electionId: input.electionId,
      listId: owning.listId,
      memberIndex: owning.memberIndex,
      optionIndex: match.index,
      timestamp: Date.now(),
      channel: "voice",
    });
    const after = await readElection(input.electionId).catch(() => election);
    return {
      ok: true,
      match,
      choice: election.options[match.index],
      tallies: after.tallies,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function normalisePhone(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  return "+" + s.replace(/\D/g, "");
}

// -----------------------------------------------------------------------
// Africa's Talking Voice XML helpers
// -----------------------------------------------------------------------

function say(text: string): string {
  // Basic XML-safe escape.
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<Say voice="woman" playBeep="false">${safe}</Say>`;
}

function xmlResponse(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;
}

// -----------------------------------------------------------------------
// Express handlers
// -----------------------------------------------------------------------

/**
 * AT Voice callback. Two phases distinguished by the presence of
 * recordingUrl in the request body:
 *   Phase 1 (initial): reply with <Record> XML.
 *   Phase 2 (recording delivered): fetch audio, transcribe, cast vote,
 *     reply with a spoken result.
 *
 * Which election to vote on is passed via query string ?electionId=N.
 * A real deployment would render an election picker first; the demo
 * short-circuits to a specific election so the flow fits in one call.
 */
export async function handleVoice(req: Request, res: Response): Promise<void> {
  res.setHeader("content-type", "application/xml");
  const electionId = Number(req.query.electionId ?? req.body?.electionId ?? -1);
  const caller = String(req.body?.callerNumber ?? "");
  const langParam = String(req.query.lang ?? req.body?.lang ?? "eng");
  const lang: LangCode = isSupportedLang(langParam) ? langParam : "eng";

  const recordingUrl = req.body?.recordingUrl as string | undefined;

  // Phase 1: initial call — read prompt and start recording.
  if (!recordingUrl) {
    if (!Number.isInteger(electionId) || electionId < 0) {
      res.send(
        xmlResponse(
          say("Sorry, no election was selected. Please try again later.") +
            "<Hangup/>",
        ),
      );
      return;
    }
    let prompt = "After the beep, say the name of your candidate.";
    try {
      const info = await readElection(electionId);
      prompt = `Voting on ${info.question}. Options are: ${info.options
        .map((o, i) => `${i + 1}, ${o}`)
        .join(". ")}. After the beep, say your choice.`;
    } catch {
      // fall through with generic prompt
    }
    const cbHost = req.headers["x-forwarded-host"] ?? req.headers.host;
    const proto = req.headers["x-forwarded-proto"] ?? "https";
    const cb = `${proto}://${cbHost}/voice/answer?electionId=${electionId}&lang=${lang}`;
    res.send(
      xmlResponse(
        say(prompt) +
          `<Record finishOnKey="#" maxLength="6" trimSilence="true" playBeep="true" callbackUrl="${cb}"/>`,
      ),
    );
    return;
  }

  // Phase 2: recording has been posted back. Fetch audio, transcribe, vote.
  try {
    const audio = await fetchAudio(recordingUrl);
    const stt = await transcribe({
      audio,
      language: lang,
      filename: "voice.wav",
    });
    const result = await castVoiceVote({
      callerNumber: caller,
      electionId,
      transcript: stt.text,
      language: lang,
    });
    if (result.ok) {
      res.send(
        xmlResponse(
          say(`Your vote for ${result.choice} has been recorded. Thank you.`) +
            "<Hangup/>",
        ),
      );
    } else {
      res.send(
        xmlResponse(
          say(voiceErrorMessage(result.error)) + "<Hangup/>",
        ),
      );
    }
  } catch (e) {
    // Log and hang up gracefully.
    // eslint-disable-next-line no-console
    console.error("[voice] pipeline error:", e);
    res.send(
      xmlResponse(
        say("Sorry, we could not record your vote. Please try again later.") +
          "<Hangup/>",
      ),
    );
  }
}

function voiceErrorMessage(code?: string): string {
  switch (code) {
    case "voter_not_found":
      return "This phone number is not enrolled in any voter list.";
    case "election_not_found":
      return "That election was not found.";
    case "election_closed":
      return "That election has already closed.";
    case "not_eligible":
      return "You are not enrolled in the community that owns this election.";
    case "no_match":
      return "We could not match your choice to a candidate. Please try again.";
    case "roll_out_of_sync":
      return "The voter list is out of sync with the community on the blockchain. Please ask the organiser to sync.";
    default:
      return "Sorry, we could not process your vote.";
  }
}

async function fetchAudio(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`recording fetch ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * POST /voice/simulate — dev endpoint for demoing the voice pipeline
 * without an inbound phone call. Body:
 *   { callerNumber, electionId, transcript, lang? }
 * Response: same shape as castVoiceVote().
 */
export async function handleVoiceSimulate(
  req: Request,
  res: Response,
): Promise<void> {
  const callerNumber = String(req.body?.callerNumber ?? "");
  const electionId = Number(req.body?.electionId);
  const transcript = String(req.body?.transcript ?? "");
  const langParam = String(req.body?.lang ?? "eng");
  const lang: LangCode = isSupportedLang(langParam) ? langParam : "eng";
  if (!callerNumber) {
    res.status(400).json({ error: "callerNumber required" });
    return;
  }
  if (!Number.isInteger(electionId) || electionId < 0) {
    res.status(400).json({ error: "electionId must be a non-negative integer" });
    return;
  }
  if (!transcript.trim()) {
    res.status(400).json({ error: "transcript required" });
    return;
  }
  const result = await castVoiceVote({
    callerNumber,
    electionId,
    transcript,
    language: lang,
  });
  res.json(result);
  // reference config to satisfy TS import when unused
  void config.port;
}
