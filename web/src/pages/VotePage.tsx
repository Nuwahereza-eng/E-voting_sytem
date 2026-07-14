import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { proofForMember } from "../merkle";
import { readElection, submitVote, type ElectionInfo } from "../soroban";
import { fetchMembers } from "../bridge";
import { useWallet } from "../wallet";
import { config } from "../config";

export function VotePage() {
  const [params] = useSearchParams();
  const wallet = useWallet();
  const [electionId, setElectionId] = useState<number | null>(() => {
    const v = params.get("id");
    return v === null ? null : Number(v);
  });
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [membersText, setMembersText] = useState(config.demoMembers.join("\n"));
  const [membersSource, setMembersSource] = useState<"demo" | "bridge" | "manual">(
    config.demoMembers.length > 0 ? "demo" : "manual",
  );
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function loadElection(id: number) {
    setErr(null);
    try {
      const info = await readElection(id);
      setElection(info);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setElection(null);
    }
  }

  // Try to auto-load the member list from the bridge on mount. This is
  // the common case: the admin onboarded voters through the bridge, so
  // it already has the canonical list. If the bridge is unreachable or
  // empty, we silently keep the demo/manual list.
  useEffect(() => {
    fetchMembers()
      .then((m) => {
        if (m.count > 0) {
          setMembersText(m.members.join("\n"));
          setMembersSource("bridge");
        }
      })
      .catch(() => {
        /* bridge offline — keep whatever we had */
      });
  }, []);

  useEffect(() => {
    if (electionId !== null && !Number.isNaN(electionId)) {
      loadElection(electionId);
    }
  }, [electionId]);

  async function castVote() {
    if (!wallet.address || electionId === null || chosen === null) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const members = membersText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const p = await proofForMember(members, wallet.address);
      if (!p) {
        throw new Error(
          "Your wallet address is not in the member list you pasted. Ask the community admin for the exact list they registered.",
        );
      }
      await submitVote(wallet.address, electionId, chosen, p.proof, wallet.sign);
      setOk("Vote submitted. Refreshing tally...");
      await loadElection(electionId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Vote</h1>

      {err && <div className="error">{err}</div>}
      {ok && <div className="ok-box">{ok}</div>}

      <div className="card">
        <label>Election ID</label>
        <input
          type="number"
          value={electionId ?? ""}
          onChange={(e) =>
            setElectionId(e.target.value === "" ? null : Number(e.target.value))
          }
        />
        <button
          className="secondary"
          style={{ marginTop: 10 }}
          onClick={() => electionId !== null && loadElection(electionId)}
          disabled={electionId === null}
        >
          Load election
        </button>
      </div>

      {election && (
        <div className="card">
          <h2>{election.question}</h2>
          <p className="muted">
            {election.closed || Date.now() / 1000 >= election.closesAt ? (
              <span className="pill err">closed</span>
            ) : (
              <span className="pill ok">open</span>
            )}
            <span className="pill">
              Closes {new Date(election.closesAt * 1000).toLocaleString()}
            </span>
            <span className="pill">Community #{election.communityId}</span>
          </p>

          {!wallet.address ? (
            <>
              <p className="muted">Connect a wallet to vote.</p>
              <button onClick={wallet.connect} disabled={wallet.connecting}>
                {wallet.connecting ? "Connecting..." : "Connect Freighter"}
              </button>
              {wallet.error && <div className="error">{wallet.error}</div>}
            </>
          ) : (
            <>
              <label>Member list (paste the same list the admin registered)</label>
              <textarea
                value={membersText}
                onChange={(e) => {
                  setMembersText(e.target.value);
                  setMembersSource("manual");
                }}
                placeholder="GABC...&#10;GDEF..."
              />
              <p className="muted" style={{ fontSize: 12 }}>
                {membersSource === "bridge" && (
                  <>Loaded from the community bridge automatically. </>
                )}
                {membersSource === "demo" && <>Pre-filled from demo config. </>}
                This is used locally to build your Merkle proof. It never leaves your browser
                except embedded in the proof itself.
              </p>

              <div style={{ marginTop: 16 }}>
                {election.options.map((opt, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        color: "var(--text)",
                        margin: 0,
                      }}
                    >
                      <input
                        type="radio"
                        name="option"
                        checked={chosen === i}
                        onChange={() => setChosen(i)}
                        style={{ width: "auto" }}
                      />
                      {opt}
                    </label>
                  </div>
                ))}
              </div>

              <button
                onClick={castVote}
                disabled={busy || chosen === null}
                style={{ marginTop: 12 }}
              >
                {busy ? "Submitting..." : "Cast vote"}
              </button>
            </>
          )}

          <hr style={{ margin: "20px 0", borderColor: "var(--border)" }} />
          <TallyBars election={election} />
        </div>
      )}
    </>
  );
}

export function TallyBars({ election }: { election: ElectionInfo }) {
  const max = Math.max(1, ...election.tallies);
  return (
    <div>
      <p className="muted" style={{ marginBottom: 12 }}>
        {election.totalVotes} total votes
      </p>
      {election.options.map((opt, i) => {
        const n = election.tallies[i] ?? 0;
        const pct = (n / max) * 100;
        return (
          <div key={i} className="tally-row">
            <div className="tally-label">{opt}</div>
            <div className="tally-bar">
              <div className="tally-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="tally-count">{n}</div>
          </div>
        );
      })}
    </div>
  );
}
