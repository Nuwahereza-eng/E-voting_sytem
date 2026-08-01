import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  Copy,
  Check,
  LogOut,
  Home,
  Wallet as WalletIcon,
  Vote as VoteIcon,
  UserCheck,
  ShieldCheck,
  Users,
  Landmark,
  Building2,
  Stamp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWallet } from "../wallet";
import { config as appConfig } from "../config";

type Item = { to: string; label: string; icon: React.ReactNode };

const PARTICIPATE: Item[] = [
  { to: "/vote", label: "Cast a vote", icon: <VoteIcon className="size-4" /> },
  { to: "/my-status", label: "My status", icon: <UserCheck className="size-4" /> },
  { to: "/verify", label: "Verify results", icon: <ShieldCheck className="size-4" /> },
];

const ORGANISE: Item[] = [
  { to: "/voters", label: "Voters", icon: <Users className="size-4" /> },
  { to: "/community", label: "Community", icon: <Building2 className="size-4" /> },
  { to: "/election", label: "Election", icon: <Landmark className="size-4" /> },
  { to: "/attesters", label: "Attesters", icon: <Stamp className="size-4" /> },
];

function Section({ title, items, disabled }: { title: string; items: Item[]; disabled?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {items.map((it) =>
        disabled ? (
          <span
            key={it.to}
            aria-disabled="true"
            title="Connect your wallet to continue"
            className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground/40"
          >
            {it.icon}
            <span>{it.label}</span>
          </span>
        ) : (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium no-underline transition-colors",
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )
            }
          >
            {it.icon}
            <span>{it.label}</span>
          </NavLink>
        ),
      )}
    </div>
  );
}

/**
 * The wallet-aware side rail. It lives in the previously blank left
 * gutter on wide screens and only appears once a wallet is connected,
 * surfacing the actions that need an identity (voting, organising).
 */
export function Sidebar() {
  const wallet = useWallet();
  const [copied, setCopied] = useState(false);
  const network = (appConfig.network || "").toLowerCase();

  const connected = Boolean(wallet.address);
  const short = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : "";

  async function copy() {
    if (!wallet.address) return;
    await navigator.clipboard.writeText(wallet.address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <aside className="hidden shrink-0 xl:block xl:w-56">
      <div className="sticky top-24 flex max-h-[calc(100vh-7rem)] min-h-[calc(100vh-7rem)] flex-col space-y-5 overflow-y-auto rounded-xl border border-border/60 bg-background/60 p-3 backdrop-blur">
        {/* Wallet card — connected details, or a connect prompt. */}
        {connected ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-success">
                <span className="size-2 rounded-full bg-success" />
                Connected
              </span>
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                {network || "unknown"}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-1">
              <span className="font-mono text-xs text-foreground" title={wallet.address ?? undefined}>
                {short}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={copy}
                  title="Copy address"
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                </button>
                <button
                  onClick={wallet.disconnect}
                  title="Disconnect"
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                >
                  <LogOut className="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className="size-2 rounded-full bg-muted-foreground/40" />
                Not connected
              </span>
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                {network || "unknown"}
              </span>
            </div>
            <Button
              size="sm"
              onClick={wallet.connect}
              disabled={wallet.connecting}
              className="mt-2 w-full gap-1.5"
            >
              <WalletIcon className="size-3.5" />
              {wallet.connecting ? "Connecting…" : "Connect wallet"}
            </Button>
            {wallet.error && (
              <p className="mt-2 text-[11px] leading-snug text-destructive">{wallet.error}</p>
            )}
          </div>
        )}

        <nav className="space-y-4">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium no-underline transition-colors",
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )
            }
          >
            <Home className="size-4" />
            <span>Home</span>
          </NavLink>
          <Section title="Participate" items={PARTICIPATE} disabled={!connected} />
          <Section title="Organise" items={ORGANISE} disabled={!connected} />
        </nav>
      </div>
    </aside>
  );
}
