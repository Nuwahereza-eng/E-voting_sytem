/**
 * Photo → voter-roll CSV, via tesseract.js OCR.
 *
 * Voter organisers commonly hand us a printed sheet or a phone snapshot
 * of one. This module OCRs the image locally in the browser (no server
 * upload), then normalises each recognised line into a CSV row that
 * parseVoterCsv() understands: "Name,Phone,ID".
 *
 * Heuristics (per line):
 *   - phone: first token matching /(\+?\d[\d\s-]{7,15}\d)/
 *   - id   : leftover token that looks like an ID
 *            (uppercase letters + digits, or a bare digit run >= 5)
 *   - name : the rest, joined with spaces
 *
 * Lines with no recognised phone-or-id are dropped (usually headers or
 * decorative text). Whatever we produce is presented to the organiser
 * for review before enrolment — we never enrol directly from OCR.
 */

import Tesseract from "tesseract.js";

export interface OcrRow {
  name: string;
  phone: string;
  id: string;
  raw: string;
}

export interface OcrResult {
  rows: OcrRow[];
  csv: string;
  confidence: number; // 0..1
  droppedLines: number;
}

const PHONE_RE = /(\+?\d[\d\s-]{7,15}\d)/;
const ID_LIKE_RE = /^[A-Z][A-Z0-9-]{3,}$|^\d{5,}$/;

/**
 * Run OCR on an image blob and return normalised rows + a CSV
 * representation that can be dropped straight into parseVoterCsv().
 * onProgress reports a value between 0 and 1 while tesseract loads
 * language data and processes the image.
 */
export async function ocrVoterRoll(
  image: Blob | File,
  onProgress?: (p: number) => void,
): Promise<OcrResult> {
  const result = await Tesseract.recognize(image, "eng", {
    logger: (m) => {
      if (onProgress && typeof m.progress === "number") {
        onProgress(m.progress);
      }
    },
  });
  const confidence = (result.data.confidence ?? 0) / 100;
  const lines = result.data.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: OcrRow[] = [];
  let dropped = 0;
  for (const raw of lines) {
    const parsed = parseLine(raw);
    if (parsed) rows.push(parsed);
    else dropped += 1;
  }

  const csv = rows
    .map((r) => [csvEscape(r.name), csvEscape(r.phone), csvEscape(r.id)].join(","))
    .join("\n");

  return { rows, csv, confidence, droppedLines: dropped };
}

function parseLine(raw: string): OcrRow | null {
  // Normalise smart quotes and stray characters that tesseract emits.
  const cleaned = raw
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  const phoneMatch = cleaned.match(PHONE_RE);
  const phone = phoneMatch ? normalisePhone(phoneMatch[1]) : "";

  // Remove the phone substring so it doesn't interfere with name/id
  // extraction.
  const withoutPhone = phoneMatch
    ? cleaned.replace(phoneMatch[0], "").replace(/\s+/g, " ").trim()
    : cleaned;

  const tokens = withoutPhone.split(" ").filter(Boolean);

  // Pick the first token that looks like an ID.
  let id = "";
  const nameTokens: string[] = [];
  let foundId = false;
  for (const tok of tokens) {
    if (!foundId && ID_LIKE_RE.test(tok.replace(/[^A-Z0-9-]/gi, "").toUpperCase())) {
      id = tok.replace(/[^A-Z0-9-]/gi, "").toUpperCase();
      foundId = true;
    } else {
      nameTokens.push(tok);
    }
  }

  const name = nameTokens.join(" ").replace(/^[^\p{L}]+/u, "").trim();

  if (!phone && !id) return null;
  return { name, phone, id, raw };
}

function normalisePhone(s: string): string {
  const cleaned = s.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return "+" + cleaned.slice(2);
  if (cleaned.startsWith("0")) return "+256" + cleaned.slice(1);
  return "+" + cleaned;
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
