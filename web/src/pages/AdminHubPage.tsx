import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { readConfig, readNextElectionId, type ProtocolConfig } from "../soroban";
import { fetchMembers } from "../bridge";
import { useWallet } from "../wallet";
import { config as appConfig } from "../config";

// Small helper: format a token amount (i128 in smallest unit, 7 decimals
// for XLM) as a human XLM string. Not currency-specific in the contract,
// but the deployed instance uses native XLM so the label reflects that.
function xlm(amount: bigint): string {
  const s = amount.toString().padStart(8, "0");
  const whole = s.slice(0, s.length - 7);
  const frac = s.slice(s.length - 7).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// Admin hub. Deliberately spartan: it is the *first* thing an organiser
// sees when they enter /admin, so it lists the four things they can do
// (nothing more) and surfaces the on-chain fee schedule so they know
// what an election will cost before they click through.
export function AdminHubPage() {
  const wallet = useWallet();
  const [cfg, setCfg] = useState<ProtocolConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [bridgeCount, setBridgeCount] = useState<number | null>(null);
  const [nextElection, setNextElection] = useState<number | null>(null);

  useEffect(() => {
    readConfig()
      .then(setCfg)
      .catch((e) => setCfgErr(e instanceof Error ? e.message : String(e)));
    readNextElectionId()
      .then(setNextElection)
      .catch(() => setNextElection(null));
    fetchMembers()
      .then((m) => setBridgeCount(m.count))
      .catch(() => setBridgeCount(null));
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <p className="muted">Organise a community and run an election.</p>
        </div>
        <div className="wallet-chip">
          {wallet.address ? (
            <>
              <span className="pill ok">Connected</span>
              <span className="mono" title={wallet.address}>
                {wallet.address.slice(0, 6)}…{wallet.address.slice(-6)}
              </span>
            </>
          ) : (
            <button onClick={wallet.connect} disabled={wallet.connecting}>
              {wallet.connecting ? "Connecting..." : "Connect Freighter"}
            </button>
          )}
        </div>
      </div>

      {cfgErr && (
        <div className="error">
          Contract not initialized or unreachable: {cfgErr}
        </div>
      )}

      <div className="grid-2">
        <Link to="/admin/onboard" className="card action-card">
          <div className="action-title">Voters</div>
          <div className="action-sub">
            {bridgeCount === null
              ? "Enrol voters by phone number."
              : `${bridgeCount} voter${bridgeCount === 1 ? "" : "s"} enrolled.`}
          </div>
        </Link>

        <Link to="/admin/community" className="card action-card">
          <div className="action-title">Community</div>
          <div className="action-sub">
            Commit the member list to Soroban as a Merkle root.
          </div>
        </Link>

        <Link to="/admin/election" className="card action-card">
          <div className="action-title">Election</div>
          <div className="action-sub">
            {nextElection === null
              ? "Open a new ballot."
              : `${nextElection} election${nextElection === 1 ? "" : "s"} opened so far.`}
          </div>
        </Link>

        <Link to="/verify" className="card action-card">
          <div className="action-title">Verify</div>
          <div className="action-sub">
            Open the public verification page for any election ID.
          </div>
        </Link>
      </div>

      {cfg && (
        <div className="card">
          <h2>Cost to open an election</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Set by the protocol at deploy time and stored on-chain.
          </p>
          <div className="kv">
            <div>
              <div className="kv-key">Fee (paid to treasury)</div>
              <div className="kv-val">{xlm(cfg.fee)} XLM</div>
            </div>
            <div>
              <div className="kv-key">Minimum bond (locked, refunded on close)</div>
              <div className="kv-val">{xlm(cfg.bondMin)} XLM</div>
            </div>
            <div>
              <div className="kv-key">Token</div>
              <div className="kv-val mono">
                {cfg.token.slice(0, 8)}…{cfg.token.slice(-6)}
              </div>
            </div>
            <div>
              <div className="kv-key">Treasury</div>
              <div className="kv-val mono">
                {cfg.treasury.slice(0, 8)}…{cfg.treasury.slice(-6)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card muted-card">
        <div className="mono" style={{ fontSize: 12 }}>
          Contract: {appConfig.contractId}
        </div>
        <div className="mono" style={{ fontSize: 12 }}>
          Network: {appConfig.network} · Bridge: {appConfig.bridgeUrl}
        </div>
      </div>
    </>
  );
}
