import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { buildTree, toHex } from "../merkle";
import type { CommunityInfo } from "../soroban";
import {
  readCommunity,
  readNextCommunityId,
  registerCommunity,
  updateMembers,
} from "../soroban";
import { bindListCommunity, fetchLists, fetchListMembers, fetchMembers } from "../bridge";
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
  // Communities this wallet already admins. Shown so the organiser can
  // reuse an existing one instead of accidentally minting a duplicate
  // (which is how a dozen identically-named "Kampala SACCO" records got
  // created before this list existed).
  const [mine, setMine] = useState<CommunityInfo[] | null>(null);

  useEffect(() => {
    if (!wallet.address) {
      setMine(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const next = await readNextCommunityId();
        const ids = Array.from({ length: next }, (_, i) => i);
        const infos = await Promise.all(
          ids.map((id) => readCommunity(id).catch(() => null)),
        );
        if (cancelled) return;
        setMine(
          infos.filter(
            (c): c is CommunityInfo => c !== null && c.admin === wallet.address,
          ),
        );
      } catch {
        if (!cancelled) setMine([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.address, communityId]);

  // Does the typed name collide with one this wallet already admins?
  const duplicate = (mine ?? []).find(
    (c) => c.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );

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
      // Bind the bridge voter list to this new community so the OTP
      // voting flow can filter elections by community. Crucially, bind
      // the list whose Merkle root MATCHES the one we just registered —
      // NOT whichever list happens to be active. Blindly binding the
      // active list used to hijack an unrelated list's binding (e.g.
      // registering "Kampala trader" would steal "utamu"'s binding),
      // which then broke voting with an "out of sync" error.
      try {
        const { activeId, lists } = await fetchLists();
        // Find the list whose current root equals the registered root.
        const withRoots = await Promise.all(
          lists.map(async (l) => {
            try {
              const lm = await fetchListMembers(l.id);
              return { id: l.id, root: lm.root, communityId: l.communityId };
            } catch {
              return { id: l.id, root: "", communityId: l.communityId };
            }
          }),
        );
        const match = withRoots.find(
          (l) => l.root.toLowerCase() === root.toLowerCase(),
        );
        // Prefer the root-matched list; otherwise only fall back to the
        // active list if it isn't already bound to a different community.
        const target =
          match?.id ??
          (() => {
            const active = withRoots.find((l) => l.id === activeId);
            return active && (active.communityId ?? null) === null
              ? active.id
              : undefined;
          })();
        if (target) await bindListCommunity(target, id);
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
          {mine && mine.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label>Your communities</label>
              <div className="muted small" style={{ marginBottom: 8 }}>
                Reuse one of these instead of creating a duplicate.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {mine.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      border: "1px solid var(--border, #333)",
                      borderRadius: 8,
                      padding: "8px 10px",
                    }}
                  >
                    <div>
                      <b>{c.name}</b>{" "}
                      <span className="muted small">
                        · ID {c.id} · {c.memberCount} members
                      </span>
                    </div>
                    <Link to="/election" className="secondary">
                      Open election →
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}

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
            {duplicate && (
              <div className="muted small" style={{ marginBottom: 8 }}>
                ⚠️ You already admin a community named “{duplicate.name}” (ID {duplicate.id}).
                Registering again creates a separate one. To change its member roll instead,
                use “Sync members” below.
              </div>
            )}
            <button
              onClick={doRegister}
              disabled={busy || memberCount === 0}
            >
              {busy
                ? "Registering..."
                : duplicate
                  ? "Register anyway (new community)"
                  : "Register community on-chain"}
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
    listId: string;
    listName: string;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The organiser's own communities, so they can look up the ID to
  // sync without having to remember the number.
  const [mine, setMine] = useState<CommunityInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await readNextCommunityId();
        const ids = Array.from({ length: next }, (_, i) => i);
        const infos = await Promise.all(
          ids.map((id) => readCommunity(id).catch(() => null)),
        );
        if (cancelled) return;
        setMine(
          infos.filter(
            (c): c is CommunityInfo => c !== null && c.admin === admin,
          ),
        );
      } catch {
        if (!cancelled) setMine([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [admin]);

  async function doCheck() {
    setChecking(true);
    setErr(null);
    setMsg(null);
    setCheck(null);
    try {
      const id = Number(cid);
      if (!Number.isInteger(id) || id < 0) throw new Error("Enter a valid community ID");
      // Find the voter list BOUND to this community — never blindly hash
      // whatever list happens to be active, or we'd push the wrong roll
      // on-chain. Fall back to the active list only if no list is bound
      // (legacy single-list setups), and warn about it.
      const [c, listsResp] = await Promise.all([readCommunity(id), fetchLists()]);
      const bound = listsResp.lists.find((l) => l.communityId === id);
      let listId: string;
      let listName: string;
      let members: string[];
      if (bound) {
        listId = bound.id;
        listName = bound.name;
        const lm = await fetchListMembers(bound.id);
        members = lm.members;
      } else {
        // No binding — use the active list but make it obvious.
        const b = await fetchMembers();
        listId = b.activeList?.id ?? "active";
        listName = `${b.activeList?.name ?? "active list"} (not bound to #${id})`;
        members = b.members;
      }
      if (members.length === 0) {
        throw new Error(`The voter list "${listName}" has no members.`);
      }
      const bridgeRoot = toHex((await buildTree(members)).root);
      setCheck({
        onChainRoot: c.merkleRoot,
        onChainCount: c.memberCount,
        bridgeRoot,
        bridgeCount: members.length,
        match: bridgeRoot.toLowerCase() === c.merkleRoot.toLowerCase(),
        listId,
        listName,
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
      {mine !== null && (
        <div style={{ marginBottom: 12 }}>
          {mine.length === 0 ? (
            <p className="muted small">
              This wallet doesn't admin any registered communities yet.
            </p>
          ) : (
            <>
              <label>Your communities</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {mine.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setCid(String(c.id));
                      setCheck(null);
                      setMsg(null);
                    }}
                    title={`${c.memberCount} members on-chain`}
                  >
                    #{c.id} · {c.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
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
              <>
                Community #{cid} is already in sync with list &ldquo;{check.listName}&rdquo; (
                {check.bridgeCount} voters).
              </>
            ) : (
              <>
                Out of sync. On-chain has {check.onChainCount} voters; list &ldquo;
                {check.listName}&rdquo; has {check.bridgeCount}. Click <b>Sync now</b> to push list
                &ldquo;{check.listName}&rdquo; on-chain.
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
