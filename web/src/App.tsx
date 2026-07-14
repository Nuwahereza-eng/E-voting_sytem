import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { AdminHubPage } from "./pages/AdminHubPage";
import { OnboardPage } from "./pages/OnboardPage";
import { CommunityPage } from "./pages/CommunityPage";
import { ElectionPage } from "./pages/ElectionPage";
import { MyStatusPage } from "./pages/MyStatusPage";
import { VotePage } from "./pages/VotePage";
import { VerifyPage } from "./pages/VerifyPage";

// Two nav bars, one context per user role. The admin bar appears only
// under /admin/*; the voter bar appears everywhere else. Keeping the
// two sets of URLs separate makes it obvious which surface a user is
// looking at, and lets us keep the admin flow (which requires wallet
// signing, bond payments, etc.) out of the voter's face.
function Nav() {
  const { pathname } = useLocation();
  const isAdmin = pathname.startsWith("/admin");

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? "active" : "";

  return (
    <nav className="nav">
      <NavLink to="/" className="brand" end>
        Sauti<span className="dot">.</span>
      </NavLink>
      <div className="nav-links">
        {isAdmin ? (
          <>
            <NavLink to="/admin" end className={linkClass}>
              Overview
            </NavLink>
            <NavLink to="/admin/onboard" className={linkClass}>
              Voters
            </NavLink>
            <NavLink to="/admin/community" className={linkClass}>
              Community
            </NavLink>
            <NavLink to="/admin/election" className={linkClass}>
              Election
            </NavLink>
            <span className="nav-sep" aria-hidden />
            <NavLink to="/" className="nav-role">
              Exit admin
            </NavLink>
          </>
        ) : (
          <>
            <NavLink to="/vote" className={linkClass}>
              Vote
            </NavLink>
            <NavLink to="/my-status" className={linkClass}>
              My status
            </NavLink>
            <NavLink to="/verify" className={linkClass}>
              Verify
            </NavLink>
            <span className="nav-sep" aria-hidden />
            <NavLink to="/admin" className="nav-role">
              Admin →
            </NavLink>
          </>
        )}
      </div>
    </nav>
  );
}

export function App() {
  return (
    <>
      <Nav />
      <div className="container">
        <Routes>
          <Route path="/" element={<HomePage />} />

          {/* Voter surfaces */}
          <Route path="/vote" element={<VotePage />} />
          <Route path="/vote/:id" element={<VotePage />} />
          <Route path="/my-status" element={<MyStatusPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/verify/:id" element={<VerifyPage />} />

          {/* Admin surfaces */}
          <Route path="/admin" element={<AdminHubPage />} />
          <Route path="/admin/onboard" element={<OnboardPage />} />
          <Route path="/admin/community" element={<CommunityPage />} />
          <Route path="/admin/election" element={<ElectionPage />} />
        </Routes>
      </div>
    </>
  );
}
