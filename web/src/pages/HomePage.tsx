import { Link } from "react-router-dom";
import { useState } from "react";

// Landing page. The single job here is to steer the visitor into one of
// two lanes: "I want to vote" or "I want to organise an election".
// Everything else (how the crypto works, what the fee is, the tech
// stack) is deliberately behind a disclosure toggle so first-time users
// are not drowned in copy.
export function HomePage() {
  const [showHow, setShowHow] = useState(false);

  return (
    <>
      <div className="hero">
        <h1>Community decisions that no one can quietly rewrite.</h1>
        <p>
          Vote from a wallet or from a basic feature phone. Every tally is
          public and verifiable on Stellar.
        </p>
      </div>

      <div className="grid-2">
        <Link to="/vote" className="card role-card">
          <div className="role-emoji" aria-hidden>🗳️</div>
          <div className="role-title">I want to vote</div>
          <div className="role-sub">
            Enter an election ID, confirm you're on the roll, cast your
            ballot — from wallet or phone.
          </div>
        </Link>

        <Link to="/admin" className="card role-card">
          <div className="role-emoji" aria-hidden>🏛️</div>
          <div className="role-title">I want to organise an election</div>
          <div className="role-sub">
            Enrol voters, register the community, and open a ballot.
            Requires a small fee and a refundable bond.
          </div>
        </Link>
      </div>

      <div className="card">
        <button
          className="secondary link-button"
          onClick={() => setShowHow((v) => !v)}
        >
          {showHow ? "Hide how it works" : "How does this work?"}
        </button>

        {showHow && (
          <ol className="steps" style={{ marginTop: 16 }}>
            <li>
              An organiser enrols voters by phone number. The bridge creates a
              custodial Stellar key per voter and computes a Merkle root of the roll.
            </li>
            <li>
              The organiser pays a fee and locks a bond, then commits the
              root to a Soroban contract — the raw roll never touches the ledger.
            </li>
            <li>
              Voters cast a ballot via Freighter, or by dialling a USSD code
              from any basic phone. Each vote is a signed transaction.
            </li>
            <li>
              After the deadline anyone can close the election. The tally is
              contract state; the bond is refunded to the organiser.
            </li>
            <li>
              Anyone — voter, journalist, court — can independently verify
              the tally at <Link to="/verify">/verify</Link>.
            </li>
          </ol>
        )}
      </div>
    </>
  );
}
