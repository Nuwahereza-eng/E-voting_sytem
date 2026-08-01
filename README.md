<div align="center">

# 🗳️ Sauti

### **The ballot box you can't stuff.**

Verifiable community elections on **Stellar Soroban** — every vote is a signed
public transaction, and no admin, server, or Sauti operator can quietly
rewrite the tally.

<br/>

[![Stellar](https://img.shields.io/badge/Stellar-Soroban-7D00FF?style=for-the-badge&logo=stellar&logoColor=white)](https://stellar.org)
[![Sunbird AI](https://img.shields.io/badge/Sunbird_AI-Translation-F2892B?style=for-the-badge&logoColor=white)](https://sunbird.ai)
[![Google Cloud Vision](https://img.shields.io/badge/Google_Cloud_Vision-OCR-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white)](https://cloud.google.com/vision)

[![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](#-license)

**[🚀 Live Demo](https://decentralized-e-voting-sytem.vercel.app/)** ·
**[🔍 On-Chain Contract](https://stellar.expert/explorer/testnet/contract/CDLYCBSVJ4NFTXT22D3CQXB7WPK3D5DLS7TOCOLKFM6AO5HUZK7Z6IDZ)** ·
**[🎬 90-sec Walkthrough](https://youtu.be/_xIx9ybzdVs?si=QbVdOxb5X1Gyo1lp)**

</div>

<br/>

## 🌍 What is Sauti?

Sauti is a decision-making platform for African community organisations —
SACCOs, student unions, cooperatives, village councils — built on Stellar
Soroban. Every ballot is a signed transaction on a public ledger. **The tally
cannot be edited by an admin, a server, or the Sauti team.**

Voters cast their ballot from a browser, in one of two ways:

> 💳 **A Stellar wallet** (Freighter) — for admins, staff, and voters who
> already self-custody.
>
> 📱 **A one-time SMS code** — enter your voter ID, receive a 6-digit code by
> SMS, pick a candidate. The bridge signs on your behalf using a custodial
> keypair derived from your voter reference.

Voters who can't read a printed name still recognise their candidate — every
option is shown with a **symbol** (umbrella, watch, bicycle) alongside the
label, the same emblems used on paper ballots. Ballots also translate in real
time into **local languages** (Luganda, Acholi, Runyankole, Ateso, Lugbara,
Swahili) via Sunbird AI.

<br/>

## ✨ Live Demo

| | |
| :-- | :-- |
| 🌐 **Web app** | <https://decentralized-e-voting-sytem.vercel.app/> |
| 🔗 **Contract** | [Stellar Expert (testnet)](https://stellar.expert/explorer/testnet/contract/CDLYCBSVJ4NFTXT22D3CQXB7WPK3D5DLS7TOCOLKFM6AO5HUZK7Z6IDZ) |
| 🎥 **Walkthrough** | [90-second video](https://youtu.be/_xIx9ybzdVs?si=QbVdOxb5X1Gyo1lp) |

> **Try it yourself:** open the demo, go to **Verify**, and paste any election
> ID. The numbers you see are being read from the Stellar contract in real
> time — there is no Sauti database.

<br/>

## 💡 Why This Matters

| Problem in African community elections | How Sauti addresses it |
| :-- | :-- |
| 📥 Paper ballots can be stuffed, lost, or "corrected" by an official. | Every vote is a public transaction on Stellar. |
| 🔐 Most e-voting demos require every voter to own and manage a Stellar wallet. | Voters authenticate with an ID + one-time SMS code; the bridge signs on their behalf using a per-voter custodial key. |
| 📲 One person, three SIMs = three votes. | The organiser assigns a stable voter reference (student number, membership number, national ID). Two SIMs on the same ref = one wallet = one vote. |
| 👁️ Voters can't read the ballot. | Every candidate has a **symbol** rendered as a large emblem next to the name, plus real-time translation into local languages. |
| 🤝 Nobody trusts the developer running the server. | The web app and the SMS gateway are just clients. The chain is the source of truth. Anyone can audit at `/verify`. |
| 🚫 An organiser could open fake elections to spam voters. | Opening an election costs a **fee** and locks a **bond**, refunded when the election closes cleanly. |
| ⏱️ Results announced early skew turnout. | Tallies are **sealed** in the UI until the deadline passes; the chain has always allowed anyone to read them, we simply don't display them. |

<br/>

## 🛠️ Powered By

<div align="center">

| Technology | Role |
| :-: | :-- |
| ⭐ **Stellar (Soroban)** | Tamper-evident ballots recorded on-chain as signed transactions |
| 🐦 **Sunbird AI** | Real-time translation of ballots into local African languages |
| 👁️ **Google Cloud Vision** | Turns a photo of a paper voter roll into a digital list |

</div>

Under the hood: **React · TypeScript · Rust · Vite · Node/Express · Tailwind
CSS · Freighter · Merkle proofs**.

<br/>

## 🏗️ Architecture

```
                       ┌────────────────────┐
                       │  Stellar Soroban   │
                       │  evoting contract  │
                       │  registry contract │
                       └─────────┬──────────┘
                                 │
             ┌───────────────────┴───────────────────┐
             │                                        │
      ┌──────▼───────┐                        ┌───────▼──────┐
      │   Web app    │                        │  Freighter   │
      │ (React/Vite) │                        │    wallet    │
      └──────┬───────┘                        └───────┬──────┘
             │                                        │
    ┌────────▼─────────┐                              │
    │ SMS OTP + custody│                              │
    │      bridge      │                              │
    └────────┬─────────┘                              │
             │                                        │
      voter with ID +                          power user with
      one-time SMS code                        self-custody
```

> ⭐ **`soroban-evoting/`** — Rust smart contracts: `evoting` (the tally) and
> `registry` (organiser attestation).
>
> 💻 **`web/`** — Vite + React + TypeScript. Talks to Soroban RPC and the
> bridge. Uses Freighter for signing when the voter has a wallet.
>
> 📡 **`ussd-bridge/`** — Node/Express. Issues one-time SMS codes and holds a
> custodial keypair per enrolled voter reference so the web app can sign a
> vote on the voter's behalf.
>
> 🧩 **`shared/`** — Merkle tree utility. Same algorithm in Rust (contract)
> and TypeScript (web + bridge) so proofs verify across all three.

The eligibility list is committed on-chain as a **Merkle root only**. Phone
numbers, names, and public keys never touch the ledger.

<br/>

## 🔒 Trust Model

**What the chain guarantees:** the tally was computed honestly from signed
votes cast by holders of keypairs whose Merkle proof matches the committed
root.

**What the chain does not guarantee:** that "Community #7" is really Makerere
University's Guild. Blockchains don't solve naming.

Sauti closes that gap with a second contract, `SautiRegistry`. A single
curator address attests on-chain to
`(evoting_contract, community_id) → { org_name, admin, metadata_url }`. The
`/verify/:id` page reads that attestation and shows a green **Verified
organiser** badge with a link to the organiser's own authoritative page
(e.g. `mak.ac.ug/guild-2026`). If no attestation exists, the page shows an
amber warning instead — cryptographic consistency without organiser identity.

**Double-vote prevention:**

> ✅ The contract's `has_voted(voter, election)` is the final gate.
>
> ✅ Custodial addresses are derived from the **voter reference** (student
> number etc.), so a second SIM linked to the same voter shares the same
> address and cannot vote twice.
>
> ✅ The bridge additionally filters already-voted elections out of the
> eligibility list before the voter sees them.

<br/>

## 📁 Repository Layout

```
soroban-evoting/   Rust workspace: the Soroban smart contracts + tests
web/               Vite + React + TS frontend
ussd-bridge/       Node/Express SMS OTP + custody bridge
shared/            Shared TS Merkle utility with unit tests
```

<br/>

## ⚡ Quick Start

### 1️⃣ Contract

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

Then initialize it once (the fifth argument is the **bond-slash grace period**
in seconds — after `closes_at + this` any wallet can slash a stuck election
and take 50% of the bond as a keeper reward):

```bash
stellar contract invoke \
  --id <CONTRACT_ID> --source <YOUR_IDENTITY> --network testnet \
  -- initialize \
  --token   <SAC_TOKEN_ID> \
  --treasury <TREASURY_ADDRESS> \
  --fee 5000000 \
  --bond_min 100000000 \
  --slash_grace_period 86400
```

### 2️⃣ Web frontend

```bash
cd web
cp .env.example .env      # then edit VITE_CONTRACT_ID
npm install
npm run dev               # http://localhost:5173
```

Install [Freighter](https://freighter.app), switch it to Testnet, and connect
from the Organise page.

### 3️⃣ SMS bridge

```bash
cd ussd-bridge
cp .env.example .env      # fill in CONTRACT_ID, RPC, passphrase
npm install
npm start                 # http://localhost:4000
```

Set `OTP_DEV_ECHO=1` in `.env` to see OTP codes on stdout instead of sending
real SMS. For a real deployment, wire the Africa's Talking API key so the
bridge can deliver OTPs over SMS.

### 4️⃣ Try a full round

1. **Organise → Voters** — paste a CSV of `name,phone,idNumber` rows.
2. **Organise → Community** — click *Load from bridge* and register the
   community on-chain from your Freighter admin wallet.
3. **Organise → Election** — pick the community, add candidate names and
   symbols, set a close time, hit *Open election*.
4. **Participate → Vote** — enter a voter ID, receive an SMS code (or read it
   off stdout in dev mode), pick a candidate.
5. **Verify** — enter the election ID. Watch the live tally.

<br/>

## 🎯 What Each Path Proves

| Path | Signs with | Answers the judge |
| :-- | :-- | :-- |
| Web + Freighter | Voter's own Stellar key | "Yes, self-custody works." |
| Web + ID/OTP | Bridge's custodial key derived from voter ref | "Yes, voters without a wallet are included." |
| `/verify` page | Nothing — read-only | "Yes, anyone with a browser can audit." |

<br/>

## ⚖️ Honest Trade-offs

> 🔑 **Custodial signing** for OTP voters. Documented, deliberate, and the
> only realistic way to include voters who don't run a Stellar wallet. A
> future release can move signing back onto the voter's device.
>
> 👀 **Votes are not anonymous.** Each vote is a signed transaction on a public
> chain. A shielded-vote / commit-reveal layer is the next step, not a claim
> we're making today.
>
> 🧵 **The bridge is a single process.** It is a client, not a trust anchor —
> even if it is compromised, the chain state is the source of truth and any
> tampering is detectable at `/verify`.

<br/>

## 👥 Team

**Hackers:** Nuwahereza Peter · Nyanja Joseph

<br/>

## 📄 License

Released under the **MIT License**.

<div align="center">
<br/>

**Sauti — every voice, on-chain.**

</div>
