import { useState } from "react";
import { Link } from "react-router-dom";
import { buildTree, toHex } from "../merkle";
import { registerCommunity } from "../soroban";
import { fetchMembers } from "../bridge";
import { useWallet } from "../wallet";
import { config } from "../config";

// Community registration. Extracted from the old monolithic AdminPage
// so an organiser can focus on one thing at a time. The member list is
// hashed client-side into a Merkle root; only the root and the count
// go on-chain, so the plaintext roll is never leaked to the ledger.
export function CommunityPage() {
  const wallet = useWallet();
  const [name, setName] = useState("Kampala SACCO");
  const [membersText, setMembersText] = useState(config.demoMembers.join("\n"));
  const [showMembers, setShowMembers] = useState(false);
  const [computedRoot, setComputedRoot] = useState<string>("");
  const [communityId, setCommunityId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function members(): string[] {
    return membersText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function loadFromBridge() {
    setErr(null);
    try {
      const b = await fetchMembers();
      if (b.count === 0) {
        setErr(
          "The bridge has no voters yet. Enrol some voters first on the Voters page.",
        );
        return;
      }
      setMembersText(b.members.join("\n"));
      setComputedRoot(b.root);
    } catch (e) {
      setErr(
        `Could not load from bridge (${config.bridgeUrl}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  async function computeRoot() {
    setErr(null);
    try {
      const m = members();
      if (m.length === 0) throw new Error("Add at least one member key.");
      const tree = await buildTree(m);
      setComputedRoot(toHex(tree.root));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function doRegister() {
    if (!wallet.address) return;
    setBusy(true);
    setErr(null);
    try {
      const m = members();
      const tree = await buildTree(m);
      const root = toHex(tree.root);
      setComputedRoot(root);
      const id = await registerCommunity(
        wallet.address,
        name,
        root,
        m.length,
        wallet.sign,
      );
      setCommunityId(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const memberCount = members().length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Register community</h1>
          <p className="muted">
            Commit the member list to Soroban. The raw list never leaves
            your device — only the Merkle root does.
          </p>
        </div>
        <Link to="/admin" className="back-link">← Back</Link>
      </div>

      {err && <div className="error">{err}</div>}

      {!wallet.address ? (
        <div className="card">
          <h2>Connect an admin wallet</h2>
          <p className="muted">Freighter signs the register transaction.</p>
          <button onClick={wallet.connect} disabled={wallet.connecting}>
            {wallet.connecting ? "Connecting..." : "Connect Freighter"}
          </button>
          {wallet.error && <div className="error">{wallet.error}</div>}
        </div>
      ) : (
        <div className="card">
          <label>Community name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />

          <div className="row">
            <div>
              <label>Members</label>
              <div className="pill">
                {memberCount} loaded
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="secondary" onClick={loadFromBridge}>
                Load from bridge
              </button>
              <button className="secondary" onClick={computeRoot} disabled={memberCount === 0}>
                Preview root
              </button>
              <button
                className="secondary"
                onClick={() => setShowMembers((v) => !v)}
              >
                {showMembers ? "Hide list" : "Show list"}
              </button>
            </div>
          </div>

          {showMembers && (
            <textarea
              value={membersText}
              onChange={(e) => setMembersText(e.target.value)}
              placeholder="GABC...&#10;GDEF...&#10;GHIJ..."
              rows={8}
              style={{ marginTop: 8 }}
            />
          )}

          {computedRoot && (
            <>
              <label style={{ marginTop: 12 }}>Merkle root</label>
              <div className="mono small">{computedRoot}</div>
            </>
          )}

          <div style={{ marginTop: 16 }}>
            <button
              onClick={doRegister}
              disabled={busy || memberCount === 0}
            >
              {busy ? "Registering..." : "Register community on-chain"}
            </button>
          </div>

          {communityId !== null && (
            <div className="ok-box">
              Community registered. ID = <b>{communityId}</b>.{" "}
              <Link to="/admin/election">Open an election →</Link>
            </div>
          )}
        </div>
      )}
    </>
  );
}
