/**
 * Ballot translations cache.
 *
 * Storage: one JSON file (config.translationsPath) keyed by electionId, then
 * by target-language code. Each cached entry stores translated question +
 * option labels + a hash of the source strings so we can invalidate when the
 * election is edited.
 *
 * Shape:
 *   {
 *     [electionId]: {
 *       [langCode]: {
 *         question: string,
 *         options: string[],   // parallel to source options
 *         sourceHash: string,
 *         updatedAt: number
 *       }
 *     }
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { translate, translateBatch, type LangCode } from "./sunbird.js";

export interface BallotTranslation {
  question: string;
  options: string[];
  sourceHash: string;
  updatedAt: number;
}

type Store = Record<string, Record<string, BallotTranslation>>;

let store: Store | null = null;

function load(): Store {
  if (store) return store;
  const p = config.translationsPath;
  if (fs.existsSync(p)) {
    try {
      store = JSON.parse(fs.readFileSync(p, "utf8")) as Store;
    } catch {
      store = {};
    }
  } else {
    store = {};
  }
  return store;
}

function persist(): void {
  const p = config.translationsPath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store ?? {}, null, 2));
}

function hashSource(question: string, options: string[]): string {
  const h = crypto.createHash("sha256");
  h.update(question);
  h.update("\u0001");
  for (const o of options) {
    h.update(o);
    h.update("\u0001");
  }
  return h.digest("hex").slice(0, 16);
}

/** Read a cached translation, or null. */
export function getTranslation(
  electionId: string,
  lang: string,
): BallotTranslation | null {
  const s = load();
  return s[electionId]?.[lang] ?? null;
}

/** All cached translations for an election, keyed by lang. */
export function getAllForElection(
  electionId: string,
): Record<string, BallotTranslation> {
  const s = load();
  return s[electionId] ?? {};
}

/**
 * Ensure a translation exists for (electionId, lang). If the source strings
 * changed since the cache entry was written we re-translate. English is a
 * no-op that just echoes the source (English is our source language).
 */
export async function ensureTranslation(
  electionId: string,
  lang: LangCode,
  source: { question: string; options: string[] },
): Promise<BallotTranslation> {
  const sourceHash = hashSource(source.question, source.options);
  const s = load();
  const existing = s[electionId]?.[lang];
  if (existing && existing.sourceHash === sourceHash) return existing;

  let entry: BallotTranslation;
  if (lang === "eng") {
    entry = {
      question: source.question,
      options: [...source.options],
      sourceHash,
      updatedAt: Date.now(),
    };
  } else {
    const question = await translate({
      text: source.question,
      target: lang,
      source: "eng",
    });
    const options = await translateBatch(source.options, lang, "eng");
    entry = {
      question,
      options,
      sourceHash,
      updatedAt: Date.now(),
    };
  }

  if (!s[electionId]) s[electionId] = {};
  s[electionId][lang] = entry;
  persist();
  return entry;
}

/** Drop the cache for one election (call when the ballot is edited). */
export function invalidate(electionId: string): void {
  const s = load();
  if (s[electionId]) {
    delete s[electionId];
    persist();
  }
}
