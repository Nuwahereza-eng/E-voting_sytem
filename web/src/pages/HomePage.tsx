import { useState } from "react";
import { Link } from "react-router-dom";
import { Landmark, ShieldCheck, Vote as VoteIcon } from "lucide-react";
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

// Home is a lane picker with exactly two choices, plus a small
// disclosure of trust signals underneath. The point of this page is
// to answer one question — "am I here to vote, or to run an election?"
// — and then get out of the user's way.
export function HomePage() {
  const [showHow, setShowHow] = useState(false);

  return (
    <>
      <section className="mx-auto max-w-2xl px-2 py-14 text-center">
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
          Vote from a wallet or a basic feature phone. Every tally is
          public and independently auditable.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <LaneCard
          to="/participate"
          icon={<VoteIcon className="size-6" />}
          title="Participate in an election"
          description="Cast a ballot, check if you're on the voter roll, or verify a public result."
          accent="from-accent/25 to-transparent"
          ring="ring-accent/30 group-hover:ring-accent/60"
        />
        <LaneCard
          to="/organise"
          icon={<Landmark className="size-6" />}
          title="Organise an election"
          description="Enrol voters, register a community, and run a ballot. Small fee + refundable bond."
          accent="from-primary/25 to-transparent"
          ring="ring-primary/30 group-hover:ring-primary/60"
        />
      </section>

      <div className="mt-8 flex flex-col items-center gap-3 text-center">
        <Button
          variant="link"
          size="sm"
          onClick={() => setShowHow((v) => !v)}
        >
          {showHow ? "Hide how it works" : "How does this work?"}
        </Button>

        {showHow && (
          <Card className="w-full max-w-2xl text-left">
            <CardContent className="pt-6">
              <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
                <li>
                  An organiser enrols voters by phone. The bridge issues
                  a custodial Stellar key per voter and computes a
                  Merkle root of the roll.
                </li>
                <li>
                  The organiser pays a fee and locks a bond, then
                  commits only the root to a Soroban contract — the raw
                  roll never touches the ledger.
                </li>
                <li>
                  Voters cast a ballot via Freighter, or by entering
                  their enrolled phone number. Each vote is a signed
                  transaction on Soroban.
                </li>
                <li>
                  After the deadline anyone can close the election —
                  tally is contract state, bond is refunded.
                </li>
                <li>
                  Anyone can independently verify the tally at{" "}
                  <Link to="/verify" className="text-accent hover:underline">
                    /verify
                  </Link>
                  .
                </li>
              </ol>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="mt-10 text-center text-xs text-muted-foreground">
        Network <b className="text-foreground">{appConfig.network}</b>{" "}
        · Contract{" "}
        <span className="font-mono">
          {appConfig.contractId
            ? `${appConfig.contractId.slice(0, 8)}…${appConfig.contractId.slice(-6)}`
            : "(not set)"}
        </span>
      </div>
    </>
  );
}

// A big, tappable role card. Extracted so both lanes stay visually
// identical — same size, same header layout, same CTA row.
function LaneCard({
  to,
  icon,
  title,
  description,
  accent,
  ring,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  accent: string;
  ring: string;
}) {
  return (
    <Link
      to={to}
      className="group block h-full no-underline focus-visible:outline-none"
    >
      <Card
        className={
          "relative h-full overflow-hidden transition-all duration-200 " +
          "group-hover:-translate-y-1 group-hover:border-primary/40 " +
          "group-focus-visible:ring-2 group-focus-visible:ring-ring"
        }
      >
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b ${accent} opacity-70`}
          aria-hidden
        />
        <CardHeader className="relative">
          <div
            className={`mb-3 inline-flex size-11 items-center justify-center rounded-xl bg-background/40 text-foreground ring-1 ${ring} transition`}
          >
            {icon}
          </div>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription className="text-sm">{description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
