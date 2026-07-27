import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fetchLanguages, type SupportedLanguage } from "./bridge";

// -----------------------------------------------------------------------
// Global ballot-language state.
//
// The picker lives in the top nav (so it's reachable from the landing
// page) and its value flows through to the Vote page, which translates
// the ballot question + option labels via Sunbird. We persist the choice
// in sessionStorage under the same key the Vote page historically used,
// so an in-progress vote keeps its language across a reload.
//
// The supported-language list is fetched from the bridge once; until it
// arrives we fall back to a static list that matches the bridge's
// SUPPORTED_LANGS so the picker is usable immediately.
// -----------------------------------------------------------------------

const STORAGE_KEY = "sauti.ballotLang";

export const FALLBACK_LANGS: SupportedLanguage[] = [
  { code: "eng", label: "English" },
  { code: "lug", label: "Luganda" },
  { code: "ach", label: "Acholi" },
  { code: "nyn", label: "Runyankole" },
  { code: "teo", label: "Ateso" },
  { code: "lgg", label: "Lugbara" },
  { code: "swa", label: "Swahili" },
];

interface LanguageContextValue {
  /** Currently selected ballot language ISO code (e.g. "lug"). */
  lang: string;
  setLang: (code: string) => void;
  /** Languages offered in the picker. */
  languages: SupportedLanguage[];
  /** Whether the bridge has Sunbird credentials (false = dev stub). */
  sunbirdConfigured: boolean;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readInitial(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? "eng";
  } catch {
    return "eng";
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<string>(readInitial);
  const [languages, setLanguages] = useState<SupportedLanguage[]>(FALLBACK_LANGS);
  const [sunbirdConfigured, setSunbirdConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchLanguages()
      .then((r) => {
        if (cancelled) return;
        if (r.languages?.length) setLanguages(r.languages);
        setSunbirdConfigured(r.sunbirdConfigured);
      })
      .catch(() => {
        /* keep fallback list; bridge may be offline */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLang = (code: string) => {
    setLangState(code);
    try {
      sessionStorage.setItem(STORAGE_KEY, code);
    } catch {
      /* ignore */
    }
  };

  const value = useMemo(
    () => ({ lang, setLang, languages, sunbirdConfigured }),
    [lang, languages, sunbirdConfigured],
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return ctx;
}
