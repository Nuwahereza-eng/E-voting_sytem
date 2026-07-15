import { useState } from "react";
import { Link } from "react-router-dom";
import { buildTree, toHex } from "../merkle";
import { readCommunity, registerCommunity, updateMembers } from "../soroban";
import { bindListCommunity, fetchLists, fetchMembers } from "../bridge";
import { useWallet } from "../wallet";
import { config } from "../config";
import { PageHeader } from "@/components/PageHeader";

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
      // Persist the mapping "active bridge list == community #id" so
      // the OTP voting flow can filter elections by community without
      // asking the voter which list they're on. Non-fatal on failure —
      // the organiser can rebind manually if this ever misses.
      try {
        const { activeId } = await fetchLists();
        if (activeId) await bindListCommunity(activeId, id);
      } catch {
        /* ignore — binding is best-effort */
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const memberCount = members().length;

  return (
    <>
      <PageHeader
        backTo="/organise"
        backLabel="Organise"
        title="Register community"
        subtitle="Commit the member list to Soroban. Only the Merkle root leaves your device."
      />

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
              <Link to="/election">Open an election →</Link>
            </div>
          )}
        </div>
      )}

      {wallet.address && (
        <SyncCommunityCard
          admin={wallet.address}
          sign={wallet.sign}
        />
      )}
    </>
  );
}

// -------- Sync existing community with the current bridge list --------
//
// When the organiser enrols new voters (or removes some) after having
// already registered a community on-chain, the on-chain merkle_root
// falls out of sync with the bridge's current member list. Any vote
// then fails with Error #7 (InvalidProof). This card lets the admin
// push the current list's root back on-chain via update_members().
function SyncCommunityCard({
  admin,
  sign,
}: {
  admin: string;
  sign: (xdr: string, opts: { networkPassphrase: string }) => Promise<{ signedTxXdr: string }>;
}) {
  const [cid, setCid] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<null | {
    onChainRoot: string;
    onChainCount: number;
    bridgeRoot: string;
    bridgeCount: number;
    match: boolean;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function doCheck() {
    setChecking(true);
    setErr(null);
    setMsg(null);
    setCheck(null);
    try {
      const id = Number(cid);
      if (!Number.isInteger(id) || id < 0) throw new Error("Enter a valid community ID");
      const [b, c] = await Promise.all([fetchMembers(), readCommunity(id)]);
      if (b.count === 0) throw new Error("The bridge has no voters in the active list.");
      const bridgeRoot = toHex((await buildTree(b.members)).root);
      setCheck({
        onChainRoot: c.merkleRoot,
        onChainCount: c.memberCount,
        bridgeRoot,
        bridgeCount: b.count,
        match: bridgeRoot.toLowerCase() === c.merkleRoot.toLowerCase(),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  async function doSync() {
    if (!check) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const id = Number(cid);
      const hash = await updateMembers(admin, id, check.bridgeRoot, check.bridgeCount, sign);
      setMsg(`Community #${id} synced. Tx: ${hash.slice(0, 12)}…`);
      // small delay so the RPC has a chance to index the new state
      await new Promise((r) => setTimeout(r, 1500));
      await doCheck();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Sync existing community</h2>
      <p className="muted">
        Use this after enrolling or removing voters. It pushes the current voter list's Merkle
        root back on-chain so proofs verify. Only the community admin can call this.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
        <div>
          <label>Community ID</label>
          <input
            value={cid}
            onChange={(e) => {
              setCid(e.target.value);
              setCheck(null);
              setMsg(null);
            }}
            placeholder="e.g. 0"
            style={{ width: 120 }}
          />
        </div>
        <button className="secondary" onClick={doCheck} disabled={checking || !cid.trim()}>
          {checking ? "Checking…" : "Check status"}
        </button>
      </div>

      {check && (
        <div style={{ marginTop: 12 }}>
          <div className={check.match ? "ok-box" : "warn-box"}>
            {check.match ? (
              <>Community #{cid} is already in sync ({check.bridgeCount} voters).</>
            ) : (
              <>
                Out of sync. On-chain has {check.onChainCount} voters, bridge active list has{" "}
                {check.bridgeCount}. Click <b>Sync now</b> to update.
              </>
            )}
          </div>
          <div style={{ marginTop: 8 }} className="mono small">
            on-chain: {check.onChainRoot}
            <br />
            bridge&nbsp;&nbsp;: {check.bridgeRoot}
          </div>
          {!check.match && (
            <div style={{ marginTop: 12 }}>
              <button onClick={doSync} disabled={busy}>
                {busy ? "Syncing…" : "Sync now (update_members)"}
              </button>
            </div>
          )}
        </div>
      )}
      {msg && <div className="ok-box" style={{ marginTop: 12 }}>{msg}</div>}
      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
    </div>
  );
}
