# AGENT BUILD BRIEF — Soroban Community Governance Platform
### 10-day hackathon build plan for an AI coding agent (Claude Code or similar)

## 0. Read this first, agent

You are building a hackathon project, not a toy demo. The bar is: a judge
watching a 4-minute live demo should see something they haven't seen
before, understand why it needs a blockchain (not just a database), and
believe it could keep running after the hackathon ends. Do not pad the
pitch with unbuilt features — every claim made in the demo must map to
working code. Honesty about scope is a strength in judging, not a
weakness; a small thing that works beats a large thing that's faked.

Do not fabricate benchmark numbers, fake user testimonials, or claim
partnerships/adoption that don't exist. If a stretch goal doesn't get
built, cut it from the pitch — don't describe it as done.

## 1. What this project is

**Working name:** Sauti (Swahili/Luganda-adjacent for "voice") — pick
your own, but something that signals "voice/decision," not "vote," so it
reads as a governance platform rather than a single-purpose voting app.

**One-line pitch:** A tamper-proof decision-making platform for African
community organizations — student unions, SACCOs, cooperatives — that
lets anyone participate by smartphone app, web, *or* basic USSD/SMS on a
feature phone, with results that no single official can quietly alter.

**Why this stands out against typical hackathon voting apps:**

1. Most blockchain voting demos assume every voter has a smartphone and
   a crypto wallet. In Uganda, and across most of the continent, a large
   share of the target users (SACCO members, market vendor cooperatives,
   rural student bodies) do not. **The USSD/SMS voting channel is the
   single biggest differentiator in this build — build it early, protect
   it from being cut if time runs short.**
2. It's a reusable primitive (register any community, run any number of
   elections/decisions against it) rather than a one-off "vote for class
   president" app — this is what turns a hackathon demo into something
   that reads as an actual company direction.
3. Verifiable-without-exposing-the-list membership (Merkle root
   eligibility) is a real cryptographic technique, not decoration —
   it answers the "why blockchain" question directly.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Soroban Contract                        │
│  Community Registry │ Election Engine │ Merkle Eligibility    │
└─────────────────────────────────────────────────────────────┘
        ▲                    ▲                      ▲
        │                    │                      │
   Web frontend        USSD/SMS gateway        Public results
   (React + Freighter)  (Africa's Talking      verification page
                         or similar API)        (no login needed)
```

Three access channels hit the same on-chain contract:
- **Web app** — admin dashboard (create community, open election) +
  voter view (connect Freighter wallet, vote, watch live tally).
- **USSD/SMS bridge** — a small backend service that receives USSD
  session requests (or SMS), maps a phone number to a pre-registered
  wallet (custodial signing done server-side for this channel, clearly
  disclosed as a hackathon simplification — see Section 6), and submits
  the `vote` transaction on the voter's behalf.
- **Public verification page** — anyone, no login, can look up an
  election ID and see the live tally plus total votes cast, without
  needing a wallet. This is what you put on the projector during Q&A
  when a judge asks "how do I know this isn't rigged."

## 3. Must-have features (build these first, in this order)

1. Soroban contract (already scaffolded — see `soroban-evoting/`):
   `register_community`, `add_member`, `create_election`, `vote`,
   `close_election`, `results`. Confirm this compiles and the existing
   test passes before building anything else.
2. Merkle-root membership upgrade: instead of storing every member
   address directly in contract storage, store a Merkle root of the
   member list; `vote` takes a Merkle proof alongside the vote. This is
   your cryptographic differentiator — implement it, don't just describe
   it, but keep the direct-storage version as a fallback path if the
   proof verification eats too much time.
3. Web frontend: admin flow (create community + election) and voter flow
   (connect wallet, see ballot, vote, see live results).
4. USSD/SMS bridge: phone number → registered wallet lookup, vote
   submission, confirmation SMS back. Even a two-option "reply 1 or 2"
   flow is enough — this doesn't need to be elaborate to land the point.
5. Public verification page: read-only, no auth, shows live tally and
   total participation for any election ID.

## 4. Stretch features (only after section 3 is fully working and tested)

- Live results as an animated bar chart, not just numbers.
- QR code per election that opens straight to the public verification
  page, for posting on a physical notice board.
- Multi-election dashboard for a community admin (list of past/active
  elections, participation rate over time).
- Basic anti-Sybil check on the USSD path (rate-limit by phone number,
  one active session per number).

Do not start any stretch item until every must-have item has passed its
own test and been demoed successfully end-to-end at least once.

## 5. Day-by-day plan (10 days)

**Day 1 — Contract foundation.** Get the existing Soroban contract
compiling and its test passing locally. Confirm `soroban-sdk` version
matches your installed CLI. Deploy to testnet once. Do not touch the
frontend yet.

**Day 2 — Merkle eligibility.** Extend the contract: store a Merkle root
per community instead of (or alongside) direct membership entries; add
proof verification to `vote`. Write a new test that proves both a valid
member with a correct proof succeeds and an invalid proof is rejected.

**Day 3 — Contract hardening + redeploy.** Add remaining edge-case tests:
double vote, expired deadline, non-existent election, wrong option
index. Redeploy final contract version to testnet. Freeze the contract
interface here — don't change function signatures after today, or the
frontend and USSD bridge built in the following days will break.

**Day 4-5 — Web frontend.** Admin dashboard (create community, create
election) and voter view (Freighter connect, ballot, vote, live tally).
Use the frozen contract interface from Day 3. Get one full click-through
working end to end before polishing styling.

**Day 6-7 — USSD/SMS bridge.** Build the phone-number-to-wallet mapping
service and the vote-submission bridge. Test with real phone numbers if
your USSD sandbox allows it. This is the highest-risk component — if it
is not working reliably by end of Day 7, cut scope to SMS-only (simpler
than full USSD menus) rather than dropping the channel entirely.

**Day 8 — Public verification page + polish pass.** Build the no-login
results page. Do a full pass on error states across all three channels
(what does a voter see if they've already voted, if the election is
closed, if they're not eligible).

**Day 9 — Full dry-run + pitch deck.** Run the entire demo script
(Section 7) at least three times end to end, with different people
playing different roles. Time it. Cut anything that doesn't fit in the
demo window. Build the pitch deck around what actually works.

**Day 10 — Buffer day.** Reserve this entirely for fixing whatever broke
in Day 9's dry runs and for a final rehearsal. Do not write new features
on Day 10.

## 6. Things to be upfront about in the pitch (don't hide these)

- The USSD-to-wallet mapping in this hackathon build uses server-side
  custodial signing for phone-based voters (the server holds keys on
  their behalf), since full self-custody over USSD in 10 days isn't
  realistic. Say this plainly if asked — the honest framing is "this is
  the pattern that would evolve into non-custodial signing (e.g. via a
  USSD-triggered hardware or SIM-based key) in a production version,"
  not silence or evasion.
- Merkle proofs protect the membership *list* from being publicly
  readable, but the current build does not yet make the vote itself
  anonymous (a vote transaction is still linked to a wallet on-chain).
  If a judge asks about ballot secrecy, say that's the clear next layer
  (commit-reveal or a shielded-vote scheme), not something already built.

## 7. Demo script (target 4 minutes, rehearse to this exact shape)

1. **0:00-0:30 — Problem.** One sentence: community organizations across
   Uganda run major decisions on paper or WhatsApp polls, with no way to
   prove the count wasn't altered, and most voters don't have a
   smartphone wallet.
2. **0:30-1:00 — Register a community live** on the admin dashboard.
3. **1:00-1:30 — Open an election live** with a real question.
4. **1:30-2:30 — Vote from three channels on stage**: one teammate votes
   from the web app with Freighter, one "votes" via the USSD/SMS bridge
   from an actual phone, and pull up the public verification page so the
   audience watches the tally update in real time from both channels.
5. **2:30-3:00 — Break it on purpose.** Try to vote twice from the same
   wallet, or vote from an unregistered number — show the rejection.
   This is the single most important 30 seconds of the demo.
6. **3:00-4:00 — Close with vision, not features.** "Today this is a
   student union election. The same registry becomes a SACCO leadership
   vote, a cooperative's loan-committee decision, tomorrow." State
   clearly which parts are built vs. roadmap if there's a Q&A follow-up.

## 8. Judging-criteria checklist (map every session's work back to this)

- **Problem clarity:** stated in one sentence, understood instantly.
- **Genuine use of the chain:** Merkle eligibility + immutable tally are
  the answers if asked "why blockchain, not a database."
- **Technical depth:** Merkle proofs, multi-channel (web + USSD) access
  hitting one contract, live public verification.
- **Feasibility/completeness:** everything demoed must be live, not
  slides — protect must-have features (Section 3) over stretch goals.
- **Real-world relevance:** USSD channel directly addresses actual
  device/connectivity constraints for the stated user base, not a
  hypothetical one.

## 9. Non-negotiables for the agent building this

- Never claim a feature works in the pitch deck or README before its
  test passes and it has been demoed successfully at least once.
- Never fabricate metrics, adoption numbers, or user quotes.
- Keep the contract interface frozen after Day 3 — coordinate any
  necessary change across contract, frontend, and USSD bridge in the
  same session rather than patching one and leaving the others stale.
- If the USSD bridge is not reliable by Day 7, cut to SMS-only rather
  than presenting a flaky live demo — a working narrower channel beats a
  wide one that fails on stage.
