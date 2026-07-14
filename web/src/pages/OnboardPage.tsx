import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { bulkProvision, fetchMembers, type BridgeVoter } from "../bridge";
import { config } from "../config";

// A voter row the organiser is editing. Only `msisdn` is required.
//   `name`     — local convenience label; not stored on the bridge.
//   `voterRef` — a stable identity string (national ID, student number,
//                SACCO membership number, ...). Two rows with the same
//                voterRef become aliases: one keypair, one on-chain
//                vote, but both phones can dial in.
interface Row {
  name: string;
  msisdn: string;
  voterRef: string;
}

const BLANK_ROW: Row = { name: "", msisdn: "", voterRef: "" };

export function OnboardPage() {
  const [rows, setRows] = useState<Row[]>([
    { name: "Alice", msisdn: "+256700000001", voterRef: "STU-2026-001" },
    { name: "Bob", msisdn: "+256700000002", voterRef: "STU-2026-002" },
    { name: "Carol", msisdn: "+256700000003", voterRef: "STU-2026-003" },
  ]);
  const [mode, setMode] = useState<"replace" | "append">("replace");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    root: string;
    members: string[];
    assignments: BridgeVoter[];
  } | null>(null);
  const [current, setCurrent] = useState<{ count: number; root: string } | null>(null);
  // Progressive-disclosure toggles. Both start collapsed — organisers
  // rarely need to see the raw bridge status or the per-phone assignment
  // table unless something looks wrong, so we hide them by default.
  const [showBridge, setShowBridge] = useState(false);
  const [showAssignments, setShowAssignments] = useState(false);

  useEffect(() => {
    fetchMembers()
      .then((m) => setCurrent({ count: m.count, root: m.root }))
      .catch((e) =>
        setErr(
          `Cannot reach bridge at ${config.bridgeUrl} — start it with \`cd ussd-bridge && npm start\`. (${
            e instanceof Error ? e.message : String(e)
          })`,
        ),
      );
  }, []);

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { ...BLANK_ROW }]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, j) => j !== i));
  }

  // Parse a pasted CSV / TSV / newline block. Accepted per-row formats:
  //   "+2567..."                        (phone only)
  //   "Name, +2567..."                  (name + phone)
  //   "Name, +2567..., STU-2026-001"    (name + phone + voterRef)
  //   "+2567..., STU-2026-001"          (phone + voterRef)
  function pasteCsv(text: string) {
    const parsed = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): Row => {
        const parts = line.split(/[,\t;]/).map((s) => s.trim());
        if (parts.length === 1) {
          return { name: "", msisdn: parts[0], voterRef: "" };
        }
        // Find whichever field looks like a phone (starts with `+` or a digit).
        const phoneIdx = parts.findIndex((p) => /^[+\d]/.test(p));
        const msisdn = phoneIdx >= 0 ? parts[phoneIdx] : "";
        const rest = parts.filter((_, i) => i !== phoneIdx);
        const [name = "", voterRef = ""] = rest;
        return { name, msisdn, voterRef };
      });
    if (parsed.length > 0) setRows(parsed);
  }

  async function provision() {
    setErr(null);
    setResult(null);
    const valid = rows
      .map((r) => ({
        name: r.name.trim(),
        msisdn: r.msisdn.trim(),
        voterRef: r.voterRef.trim(),
      }))
      .filter((r) => r.msisdn.length > 0);
    if (valid.length === 0) {
      setErr("Add at least one voter with a phone number.");
      return;
    }
    const seen = new Set<string>();
    for (const r of valid) {
      if (seen.has(r.msisdn)) {
        setErr(`Duplicate phone number: ${r.msisdn}`);
        return;
      }
      seen.add(r.msisdn);
    }
    setBusy(true);
    try {
      const res = await bulkProvision(valid, mode);
      setResult({ root: res.root, members: res.members, assignments: res.assignments });
      setCurrent({ count: res.total, root: res.root });
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
          <h1>Enrol voters</h1>
          <p className="muted">
            Add voters by phone. The bridge generates a custodial Stellar
            keypair per voter so they can vote via USSD or SMS — no wallet
            required.
          </p>
        </div>
        <Link to="/admin" className="back-link">← Back</Link>
      </div>

      {err && <div className="error">{err}</div>}

      {/* Bridge status is a tiny inline chip by default. The full details
          (URL + Merkle root) are collapsed behind a toggle. */}
      <div className="card status-card">
        <div className="status-row">
          {current ? (
            <>
              <span className="pill ok">Bridge online</span>
              <span className="muted">
                {current.count} voter{current.count === 1 ? "" : "s"} enrolled
              </span>
            </>
          ) : (
            <span className="muted">Checking bridge at {config.bridgeUrl}…</span>
          )}
          {current && (
            <button
              className="secondary link-button"
              onClick={() => setShowBridge((v) => !v)}
              style={{ marginLeft: "auto" }}
            >
              {showBridge ? "Hide details" : "Show details"}
            </button>
          )}
        </div>
        {showBridge && current && (
          <div style={{ marginTop: 10 }}>
            <div className="muted small">Bridge URL</div>
            <div className="mono small">{config.bridgeUrl}</div>
            <div className="muted small" style={{ marginTop: 6 }}>
              Merkle root
            </div>
            <div className="mono small">{current.root || "(no members yet)"}</div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>1. Voter list</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          One row per phone. If a voter has more than one number, put each
          on its own row and use the <b>same voter ref</b> on both — the
          bridge binds both phones to a single keypair so they vote once.
        </p>

        <details style={{ margin: "8px 0 12px" }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Or paste a CSV block
          </summary>
          <textarea
            placeholder={"Alice,+256700000001,STU-2026-001\nBob,+256700000002,STU-2026-002"}
            onBlur={(e) => pasteCsv(e.target.value)}
            style={{ marginTop: 8 }}
          />
        </details>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Name (optional)</th>
              <th style={th}>Phone (E.164)</th>
              <th style={th}>Voter ref (recommended)</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={td} className="muted">
                  {i + 1}
                </td>
                <td style={td}>
                  <input
                    value={r.name}
                    onChange={(e) => updateRow(i, { name: e.target.value })}
                    placeholder="Alice"
                  />
                </td>
                <td style={td}>
                  <input
                    value={r.msisdn}
                    onChange={(e) => updateRow(i, { msisdn: e.target.value })}
                    placeholder="+2567..."
                  />
                </td>
                <td style={td}>
                  <input
                    value={r.voterRef}
                    onChange={(e) => updateRow(i, { voterRef: e.target.value })}
                    placeholder="STU-2026-001"
                  />
                </td>
                <td style={td}>
                  <button
                    className="secondary"
                    onClick={() => removeRow(i)}
                    style={{ padding: "6px 10px" }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="secondary" onClick={addRow} style={{ marginTop: 10 }}>
          + Add voter
        </button>
      </div>

      <div className="card">
        <h2>2. Provision</h2>
        <label>Mode</label>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <label style={rowLabel}>
            <input
              type="radio"
              checked={mode === "replace"}
              onChange={() => setMode("replace")}
              style={{ width: "auto" }}
            />
            Replace — start a fresh community
          </label>
          <label style={rowLabel}>
            <input
              type="radio"
              checked={mode === "append"}
              onChange={() => setMode("append")}
              style={{ width: "auto" }}
            />
            Append — add to existing list
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <button onClick={provision} disabled={busy || !current}>
            {busy ? "Provisioning..." : `Provision ${rows.filter((r) => r.msisdn.trim()).length} voter(s)`}
          </button>
        </div>

        {result && (
          <div className="ok-box" style={{ marginTop: 16 }}>
            <div>
              <b>{result.assignments.length}</b> phone binding(s) processed —{" "}
              <b>{result.members.length}</b> unique voter(s) in the community.
              {result.assignments.filter((a) => a.alias).length > 0 && (
                <>
                  {" "}
                  <span className="muted">
                    ({result.assignments.filter((a) => a.alias).length} were
                    additional phones for an already-listed voter.)
                  </span>
                </>
              )}
            </div>
            <div style={{ marginTop: 8 }}>
              Merkle root: <span className="mono">{result.root}</span>
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="card">
          <div className="row" style={{ alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>3. Confirm assignments</h2>
            <button
              className="secondary link-button"
              onClick={() => setShowAssignments((v) => !v)}
              style={{ marginLeft: "auto" }}
            >
              {showAssignments ? "Hide table" : "Show table"}
            </button>
          </div>
          {showAssignments && (
            <>
              <p className="muted" style={{ fontSize: 13 }}>
                Rows tagged <span className="pill">alias</span> are additional
                phones bound to the same voter (same voter ref) — they share
                one keypair and vote once.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Member #</th>
                    <th style={th}>Name</th>
                    <th style={th}>Phone</th>
                    <th style={th}>Voter ref</th>
                    <th style={th}>Public key</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {result.assignments.map((a) => (
                    <tr key={a.msisdn}>
                      <td style={td}>{a.memberIndex}</td>
                      <td style={td}>{a.name || <span className="muted">—</span>}</td>
                      <td style={td} className="mono">
                        {a.msisdn}
                      </td>
                      <td style={td} className="mono">
                        {a.voterRef || <span className="muted">—</span>}
                      </td>
                      <td style={td} className="mono" title={a.publicKey}>
                        {a.publicKey.slice(0, 6)}…{a.publicKey.slice(-6)}
                      </td>
                      <td style={td}>
                        {a.alias && <span className="pill">alias</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {result && (
        <div className="card">
          <h2>Next: register on-chain</h2>
          <p className="muted">
            The list lives on the bridge. To make it verifiable, commit the
            Merkle root to Soroban. The Community page pulls this list for
            you.
          </p>
          <Link to="/admin/community">
            <button>Register community →</button>
          </Link>
        </div>
      )}
    </>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 6px",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted)",
  fontWeight: 500,
  fontSize: 13,
};
const td: React.CSSProperties = {
  padding: "6px 6px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
};
const rowLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: "var(--text)",
  margin: 0,
  fontSize: 14,
};
