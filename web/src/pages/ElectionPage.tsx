import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BadgeCheck,
  CalendarClock,
  Check,
  Copy,
  ExternalLink,
  Fingerprint,
  Flame,
  ImagePlus,
  Loader2,
  Plus,
  Printer,
  RefreshCw,
  Share2,
  Trash2,
  User,
  Vote,
} from "lucide-react";
import {
  closeElection,
  createElection,
  encodeElectionQuestion,
  encodeOption,
  decodeOption,
  extendElection,
  readCommunity,
  readConfig,
  readElection,
  readNextCommunityId,
  readNextElectionId,
  slashElection,
  type CommunityInfo,
  type ElectionInfo,
  type ProtocolConfig,
} from "../soroban";
import { useWallet } from "../wallet";
import { candidatePhotoUrl, uploadCandidatePhoto } from "../bridge";
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

// Resize an image to a centered square JPEG at `size × size` px. Used
// before uploading candidate photos so a 4 MB phone snap becomes a
// ~30 KB avatar. Returns a Blob ready to POST to /photos.
async function resizeToSquareJpeg(
  file: Blob,
  size: number,
  quality: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement("canvas"), { width: size, height: size });
  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas)
    .getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Could not get 2D canvas context");
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  if (canvas instanceof OffscreenCanvas) {
    return await canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  return await new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Failed to encode image"))),
      "image/jpeg",
      quality,
    );
  });
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
  //
  // Community is auto-discovered from the connected wallet — we scan
  // all communities and keep the ones this wallet admins. Organisers
  // never type a numeric ID; they pick a name (or the only option is
  // pre-selected).
  const [myCommunities, setMyCommunities] = useState<CommunityInfo[] | null>(null);
  const [communityId, setCommunityId] = useState<number | null>(null);
  const [electionName, setElectionName] = useState("Kampala SACCO 2026 Chair");
  const [electionTitle, setElectionTitle] = useState("Who leads the SACCO in 2026?");
  // Candidate rows — each has a label (name) and a symbol
  // (party emblem, e.g. "☂") so voters who don't read fluently can
  // still pick their person. Symbols are single emoji so they render
  // large on the vote card and on the printed poster.
  const [candidates, setCandidates] = useState<Array<{ label: string; symbol: string; photo?: string }>>([
    { label: "Alice Nakato", symbol: "☂" },
    { label: "Bob Okello", symbol: "⌚" },
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
  const [requirePersonhood, setRequirePersonhood] = useState(false);
  const [electionId, setElectionId] = useState<number | null>(null);

  // ---- Bond formula --------------------------------------------------
  // Bond scales with the size and duration of the election so
  // organisers of small quick polls don't post as much collateral as
  // organisers of long high-stakes ones. Contract still enforces
  // `bond >= bondMin`; this is UI-only.
  //   bond = bondMin
  //        + 2 XLM × max(0, candidates − 2)
  //        + 1 XLM × ceil(days_open)
  const bondBreakdown = useMemo(() => {
    const baseStroops = cfg?.bondMin ?? 100_000_000n; // 10 XLM fallback
    const cleanCandidates = candidates.filter((c) => c.label.trim().length > 0);
    const nCandidates = Math.max(2, cleanCandidates.length);
    const perCandidateStroops = 20_000_000n; // 2 XLM
    const perDayStroops = 10_000_000n; // 1 XLM
    const extraCandidates = BigInt(Math.max(0, nCandidates - 2));
    const closesAtMs = closesAtLocal ? new Date(closesAtLocal).getTime() : NaN;
    const days = Number.isNaN(closesAtMs)
      ? 0n
      : BigInt(Math.max(0, Math.ceil((closesAtMs - Date.now()) / 86_400_000)));
    const suggested =
      baseStroops + perCandidateStroops * extraCandidates + perDayStroops * days;
    return {
      base: baseStroops,
      candidateAdd: perCandidateStroops * extraCandidates,
      dayAdd: perDayStroops * days,
      total: suggested,
      nCandidates,
      days,
    };
  }, [candidates, closesAtLocal, cfg?.bondMin]);

  // Keep the (still-used) bondXlm state in sync with the formula so
  // the existing submit path picks up the right amount.
  useEffect(() => {
    setBondXlm(stroopsToXlm(bondBreakdown.total));
  }, [bondBreakdown.total]);

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
        // bondXlm is auto-derived from cfg.bondMin + candidates + duration
        // via the bondBreakdown memo; no manual seed needed.
      })
      .catch((e) => setCfgErr(e instanceof Error ? e.message : String(e)));
    refreshRecent().catch(() => {});
  }, [refreshRecent]);

  // Discover the communities this wallet admins. We scan every
  // community (there aren't many in practice) and keep the ones whose
  // admin matches. If there's exactly one it becomes the default; if
  // there are several the organiser picks from a dropdown of names.
  useEffect(() => {
    if (!wallet.address) {
      setMyCommunities(null);
      setCommunityId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const next = await readNextCommunityId();
        const ids = Array.from({ length: next }, (_, i) => i);
        const infos = await Promise.all(
          ids.map((id) => readCommunity(id).catch(() => null)),
        );
        if (cancelled) return;
        const mine = infos.filter(
          (c): c is CommunityInfo => c !== null && c.admin === wallet.address,
        );
        setMyCommunities(mine);
        setCommunityId((current) => {
          if (current !== null && mine.some((c) => c.id === current)) return current;
          return mine.length > 0 ? mine[mine.length - 1].id : null;
        });
      } catch {
        if (!cancelled) setMyCommunities([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.address]);

  async function doOpen() {
    if (!wallet.address || communityId === null || !cfg) return;
    setBusy(true);
    setErr(null);
    try {
      const cleaned = candidates
        .map((c) => ({
          label: c.label.trim(),
          symbol: c.symbol.trim(),
          photo: c.photo?.trim() || undefined,
        }))
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
        requirePersonhood,
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

  async function doSlash(id: number, bond: bigint) {
    if (!wallet.address) return;
    const xlm = stroopsToXlm(bond / 2n);
    const ok = window.confirm(
      `Slash election #${id}?\n\n` +
        `The organiser missed the close deadline (plus grace period).\n` +
        `The ${stroopsToXlm(bond)} XLM bond will be split 50/50:\n` +
        `  • ${xlm} XLM keeper reward → YOUR wallet\n` +
        `  • ${xlm} XLM → protocol treasury\n\n` +
        `This is irreversible.`,
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    setCloseResult(null);
    try {
      await slashElection(wallet.address, id, wallet.sign);
      setCloseResult(
        `Slashed election ${id}. ${stroopsToXlm(bond / 2n)} XLM keeper reward sent to your wallet.`,
      );
      refreshRecent().catch(() => {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doExtend(id: number, currentClosesAt: number) {
    if (!wallet.address) return;
    // Suggest 24h later than the current deadline as a sensible default.
    const suggested = new Date((currentClosesAt + 86_400) * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const defaultLocal = `${suggested.getFullYear()}-${pad(suggested.getMonth() + 1)}-${pad(
      suggested.getDate(),
    )}T${pad(suggested.getHours())}:${pad(suggested.getMinutes())}`;
    const raw = window.prompt(
      `Extend election #${id}\n\n` +
        `Current deadline: ${new Date(currentClosesAt * 1000).toLocaleString()}\n\n` +
        `Enter new deadline (YYYY-MM-DDTHH:mm, local time). ` +
        `Must be later than the current one.`,
      defaultLocal,
    );
    if (!raw) return;
    const ms = new Date(raw).getTime();
    if (Number.isNaN(ms)) {
      setErr("Invalid date/time.");
      return;
    }
    const newClosesAt = Math.floor(ms / 1000);
    if (newClosesAt <= currentClosesAt) {
      setErr("New deadline must be later than the current one.");
      return;
    }
    setBusy(true);
    setErr(null);
    setCloseResult(null);
    try {
      await extendElection(wallet.address, id, newClosesAt, wallet.sign);
      setCloseResult(
        `Election ${id} deadline extended to ${new Date(newClosesAt * 1000).toLocaleString()}.`,
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
              Fee <b>{stroopsToXlm(cfg.fee)} XLM</b>. Bond <b>{stroopsToXlm(cfg.bondMin)} XLM</b>{" "}
              (refunded on close).
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Community</label>
            {myCommunities === null ? (
              <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading your communities…
              </div>
            ) : myCommunities.length === 0 ? (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                No communities under this wallet.{" "}
                <Link to="/community" className="underline">
                  Register one
                </Link>{" "}
                first.
              </div>
            ) : myCommunities.length === 1 ? (
              <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm">
                <Badge variant="outline">#{myCommunities[0].id}</Badge>
                <span className="font-medium">{myCommunities[0].name}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {myCommunities[0].memberCount} members
                </span>
              </div>
            ) : (
              <select
                value={communityId ?? ""}
                onChange={(e) => setCommunityId(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {myCommunities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.memberCount} members
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              value={electionName}
              onChange={(e) => setElectionName(e.target.value)}
              placeholder="Kampala SACCO 2026 Chair"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Question</label>
            <input
              value={electionTitle}
              onChange={(e) => setElectionTitle(e.target.value)}
              placeholder="Who leads the SACCO in 2026?"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <label className="text-sm font-medium">Candidates</label>
              <span className="text-xs text-muted-foreground">
                {candidates.filter((c) => c.label.trim()).length} named ·{" "}
                need at least 2
              </span>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              Each candidate needs a <b>name</b> and a <b>symbol</b>. The
              symbol prints big on the ballot for voters who don’t read
              fluently.
            </p>
            <div className="space-y-3">
              {candidates.map((c, i) => (
                <CandidateEditor
                  key={i}
                  index={i}
                  candidate={c}
                  canRemove={candidates.length > 2}
                  onChange={(next) =>
                    setCandidates((prev) =>
                      prev.map((p, j) => (j === i ? next : p)),
                    )
                  }
                  onRemove={() =>
                    setCandidates((prev) =>
                      prev.length > 1 ? prev.filter((_, j) => j !== i) : prev,
                    )
                  }
                />
              ))}
            </div>
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCandidates((prev) => [...prev, { label: "", symbol: "" }])
                }
              >
                <Plus className="size-4" />
                Add another candidate
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Closes on</label>
              <input
                type="datetime-local"
                value={closesAtLocal}
                onChange={(e) => setClosesAtLocal(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Bond (auto)</label>
              <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
                <div className="text-lg font-semibold">
                  {stroopsToXlm(bondBreakdown.total)} XLM
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {stroopsToXlm(bondBreakdown.base)} base
                  {bondBreakdown.candidateAdd > 0n && (
                    <> · +{stroopsToXlm(bondBreakdown.candidateAdd)} for {bondBreakdown.nCandidates} candidates</>
                  )}
                  {bondBreakdown.dayAdd > 0n && (
                    <> · +{stroopsToXlm(bondBreakdown.dayAdd)} for {String(bondBreakdown.days)} day{bondBreakdown.days === 1n ? "" : "s"}</>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Refunded when you close on time · slashed if you miss the deadline.
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-md border border-input bg-muted/40 p-3 text-sm">
            <input
              id="require-personhood"
              type="checkbox"
              checked={requirePersonhood}
              onChange={(e) => setRequirePersonhood(e.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
            <label htmlFor="require-personhood" className="cursor-pointer">
              <span className="font-medium">Require proof of personhood</span>
              <span className="block text-xs text-muted-foreground">
                Voters must hold a live attestation from the registry.
                Prevents multi-account voting from the same human.
              </span>
            </label>
          </div>
          <div className="pt-2">
            <Button onClick={doOpen} disabled={busy || !wallet.address || communityId === null || !cfg}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Opening…" : "Open election"}
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
                    <th className="px-3 py-2 text-left font-medium">Symbols</th>
                    <th className="px-3 py-2 text-left font-medium">Candidates</th>
                    <th className="px-3 py-2 text-left font-medium">Community</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Votes</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => {
                    const nowSec = Date.now() / 1000;
                    const isOpen = !e.closed && nowSec < e.closesAt;
                    const closedForResults = e.closed || nowSec >= e.closesAt;
                    const grace = cfg?.slashGracePeriod ?? 0;
                    const slashableAt = e.closesAt + grace;
                    const slashable =
                      !e.closed &&
                      !e.slashed &&
                      !e.bondReturned &&
                      e.bond > 0n &&
                      nowSec >= slashableAt;
                    const communityName =
                      myCommunities?.find((c) => c.id === e.communityId)?.name;
                    const decoded = e.options.map((raw) => decodeOption(raw));
                    const preview = decoded.slice(0, 3);
                    const extra = decoded.length - preview.length;
                    return (
                      <tr key={e.id} className="border-t border-border/60 align-top">
                        <td className="px-3 py-2 font-mono text-base font-semibold">{e.id}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{e.meta.name || e.meta.title || e.question}</div>
                          {e.meta.name && e.meta.title && (
                            <div className="text-xs text-muted-foreground">{e.meta.title}</div>
                          )}
                          {e.requirePersonhood && (
                            <Badge variant="secondary" className="mt-1" title="Voters must hold a live personhood attestation">
                              <Fingerprint className="mr-1 size-3" />
                              verified humans only
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {preview.map((o, i) => (
                              <span
                                key={i}
                                className="inline-flex size-8 items-center justify-center rounded-md border border-border/60 bg-background text-lg leading-none"
                                title={o.label}
                              >
                                {o.symbol || (
                                  <span className="text-muted-foreground/50">·</span>
                                )}
                              </span>
                            ))}
                            {extra > 0 && (
                              <span className="inline-flex size-8 items-center justify-center rounded-md border border-dashed border-border/60 text-xs text-muted-foreground">
                                +{extra}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          <div className="space-y-0.5">
                            {preview.map((o, i) => (
                              <div key={i} className="truncate">
                                {o.label}
                              </div>
                            ))}
                            {extra > 0 && <div>+{extra} more</div>}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {communityName ?? `#${e.communityId}`}
                        </td>
                        <td className="px-3 py-2">
                          {e.slashed ? (
                            <Badge variant="destructive" title="Bond was slashed — organiser missed the close deadline">
                              <Flame className="mr-1 size-3" />
                              slashed
                            </Badge>
                          ) : isOpen ? (
                            <Badge variant="success">{untilString(e.closesAt)}</Badge>
                          ) : e.closed ? (
                            <Badge variant="secondary">closed</Badge>
                          ) : slashable ? (
                            <Badge variant="destructive" title="Grace period expired — bond is up for grabs">
                              slashable
                            </Badge>
                          ) : (
                            <Badge variant="warning">deadline passed</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {closedForResults ? e.totalVotes : <span className="text-xs">hidden until close</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-1">
                            {isOpen && communityName && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => doExtend(e.id, e.closesAt)}
                                disabled={busy || !wallet.address}
                                title="Push the close deadline back"
                              >
                                <CalendarClock className="size-4" />
                                Extend
                              </Button>
                            )}
                            {slashable && (
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => doSlash(e.id, e.bond)}
                                disabled={busy || !wallet.address}
                                title={`Slash bond — take ${stroopsToXlm(e.bond / 2n)} XLM keeper reward`}
                              >
                                <Flame className="size-4" />
                                Slash
                              </Button>
                            )}
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
            After the deadline anyone can close (bond refunds to the admin). If it stays open past
            the {cfg?.slashGracePeriod ? `${Math.floor(cfg.slashGracePeriod / 3600)}h ` : ""}
            grace period, any wallet can hit
            <span className="mx-1 inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-destructive"><Flame className="size-3" />Slash</span>
            above for a 50% keeper reward.
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
  const [election, setElection] = useState<ElectionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    readElection(electionId)
      .then((e) => {
        if (!cancelled) setElection(e);
      })
      .catch(() => {
        /* poster will still render with just the ID */
      });
    return () => {
      cancelled = true;
    };
  }, [electionId]);

  function printPoster() {
    const win = window.open("", "_blank", "width=800,height=1000");
    if (!win) return;
    const name = election?.meta?.name || `Election #${electionId}`;
    const question = election?.meta?.title || election?.question || "";
    const options = (election?.options ?? []).map((o) => decodeOption(o));
    const closes = election
      ? new Date(Number(election.closesAt) * 1000).toLocaleString()
      : "";
    const esc = (s: string) =>
      s.replace(/[&<>"']/g, (c) =>
        c === "&"
          ? "&amp;"
          : c === "<"
            ? "&lt;"
            : c === ">"
              ? "&gt;"
              : c === '"'
                ? "&quot;"
                : "&#39;",
      );
    const optionRows = options
      .map(
        (o, i) => `
          <tr>
            <td class="num">${i + 1}</td>
            <td class="sym">${esc(o.symbol || "•")}</td>
            <td class="lbl">${esc(o.label)}</td>
          </tr>`,
      )
      .join("");
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Sauti — Election #${electionId} poster</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: 'Inter', system-ui, sans-serif; color: #111; background: #fff; }
  .sheet { padding: 40px 48px; max-width: 800px; margin: 0 auto; }
  .brand { font-size: 14px; letter-spacing: .15em; text-transform: uppercase; color: #555; }
  h1 { font-size: 40px; line-height: 1.1; margin: 8px 0 24px; }
  .id-block { text-align: center; border: 3px solid #111; border-radius: 12px; padding: 24px 12px; margin: 16px 0 28px; }
  .id-label { font-size: 12px; letter-spacing: .2em; text-transform: uppercase; color: #555; }
  .id-num { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 96px; font-weight: 800; line-height: 1; margin-top: 8px; }
  .qn { font-size: 18px; margin: 16px 0 8px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td { border-bottom: 1px solid #ddd; padding: 10px 8px; font-size: 18px; vertical-align: middle; }
  td.num { width: 40px; font-family: ui-monospace, SFMono-Regular, monospace; color: #555; }
  td.sym { width: 56px; font-size: 32px; text-align: center; }
  td.lbl { font-weight: 500; }
  .how { margin-top: 24px; background: #f4f4f4; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.5; }
  .how h3 { margin: 0 0 8px; font-size: 14px; letter-spacing: .1em; text-transform: uppercase; }
  .foot { margin-top: 24px; font-size: 11px; color: #777; text-align: center; }
  .row { display: flex; gap: 16px; }
  .row > div { flex: 1; }
  @media print {
    .no-print { display: none !important; }
    .sheet { padding: 20px; }
  }
</style></head><body>
<div class="sheet">
  <div class="brand">SAUTI · Community vote</div>
  <h1>${esc(name)}</h1>
  ${question ? `<div class="qn">${esc(question)}</div>` : ""}
  <div class="id-block">
    <div class="id-label">Election ID — type this to vote</div>
    <div class="id-num">${electionId}</div>
  </div>
  ${options.length ? `<h3 style="margin:20px 0 4px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#555">Candidates</h3><table>${optionRows}</table>` : ""}
  <div class="how">
    <h3>How to vote</h3>
    <div class="row">
      <div><strong>Web:</strong> open <code>${esc(voteUrl)}</code></div>
      <div><strong>SMS:</strong> text <code>VOTE ${electionId} &lt;option&gt;</code></div>
    </div>
    <div style="margin-top:8px"><strong>Verify results:</strong> <code>${esc(verifyUrl)}</code></div>
  </div>
  ${closes ? `<div class="foot">Voting closes: ${esc(closes)}</div>` : ""}
  <div class="foot">Every ballot is a signed transaction on the Stellar Soroban ledger.</div>
  <button class="no-print" style="margin:24px auto 0;display:block;padding:10px 20px;font-size:14px;cursor:pointer" onclick="window.print()">Print / Save as PDF</button>
</div>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 400));</script>
</body></html>`);
    win.document.close();
  }

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
              Voters enter this ID on the Vote page. Paste any of the below into WhatsApp, SMS,
              or a printed poster.
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

        <div className="flex justify-end pt-2">
          <Button variant="secondary" size="sm" onClick={printPoster} className="gap-1.5">
            <Printer className="size-4" />
            Download poster (PDF)
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// A quick-pick palette of common ballot emblems. Organisers can still
// type any single emoji they like; these are just one-tap shortcuts.
const SYMBOL_SUGGESTIONS = [
  "\u2602",
  "\u231a",
  "\u26bd",
  "\ud83d\udeb2",
  "\ud83c\udf3b",
  "\ud83c\udf3e",
  "\u2b50",
  "\ud83c\udfe0",
  "\ud83c\udf33",
  "\ud83d\udcda",
  "\ud83d\udd11",
  "\u2618\ufe0f",
  "\ud83d\udd25",
  "\ud83d\ude9c",
  "\ud83d\udca7",
  "\ud83d\udd28",
];

function CandidateEditor({
  index,
  candidate,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  candidate: { label: string; symbol: string; photo?: string };
  canRemove: boolean;
  onChange: (next: { label: string; symbol: string; photo?: string }) => void;
  onRemove: () => void;
}) {
  const nameFilled = candidate.label.trim().length > 0;
  const symbolFilled = candidate.symbol.trim().length > 0;
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const photoUrl = candidatePhotoUrl(candidate.photo);

  async function handleFile(file: File | null) {
    if (!file) return;
    setUploadErr(null);
    setUploading(true);
    try {
      const compressed = await resizeToSquareJpeg(file, 384, 0.82);
      const { hash } = await uploadCandidatePhoto(compressed);
      onChange({ ...candidate, photo: hash });
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      className={`rounded-lg border p-3 transition ${
        nameFilled && symbolFilled
          ? "border-border/60 bg-background"
          : "border-amber-500/30 bg-amber-500/5"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Poster-style preview tile: photo when uploaded, otherwise the symbol. */}
        <div className="relative flex size-14 flex-none items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/40 text-3xl leading-none">
          {photoUrl ? (
            <img src={photoUrl} alt="" className="size-full object-cover" />
          ) : (
            candidate.symbol.trim() || (
              <span className="text-muted-foreground/50">?</span>
            )
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
              {index + 1}
            </span>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Candidate {index + 1}
            </span>
          </div>
          <input
            value={candidate.label}
            onChange={(e) => onChange({ ...candidate, label: e.target.value })}
            placeholder="Full name (e.g. Alice Nakato)"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={!canRemove}
          title={canRemove ? "Remove candidate" : "Need at least 2 candidates"}
          className="self-start"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Photo upload row */}
      <div className="mt-3 border-t border-border/50 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Photo
          </span>
          <label
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium transition hover:border-primary/40 hover:bg-muted/30 ${
              uploading ? "opacity-60" : ""
            }`}
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : photoUrl ? (
              <User className="size-3.5" />
            ) : (
              <ImagePlus className="size-3.5" />
            )}
            {photoUrl ? "Replace" : "Upload"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                void handleFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
              disabled={uploading}
              className="hidden"
            />
          </label>
          {photoUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ ...candidate, photo: undefined })}
              className="h-7 px-2 text-xs"
              title="Remove photo"
            >
              <Trash2 className="size-3.5" />
              Remove
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground">
            Optional · resized to 384px before upload.
          </span>
        </div>
        {uploadErr && (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {uploadErr}
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-border/50 pt-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Symbol
          </span>
          <input
            value={candidate.symbol}
            onChange={(e) => onChange({ ...candidate, symbol: e.target.value })}
            placeholder="☂"
            maxLength={4}
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-center text-lg"
          />
          <span className="text-xs text-muted-foreground">
            or tap one:
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SYMBOL_SUGGESTIONS.map((s) => {
            const active = candidate.symbol.trim() === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onChange({ ...candidate, symbol: s })}
                className={`flex size-9 items-center justify-center rounded-md border text-xl leading-none transition ${
                  active
                    ? "border-primary bg-primary/10"
                    : "border-border/60 bg-background hover:border-primary/40 hover:bg-muted/30"
                }`}
                aria-label={`Use ${s}`}
              >
                {s}
              </button>
            );
          })}
        </div>
      </div>
    </div>
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
