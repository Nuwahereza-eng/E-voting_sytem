import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  BadgeCheck,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  Vote,
} from "lucide-react";
import {
  closeElection,
  createElection,
  encodeElectionQuestion,
  encodeOption,
  decodeOption,
  readConfig,
  readElection,
  readNextElectionId,
  type ElectionInfo,
  type ProtocolConfig,
} from "../soroban";
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

function xlmToStroops(xlm: string): bigint {
  const trimmed = xlm.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Bond must be a positive number.");
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded);
}

function stroopsToXlm(s: bigint): string {
  const str = s.toString().padStart(8, "0");
  const w = str.slice(0, str.length - 7);
  const f = str.slice(str.length - 7).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

// Human-readable countdown to a unix epoch. Returns "closed" if in the past.
function untilString(unix: number): string {
  const s = unix - Math.floor(Date.now() / 1000);
  if (s <= 0) return "closed";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `closes in ${d}d ${h}h`;
  if (h > 0) return `closes in ${h}h ${m}m`;
  return `closes in ${m}m`;
}

// Election page. Three flows share the page because they all revolve
// around a single election ID:
//   1. Open a new one (costs fee + locks bond).
//   2. See the shareable link & poster info for a just-opened or
//      selected election — so voters know which ID to use.
//   3. Close an existing one (returns the bond to admin).
export function ElectionPage() {
  const wallet = useWallet();
  const [cfg, setCfg] = useState<ProtocolConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);

  // Open form
  const [communityId, setCommunityId] = useState<number | null>(null);
  const [electionName, setElectionName] = useState("Kampala SACCO \u2014 2026 Chair");
  const [electionTitle, setElectionTitle] = useState("Who leads the SACCO in 2026?");
  // Candidate rows — each has a label (name) and an optional symbol
  // (party emblem, e.g. "\u2602 Umbrella") so voters who don't read
  // fluently can still pick their person.
  const [candidates, setCandidates] = useState<Array<{ label: string; symbol: string }>>([
    { label: "Alice Nakato", symbol: "\u2602 Umbrella" },
    { label: "Bob Okello", symbol: "\u231A Watch" },
  ]);
  // Calendar date + time when voting closes. Default: 1 hour from now,
  // formatted for <input type="datetime-local"> (YYYY-MM-DDTHH:mm in
  // the organiser's local timezone).
  const [closesAtLocal, setClosesAtLocal] = useState<string>(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [bondXlm, setBondXlm] = useState("10");
  const [electionId, setElectionId] = useState<number | null>(null);

  // Close form
  const [closeId, setCloseId] = useState("");
  const [closeResult, setCloseResult] = useState<string | null>(null);

  // Recent elections listing
  const [recent, setRecent] = useState<ElectionInfo[] | null>(null);
  const [recentErr, setRecentErr] = useState<string | null>(null);
  const [loadingRecent, setLoadingRecent] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refreshRecent = useCallback(async () => {
    setLoadingRecent(true);
    setRecentErr(null);
    try {
      const nextId = await readNextElectionId();
      // Show up to the last 10 elections. IDs are 0-indexed; nextId is
      // "the ID that would be assigned to the next election".
      const start = Math.max(0, nextId - 10);
      const ids: number[] = [];
      for (let i = nextId - 1; i >= start; i--) ids.push(i);
      const info = await Promise.all(
        ids.map((id) => readElection(id).catch(() => null)),
      );
      setRecent(info.filter((e): e is ElectionInfo => e !== null));
    } catch (e) {
      setRecentErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    readConfig()
      .then((c) => {
        setCfg(c);
        setBondXlm(stroopsToXlm(c.bondMin));
      })
      .catch((e) => setCfgErr(e instanceof Error ? e.message : String(e)));
    refreshRecent().catch(() => {});
  }, [refreshRecent]);

  async function doOpen() {
    if (!wallet.address || communityId === null || !cfg) return;
    setBusy(true);
    setErr(null);
    try {
      const cleaned = candidates
        .map((c) => ({ label: c.label.trim(), symbol: c.symbol.trim() }))
        .filter((c) => c.label.length > 0);
      if (cleaned.length < 2) throw new Error("Need at least 2 candidates with a name.");
      const name = electionName.trim();
      const title = electionTitle.trim();
      if (!name) throw new Error("Election name is required.");
      if (!title) throw new Error("Election title (the question) is required.");
      const bond = xlmToStroops(bondXlm);
      if (bond < cfg.bondMin) {
        throw new Error(
          `Bond ${stroopsToXlm(bond)} XLM is below the minimum ${stroopsToXlm(cfg.bondMin)} XLM.`,
        );
      }
      if (!closesAtLocal) throw new Error("Pick a date and time when voting closes.");
      const closesAtMs = new Date(closesAtLocal).getTime();
      if (Number.isNaN(closesAtMs)) throw new Error("Close date/time is invalid.");
      if (closesAtMs <= Date.now())
        throw new Error("Close date/time must be in the future.");
      const closesAt = Math.floor(closesAtMs / 1000);
      // The contract stores a single `question` string and an array of
      // option strings, so we pack name/title into JSON for the
      // question, and each candidate's label+symbol into JSON per
      // option. Voters see the clean, decoded values on the vote page.
      const encodedQuestion = encodeElectionQuestion({ name, title });
      const encodedOptions = cleaned.map((c) => encodeOption(c));
      const id = await createElection(
        wallet.address,
        communityId,
        encodedQuestion,
        encodedOptions,
        closesAt,
        bond,
        wallet.sign,
      );
      setElectionId(id);
      refreshRecent().catch(() => {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doClose() {
    if (!wallet.address) return;
    const id = Number(closeId);
    if (!Number.isFinite(id) || id < 0) {
      setErr("Enter a valid election ID.");
      return;
    }
    setBusy(true);
    setErr(null);
    setCloseResult(null);
    try {
      const before = await readElection(id).catch(() => null);
      await closeElection(wallet.address, id, wallet.sign);
      const after = await readElection(id).catch(() => null);
      const returned = after?.bondReturned && !before?.bondReturned;
      setCloseResult(
        returned
          ? `Election ${id} closed. Bond of ${stroopsToXlm(after?.bond ?? 0n)} XLM refunded to admin.`
          : `Election ${id} closed.`,
      );
      refreshRecent().catch(() => {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        backTo="/organise"
        backLabel="Organise"
        title="Election"
        subtitle="Open a new ballot, share its ID with voters, and close it after the deadline to refund your bond."
      />

      {cfgErr && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Cannot read config: {cfgErr}
        </div>
      )}
      {err && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}

      {!wallet.address && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Connect an admin wallet</CardTitle>
            <CardDescription>
              Freighter signs the create/close transactions on Stellar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={wallet.connect} disabled={wallet.connecting}>
              {wallet.connecting ? "Connecting..." : "Connect Freighter"}
            </Button>
            {wallet.error && (
              <div className="mt-2 text-sm text-destructive">{wallet.error}</div>
            )}
          </CardContent>
        </Card>
      )}

      {/* -------- Share panel for just-opened election -------- */}
      {electionId !== null && <ShareCard electionId={electionId} />}

      {/* -------- Open a new election -------- */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Open a new election</CardTitle>
          {cfg && (
            <CardDescription>
              This charges <b>{stroopsToXlm(cfg.fee)} XLM</b> (non-refundable) and locks a bond of
              at least <b>{stroopsToXlm(cfg.bondMin)} XLM</b>. The bond is returned when you close
              the election.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Community ID</label>
            <input
              type="number"
              value={communityId ?? ""}
              onChange={(e) =>
                setCommunityId(e.target.value === "" ? null : Number(e.target.value))
              }
              placeholder="e.g. 0"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Name <span className="text-xs font-normal text-muted-foreground">(long form, on the poster)</span>
            </label>
            <input
              value={electionName}
              onChange={(e) => setElectionName(e.target.value)}
              placeholder="Kampala SACCO \u2014 2026 Chair"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Title <span className="text-xs font-normal text-muted-foreground">(the exact question voters answer)</span>
            </label>
            <input
              value={electionTitle}
              onChange={(e) => setElectionTitle(e.target.value)}
              placeholder="Who leads the SACCO in 2026?"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Candidates</label>
            <p className="mb-2 text-xs text-muted-foreground">
              Give each candidate a <strong>symbol</strong> (party emblem, emoji, or short word
              like \u201cUmbrella\u201d, \u201cWatch\u201d, \u201cBicycle\u201d) so voters who don't
              read fluently can still identify their choice on the ballot.
            </p>
            <div className="space-y-2">
              {candidates.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <span className="w-6 text-xs font-mono text-muted-foreground">#{i}</span>
                  <input
                    value={c.label}
                    onChange={(e) =>
                      setCandidates((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)),
                      )
                    }
                    placeholder="Candidate name"
                    className="flex-1 min-w-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                  <input
                    value={c.symbol}
                    onChange={(e) =>
                      setCandidates((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, symbol: e.target.value } : p)),
                      )
                    }
                    placeholder="Symbol (e.g. \u2602 Umbrella)"
                    className="w-52 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setCandidates((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))
                    }
                    disabled={candidates.length <= 1}
                    title="Remove candidate"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCandidates((prev) => [...prev, { label: "", symbol: "" }])
                }
              >
                <Plus className="size-4" />
                Add candidate
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Voting closes on</label>
              <input
                type="datetime-local"
                value={closesAtLocal}
                onChange={(e) => setClosesAtLocal(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Results are sealed until this date and time (your local timezone).
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Bond (XLM)</label>
              <input
                type="text"
                value={bondXlm}
                onChange={(e) => setBondXlm(e.target.value)}
                placeholder={cfg ? stroopsToXlm(cfg.bondMin) : "10"}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="pt-2">
            <Button onClick={doOpen} disabled={busy || !wallet.address || communityId === null || !cfg}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Opening..." : "Pay fee, lock bond, open election"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* -------- Recent elections -------- */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">Recent elections</CardTitle>
              <CardDescription>
                The election ID is the number in the first column. Share it with your voters —
                they enter it on the Vote page.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshRecent}
              disabled={loadingRecent}
            >
              <RefreshCw className={`size-4 ${loadingRecent ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {recentErr && (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {recentErr}
            </div>
          )}
          {recent === null ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto mb-2 size-5 animate-spin" />
              Loading elections…
            </div>
          ) : recent.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No elections yet. Open one above to get an ID.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border/70">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">ID</th>
                    <th className="px-3 py-2 text-left font-medium">Name / Title</th>
                    <th className="px-3 py-2 text-left font-medium">Candidates</th>
                    <th className="px-3 py-2 text-left font-medium">Community</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Votes</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => {
                    const isOpen = !e.closed && Date.now() / 1000 < e.closesAt;
                    const closedForResults = e.closed || Date.now() / 1000 >= e.closesAt;
                    return (
                      <tr key={e.id} className="border-t border-border/60">
                        <td className="px-3 py-2 font-mono text-base font-semibold">{e.id}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{e.meta.name || e.meta.title || e.question}</div>
                          {e.meta.name && e.meta.title && (
                            <div className="text-xs text-muted-foreground">{e.meta.title}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {e.options.slice(0, 3).map((raw, i) => {
                            const o = decodeOption(raw);
                            return (
                              <span key={i} className="mr-2 inline-block whitespace-nowrap">
                                {o.symbol && <span className="mr-1">{o.symbol}</span>}
                                {o.label}
                              </span>
                            );
                          })}
                          {e.options.length > 3 && <span>+{e.options.length - 3}</span>}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">#{e.communityId}</td>
                        <td className="px-3 py-2">
                          {isOpen ? (
                            <Badge variant="success">{untilString(e.closesAt)}</Badge>
                          ) : e.closed ? (
                            <Badge variant="secondary">closed</Badge>
                          ) : (
                            <Badge variant="warning">deadline passed</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {closedForResults ? e.totalVotes : <span className="text-xs">hidden until close</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Button asChild variant="ghost" size="sm">
                              <Link to={`/vote/${e.id}`} title="Vote page for this election">
                                <Vote className="size-4" />
                              </Link>
                            </Button>
                            <Button asChild variant="ghost" size="sm">
                              <Link to={`/verify/${e.id}`} title="Public verify page">
                                <BadgeCheck className="size-4" />
                              </Link>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* -------- Close an election -------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Close an election</CardTitle>
          <CardDescription>
            After the deadline anyone can close an election and trigger the bond refund. Before the
            deadline only the community admin can close it early.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Election ID</label>
            <input
              type="number"
              value={closeId}
              onChange={(e) => setCloseId(e.target.value)}
              placeholder="e.g. 0"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <Button onClick={doClose} disabled={busy || !wallet.address || closeId === ""}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Closing..." : "Close & refund bond"}
            </Button>
          </div>
          {closeResult && (
            <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
              {closeResult}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

// A share panel displayed as soon as an organiser opens a new election.
// Big ID, copy-able links, and an SMS-ready template — this is how
// voters find out what number to type.
function ShareCard({ electionId }: { electionId: number }) {
  const voteUrl = `${window.location.origin}/vote/${electionId}`;
  const verifyUrl = `${window.location.origin}/verify/${electionId}`;
  const smsBody = `Sauti vote: election #${electionId}. Vote at ${voteUrl}`;

  return (
    <Card className="mb-6 border-primary/40 bg-primary/5">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            <Share2 className="size-5" />
          </div>
          <div>
            <CardTitle className="text-base">Election opened — share the ID</CardTitle>
            <CardDescription>
              Voters cast their ballot by entering the election ID at the Vote page. Copy any of
              the below and paste into WhatsApp / SMS / a printed poster.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col items-center gap-1 rounded-md bg-background/50 py-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Election ID</div>
          <div className="font-mono text-4xl font-bold text-primary">{electionId}</div>
        </div>

        <ShareRow label="Vote link" value={voteUrl} openHref={`/vote/${electionId}`} />
        <ShareRow label="Verify link" value={verifyUrl} openHref={`/verify/${electionId}`} />
        <ShareRow label="SMS / WhatsApp text" value={smsBody} multiline />
      </CardContent>
    </Card>
  );
}

function ShareRow({
  label,
  value,
  openHref,
  multiline,
}: {
  label: string;
  value: string;
  openHref?: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for older browsers: create a hidden textarea and use
      // execCommand. Best-effort — modern browsers won't hit this path.
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="flex gap-2">
        {multiline ? (
          <textarea
            readOnly
            value={value}
            rows={2}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
        ) : (
          <input
            readOnly
            value={value}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        {openHref && (
          <Button asChild variant="ghost" size="sm">
            <Link to={openHref}>
              <ExternalLink className="size-4" />
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
