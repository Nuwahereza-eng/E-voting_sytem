import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Radio,
  Search,
} from "lucide-react";
import { decodeElectionQuestion, readElection, type ElectionInfo } from "../soroban";
import { TallyBars } from "./VotePage";
import { lookupAttestation, type Attestation } from "../registry";
import { config } from "../config";
import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const timer = useRef<number | null>(null);

  const network = (config.network || "").toLowerCase();
  const isMainnet = network.includes("main") || network === "public";
  const explorerBase = isMainnet
    ? "https://stellar.expert/explorer/public/contract/"
    : "https://stellar.expert/explorer/testnet/contract/";

  async function reload(id: number, isFirst: boolean) {
    if (isFirst) setLoading(true);
    try {
      const info = await readElection(id);
      setElection(info);
      setErr(null);
      setLastUpdated(new Date());
      if (!attestation || attestation === null) {
        const a = await lookupAttestation(
          config.contractId,
          info.communityId,
        ).catch(() => null);
        setAttestation(a);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      if (isFirst) setElection(null);
    } finally {
      if (isFirst) setLoading(false);
    }
  }

  useEffect(() => {
    if (electionId === null || Number.isNaN(electionId)) return;
    setAttestation(null);
    reload(electionId, true);
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => reload(electionId, false), 4000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [electionId]);

  // Independent 1s tick so the "updated Ns ago" label counts down live.
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const secondsAgo = lastUpdated
    ? Math.max(0, Math.floor((nowTick - lastUpdated.getTime()) / 1000))
    : null;

  return (
    <>
      <PageHeader
        backTo="/participate"
        backLabel="Participate"
        title="Public verification"
        subtitle="Anyone can look up any election ID here — no wallet, no login. The numbers below come straight from the Soroban contract state."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Look up an election</CardTitle>
          <CardDescription>
            Enter the numeric election ID the organiser shared.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[160px]">
            <label
              htmlFor="election-id"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Election ID
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="election-id"
                type="number"
                min={0}
                value={electionId ?? ""}
                onChange={(e) =>
                  setElectionId(
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
                placeholder="e.g. 3"
                className="block w-full rounded-md border border-input bg-input/70 pl-9 pr-3 py-2 font-mono text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground/60 focus:border-ring focus:ring-2 focus:ring-ring/40"
              />
            </div>
          </div>
          {config.contractId && (
            <a
              href={`${explorerBase}${config.contractId}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs font-medium text-foreground no-underline hover:bg-secondary/70"
            >
              <ExternalLink className="size-3.5" />
              Explorer
            </a>
          )}
        </CardContent>
      </Card>

      {loading && !election && <VerifySkeleton />}

      {err && !loading && (
        <Card className="mt-4 border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-start gap-3 pt-6 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-5 flex-none" />
            <div>
              <div className="font-semibold">Could not load election</div>
              <div className="mt-1 text-xs text-destructive/80">{err}</div>
              <div className="mt-2 text-xs text-muted-foreground">
                Check the ID with the organiser, or try again in a few
                seconds — the ledger may still be indexing.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {election && (() => {
        const meta = decodeElectionQuestion(election.question);
        const displayTitle = meta.title || election.question;
        const closedForResults =
          election.closed || Date.now() / 1000 >= election.closesAt;
        return (
          <Card className="mt-4">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-lg">
                    {meta.name || displayTitle}
                  </CardTitle>
                  {meta.name && meta.title && (
                    <CardDescription className="mt-1">
                      {displayTitle}
                    </CardDescription>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="pulse-dot" aria-hidden />
                  <span
                    className="text-xs tabular-nums text-muted-foreground"
                    aria-live="polite"
                  >
                    {secondsAgo === null
                      ? "connecting…"
                      : `Live · updated ${secondsAgo}s ago`}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  Community #{election.communityId}
                </Badge>
                <Badge variant="outline">Election #{election.id}</Badge>
                {closedForResults ? (
                  <Badge variant="secondary">closed</Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="border-success/40 bg-success/10 text-success"
                  >
                    <Radio className="mr-1 size-3" />
                    live
                  </Badge>
                )}
                <Badge variant="outline" className="tabular-nums">
                  Closes {new Date(election.closesAt * 1000).toLocaleString()}
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {attestation ? (
                <div className="flex items-start gap-3 rounded-lg border border-success/50 bg-success/10 px-4 py-3 text-success">
                  <CheckCircle2 className="mt-0.5 size-5 flex-none" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">
                      Verified organiser: {attestation.orgName}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Attested on{" "}
                      {new Date(
                        attestation.attestedAt * 1000,
                      ).toLocaleDateString()}
                      . Cross-check the announcement:{" "}
                      <a
                        href={attestation.metadataUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {attestation.metadataUrl}
                      </a>
                    </div>
                    <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      Admin: {attestation.admin}
                    </div>
                  </div>
                </div>
              ) : config.registryId ? (
                <div className="flex items-start gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-yellow-300">
                  <AlertTriangle className="mt-0.5 size-5 flex-none" />
                  <div className="text-sm leading-relaxed">
                    <b>Not in the trust registry.</b> This election is
                    cryptographically consistent, but the organiser has not
                    been attested by the Sauti curator. Verify their identity
                    through off-chain channels before trusting the result.
                  </div>
                </div>
              ) : null}

              {closedForResults ? (
                <TallyBars election={election} />
              ) : (
                <div className="rounded-md border border-dashed border-border/70 bg-muted/20 p-4 text-center text-sm text-muted-foreground">
                  Results are sealed until the deadline. Voting is still in
                  progress — come back after{" "}
                  <span className="tabular-nums text-foreground">
                    {new Date(election.closesAt * 1000).toLocaleString()}
                  </span>
                  .
                </div>
              )}

              {config.contractId && (
                <div className="flex justify-end pt-1">
                  <Button asChild variant="link" size="sm" className="gap-1">
                    <a
                      href={`${explorerBase}${config.contractId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="size-3.5" />
                      Read contract state on Stellar Explorer
                    </a>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {electionId === null && !loading && !err && (
        <Card className="mt-4 border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Search className="size-8 text-muted-foreground" />
            <div className="text-sm font-medium">Nothing to verify yet</div>
            <div className="max-w-sm text-xs text-muted-foreground">
              Enter an election ID above to pull the tally live from the
              Soroban contract.
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

// Placeholder shown during the first contract read so the page doesn't
// look blank / broken while RPC roundtrips.
function VerifySkeleton() {
  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <div className="h-5 w-56 rounded bg-muted/60" />
            <div className="h-3 w-40 rounded bg-muted/40" />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            reading contract…
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <div className="h-5 w-24 rounded-full bg-muted/50" />
          <div className="h-5 w-20 rounded-full bg-muted/50" />
          <div className="h-5 w-32 rounded-full bg-muted/50" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-4 w-24 rounded bg-muted/50" />
            <div className="h-6 flex-1 rounded-full bg-muted/40" />
            <div className="h-4 w-8 rounded bg-muted/50" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
