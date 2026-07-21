import { Suspense, lazy } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { Loader2, ShieldCheck } from "lucide-react";
import { HomePage } from "./pages/HomePage";
import { Badge } from "@/components/ui/badge";
import { config as appConfig } from "./config";

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
            src="/logo.jpg"
            alt="Sauti"
            className="h-16 w-16 rounded-2xl object-contain transition group-hover:scale-105 sm:h-20 sm:w-20"
          />
        </Link>
        <div className="ml-auto flex items-center gap-2">
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

export function App() {
  return (
    <>
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
    </>
  );
}
