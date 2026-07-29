// -----------------------------------------------------------------------
// Warm the persistent UI-translation cache.
//
// Runs every harvested English UI string through the bridge's
// /translate/text endpoint for each supported language. The bridge caches
// each (lang, string) result to disk (data/ui-translations.json), so after
// one successful run the whole interface translates instantly and offline —
// no more live Sunbird calls (and no more daily-quota risk) at demo time.
//
// Usage:
//   node scripts/warm-translations.mjs
//   BRIDGE_URL=http://localhost:4000 node scripts/warm-translations.mjs
//
// Safe to re-run: strings already cached are returned from disk and never
// re-fetched from Sunbird. If a language is rate-limited mid-run, just run
// the script again later — it resumes where it left off.
// -----------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_URL = (process.env.BRIDGE_URL ?? "http://localhost:4000").replace(
  /\/$/,
  "",
);

// Languages to warm (all non-English supported languages).
const LANGS = ["lug", "ach", "nyn", "teo", "lgg", "swa"];

// Send strings in modest chunks so a single request stays well under the
// per-minute rate limit and completes quickly.
const CHUNK = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadStrings() {
  const p = path.join(__dirname, "ui-strings.json");
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  const seen = new Set();
  const out = [];
  for (const s of doc.strings) {
    if (typeof s !== "string" || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function translateChunk(target, texts) {
  const res = await fetch(`${BRIDGE_URL}/translate/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  const strings = loadStrings();
  console.log(
    `Warming ${strings.length} strings × ${LANGS.length} languages via ${BRIDGE_URL}\n`,
  );

  let failures = 0;
  for (const lang of LANGS) {
    let done = 0;
    let sample = "";
    for (let i = 0; i < strings.length; i += CHUNK) {
      const chunk = strings.slice(i, i + CHUNK);
      try {
        const { translations } = await translateChunk(lang, chunk);
        done += chunk.length;
        if (!sample && translations?.[0]) {
          sample = `${chunk[0].trim()} → ${translations[0]}`;
        }
      } catch (e) {
        failures++;
        console.error(`  [${lang}] chunk ${i / CHUNK} failed: ${e.message}`);
        // Back off a moment on failure (likely a transient rate limit).
        await sleep(2000);
      }
      // Gentle pacing between chunks.
      await sleep(400);
    }
    console.log(`✓ ${lang}: ${done}/${strings.length} cached   ${sample}`);
  }

  console.log(
    failures === 0
      ? "\nDone. Cache written to data/ui-translations.json — the UI now translates offline."
      : `\nFinished with ${failures} failed chunk(s). Re-run the script to fill the gaps (cached strings are skipped).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
