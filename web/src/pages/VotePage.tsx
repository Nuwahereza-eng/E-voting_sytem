import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Loader2, IdCard, Wallet, ShieldCheck, RotateCw, ArrowRight, Check, Circle } from "lucide-react";
import { proofForMember } from "../merkle";
import { readElection, readNextElectionId, submitVote, type ElectionInfo } from "../soroban";
import {
  fetchMembers,
  fetchVoterElections,
  requestOtp,
  voteByRef,
  type VoterElection,
} from "../bridge";
import { decodeElectionQuestion, decodeOption } from "../soroban";
import { useWallet } from "../wallet";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Two ways to vote in Sauti:
//   1. By ID + OTP — the everyday path. Voter enters the ID their
//      organiser enrolled them under (NIN, student number, …), gets a
//      one-time code by SMS on the phone(s) bound to that ID, then
//      picks from the elections they're eligible for. The bridge holds
//      the custodial key and signs on their behalf. No wallet needed.
//   2. By wallet — a voter whose Freighter public key was on the roll
//      when the community was registered signs the tx themselves. Rare
//      for real voters; common for admins/staff or air-gapped tests.
export function VotePage() {
  const params = useParams<{ id?: string }>();
  const [search] = useSearchParams();
  const initialElectionId = (() => {
    if (params.id !== undefined) {
      const n = Number(params.id);
      if (Number.isFinite(n)) return n;
    }
    const q = search.get("id");
    if (q !== null) {
      const n = Number(q);
      if (Number.isFinite(n)) return n;
    }
    return null;
  })();
  const initialVoterRef = search.get("ref") ?? undefined;
  // Most voters never touch Wallet mode; make ID the default and keep
  // Wallet as a small secondary toggle further down.
  const [mode, setMode] = useState<"id" | "wallet">("id");

  return (
    <>
      <PageHeader backTo="/participate" backLabel="Participate" title="Vote" />

      {mode === "id" ? (
        <>
          <IdVote
            defaultElectionId={initialElectionId}
            defaultVoterRef={initialVoterRef}
          />
          <div className="mt-6 text-center">
            <Button
              variant="link"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => setMode("wallet")}
            >
              <Wallet className="size-3.5" />
              Vote with a Stellar wallet instead
            </Button>
          </div>
        </>
      ) : (
        <>
          <Card className="mb-4 border-dashed">
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 py-3">
              <div className="flex items-center gap-2 text-sm">
                <Wallet className="size-4 text-primary" />
                <span className="font-medium">Wallet mode</span>
                <span className="text-xs text-muted-foreground">
                  · for voters registered by public key
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setMode("id")}>
                <IdCard className="size-4" />
                Use ID + code
              </Button>
            </CardHeader>
          </Card>
          <WalletVoteFlow defaultElectionId={initialElectionId} />
        </>
      )}
    </>
  );
}

// ============================================================================
// ID + OTP flow — wizard style
// ============================================================================
//
// One step at a time. Each step fully replaces the previous card so the
// voter always sees a single question. A small breadcrumb across the
// top shows progress, and every step (except the entry point) has a
// Back link that rewinds to the previous step without losing state.
//
// Steps:
//   "id"        → enter voter ID
//   "code"      → enter 6-digit SMS code
//   "election"  → pick one of the elections they're eligible for
//   "option"    → pick a choice + confirm cast
//   "done"      → success card with tally
//
// State never persists across reloads.

type Step = "id" | "code" | "election" | "option" | "confirm" | "done";

interface IdSessionState {
  voterRef: string;
  sentTo: string[];
  expiresAt: number;
  devCode?: string;
}

// ---- Wizard state persistence --------------------------------------
//
// The whole point of Sauti is that voters may be on flaky mobile
// networks or a shared handset. An accidental refresh used to wipe
// everything. We snapshot the (non-secret) wizard state to
// sessionStorage on every change and hydrate on mount. The OTP code
// itself is deliberately *not* persisted — the user re-types it, but
// otherwise picks up exactly where they left off.

const WIZARD_KEY = "sauti.vote.wizard.v1";

interface PersistedWizard {
  step: Step;
  voterRef: string;
  session: IdSessionState | null;
  selectedElectionId: number | null;
  chosenOption: number | null;
}

function saveWizard(w: PersistedWizard) {
  try {
    sessionStorage.setItem(WIZARD_KEY, JSON.stringify(w));
  } catch {
    /* private mode / quota — persistence is best-effort */
  }
}

function loadWizard(): PersistedWizard | null {
  try {
    const raw = sessionStorage.getItem(WIZARD_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedWizard;
    // Expire the OTP session if the clock has passed it — the code
    // wouldn't verify anyway, and we'd rather send the voter back to
    // step 1 than pretend we're still authenticated.
    if (p.session && p.session.expiresAt < Date.now()) {
      p.session = null;
      if (p.step === "code" || p.step === "election" || p.step === "option" || p.step === "confirm") {
        p.step = "id";
      }
    }
    return p;
  } catch {
    return null;
  }
}

function clearWizard() {
  try {
    sessionStorage.removeItem(WIZARD_KEY);
  } catch {
    /* ignore */
  }
}

function IdVote({
  defaultElectionId,
  defaultVoterRef,
}: {
  defaultElectionId: number | null;
  defaultVoterRef?: string;
}) {
  const persisted = useRef<PersistedWizard | null>(loadWizard());
  const [step, setStep] = useState<Step>(persisted.current?.step ?? "id");

  const [voterRef, setVoterRef] = useState(
    defaultVoterRef ?? persisted.current?.voterRef ?? "",
  );
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpErr, setOtpErr] = useState<string | null>(null);
  const [session, setSession] = useState<IdSessionState | null>(
    persisted.current?.session ?? null,
  );

  const [code, setCode] = useState("");
  const [electionsBusy, setElectionsBusy] = useState(false);
  const [electionsErr, setElectionsErr] = useState<string | null>(null);
  const [elections, setElections] = useState<VoterElection[] | null>(null);
  const [unboundLists, setUnboundLists] = useState<string[]>([]);
  const [selected, setSelected] = useState<VoterElection | null>(null);
  const [chosenOption, setChosenOption] = useState<number | null>(
    persisted.current?.chosenOption ?? null,
  );

  // Live-countdown ticker for the OTP expiry display.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  // Track the last resend so we can enforce a 30s cooldown that
  // survives typing but resets on step change.
  const [lastSentAt, setLastSentAt] = useState<number>(() =>
    persisted.current?.session ? Date.now() : 0,
  );
  const resendCooldown = Math.max(0, 30 - Math.floor((now - lastSentAt) / 1000));

  // Snapshot wizard state on every meaningful change.
  useEffect(() => {
    if (step === "done") return; // "done" is a one-off success view, don't stash it
    saveWizard({
      step,
      voterRef,
      session,
      selectedElectionId: selected?.electionId ?? null,
      chosenOption,
    });
  }, [step, voterRef, session, selected, chosenOption]);

  // Scroll the newly-active card into view on every step transition.
  // Feature phones and long ballot cards otherwise leave the voter
  // scrolled mid-page after "Continue".
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [step]);

  const [castBusy, setCastBusy] = useState(false);
  const [castErr, setCastErr] = useState<string | null>(null);
  const [castResult, setCastResult] = useState<{
    question: string;
    choice: string;
    totalVotes: number;
    closesAt: number;
    closed: boolean;
    electionId: number;
  } | null>(null);

  function resetAll() {
    setStep("id");
    setVoterRef("");
    setOtpErr(null);
    setSession(null);
    setCode("");
    setElectionsErr(null);
    setElections(null);
    setUnboundLists([]);
    setSelected(null);
    setChosenOption(null);
    setCastErr(null);
    setCastResult(null);
    clearWizard();
  }

  async function sendCode(isResend = false) {
    const ref = voterRef.trim();
    if (!ref) return;
    setOtpBusy(true);
    setOtpErr(null);
    try {
      const r = await requestOtp(ref);
      if (!r.ok) {
        setOtpErr(r.error ?? "Could not send verification code.");
        return;
      }
      setSession({
        voterRef: ref,
        sentTo: r.sentTo,
        expiresAt: r.expiresAt,
        devCode: r.devCode,
      });
      setLastSentAt(Date.now());
      if (!isResend) {
        setCode("");
        setStep("code");
      }
    } catch (e) {
      setOtpErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOtpBusy(false);
    }
  }

  // Auto-send OTP the first time we arrive with a `?ref=` in the URL,
  // so an organiser's SMS deep-link drops the voter straight onto the
  // code step with no taps.
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (autoSentRef.current) return;
    if (!defaultVoterRef) return;
    if (session) return; // restored from sessionStorage
    if (step !== "id") return;
    autoSentRef.current = true;
    sendCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultVoterRef]);

  async function verifyAndLoad() {
    if (!session || !code.trim()) return;
    // The bridge combines verify+vote in /vote/by-ref, so we don't
    // consume the OTP here. A bad code will surface at cast time.
    setElectionsBusy(true);
    setElectionsErr(null);
    try {
      const r = await fetchVoterElections(session.voterRef);
      setElections(r.elections);
      setUnboundLists(r.unboundLists);
      // Pre-select the election that was in the URL, if any, and jump
      // straight to the option step so a shared "vote for #2" link
      // still feels one-tap after the code.
      if (defaultElectionId !== null) {
        const match = r.elections.find((e) => e.electionId === defaultElectionId);
        if (match) {
          setSelected(match);
          setChosenOption(null);
          setStep("option");
          return;
        }
      }
      setStep("election");
    } catch (e) {
      setElectionsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setElectionsBusy(false);
    }
  }

  async function cast() {
    if (!session || !selected || chosenOption === null || !code.trim()) return;
    setCastBusy(true);
    setCastErr(null);
    try {
      const r = await voteByRef({
        voterRef: session.voterRef,
        code: code.trim(),
        electionId: selected.electionId,
        optionIndex: chosenOption,
      });
      setCastResult({
        question: r.election.question,
        choice: r.election.choice,
        totalVotes: r.election.totalVotes,
        closesAt: selected.closesAt,
        closed: selected.closed,
        electionId: selected.electionId,
      });
      // Wizard is over — clear the persisted state so a later refresh
      // lands cleanly on step 1 for the next voter (or the same voter
      // if they've come back to vote in a different election).
      clearWizard();
      setStep("done");
    } catch (e) {
      setCastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCastBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Breadcrumb step={step} hasElections={elections !== null} />

      {step === "id" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your voter ID</CardTitle>
            <CardDescription>
              We'll SMS a code to the phone your organiser enrolled.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              type="text"
              value={voterRef}
              onChange={(e) => setVoterRef(e.target.value)}
              placeholder="e.g. CM-2024-0187"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") sendCode();
              }}
            />
            {otpErr && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {otpErr}
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={() => sendCode()} disabled={otpBusy || !voterRef.trim()}>
                {otpBusy && <Loader2 className="size-4 animate-spin" />}
                {otpBusy ? "Sending…" : "Send code"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "code" && session && (() => {
        const msLeft = Math.max(0, session.expiresAt - now);
        const expired = msLeft === 0;
        const mm = String(Math.floor(msLeft / 60000)).padStart(2, "0");
        const ss = String(Math.floor((msLeft % 60000) / 1000)).padStart(2, "0");
        return (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enter verification code</CardTitle>
            <CardDescription>
              A 6-digit code was sent to {session.sentTo.join(", ")}.{" "}
              {expired ? (
                <span className="text-destructive">
                  This code has expired — tap <b>Resend code</b> to get a new one.
                </span>
              ) : (
                <>
                  Expires in{" "}
                  <span className="font-mono tabular-nums text-foreground">
                    {mm}:{ss}
                  </span>
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {session.devCode && (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground/80">
                Dev mode — code:{" "}
                <span className="font-mono text-foreground">{session.devCode}</span>
              </div>
            )}
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(digits);
                // Auto-advance the moment the voter has punched in all
                // six digits — one less tap, feels magic.
                if (digits.length === 6 && !electionsBusy) {
                  // Defer so React has committed the value first.
                  window.setTimeout(() => verifyAndLoad(), 0);
                }
              }}
              placeholder="123456"
              className="w-full rounded-md border border-input bg-background px-3 py-3 text-center font-mono text-2xl tracking-[0.5em]"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.length >= 4) verifyAndLoad();
              }}
            />
            {electionsErr && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {electionsErr}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setStep("id");
                  setCode("");
                }}
              >
                Back
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => sendCode(true)}
                  disabled={otpBusy || (resendCooldown > 0 && !expired)}
                >
                  <RotateCw
                    className={`size-4 ${otpBusy ? "animate-spin" : ""}`}
                  />
                  {otpBusy
                    ? "Resending…"
                    : resendCooldown > 0 && !expired
                      ? `Resend in ${resendCooldown}s`
                      : "Resend code"}
                </Button>
                <Button
                  onClick={verifyAndLoad}
                  disabled={electionsBusy || code.length < 4 || expired}
                >
                  {electionsBusy && <Loader2 className="size-4 animate-spin" />}
                  {electionsBusy ? "Loading…" : "Continue"}
                </Button>
              </div>
            </div>
            {otpErr && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {otpErr}
              </div>
            )}
          </CardContent>
        </Card>
        );
      })()}

      {step === "election" && elections !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pick an election</CardTitle>
            <CardDescription>
              {elections.length === 0
                ? "You are not eligible for any open elections right now."
                : `You are eligible for ${elections.length} open election${elections.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {elections.length === 0 && (
              <div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                <p>You're not eligible for any open elections right now.</p>
                <p className="mt-1 text-xs">
                  Your organiser may not have opened one yet, or you may be on a
                  list that hasn't been registered on-chain.
                </p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/my-status">Check my enrollment status</Link>
                  </Button>
                </div>
              </div>
            )}
            {elections.map((e) => {
              const meta = decodeElectionQuestion(e.question);
              const displayTitle = meta.title || e.question;
              const resultsVisible = e.closed || Date.now() / 1000 >= e.closesAt;
              return (
                <button
                  key={e.electionId}
                  type="button"
                  onClick={() => {
                    setSelected(e);
                    setChosenOption(null);
                    setStep("option");
                  }}
                  className="w-full rounded-md border border-border/70 p-3 text-left transition hover:border-primary/60 hover:bg-primary/5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{meta.name || displayTitle}</span>
                    <Badge variant="outline">#{e.electionId}</Badge>
                    <Badge variant="secondary">{e.listName}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      closes {new Date(e.closesAt * 1000).toLocaleString()}
                    </span>
                  </div>
                  {meta.name && (
                    <div className="mt-1 text-sm text-foreground/80">{displayTitle}</div>
                  )}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {e.options.length} candidate{e.options.length === 1 ? "" : "s"}
                    {resultsVisible
                      ? ` \u00b7 ${e.totalVotes} vote${e.totalVotes === 1 ? "" : "s"}`
                      : " \u00b7 results appear after close"}
                  </div>
                </button>
              );
            })}
            {unboundLists.length > 0 && (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground/80">
                You're also on {unboundLists.length} list(s) that aren't linked to an on-chain
                community yet: {unboundLists.join(", ")}. Their elections will appear here once an
                organiser registers them.
              </div>
            )}
            <div className="flex justify-start pt-2">
              <Button variant="ghost" onClick={() => setStep("code")}>
                Back
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "option" && selected && (() => {
        const meta = decodeElectionQuestion(selected.question);
        const displayTitle = meta.title || selected.question;
        return (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{meta.name || displayTitle}</CardTitle>
              </div>
              {meta.name && (
                <div className="mt-2 text-sm text-foreground/80">{displayTitle}</div>
              )}
              <CardDescription className="mt-2 flex flex-wrap items-center gap-1">
                <Badge variant="outline">#{selected.electionId}</Badge>
                <Badge variant="secondary">{selected.listName}</Badge>
                <span className="text-xs">
                  closes {new Date(selected.closesAt * 1000).toLocaleString()}
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Tap your candidate. The symbol on the left is the party emblem printed on the poster.
              </p>
              <div className="space-y-3">
                {selected.options.map((rawOpt, i) => {
                  const o = decodeOption(rawOpt);
                  return (
                    <CandidateCard
                      key={i}
                      index={i}
                      label={o.label}
                      symbol={o.symbol}
                      selected={chosenOption === i}
                      onSelect={() => setChosenOption(i)}
                      name={`opt-${selected.electionId}`}
                    />
                  );
                })}
              </div>
              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStep("election");
                    setChosenOption(null);
                  }}
                >
                  Back
                </Button>
                <Button
                  onClick={() => {
                    setCastErr(null);
                    setStep("confirm");
                  }}
                  disabled={chosenOption === null}
                >
                  Review
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {step === "confirm" && selected && chosenOption !== null && (() => {
        const meta = decodeElectionQuestion(selected.question);
        const displayTitle = meta.title || selected.question;
        const chosen = decodeOption(selected.options[chosenOption]);
        return (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Confirm your vote</CardTitle>
              <CardDescription>
                Once submitted, your vote is on-chain and{" "}
                <strong>cannot be changed</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-4 text-sm">
                <Row label="Election">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{meta.name || displayTitle}</span>
                    <Badge variant="outline">#{selected.electionId}</Badge>
                  </div>
                </Row>
                {meta.name && meta.title && <Row label="Question">{displayTitle}</Row>}
                <Row label="Your choice">
                  <div className="flex flex-wrap items-center gap-3">
                    {chosen.symbol && (
                      <span className="flex size-10 items-center justify-center rounded-md border border-primary/40 bg-background text-2xl leading-none">
                        {chosen.symbol}
                      </span>
                    )}
                    <span className="text-base font-semibold text-primary">
                      {chosen.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      (option #{chosenOption})
                    </span>
                  </div>
                </Row>
                <Row label="Voter ID">
                  <span className="font-mono text-xs">{session?.voterRef}</span>
                </Row>
                <Row label="Closes">
                  {new Date(selected.closesAt * 1000).toLocaleString()}
                </Row>
              </div>
              {castErr && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {castErr}
                </div>
              )}
              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" disabled={castBusy} onClick={() => setStep("option")}>
                  Back
                </Button>
                <Button
                  onClick={cast}
                  disabled={castBusy || !code.trim()}
                  className="bg-primary"
                >
                  {castBusy && <Loader2 className="size-4 animate-spin" />}
                  {castBusy ? "Submitting…" : "Confirm & cast vote"}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {step === "done" && castResult && (() => {
        const meta = decodeElectionQuestion(castResult.question);
        const displayTitle = meta.title || castResult.question;
        const chosen = decodeOption(castResult.choice);
        const resultsVisible = castResult.closed || Date.now() / 1000 >= castResult.closesAt;
        return (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="inline-flex size-9 items-center justify-center rounded-full bg-success/15 text-success ring-2 ring-success/30">
                  <ShieldCheck className="size-5" />
                </span>
                <div>
                  <CardTitle className="text-base">Vote recorded</CardTitle>
                  <CardDescription>
                    Your vote is now on-chain and cannot be changed.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md border border-success/40 bg-success/10 px-3 py-3 text-sm text-success">
                You voted for{" "}
                {chosen.symbol && <strong>{chosen.symbol} </strong>}
                <strong>&ldquo;{chosen.label}&rdquo;</strong> in &ldquo;
                {meta.name || displayTitle}&rdquo;.
              </div>
              {resultsVisible ? (
                <div className="text-sm text-muted-foreground">
                  Total votes in this election so far:{" "}
                  <span className="tabular-nums text-foreground">
                    {castResult.totalVotes}
                  </span>
                  .
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Results are hidden until the election closes on{" "}
                  <span className="tabular-nums text-foreground">
                    {new Date(castResult.closesAt * 1000).toLocaleString()}
                  </span>
                  .
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <Button variant="ghost" onClick={resetAll}>
                  Vote in another election
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const url = `${window.location.origin}/verify/${castResult.electionId}`;
                      try {
                        if (
                          typeof navigator !== "undefined" &&
                          typeof navigator.share === "function"
                        ) {
                          await navigator.share({
                            title: "Sauti · verify this result",
                            text: `Verify election #${castResult.electionId} on Sauti`,
                            url,
                          });
                        } else {
                          await navigator.clipboard.writeText(url);
                        }
                      } catch {
                        /* user cancelled — no-op */
                      }
                    }}
                  >
                    Share result
                  </Button>
                  <Button asChild>
                    <Link to={`/verify/${castResult.electionId}`}>
                      Verify this result
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })()}
    </div>
  );
}

/** Tiny progress breadcrumb so the voter knows where they are in the
 *  five-step ID flow. Purely decorative — clicks are ignored. */
function Breadcrumb({ step, hasElections }: { step: Step; hasElections: boolean }) {
  const items: Array<{ key: Step; label: string }> = [
    { key: "id", label: "ID" },
    { key: "code", label: "Code" },
    { key: "election", label: "Election" },
    { key: "option", label: "Choose" },
    { key: "confirm", label: "Confirm" },
  ];
  const order: Step[] = ["id", "code", "election", "option", "confirm", "done"];
  const currentIdx = order.indexOf(step);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {items.map((it, i) => {
        const idx = order.indexOf(it.key);
        const done = idx < currentIdx || step === "done";
        const active = it.key === step;
        // Grey out "Election" if we skipped it via defaultElectionId
        const skipped = it.key === "election" && !hasElections && (step === "option" || step === "confirm");
        return (
          <div key={it.key} className="flex items-center gap-2">
            <span
              className={`inline-flex size-5 items-center justify-center rounded-full border text-[10px] font-medium ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : done
                    ? "border-success/60 bg-success/10 text-success"
                    : "border-border/70"
              }`}
            >
              {done && !active ? "✓" : i + 1}
            </span>
            <span className={active ? "font-medium text-foreground" : skipped ? "opacity-40" : ""}>
              {it.label}
            </span>
            {i < items.length - 1 && <span className="text-muted-foreground/40">›</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Label + value row used in the confirmation card. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 py-1">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * A single candidate on the ballot. Renders as a big touch-friendly
 * card with:
 *   - a 56px "poster tile" showing the party emblem / symbol,
 *   - the candidate's name in large type,
 *   - a tick indicator on the right that fills in when chosen.
 *
 * The radio input is kept for accessibility but visually hidden — the
 * card itself is the click target.
 */
function CandidateCard({
  index,
  label,
  symbol,
  selected,
  onSelect,
  name,
}: {
  index: number;
  label: string;
  symbol?: string;
  selected: boolean;
  onSelect: () => void;
  name: string;
}) {
  return (
    <label
      className={`group relative flex cursor-pointer items-center gap-4 rounded-xl border-2 p-4 transition ${
        selected
          ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20"
          : "border-border/70 hover:border-primary/40 hover:bg-muted/30"
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
        aria-label={label}
      />

      {/* Symbol tile — large, high-contrast, mimics a printed poster. */}
      <div
        className={`flex size-14 flex-none items-center justify-center rounded-lg border text-3xl leading-none transition ${
          selected
            ? "border-primary/40 bg-background"
            : "border-border/60 bg-muted/40"
        }`}
        aria-hidden
      >
        {symbol || <span className="text-muted-foreground/60">·</span>}
      </div>

      {/* Name + option number. */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold leading-tight sm:text-lg">
          {label}
        </div>
        <div className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          Option #{index}
        </div>
      </div>

      {/* Tick indicator. */}
      <div
        className={`flex size-8 flex-none items-center justify-center rounded-full border-2 transition ${
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border/70 bg-background text-muted-foreground/50 group-hover:border-primary/50"
        }`}
        aria-hidden
      >
        {selected ? (
          <Check className="size-4" strokeWidth={3} />
        ) : (
          <Circle className="size-4 opacity-0" />
        )}
      </div>
    </label>
  );
}


// ============================================================================
// Wallet flow (unchanged behaviour, just extracted)
// ============================================================================

function WalletVoteFlow({ defaultElectionId }: { defaultElectionId: number | null }) {
  const [electionId, setElectionId] = useState<number | null>(defaultElectionId);
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);

  async function loadElection(id: number) {
    setLoadErr(null);
    try {
      const info = await readElection(id);
      setElection(info);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (raw.includes("Error(Contract, #3)")) {
        try {
          const next = await readNextElectionId();
          if (next === 0) {
            setLoadErr(
              `Election #${id} does not exist. No elections have been created yet — ask the organiser to open one on the Elections page.`,
            );
          } else {
            setLoadErr(
              `Election #${id} does not exist. Valid IDs are 0 to ${next - 1}. Double-check the ID your organiser shared.`,
            );
          }
        } catch {
          setLoadErr(`Election #${id} does not exist. Double-check the ID your organiser shared.`);
        }
      } else {
        setLoadErr(raw);
      }
      setElection(null);
    }
  }

  useEffect(() => {
    if (electionId !== null && !Number.isNaN(electionId)) loadElection(electionId);
  }, [electionId]);

  const isOpen =
    !!election && !election.closed && Date.now() / 1000 < election.closesAt;

  return (
    <>
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Which election?</CardTitle>
          <CardDescription>Enter the election ID your organiser shared.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              value={electionId ?? ""}
              onChange={(e) =>
                setElectionId(e.target.value === "" ? null : Number(e.target.value))
              }
              placeholder="e.g. 0"
              className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <Button
              variant="outline"
              onClick={() => electionId !== null && loadElection(electionId)}
              disabled={electionId === null}
            >
              Load election
            </Button>
          </div>
          {loadErr && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {loadErr}
            </div>
          )}
        </CardContent>
      </Card>

      {election && (() => {
        const meta = decodeElectionQuestion(election.question);
        const displayTitle = meta.title || election.question;
        const resultsVisible = election.closed || Date.now() / 1000 >= election.closesAt;
        return (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-lg">{meta.name || displayTitle}</CardTitle>
                {isOpen ? (
                  <Badge variant="success">open</Badge>
                ) : (
                  <Badge variant="secondary">closed</Badge>
                )}
                <Badge variant="outline">Community #{election.communityId}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  Closes {new Date(election.closesAt * 1000).toLocaleString()}
                </span>
              </div>
              {meta.name && (
                <div className="mt-2 text-sm text-foreground/80">{displayTitle}</div>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {election.options.map((rawOpt, i) => {
                  const o = decodeOption(rawOpt);
                  return (
                    <CandidateCard
                      key={i}
                      index={i}
                      label={o.label}
                      symbol={o.symbol}
                      selected={chosen === i}
                      onSelect={() => setChosen(i)}
                      name="option"
                    />
                  );
                })}
              </div>
              <WalletVote
                electionId={election.id}
                chosen={chosen}
                disabled={!isOpen}
                onVoted={() => loadElection(election.id)}
              />
              <div className="border-t border-border/60 pt-4">
                {resultsVisible ? (
                  <TallyBars election={election} />
                ) : (
                  <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-center text-xs text-muted-foreground">
                    Results are hidden until the election closes on{" "}
                    {new Date(election.closesAt * 1000).toLocaleString()}.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })()}
    </>
  );
}

// -------- Vote by wallet (Freighter signs) --------
function WalletVote({
  electionId,
  chosen,
  disabled,
  onVoted,
}: {
  electionId: number;
  chosen: number | null;
  disabled: boolean;
  onVoted: () => void;
}) {
  const wallet = useWallet();
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    fetchMembers()
      .then((m) => setMembers(m.members))
      .catch(() => {
        /* bridge offline — user will see a helpful error on cast */
      });
  }, []);

  const inRoll = wallet.address ? members.includes(wallet.address) : false;

  async function cast() {
    if (!wallet.address || chosen === null) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      if (members.length === 0) {
        throw new Error(
          "Cannot reach the bridge to load the community roll. Try again or use ID + code.",
        );
      }
      const p = await proofForMember(members, wallet.address);
      if (!p) {
        throw new Error(
          "Your wallet address is not in the community roll. This flow only works for voters who registered their Stellar public key with the organiser. Try ID + code instead.",
        );
      }
      await submitVote(wallet.address, electionId, chosen, p.proof, wallet.sign);
      setOk("Vote recorded. Refreshing tally…");
      onVoted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {!wallet.address ? (
        <>
          <p className="text-sm text-muted-foreground">
            Wallet voting only works if your Stellar public key was registered with the community.
            Most voters should use ID + code instead.
          </p>
          <Button onClick={wallet.connect} disabled={wallet.connecting}>
            {wallet.connecting ? "Connecting…" : "Connect Freighter"}
          </Button>
          {wallet.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {wallet.error}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Wallet:</span>
            <span className="font-mono text-xs" title={wallet.address}>
              {wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}
            </span>
            {inRoll ? (
              <Badge variant="success">on roll</Badge>
            ) : members.length > 0 ? (
              <Badge variant="destructive">not on roll</Badge>
            ) : (
              <Badge variant="secondary">checking…</Badge>
            )}
          </div>
          {!inRoll && members.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground/80">
              Your wallet address isn't in the registered roll for this community. Switch to ID +
              code above if you were enrolled by ID.
            </div>
          )}
          <Button
            onClick={cast}
            disabled={busy || disabled || chosen === null || !inRoll}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? "Submitting…" : "Cast vote"}
          </Button>
          {busy && (
            <div className="flex items-start gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground/80">
              <Loader2 className="mt-0.5 size-3.5 flex-none animate-spin text-primary" />
              <div>
                Waiting for you to approve the transaction in Freighter. This
                can take up to 20 seconds — please don't refresh the page.
              </div>
            </div>
          )}
        </>
      )}
      {ok && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {ok}
        </div>
      )}
      {err && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
    </div>
  );
}

export function TallyBars({ election }: { election: ElectionInfo }) {
  const max = Math.max(1, ...election.tallies);
  return (
    <div className="space-y-2.5">
      <p className="text-sm text-muted-foreground">
        <span className="tabular-nums text-foreground">
          {election.totalVotes}
        </span>{" "}
        total votes
      </p>
      {election.options.map((raw, i) => {
        const o = decodeOption(raw);
        const n = election.tallies[i] ?? 0;
        const pct = (n / max) * 100;
        return (
          <div key={i} className="flex items-center gap-3">
            <div className="flex min-w-[140px] items-center gap-2 text-sm font-semibold">
              {o.symbol && <span className="text-base">{o.symbol}</span>}
              <span className="truncate">{o.label}</span>
            </div>
            <div className="h-6 flex-1 overflow-hidden rounded-full border border-border bg-secondary/70">
              <div
                className="h-full bg-gradient-to-r from-primary to-accent transition-[width] duration-500"
                style={{ width: `${pct}%` }}
                aria-hidden
              />
            </div>
            <div className="min-w-[3rem] text-right font-mono text-sm tabular-nums text-muted-foreground">
              {n}
            </div>
          </div>
        );
      })}
    </div>
  );
}
