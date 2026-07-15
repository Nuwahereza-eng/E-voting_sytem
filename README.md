# Sauti

> **800 million Africans still vote on paper because e-voting requires a
> smartphone. Sauti works from a $10 Nokia — and no one, not even us,
> can quietly rewrite the tally.**

Sauti is a decision-making platform for African community
organisations — SACCOs, student unions, cooperatives, village councils —
built on Stellar Soroban. Every ballot is a signed transaction on a
public ledger. The tally cannot be edited by an admin, a server, or the
Sauti team.

Voters can cast a ballot from:

- **A Stellar wallet** (Freighter) — for admins and staff.
- **The web app** with an ID + one-time SMS code — for anyone with a
  smartphone browser.
- **A feature phone** via USSD or plain SMS — because most of the target
  audience does not own a smartphone.

Illiterate voters pick their candidate by **symbol** (umbrella, watch,
bicycle — the same emblems used on printed ballots), not by reading a
name.

---

## Live demo

- Web: <https://sauti.example> _(replace with your deployment)_
- Contract on Stellar Expert:
  <https://stellar.expert/explorer/testnet/contract/CDLYCBSVJ4NFTXT22D3CQXB7WPK3D5DLS7TOCOLKFM6AO5HUZK7Z6IDZ>
- 90-second walkthrough: _(link your Loom / YouTube)_

Try it yourself: open the demo, go to **Verify**, and paste any
election ID. The numbers you see are being read from the Stellar
contract in real time — there is no Sauti database.

---

## Why this matters

| Problem in African community elections | How Sauti addresses it |
| --- | --- |
| Paper ballots can be stuffed, lost, or "corrected" by an official. | Every vote is a public transaction on Stellar. |
| E-voting demos assume everyone has a smartphone and a wallet. | Voters authenticate by ID + SMS code; the bridge signs on their behalf. |
| One person, three SIMs = three votes. | The organiser assigns a stable voter reference (student number, membership number, national ID). Two SIMs on the same ref = one vote. |
| Voters can't read the ballot. | Every candidate has a **symbol** rendered as a large emblem next to the name. |
| Nobody trusts the developer running the server. | The web app and the SMS bridge are just clients. The chain is the source of truth. Anyone can audit at `/verify`. |
| An organiser could open fake elections to spam voters. | Opening an election costs a **fee** and locks a **bond**. The bond is refunded when the election closes cleanly. |
| Results announced early skew turnout. | Tallies are **sealed** in the UI until the deadline passes; the chain has always allowed anyone to read them, we simply don't display them. |

---

## Architecture

```
                       +--------------------+
                       |  Stellar Soroban   |
                       |  evoting contract  |
                       |  registry contract |
                       +----------+---------+
                                  |
              +-------------------+-------------------+
              |                   |                   |
       +------v------+     +------v------+     +------v------+
       |   Web app   |     | SMS bridge  |     | Freighter   |
       | (React/Vite)|     | (Express)   |     |   wallet    |
       +------+------+     +------+------+     +------+------+
              |                   |                   |
        smartphone           feature phone       power user
        or laptop            (USSD / SMS)        (self-custody)
```

- **`soroban-evoting/`** — Rust smart contracts: `evoting` (the tally)
  and `registry` (organiser attestation).
- **`web/`** — Vite + React + TypeScript. Talks to Soroban RPC and the
  bridge. Uses Freighter for signing when the voter has a wallet.
- **`ussd-bridge/`** — Node/Express. Holds a custodial keypair per
  enrolled phone, signs on the voter's behalf when they dial in.
- **`shared/`** — Merkle tree utility. Same algorithm in Rust (contract)
  and TypeScript (web + bridge) so proofs verify across all three.

The eligibility list is committed on-chain as a **Merkle root only**.
Phone numbers, names, and public keys never touch the ledger.

---

## Trust model

**What the chain guarantees:** the tally was computed honestly from
signed votes cast by holders of keypairs whose Merkle proof matches the
committed root.

**What the chain does not guarantee:** that "Community #7" is really
Makerere University's Guild. Blockchains don't solve naming.

Sauti closes that gap with a second contract, `SautiRegistry`. A single
curator address attests on-chain to
`(evoting_contract, community_id) → { org_name, admin, metadata_url }`.
The `/verify/:id` page reads that attestation and shows a green
**Verified organiser** badge with a link to the organiser's own
authoritative page (e.g. `mak.ac.ug/guild-2026`). If no attestation
exists, the page shows an amber warning instead — cryptographic
consistency without organiser identity.

Double-vote prevention:

- The contract's `has_voted(voter, election)` is the final gate.
- Custodial addresses are derived from the **voter reference** (student
  number etc.), so a second SIM added to the same voter shares the same
  address and cannot vote twice.
- The bridge additionally filters already-voted elections out of the
  eligibility list before the voter sees them.

---

## Repository layout

```
soroban-evoting/   Rust workspace: the Soroban smart contracts + tests
web/               Vite + React + TS frontend
ussd-bridge/       Node/Express USSD + SMS bridge
shared/            Shared TS Merkle utility with unit tests
```

---

## Quick start

### 1. Contract

```bash
cd soroban-evoting
cargo test --lib
cargo build --target wasm32v1-none --release
stellar contract deploy \
  --wasm target/wasm32v1-none/release/evoting.wasm \
  --source <YOUR_IDENTITY> \
  --network testnet
```

Paste the printed contract ID into `web/.env` (`VITE_CONTRACT_ID`) and
`ussd-bridge/.env` (`CONTRACT_ID`).

### 2. Web frontend

```bash
cd web
cp .env.example .env      # then edit VITE_CONTRACT_ID
npm install
npm run dev               # http://localhost:5173
```

Install [Freighter](https://freighter.app), switch it to Testnet, and
connect from the Organise page.

### 3. SMS / USSD bridge

```bash
cd ussd-bridge
cp .env.example .env      # fill in CONTRACT_ID, RPC, passphrase
npm install
npm start                 # http://localhost:4000
```

Set `OTP_DEV_ECHO=1` in `.env` to see OTP codes on stdout instead of
sending real SMS. For a real deployment, wire the Africa's Talking API
key and point their USSD / SMS-in callbacks at `/ussd` and `/sms`.

### 4. Try a full round

1. **Organise → Voters** — paste a CSV of `name,phone,idNumber` rows.
2. **Organise → Community** — click *Load from bridge* and register the
   community on-chain from your Freighter admin wallet.
3. **Organise → Election** — pick the community, add candidate names
   and symbols, set a close time, hit *Open election*.
4. **Participate → Vote** — enter a voter ID, receive an SMS code
   (or read it off stdout in dev mode), pick a candidate.
5. **Verify** — enter the election ID. Watch the live tally.

---

## What each channel proves

| Channel | Signs with | Answers the judge |
| --- | --- | --- |
| Web + Freighter | Voter's own Stellar key | "Yes, self-custody works." |
| Web + ID/OTP | Bridge's custodial key derived from voter ref | "Yes, smartphone voters without wallets are included." |
| USSD / SMS | Same custodial key | "Yes, feature-phone voters are included." |
| `/verify` page | Nothing — read-only | "Yes, anyone with a browser can audit." |

---

## Honest trade-offs

- **Custodial signing** for phone voters. Documented, deliberate, and
  the only realistic way to include voters without wallets on day one.
  A future release can swap this for phone-side key derivation over
  SIM-based key storage.
- **Votes are not anonymous.** Each vote is a signed transaction on a
  public chain. A shielded-vote / commit-reveal layer is the next step,
  not a claim we're making today.
- **The SMS bridge is a single process.** It is a client, not a trust
  anchor — even if it is compromised, the chain state is the source of
  truth and any tampering is detectable at `/verify`.

---

## License

MIT.
