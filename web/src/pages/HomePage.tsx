import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  Copy,
  ExternalLink,
  EyeOff,
  Landmark,
  ScanLine,
  ShieldCheck,
  Vote as VoteIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { config as appConfig } from "../config";
import {
  readElection,
  readNextCommunityId,
  readNextElectionId,
} from "../soroban";

// Home is a lane picker with exactly two choices, plus a small
// disclosure of trust signals underneath. The point of this page is
// to answer one question — "am I here to vote, or to run an election?"
// — and then get out of the user's way.
export function HomePage() {
  return (
    <>
      <section className="mx-auto max-w-2xl px-2 pb-10 pt-2 text-center sm:pb-12">
        <Badge variant="outline" className="mb-4">
          <ShieldCheck className="mr-1" /> Verifiable on Stellar
        </Badge>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Community decisions{" "}
          <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
            no one can quietly rewrite.
          </span>
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-base text-muted-foreground">
          Vote from a wallet or with a one-time SMS code. Every tally is
          public and independently auditable.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <LaneCard
          to="/participate"
          icon={<VoteIcon className="size-7" />}
          title="Participate in an election"
          description="Cast a ballot, check if you're on the voter roll, or verify a public result."
          cta="Start voting"
          reassurance="Free · takes 30 seconds"
          accent="from-accent/40 via-accent/10 to-transparent"
          ring="ring-accent/50 group-hover:ring-accent/80"
          border="border-accent/40 group-hover:border-accent/70"
          glow="shadow-[0_20px_50px_-20px_hsl(var(--accent)/0.45)]"
          ctaColor="text-accent"
        />
        <LaneCard
          to="/organise"
          icon={<Landmark className="size-7" />}
          title="Organise an election"
          description="Enrol voters, register a community, and run a ballot. Small fee + refundable bond."
          cta="Set up an election"
          reassurance="Small fee · bond refunds on close"
          accent="from-primary/40 via-primary/10 to-transparent"
          ring="ring-primary/50 group-hover:ring-primary/80"
          border="border-primary/40 group-hover:border-primary/70"
          glow="shadow-[0_20px_50px_-20px_hsl(var(--primary)/0.45)]"
          ctaColor="text-primary"
        />
      </section>

      <section className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TrustBadge
          icon={<EyeOff className="size-4" />}
          title="No central authority"
          body="Votes are recorded on Stellar. There's no server whose owner can edit the tally."
        />
        <TrustBadge
          icon={<ShieldCheck className="size-4" />}
          title="Tamper-evident tally"
          body="Every ballot is a signed Soroban transaction. Any change would break the chain."
        />
        <TrustBadge
          icon={<ScanLine className="size-4" />}
          title="Open verification"
          body="Anyone can pull the numbers directly from the contract — no login, no trust in us."
        />
      </section>

      <LiveStats />

      <Card className="mt-8">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">How it works</CardTitle>
          <CardDescription className="text-xs">
            Five steps from a name on a list to a public, verifiable tally.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <HowStep n={1} title="Enrol" body="Voters added by ID. Custodial key per voter." />
            <HowStep n={2} title="Commit" body="Merkle root of the roll goes on chain." />
            <HowStep n={3} title="Open" body="Organiser pays fee, locks bond, opens ballot." />
            <HowStep n={4} title="Vote" body="Freighter or SMS. Each vote a signed tx." />
            <HowStep n={5} title="Verify" body="Anyone can pull the tally from the contract." />
          </ol>
        </CardContent>
      </Card>

      <TransparencyCard />
    </>
  );
}

function HowStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary ring-1 ring-primary/30">
          {n}
        </span>
        <span className="text-xs font-semibold">{title}</span>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{body}</p>
    </li>
  );
}

// A small trust-signal card used in the row under the two lanes.
function TrustBadge({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="p-4">
        <div className="mb-2 inline-flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
          {icon}
        </div>
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        <CardDescription className="text-xs leading-relaxed">
          {body}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

// Live counter of platform activity. Reads directly from the Soroban
// contract every 8 seconds. If no elections exist yet the whole card
// hides so the home page doesn't advertise a "0 votes" number to
// first-time judges.
function LiveStats() {
  const [stats, setStats] = useState<{
    communities: number;
    elections: number;
    votes: number;
  } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [nextC, nextE] = await Promise.all([
          readNextCommunityId(),
          readNextElectionId(),
        ]);
        const ids = Array.from({ length: nextE }, (_, i) => i);
        const infos = await Promise.all(
          ids.map((id) => readElection(id).catch(() => null)),
        );
        if (cancelled) return;
        const votes = infos.reduce(
          (acc, e) => acc + (e?.totalVotes ?? 0),
          0,
        );
        setStats({ communities: nextC, elections: nextE, votes });
      } catch {
        /* leave whatever we last had */
      }
    }
    load();
    const t = window.setInterval(() => setTick((n) => n + 1), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [tick]);

  if (!stats) return null;

  if (stats.elections === 0) {
    return (
      <section className="mt-10">
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <div className="inline-flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
              <Activity className="size-4" />
            </div>
            <div className="text-sm font-semibold">No elections yet on this network</div>
            <p className="max-w-md text-xs text-muted-foreground">
              Be the first. Enrol a community and open a ballot — it takes a few minutes.
            </p>
            <Link to="/organise" className="mt-1 no-underline">
              <Button size="sm" variant="secondary">Open the first election</Button>
            </Link>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="pulse-dot" aria-hidden />
        <span aria-live="polite">Live on Stellar testnet</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <StatTile
          label="Communities"
          value={stats.communities.toLocaleString()}
        />
        <StatTile
          label="Elections"
          value={stats.elections.toLocaleString()}
        />
        <StatTile
          label="Votes cast"
          value={stats.votes.toLocaleString()}
          icon={<Activity className="size-3.5" />}
        />
      </div>
    </section>
  );
}

function StatTile({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-1 py-5 text-center">
        <div className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-3xl font-bold tabular-nums text-foreground">
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

// Public transparency block — click-to-copy contract ID and a link to
// the Stellar Explorer. This replaces the tiny muted footer so trust
// signals become actionable, not just visible.
function TransparencyCard() {
  const [copied, setCopied] = useState(false);
  const cid = appConfig.contractId;
  const network = (appConfig.network || "").toLowerCase();
  const isMainnet = network.includes("main") || network === "public";
  const explorerBase = isMainnet
    ? "https://stellar.expert/explorer/public/contract/"
    : "https://stellar.expert/explorer/testnet/contract/";

  async function copy() {
    if (!cid) return;
    try {
      await navigator.clipboard.writeText(cid);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <Card className="mt-10">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-success" />
          <CardTitle className="text-sm font-semibold">Transparency</CardTitle>
        </div>
        <CardDescription>
          Sauti stores every ballot on Stellar Soroban. Anyone can look up the
          contract and audit the tally.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Contract
        </span>
        <code className="block break-all rounded-md border border-border/60 bg-input/50 px-3 py-2 font-mono text-xs">
          {cid || "(not set — configure VITE_CONTRACT_ID)"}
        </code>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!cid}
            onClick={copy}
            className="gap-1.5"
          >
            <Copy className="size-3.5" />
            {copied ? "Copied" : "Copy"}
          </Button>
          <a
            href={cid ? `${explorerBase}${cid}` : "#"}
            target="_blank"
            rel="noreferrer"
            className={
              "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-xs font-medium text-foreground no-underline hover:bg-secondary/70 " +
              (cid ? "" : "pointer-events-none opacity-50")
            }
          >
            <ExternalLink className="size-3.5" />
            View on Stellar Explorer
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

// A big, tappable role card. Extracted so both lanes stay visually
// identical — same size, same header layout, same CTA row. Deliberately
// more prominent than the trust badges below: thicker accent border,
// coloured glow, larger icon and CTA.
function LaneCard({
  to,
  icon,
  title,
  description,
  cta,
  reassurance,
  accent,
  ring,
  border,
  glow,
  ctaColor,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
  reassurance: string;
  accent: string;
  ring: string;
  border: string;
  glow: string;
  ctaColor: string;
}) {
  return (
    <Link
      to={to}
      className="group block h-full no-underline focus-visible:outline-none"
    >
      <Card
        className={
          "relative flex h-full flex-col overflow-hidden border-2 transition-all duration-200 " +
          border +
          " " +
          glow +
          " group-hover:-translate-y-1 group-hover:shadow-xl " +
          "group-focus-visible:ring-2 group-focus-visible:ring-ring"
        }
      >
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b ${accent}`}
          aria-hidden
        />
        <CardHeader className="relative">
          <div
            className={`mb-4 inline-flex size-14 items-center justify-center rounded-2xl bg-background/60 text-foreground ring-2 ${ring} transition backdrop-blur-sm`}
          >
            {icon}
          </div>
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription className="text-sm">{description}</CardDescription>
        </CardHeader>
        <CardContent className="relative mt-auto flex items-end justify-between pt-2">
          <span className="text-xs text-muted-foreground">{reassurance}</span>
          <span
            className={`inline-flex items-center gap-1 text-base font-semibold transition-transform group-hover:translate-x-0.5 ${ctaColor}`}
          >
            {cta}
            <span aria-hidden>→</span>
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
