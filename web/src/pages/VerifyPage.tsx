import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { readElection, type ElectionInfo } from "../soroban";
import { TallyBars } from "./VotePage";
import { lookupAttestation, type Attestation } from "../registry";
import { config } from "../config";

/**
 * Public verification page. No wallet, no auth. Polls the contract
 * every 4 seconds so a projector on stage shows the tally moving.
 */
export function VerifyPage() {
  const { id: pathId } = useParams();
  const [electionId, setElectionId] = useState<number | null>(
    pathId !== undefined ? Number(pathId) : null,
  );
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [attestation, setAttestation] = useState<Attestation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timer = useRef<number | null>(null);

  async function reload(id: number) {
    try {
      const info = await readElection(id);
      setElection(info);
      setErr(null);
      setLastUpdated(new Date());
      // Attestation only depends on (contract, community_id); look it
      // up once per (id) change, not every 4s.
      if (!attestation || attestation === null) {
        const a = await lookupAttestation(
          config.contractId,
          info.communityId,
        ).catch(() => null);
        setAttestation(a);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (electionId === null || Number.isNaN(electionId)) return;
    setAttestation(null); // reset when switching elections
    reload(electionId);
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => reload(electionId), 4000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [electionId]);

  return (
    <>
      <h1>Public verification</h1>
      <p className="muted">
        Anyone can look up any election ID here — no wallet, no login. The
        numbers below come straight from the Soroban contract state.
      </p>

      <div className="card">
        <label>Election ID</label>
        <input
          type="number"
          value={electionId ?? ""}
          onChange={(e) =>
            setElectionId(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      </div>

      {err && <div className="error">{err}</div>}

      {election && (
        <div className="card">
          <h2>{election.question}</h2>
          {attestation ? (
            <div className="verified-badge">
              <span className="verified-check">✓</span>
              <div>
                <div className="verified-title">
                  Verified organiser: {attestation.orgName}
                </div>
                <div className="verified-sub">
                  Attested on {new Date(attestation.attestedAt * 1000).toLocaleDateString()}. Cross-check the announcement:{" "}
                  <a href={attestation.metadataUrl} target="_blank" rel="noreferrer">
                    {attestation.metadataUrl}
                  </a>
                </div>
                <div className="verified-sub" style={{ marginTop: 4 }}>
                  Expected admin address:{" "}
                  <span className="mono" style={{ fontSize: 11 }}>
                    {attestation.admin}
                  </span>
                </div>
              </div>
            </div>
          ) : config.registryId ? (
            <div className="unverified-note">
              <b>Not in the trust registry.</b> This election is
              cryptographically consistent, but the organiser has not been
              attested by the Sauti curator. Verify their identity through
              off-chain channels before trusting the result.
            </div>
          ) : null}
          <p className="muted">
            <span className="pill">Community #{election.communityId}</span>
            {election.closed || Date.now() / 1000 >= election.closesAt ? (
              <span className="pill err">closed</span>
            ) : (
              <span className="pill ok">live</span>
            )}
            <span className="pill">
              Closes {new Date(election.closesAt * 1000).toLocaleString()}
            </span>
            {lastUpdated && (
              <span className="pill">
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </p>
          <TallyBars election={election} />
        </div>
      )}
    </>
  );
}
