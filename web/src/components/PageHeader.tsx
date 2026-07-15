import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

// A prominent, visually consistent back button used at the top of every
// sub-page. We render it as an outlined pill on the left so users can
// find it at a glance instead of hunting for a small ghost link in the
// top-right corner.
export function BackButton({ to, label }: { to: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link to={to}>
        <ArrowLeft className="size-4" /> {label}
      </Link>
    </Button>
  );
}

// Standardised page header row: a back button on the left, then the
// title + subtitle. Optional trailing slot for wallet chips, etc.
export function PageHeader({
  backTo,
  backLabel,
  title,
  subtitle,
  right,
}: {
  backTo: string;
  backLabel: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-4">
      <BackButton to={backTo} label={backLabel} />
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {right}
    </div>
  );
}
