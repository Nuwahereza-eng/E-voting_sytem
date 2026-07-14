import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  closeElection,
  createElection,
  readConfig,
  readElection,
  type ProtocolConfig,
} from "../soroban";
import { useWallet } from "../wallet";

function xlmToStroops(xlm: string): bigint {
  // 1 XLM = 10^7 stroops. Accept plain decimals like "10", "10.5", "0.1".
  const trimmed = xlm.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Bond must be a positive number.");
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded);
}

function stroopsToXlm(s: bigint): string {
  const str = s.toString().padStart(8, "0");
  const w = str.slice(0, str.length - 7);
  const f = str.slice(str.length - 7).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

// Election page. Two flows share the page because both revolve around a
// single election ID: opening a new one (costs fee + locks bond) and
// closing an existing one (returns bond to admin). Split from the old
// AdminPage so organisers see only what they came for.
export function ElectionPage() {
  const wallet = useWallet();
  const [cfg, setCfg] = useState<ProtocolConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);

  // Open form
  const [communityId, setCommunityId] = useState<number | null>(null);
  const [question, setQuestion] = useState("Who leads the SACCO in 2026?");
  const [optionsText, setOptionsText] = useState("Alice\nBob");
  const [closesInMinutes, setClosesInMinutes] = useState(60);
  const [bondXlm, setBondXlm] = useState("10");
  const [electionId, setElectionId] = useState<number | null>(null);

  // Close form
  const [closeId, setCloseId] = useState("");
  const [closeResult, setCloseResult] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    readConfig()
      .then((c) => {
        setCfg(c);
        // Default the bond input to the on-chain minimum so users can't
        // accidentally submit a rejected value on first click.
        setBondXlm(stroopsToXlm(c.bondMin));
      })
      .catch((e) => setCfgErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function doOpen() {
    if (!wallet.address || communityId === null || !cfg) return;
    setBusy(true);
    setErr(null);
    try {
      const opts = optionsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.length < 2) throw new Error("Need at least 2 options.");
      const bond = xlmToStroops(bondXlm);
      if (bond < cfg.bondMin) {
        throw new Error(
          `Bond ${stroopsToXlm(bond)} XLM is below the minimum ${stroopsToXlm(cfg.bondMin)} XLM.`,
        );
      }
      const closesAt = Math.floor(Date.now() / 1000) + closesInMinutes * 60;
      const id = await createElection(
        wallet.address,
        communityId,
        question,
        opts,
        closesAt,
        bond,
        wallet.sign,
      );
      setElectionId(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doClose() {
    if (!wallet.address) return;
    const id = Number(closeId);
    if (!Number.isFinite(id) || id < 0) {
      setErr("Enter a valid election ID.");
      return;
    }
    setBusy(true);
    setErr(null);
    setCloseResult(null);
    try {
      const before = await readElection(id).catch(() => null);
      await closeElection(wallet.address, id, wallet.sign);
      const after = await readElection(id).catch(() => null);
      const returned = after?.bondReturned && !before?.bondReturned;
      setCloseResult(
        returned
          ? `Election ${id} closed. Bond of ${stroopsToXlm(after?.bond ?? 0n)} XLM refunded to admin.`
          : `Election ${id} closed.`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Election</h1>
          <p className="muted">
            Open a new ballot or close an existing one to refund its bond.
          </p>
        </div>
        <Link to="/admin" className="back-link">← Back</Link>
      </div>

      {cfgErr && <div className="error">Cannot read config: {cfgErr}</div>}
      {err && <div className="error">{err}</div>}

      {!wallet.address && (
        <div className="card">
          <h2>Connect an admin wallet</h2>
          <button onClick={wallet.connect} disabled={wallet.connecting}>
            {wallet.connecting ? "Connecting..." : "Connect Freighter"}
          </button>
          {wallet.error && <div className="error">{wallet.error}</div>}
        </div>
      )}

      <div className="card">
        <h2>Open a new election</h2>
        {cfg && (
          <p className="muted" style={{ fontSize: 13 }}>
            This will charge <b>{stroopsToXlm(cfg.fee)} XLM</b> (non-refundable)
            and lock a bond of at least <b>{stroopsToXlm(cfg.bondMin)} XLM</b>.
            The bond is returned when the election is closed.
          </p>
        )}

        <label>Community ID</label>
        <input
          type="number"
          value={communityId ?? ""}
          onChange={(e) =>
            setCommunityId(e.target.value === "" ? null : Number(e.target.value))
          }
          placeholder="e.g. 0"
        />

        <label>Question</label>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} />

        <label>Options (one per line)</label>
        <textarea
          value={optionsText}
          onChange={(e) => setOptionsText(e.target.value)}
          rows={4}
        />

        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Closes in (minutes)</label>
            <input
              type="number"
              value={closesInMinutes}
              onChange={(e) => setClosesInMinutes(Number(e.target.value))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Bond (XLM)</label>
            <input
              type="text"
              value={bondXlm}
              onChange={(e) => setBondXlm(e.target.value)}
              placeholder={cfg ? stroopsToXlm(cfg.bondMin) : "10"}
            />
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <button
            onClick={doOpen}
            disabled={busy || !wallet.address || communityId === null || !cfg}
          >
            {busy ? "Opening..." : "Pay fee, lock bond, open election"}
          </button>
        </div>

        {electionId !== null && (
          <div className="ok-box">
            Election opened. ID = <b>{electionId}</b>.{" "}
            <Link to={`/vote/${electionId}`}>Vote link</Link> ·{" "}
            <Link to={`/verify/${electionId}`}>Verify link</Link>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Close an election</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          After the deadline anyone can close an election and trigger the
          bond refund to the community admin. Before the deadline only
          the community admin can close it (early).
        </p>
        <label>Election ID</label>
        <input
          type="number"
          value={closeId}
          onChange={(e) => setCloseId(e.target.value)}
          placeholder="e.g. 0"
        />
        <div style={{ marginTop: 12 }}>
          <button
            onClick={doClose}
            disabled={busy || !wallet.address || closeId === ""}
          >
            {busy ? "Closing..." : "Close & refund bond"}
          </button>
        </div>
        {closeResult && <div className="ok-box">{closeResult}</div>}
      </div>
    </>
  );
}
