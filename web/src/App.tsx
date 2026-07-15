import { Link, Navigate, Route, Routes } from "react-router-dom";
import { Vote as VoteIcon } from "lucide-react";
import { HomePage } from "./pages/HomePage";
import { ParticipatePage } from "./pages/ParticipatePage";
import { OrganisePage } from "./pages/OrganisePage";
import { OnboardPage } from "./pages/OnboardPage";
import { CommunityPage } from "./pages/CommunityPage";
import { ElectionPage } from "./pages/ElectionPage";
import { MyStatusPage } from "./pages/MyStatusPage";
import { VotePage } from "./pages/VotePage";
import { VerifyPage } from "./pages/VerifyPage";

// A brand-only top bar. Every navigational choice belongs on the home
// hub or on the current page — the app has no persistent side menu.
function Nav() {
  return (
    <nav className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center px-5">
        <Link
          to="/"
          className="group inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground hover:no-underline"
        >
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30 transition group-hover:bg-primary/25">
            <VoteIcon className="size-4" />
          </span>
          <span>
            Sauti<span className="text-primary">.</span>
          </span>
        </Link>
      </div>
    </nav>
  );
}

export function App() {
  return (
    <>
      <Nav />
      <div className="mx-auto w-full max-w-5xl px-5 pb-24 pt-8">
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

          {/* Legacy /admin/* redirects so old bookmarks keep working. */}
          <Route path="/admin" element={<Navigate to="/organise" replace />} />
          <Route path="/admin/onboard" element={<Navigate to="/voters" replace />} />
          <Route path="/admin/community" element={<Navigate to="/community" replace />} />
          <Route path="/admin/election" element={<Navigate to="/election" replace />} />
          <Route path="/onboard" element={<Navigate to="/voters" replace />} />
        </Routes>
      </div>
    </>
  );
}
