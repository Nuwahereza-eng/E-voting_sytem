import { Link } from "react-router-dom";
import {
  ArrowLeft,
  BadgeCheck,
  IdCard,
  Vote as VoteIcon,
} from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Landing page for voters and the public. Three actions, all read-only
// from a wallet perspective (only casting a vote requires a signer,
// and that's the third click from home).
export function ParticipatePage() {
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/">
            <ArrowLeft className="size-4" /> Home
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Participate
          </h1>
          <p className="text-sm text-muted-foreground">
            Pick what you want to do. No wallet needed to look up your
            status or verify a result.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ActionCard
          to="/vote"
          icon={<VoteIcon className="size-5" />}
          title="Cast a vote"
          description="Enter the election ID your organiser shared and pick your option. Sign in with Freighter, or vote by phone number."
        />
        <ActionCard
          to="/my-status"
          icon={<IdCard className="size-5" />}
          title="Am I enrolled?"
          description="Type a phone number to confirm it's on the voter roll and see the assigned member number."
        />
        <ActionCard
          to="/verify"
          icon={<BadgeCheck className="size-5" />}
          title="Verify a result"
          description="Cross-check any election's public tally against the on-chain state. No login required."
        />
      </div>
    </>
  );
}

function ActionCard({
  to,
  icon,
  title,
  description,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="group block h-full">
      <Card className="h-full transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-primary/40">
        <CardHeader>
          <div className="mb-2 inline-flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            {icon}
          </div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
