import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Coins,
  Fingerprint,
  Landmark,
  Megaphone,
  Users,
  Wallet,
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
import { readConfig, type ProtocolConfig } from "../soroban";
import { useWallet } from "../wallet";

function xlm(amount: bigint): string {
  const s = amount.toString().padStart(8, "0");
  const whole = s.slice(0, s.length - 7);
  const frac = s.slice(s.length - 7).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// Landing page for organisers. Same 3-card pattern as Participate,
// plus a wallet + fee banner up top because every downstream action
// needs both a signer and awareness of how much it will cost.
export function OrganisePage() {
  const wallet = useWallet();
  const [cfg, setCfg] = useState<ProtocolConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);

  useEffect(() => {
    readConfig()
      .then(setCfg)
      .catch((e) => setCfgErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/">
            <ArrowLeft className="size-4" /> Home
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organise</h1>
          <p className="text-sm text-muted-foreground">
            Three steps: enrol voters, register the community, open a
            ballot. Do them in one sitting or over weeks.
          </p>
        </div>
      </div>

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center gap-4 py-4">
          <div className="flex items-center gap-2">
            <Wallet className="size-4 text-muted-foreground" />
            {wallet.address ? (
              <>
                <Badge variant="success">Wallet connected</Badge>
                <span className="font-mono text-xs text-muted-foreground" title={wallet.address}>
                  {wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}
                </span>
              </>
            ) : (
              <>
                <Badge variant="secondary">Not connected</Badge>
                <Button size="sm" onClick={wallet.connect} disabled={wallet.connecting}>
                  {wallet.connecting ? "Connecting..." : "Connect Freighter"}
                </Button>
              </>
            )}
          </div>
          {cfg && (
            <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Coins className="size-3.5" />
                Fee{" "}
                <b className="text-foreground">{xlm(cfg.fee)} XLM</b>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Coins className="size-3.5" />
                Bond min{" "}
                <b className="text-foreground">{xlm(cfg.bondMin)} XLM</b>{" "}
                <span className="text-muted-foreground/80">(refunded)</span>
              </span>
            </div>
          )}
        </CardContent>
        {cfgErr && (
          <CardContent className="pt-0">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Cannot reach contract: {cfgErr}
            </div>
          </CardContent>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StepCard
          to="/voters"
          step={1}
          icon={<Users className="size-5" />}
          title="Enrol voters"
          description="Add voters by phone. The bridge issues a custodial Stellar key so they can vote from the web using just their number — no wallet install needed."
        />
        <StepCard
          to="/community"
          step={2}
          icon={<Landmark className="size-5" />}
          title="Register community"
          description="Commit the voter roll to Soroban as a Merkle root. The raw list stays on your device — only the root goes on-chain."
        />
        <StepCard
          to="/election"
          step={3}
          icon={<Megaphone className="size-5" />}
          title="Open or close a ballot"
          description="Pay the fee, lock the bond, run the ballot. Anyone can close it after the deadline to trigger the bond refund."
        />
        <StepCard
          to="/attesters"
          step={4}
          icon={<Fingerprint className="size-5" />}
          title="Proof of personhood"
          description="Optional. Curator + attester console to bind Stellar addresses to real humans on-chain. No PII touches the ledger — only salted-hash nullifiers."
        />
      </div>
    </>
  );
}

function StepCard({
  to,
  step,
  icon,
  title,
  description,
}: {
  to: string;
  step: number;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="group block h-full no-underline">
      <Card className="h-full border-primary/20 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-primary/60 group-hover:shadow-md group-hover:shadow-primary/10 group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <CardHeader>
          <div className="mb-2 flex items-center justify-between">
            <div className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30 transition group-hover:ring-primary/60">
              {icon}
            </div>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Step {step}
            </span>
          </div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
          <div className="pt-2 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
            Open <span aria-hidden>→</span>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}
