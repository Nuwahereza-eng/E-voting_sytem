import { Suspense, lazy } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { Loader2, ShieldCheck, Languages } from "lucide-react";
import { HomePage } from "./pages/HomePage";
import { Badge } from "@/components/ui/badge";
import { config as appConfig } from "./config";
import { LanguageProvider, useLanguage } from "./lang";

// Lazy-load every non-home page so the initial bundle stays small.
// HomePage is eager because it is the landing route.
const ParticipatePage = lazy(() => import("./pages/ParticipatePage").then((m) => ({ default: m.ParticipatePage })));
const OrganisePage = lazy(() => import("./pages/OrganisePage").then((m) => ({ default: m.OrganisePage })));
const OnboardPage = lazy(() => import("./pages/OnboardPage").then((m) => ({ default: m.OnboardPage })));
const CommunityPage = lazy(() => import("./pages/CommunityPage").then((m) => ({ default: m.CommunityPage })));
const ElectionPage = lazy(() => import("./pages/ElectionPage").then((m) => ({ default: m.ElectionPage })));
const MyStatusPage = lazy(() => import("./pages/MyStatusPage").then((m) => ({ default: m.MyStatusPage })));
const VotePage = lazy(() => import("./pages/VotePage").then((m) => ({ default: m.VotePage })));
const VerifyPage = lazy(() => import("./pages/VerifyPage").then((m) => ({ default: m.VerifyPage })));
const AttesterPage = lazy(() => import("./pages/AttesterPage").then((m) => ({ default: m.AttesterPage })));

// A brand-only top bar. Every navigational choice belongs on the home
// hub or on the current page — the app has no persistent side menu.
// The right-hand trust strip is always visible so the user never
// forgets the results are auditable on a public chain.
function Nav() {
  const network = (appConfig.network || "").toLowerCase();
  const isMainnet = network.includes("main") || network === "public";
  return (
    <nav className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur">
      <div className="mx-auto flex h-20 max-w-5xl items-center gap-3 px-5">
        <Link
          to="/"
          className="group inline-flex items-center hover:no-underline"
          aria-label="Sauti — home"
        >
          <img
            src="/logo-wordmark.svg"
            alt="Sauti"
            className="h-12 w-auto object-contain transition group-hover:scale-105 sm:h-14"
          />
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <LanguagePicker />
          <Link to="/verify" className="no-underline">
            <Badge
              variant="outline"
              className="gap-1 border-success/40 bg-success/10 text-success"
            >
              <ShieldCheck className="size-3" />
              <span className="hidden sm:inline">On-chain verified</span>
              <span className="sm:hidden">Verified</span>
            </Badge>
          </Link>
          <Badge
            variant="outline"
            className={
              "font-mono text-[10px] uppercase tracking-wider " +
              (isMainnet
                ? "border-primary/40 text-primary"
                : "border-yellow-500/40 bg-yellow-500/10 text-yellow-300")
            }
          >
            {network || "unknown"}
          </Badge>
        </div>
      </div>
    </nav>
  );
}

// A compact ballot-language selector shown in the nav. Its value is the
// global ballot language used by the Vote page. Placing it here makes it
// reachable from the landing page and every screen.
function LanguagePicker() {
  const { lang, setLang, languages, sunbirdConfigured } = useLanguage();
  return (
    <div
      className="flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1"
      title={
        sunbirdConfigured
          ? "Ballot language (translated by Sunbird AI)"
          : "Ballot language — Sunbird key not set, translations are placeholders"
      }
    >
      <Languages className="size-3.5 text-primary" aria-hidden />
      <label htmlFor="nav-lang" className="sr-only">
        Ballot language
      </label>
      <select
        id="nav-lang"
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        className="bg-transparent text-xs font-medium outline-none"
      >
        {languages.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function App() {
  return (
    <LanguageProvider>
      <Nav />
      <div className="mx-auto w-full max-w-5xl px-5 pb-24 pt-8">
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading…
            </div>
          }
        >
          <Routes>
          <Route path="/" element={<HomePage />} />

          {/* The two lanes — the only two answers to "why are you here?" */}
          <Route path="/participate" element={<ParticipatePage />} />
          <Route path="/organise" element={<OrganisePage />} />

          {/* Voter / public actions — reachable from /participate. */}
          <Route path="/vote" element={<VotePage />} />
          <Route path="/vote/:id" element={<VotePage />} />
          <Route path="/my-status" element={<MyStatusPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/verify/:id" element={<VerifyPage />} />

          {/* Organiser actions — reachable from /organise. */}
          <Route path="/voters" element={<OnboardPage />} />
          <Route path="/community" element={<CommunityPage />} />
          <Route path="/election" element={<ElectionPage />} />
          <Route path="/attesters" element={<AttesterPage />} />

          {/* Legacy /admin/* redirects so old bookmarks keep working. */}
          <Route path="/admin" element={<Navigate to="/organise" replace />} />
          <Route path="/admin/onboard" element={<Navigate to="/voters" replace />} />
          <Route path="/admin/community" element={<Navigate to="/community" replace />} />
          <Route path="/admin/election" element={<Navigate to="/election" replace />} />
          <Route path="/onboard" element={<Navigate to="/voters" replace />} />
        </Routes>
        </Suspense>
      </div>
    </LanguageProvider>
  );
}
