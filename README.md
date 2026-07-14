# Sauti — Community Governance on Soroban

A tamper-proof decision-making platform for African community organisations
— SACCOs, student unions, cooperatives — that lets anyone participate by
smartphone wallet, web, **or basic USSD/SMS on a feature phone**, with
results no single official can quietly alter.

See [AGENT_BUILD_BRIEF.md](AGENT_BUILD_BRIEF.md) for the full product brief.

## Repo layout

```
soroban-evoting/   Rust workspace: the Soroban smart contract + tests
web/               Vite + React + TS frontend (admin, voter, verify)
ussd-bridge/       Node/Express USSD + SMS bridge (custodial signing)
shared/            Shared TS Merkle utility with unit tests
```

The three channels — web wallet, USSD, SMS — all hit the **same on-chain
contract**. The Merkle-eligibility algorithm is implemented **three times**
(Rust in the contract, browser TS in `web/`, Node TS in `ussd-bridge/`
and `shared/`) and must stay byte-for-byte identical. See the header
comment in each file if you touch it.

## Trust chain — how does a verifier know an organiser is genuine?

The e-voting contract answers **"was this tally computed honestly from
votes cast against community #N?"** — cryptographically, yes. It does
**not** answer **"is community #N really Makerere University's Guild
Electoral Commission?"** That is a naming/identity question, and blockchains
don't solve it for free.

Sauti closes the identity gap with a second, tiny contract:
[`soroban-evoting/contracts/registry/`](soroban-evoting/contracts/registry/src/lib.rs).
A single curator address attests on-chain to
`(evoting_contract, community_id) → { org_name, admin, metadata_url }`.
The `/verify/:id` page reads that attestation and shows a green
**Verified organiser** badge with a link to the organiser's own
authoritative page (e.g. `mak.ac.ug/guild-2026`). If no attestation
exists, the page shows an amber warning instead — cryptographic
consistency without organiser identity.

In short: **the chain verifies the tally, the registry verifies the
organiser's name, the organiser's own domain verifies both.** Any
verifier who doesn't trust the Sauti curator can still cross-check the
attestation against the university's official announcement.

The curator role can be upgraded to a Stellar multi-sig account without
any contract change — `require_auth` will enforce whatever threshold the
account is configured with.

## End-to-end onboarding — how voters get on the roll and prove themselves

The five nav tabs of the web app follow the natural life-cycle of a vote:

1. **Onboard** (`/onboard`) — the organiser types (or CSV-pastes) rows of
   `name, phone`. The web app POSTs to the bridge's `/voters/bulk`, which
   generates a fresh Stellar keypair per phone number, writes them to
   `ussd-bridge/data/members.json` + `.secrets.json`, and returns the new
   Merkle root plus the assignments (member #0, #1, ...).
2. **Admin** (`/admin`) — the organiser clicks **Load from bridge** and
   the members list + Merkle root are pre-filled. They connect Freighter
   and click **Register community** — the root is committed on-chain.
   Then they open an election against that community.
3. **My status** (`/my-status`) — any voter types their phone number and
   sees whether they are enrolled, which member index they got, and
   the short-form of their custodial wallet address. This is the
   **voter verification** step — anyone can self-check without a wallet
   or app install.
4. **Vote** (`/vote`) — three channels, one contract:
   - Web + Freighter — VotePage auto-loads the member list from the
     bridge, builds a Merkle proof in the browser, and signs the tx.
   - USSD — dial the short code, pick option → the bridge signs on
     behalf of the phone's custodial key.
   - SMS — `VOTE <electionId> <option>` → same custodial signing path.
5. **Verify** (`/verify/:id`) — anyone (voter, journalist, court)
   fetches the live tally from Soroban RPC and cross-checks it against
   the SautiRegistry attestation (green "Verified organiser" badge).

**Trust model at a glance:**

- The **phone→keypair** binding is held custodially by the bridge. Voters
  who don't own a wallet delegate signing to the community operator, and
  the bridge log gives them a receipt. Voters who *do* want key custody
  can be onboarded with `POST /voters` (bring-your-own public key) and
  vote from Freighter directly.
- The **member list itself** is committed on-chain as a Merkle root
  only — the raw phone numbers and public keys never touch the chain.
- The **organiser's identity** is anchored by the SautiRegistry
  attestation (see "Trust chain" above), so a verifier can distinguish
  a genuine "Makerere Guild" community from an impostor with the same
  name.

### One person, many phones — the Sybil answer

Real voters often have two SIMs (work + personal), swap SIMs when they
travel, or share a family handset. Naively, each new phone number would
buy an extra vote — a Sybil attack anyone with three SIM cards could run.

Sauti prevents this with a **voter reference** on the Onboard page. The
ref is any stable identity string the organiser already trusts:

- a **university** uses the student number (`STU-2026-001`)
- a **SACCO** uses the membership number (`SACCO/2026/00042`)
- an **NGO co-op** uses the national ID hash (`SHA256(NIN)`)

Rules the bridge enforces:

1. **Two rows with the same voter ref → one keypair, one member slot.**
   Both phones can dial in, but the contract dedupes by wallet address so
   the person votes once.
2. **A row without a ref** falls back to today's behaviour: one phone,
   one keypair. Fine for a small pilot; use refs whenever integrity
   matters.
3. `POST /voters/link` binds a new phone to an already-enrolled voter
   (by ref or by an existing phone). The voter can do this themselves
   from `/my-status`.
4. Attempting to link a phone that already belongs to a *different*
   voter is rejected — deliberate, so a compromised admin can't quietly
   reassign someone else's ballot.

What Sauti still cannot solve on its own: someone with **N genuinely
distinct national IDs**. That's the identity provider's problem, not the
ballot system's. The organiser's SautiRegistry attestation is where a
verifier sees which identity anchor was used (national ID vs SIM-only vs
none) so they can weight the result accordingly.

## Quick start

### 1. Contract

```bash
cd soroban-evoting
cargo test --lib             # runs 6 tests, all should pass
# Deploy to testnet (requires `stellar` CLI + funded identity):
cargo build --target wasm32v1-none --release
stellar contract deploy \
    --wasm target/wasm32v1-none/release/evoting.wasm \
    --source <YOUR_IDENTITY> \
    --network testnet
# copy the printed contract ID into web/.env and ussd-bridge/.env
```

If Cargo warns about `ed25519-dalek` version conflicts, this is a known
upstream issue in `soroban-env-host 27.x` — the workaround is baked
into `Cargo.lock`. If you need to regenerate the lockfile:

```bash
cargo update -p ed25519-dalek --precise 2.2.0
```

### 2. Web frontend

```bash
cd web
cp .env.example .env
# put your deployed CONTRACT_ID into VITE_CONTRACT_ID
npm install
npm run dev              # http://localhost:5173
```

Install [Freighter](https://freighter.app) in your browser, switch it to
Testnet, and connect from the Admin page.

### 3. USSD/SMS bridge

```bash
cd ussd-bridge
cp .env.example .env
# fill in CONTRACT_ID, RPC/passphrase, etc.

npm install
npm start                # http://localhost:4000
```

The bridge exposes both feature-phone endpoints (`/ussd`, `/sms`) and
admin REST endpoints (`/voters/bulk`, `/voters/status`, `/members`) that
the web app talks to for onboarding. See "End-to-end onboarding" below.

**Optional CLI provisioning** (equivalent to what the web Onboard page
does over HTTP — useful for scripting):

```bash
npx tsx src/provision.ts init 5                   # 5 keypairs + Merkle root
npx tsx src/provision.ts assign +256700000001 0   # bind phone to member #0
```

**Test a USSD session locally** without a real gateway:

```bash
curl -X POST http://localhost:4000/ussd \
    -d 'phoneNumber=+256700000001' -d 'text='
# → CON Enter election ID:

curl -X POST http://localhost:4000/ussd \
    -d 'phoneNumber=+256700000001' -d 'text=0'
# → CON <question>\n1. Alice\n2. Bob\nReply with option number:

curl -X POST http://localhost:4000/ussd \
    -d 'phoneNumber=+256700000001' -d 'text=0*1'
# → END Vote recorded for "Alice". Thank you.
```

**Test SMS**:

```bash
curl -X POST http://localhost:4000/sms \
    -d 'from=+256700000001' -d 'text=VOTE 0 1'
```

Point Africa's Talking's USSD callback at `/ussd` and their SMS-in
callback at `/sms` when running behind a public URL (ngrok is fine for
the demo).

### 4. Demo bootstrap end-to-end

The fastest way to run a full demo:

1. Deploy the contract; paste ID into both `.env` files.
2. In `ussd-bridge/`: `npx tsx src/provision.ts init 3`.
3. Copy the public keys from `data/members.json` into
   `web/.env` under `VITE_DEMO_MEMBERS`.
4. Also fund those testnet accounts via
   `https://friendbot.stellar.org/?addr=<G...>` so they can pay tx fees.
5. Copy the same list into the Admin page's "Members" box and register
   the community (from your Freighter admin wallet).
6. Open an election on the Admin page.
7. Bind a couple of phone numbers to member indices via the CLI.
8. Vote from three surfaces at once (web + curl-USSD + curl-SMS) and
   watch the `/verify/<id>` page tick up.

## What each channel proves

| Channel | Signs with | Answers judge Q |
|---|---|---|
| Web (Freighter) | User's own key | "Yes, self-custody is real here." |
| USSD | Bridge's custodial key for that phone | "Yes, the last-mile constraint is real, and we're honest about the custodial trade-off." |
| SMS | Same as USSD | Same |
| `/verify` page | (no signing — read-only) | "Anyone can audit the tally, no wallet required." |

## Known trade-offs (say these plainly if asked)

- The USSD/SMS bridge uses **server-side custodial signing**. This is a
  hackathon simplification — see AGENT_BUILD_BRIEF §6.
- Votes are **not anonymous** in this build: a vote transaction is
  linked to a wallet on-chain. Commit-reveal or a shielded-vote layer
  is the clear next step, not something already built.
- Election deadlines are enforced on ledger timestamp. A closed
  election blocks new votes but doesn't automatically archive results.
