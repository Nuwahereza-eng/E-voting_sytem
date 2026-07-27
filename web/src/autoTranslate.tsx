// -----------------------------------------------------------------------
// App-wide auto translation.
//
// The nav language picker sets a global ballot language (see lang.tsx).
// This layer makes the *entire* interface follow that choice: it walks the
// rendered DOM, collects visible English text, translates it in batches via
// the Sunbird-backed bridge, and swaps the text in place. When the user
// switches back to English the original text is restored.
//
// It is intentionally a DOM layer rather than per-string <T> wrappers so we
// don't have to touch every component. Guards below keep it from mangling
// things that must stay verbatim (contract IDs, phone numbers, code, inputs).
//
// Translations are cached per (lang, text) both here and on the bridge, so
// repeated strings across pages cost one call, once.
// -----------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { useLanguage } from "./lang";
import { translateTexts } from "./bridge";

// Elements whose text must never be translated.
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "CODE",
  "PRE",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "SVG",
  "PATH",
]);

function hasLetters(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

// A text node is translatable when it carries real words and isn't inside a
// verbatim region (monospace = addresses/roots/phones, or an opt-out marker).
function shouldSkip(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  if (SKIP_TAGS.has(parent.tagName)) return true;
  if (parent.closest("[data-no-translate]")) return true;
  if (parent.closest(".font-mono")) return true;
  const trimmed = (node.nodeValue ?? "").trim();
  if (trimmed.length < 2) return true;
  if (trimmed.length > 400) return true;
  if (!hasLetters(trimmed)) return true;
  return false;
}

interface Rec {
  orig: string;
  applied: string;
}

/**
 * Mount once inside <LanguageProvider>. Renders nothing; drives a DOM
 * translation pass keyed off the current language.
 */
export function AutoTranslate() {
  const { lang, setTranslating } = useLanguage();
  // Persist across language switches (refs survive effect re-runs).
  const cacheRef = useRef(new Map<string, string>());
  const recRef = useRef(new WeakMap<Text, Rec>());
  const pendingRef = useRef(new Set<string>());
  const flushTimer = useRef<number | null>(null);
  const applyTimer = useRef<number | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    const root = document.body;
    let observer: MutationObserver | null = null;

    function collect(): Text[] {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let n = walker.nextNode();
      while (n) {
        nodes.push(n as Text);
        n = walker.nextNode();
      }
      return nodes;
    }

    function apply() {
      const target = langRef.current;
      // Pause observation so our own edits don't re-trigger the observer.
      observer?.disconnect();
      for (const node of collect()) {
        if (shouldSkip(node)) continue;
        const raw = node.nodeValue ?? "";
        let rec = recRef.current.get(node);
        if (!rec || rec.applied !== raw) {
          // Fresh (React-authored) English content for this node.
          rec = { orig: raw, applied: raw };
          recRef.current.set(node, rec);
        }
        if (target === "eng") {
          if (node.nodeValue !== rec.orig) {
            node.nodeValue = rec.orig;
            rec.applied = rec.orig;
          }
          continue;
        }
        const key = `${target}\u0000${rec.orig}`;
        const hit = cacheRef.current.get(key);
        if (hit != null) {
          if (node.nodeValue !== hit) {
            node.nodeValue = hit;
            rec.applied = hit;
          }
        } else {
          pendingRef.current.add(rec.orig);
        }
      }
      observer?.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      if (pendingRef.current.size > 0) {
        scheduleFlush();
      } else {
        // Nothing left to fetch — the visible page is fully in-language.
        setTranslating(false);
      }
    }

    function scheduleFlush() {
      if (flushTimer.current != null) return;
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null;
        const target = langRef.current;
        const texts = Array.from(pendingRef.current);
        pendingRef.current.clear();
        if (target === "eng" || texts.length === 0) return;
        translateTexts(target, texts)
          .then(({ translations }) => {
            texts.forEach((t, i) =>
              cacheRef.current.set(`${target}\u0000${t}`, translations[i] ?? t),
            );
          })
          .catch(() => {
            // Cache identity on failure so we stay English and don't loop.
            texts.forEach((t) => {
              const k = `${target}\u0000${t}`;
              if (!cacheRef.current.has(k)) cacheRef.current.set(k, t);
            });
          })
          .finally(() => {
            // The first requested batch is now applied — the switch is
            // done as far as the user is concerned. Clear the loading
            // veil even if background mutations keep the queue busy, so
            // the overlay can never get stuck.
            setTranslating(false);
            apply();
          });
      }, 80);
    }

    function scheduleApply() {
      if (applyTimer.current != null) return;
      applyTimer.current = window.setTimeout(() => {
        applyTimer.current = null;
        apply();
      }, 50);
    }

    observer = new MutationObserver(() => scheduleApply());
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    apply();

    // Safety net: never let the loading veil hang, even if the bridge is
    // slow or unreachable. Clear it after a hard ceiling.
    const safety = window.setTimeout(() => setTranslating(false), 6000);

    return () => {
      observer?.disconnect();
      observer = null;
      window.clearTimeout(safety);
      if (flushTimer.current != null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      if (applyTimer.current != null) {
        window.clearTimeout(applyTimer.current);
        applyTimer.current = null;
      }
    };
  }, [lang]);

  return null;
}
