import { useState } from "react";
import { Link } from "react-router-dom";
import { fetchVoterStatus, linkPhone, type BridgeStatus } from "../bridge";

// A voter (or an admin acting on their behalf) types their phone number
// and gets back a "yes you're enrolled" or "no you're not" answer, with
// the assigned member index if enrolled. Uses the bridge — no wallet
// required.
export function MyStatusPage() {
  const [msisdn, setMsisdn] = useState("+256700000001");
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // "Link another phone" flow — bind an additional SIM to the voter we
  // just looked up. Both phones will vote as one on-chain identity.
  const [extraPhone, setExtraPhone] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [linkOk, setLinkOk] = useState<string | null>(null);
  // Only voters with 2+ SIMs care about link/aliases — hide behind toggles
  // so the "Am I enrolled?" answer stays the focus for everyone else.
  const [showLink, setShowLink] = useState(false);

  async function check() {
    setErr(null);
    setStatus(null);
    setLinkOk(null);
    setLinkErr(null);
    setBusy(true);
    try {
      const s = await fetchVoterStatus(msisdn);
      setStatus(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    if (!status?.registered || !extraPhone.trim()) return;
    setLinkErr(null);
    setLinkOk(null);
    setLinkBusy(true);
    try {
      const res = await linkPhone({
        msisdn: extraPhone.trim(),
        // Prefer voterRef if we know it (ties both phones to the person's
        // stable identity, not just a phone that could later be recycled).
        voterRef: status.voterRef,
        existingMsisdn: status.voterRef ? undefined : status.msisdn,
      });
      setLinkOk(
        `Linked ${res.msisdn} — this voter now has ${res.aliases.length} phone(s), one on-chain vote.`,
      );
      setExtraPhone("");
      // Refresh the status card so the newly-linked phone appears.
      const s = await fetchVoterStatus(status.msisdn);
      setStatus(s);
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLinkBusy(false);
    }
  }

  return (
    <>
      <h1>Am I enrolled?</h1>
      <p className="muted">
        Enter the phone number you gave your community organiser. If it's on
        the enrolled list you'll see your assigned member number — no wallet
        or app install required.
      </p>

      {err && <div className="error">{err}</div>}

      <div className="card">
        <label>Phone number (with country code)</label>
        <input
          value={msisdn}
          onChange={(e) => setMsisdn(e.target.value)}
          placeholder="+2567..."
        />
        <button onClick={check} disabled={busy || !msisdn.trim()} style={{ marginTop: 12 }}>
          {busy ? "Checking..." : "Check my status"}
        </button>
      </div>

      {status && status.registered && (
        <div className="card">
          <div className="verified-badge">
            <div className="verified-check">✓</div>
            <div>
              <div className="verified-title">You are enrolled</div>
              <div className="verified-sub">
                Phone: <span className="mono">{status.msisdn}</span>
              </div>
              <div className="verified-sub">
                Member number: <b>#{status.memberIndex}</b>
              </div>
              {status.voterRef && (
                <div className="verified-sub">
                  Voter ref: <span className="mono">{status.voterRef}</span>
                </div>
              )}
              <div className="verified-sub">
                Custodial wallet:{" "}
                <span className="mono" title={status.publicKey}>
                  {status.publicKey?.slice(0, 8)}…{status.publicKey?.slice(-6)}
                </span>
              </div>
            </div>
          </div>

          {status.aliases && status.aliases.length > 1 && (
            <div className="ok-box" style={{ fontSize: 13 }}>
              <b>{status.aliases.length} phones</b> are linked to this voter —
              you can dial from any of them and it still counts as one vote.
              <ul className="mono" style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {status.aliases.map((p) => (
                  <li key={p}>
                    {p}
                    {p === status.msisdn && (
                      <span className="muted"> (this phone)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            To vote, dial the USSD code your organiser gave you (e.g.{" "}
            <span className="mono">*384*12345#</span>), or send{" "}
            <span className="mono">VOTE &lt;electionId&gt; &lt;option&gt;</span> via SMS.
          </p>
          <p className="muted" style={{ fontSize: 13 }}>
            Prefer to vote from a wallet you control? See the{" "}
            <Link to="/vote">Vote page</Link> and connect Freighter with a
            wallet whose public key matches your enrolment above.
          </p>

          <hr style={{ margin: "18px 0", borderColor: "var(--border)" }} />
          <button
            className="secondary link-button"
            onClick={() => setShowLink((v) => !v)}
          >
            {showLink ? "Hide" : "Have a second SIM? Link it →"}
          </button>
          {showLink && (
            <>
              <h2 style={{ marginTop: 16 }}>Add another phone</h2>
              <p className="muted" style={{ fontSize: 13 }}>
                Both phones will share the same on-chain identity and
                combined they can still only vote once per election.
              </p>
              {linkErr && <div className="error">{linkErr}</div>}
              {linkOk && <div className="ok-box">{linkOk}</div>}
              <label>New phone number</label>
              <input
                value={extraPhone}
                onChange={(e) => setExtraPhone(e.target.value)}
                placeholder="+2567..."
              />
              <button
                onClick={link}
                disabled={linkBusy || !extraPhone.trim()}
                style={{ marginTop: 12 }}
              >
                {linkBusy ? "Linking..." : "Link this phone to me"}
              </button>
            </>
          )}
        </div>
      )}

      {status && !status.registered && (
        <div className="card">
          <div className="unverified-note">
            <b>Not enrolled.</b> The number <span className="mono">{status.msisdn}</span>{" "}
            is not on any community's voter list on this bridge.
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            If you think this is a mistake, ask your community organiser
            to add you.
          </p>
        </div>
      )}
    </>
  );
}
