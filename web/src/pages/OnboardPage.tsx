import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  FileSpreadsheet,
  FolderPlus,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  activateList,
  bulkProvision,
  createList,
  deleteList,
  deleteVoter,
  fetchAllVoters,
  fetchLists,
  fetchMembers,
  type BridgeVoter,
  type EnrolledVoter,
  type VoterList,
} from "../bridge";
import { config } from "../config";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { parseVoterCsv, parseVoterFile } from "@/lib/parseVoterFile";

// A voter row the organiser is drafting.
//   `msisdn`   — phone number (required)
//   `idNumber` — student number, national ID, membership number, etc.
//                Used as the stable identity across SIM changes. Two rows
//                sharing an idNumber become aliases (one keypair, one vote).
//   `name`     — local convenience label; not stored on the bridge.
interface Row {
  name: string;
  msisdn: string;
  idNumber: string;
}

const BLANK_ROW: Row = { name: "", msisdn: "", idNumber: "" };

export function OnboardPage() {
  // ---- draft rows -------------------------------------------------------
  const [rows, setRows] = useState<Row[]>([{ ...BLANK_ROW }]);
  const [mode, setMode] = useState<"replace" | "append">("append");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    root: string;
    members: string[];
    assignments: BridgeVoter[];
  } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- current active list membership summary --------------------------
  const [current, setCurrent] = useState<{ count: number; root: string } | null>(null);

  // ---- lists -----------------------------------------------------------
  const [lists, setLists] = useState<VoterList[] | null>(null);
  const [activeId, setActiveId] = useState<string>("");
  const [showNewList, setShowNewList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  const [confirmDeleteList, setConfirmDeleteList] = useState<VoterList | null>(null);

  // ---- enrolled voters + selection --------------------------------------
  const [enrolled, setEnrolled] = useState<EnrolledVoter[] | null>(null);
  const [enrolledErr, setEnrolledErr] = useState<string | null>(null);
  const [loadingEnrolled, setLoadingEnrolled] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDeleteOne, setConfirmDeleteOne] = useState<EnrolledVoter | null>(null);
  const [confirmDeleteMany, setConfirmDeleteMany] = useState(false);

  const refreshLists = useCallback(async () => {
    try {
      const r = await fetchLists();
      setLists(r.lists);
      setActiveId(r.activeId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshEnrolled = useCallback(async () => {
    setLoadingEnrolled(true);
    setEnrolledErr(null);
    try {
      const v = await fetchAllVoters();
      setEnrolled(v);
      setSelected(new Set());
    } catch (e) {
      setEnrolledErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingEnrolled(false);
    }
  }, []);

  const refreshMembers = useCallback(async () => {
    try {
      const m = await fetchMembers();
      setCurrent({ count: m.count, root: m.root });
    } catch (e) {
      setErr(
        `Cannot reach bridge at ${config.bridgeUrl} — start it with \`cd ussd-bridge && npm start\`. (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    }
  }, []);

  useEffect(() => {
    refreshLists().catch(() => {});
    refreshMembers().catch(() => {});
    refreshEnrolled().catch(() => {});
  }, [refreshLists, refreshMembers, refreshEnrolled]);

  const activeList = useMemo(
    () => lists?.find((l) => l.id === activeId) ?? null,
    [lists, activeId],
  );

  async function switchList(id: string) {
    if (id === activeId) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      await activateList(id);
      setActiveId(id);
      await Promise.all([refreshLists(), refreshMembers(), refreshEnrolled()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitNewList() {
    const name = newListName.trim();
    if (!name) return;
    setCreatingList(true);
    setErr(null);
    try {
      const r = await createList(name, true);
      setActiveId(r.activeId);
      setNewListName("");
      setShowNewList(false);
      await Promise.all([refreshLists(), refreshMembers(), refreshEnrolled()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingList(false);
    }
  }

  async function performDeleteList() {
    if (!confirmDeleteList) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await deleteList(confirmDeleteList.id);
      setActiveId(r.activeId);
      setConfirmDeleteList(null);
      await Promise.all([refreshLists(), refreshMembers(), refreshEnrolled()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- draft-row helpers -----------------------------------------------
  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { ...BLANK_ROW }]);
  }
  function removeRow(i: number) {
    setRows((prev) => (prev.length === 1 ? [{ ...BLANK_ROW }] : prev.filter((_, j) => j !== i)));
  }
  function clearRows() {
    setRows([{ ...BLANK_ROW }]);
  }

  async function onFilePicked(file: File | null) {
    if (!file) return;
    setErr(null);
    try {
      const parsed = await parseVoterFile(file);
      if (parsed.length === 0) {
        setErr(`No voter rows found in ${file.name}. Expected columns: Name, Phone, ID number.`);
        return;
      }
      setRows((prev) => {
        const base =
          prev.length === 1 && !prev[0].name && !prev[0].msisdn && !prev[0].idNumber ? [] : prev;
        return [
          ...base,
          ...parsed.map((p) => ({ name: p.name, msisdn: p.msisdn, idNumber: p.voterRef })),
        ];
      });
    } catch (e) {
      setErr(`Could not parse ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function pasteCsv(text: string) {
    if (!text.trim()) return;
    try {
      const parsed = parseVoterCsv(text);
      if (parsed.length === 0) return;
      setRows((prev) => {
        const base =
          prev.length === 1 && !prev[0].name && !prev[0].msisdn && !prev[0].idNumber ? [] : prev;
        return [
          ...base,
          ...parsed.map((p) => ({ name: p.name, msisdn: p.msisdn, idNumber: p.voterRef })),
        ];
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function provision() {
    setErr(null);
    setResult(null);
    const valid = rows
      .map((r) => ({
        name: r.name.trim(),
        msisdn: r.msisdn.trim(),
        voterRef: r.idNumber.trim(),
      }))
      .filter((r) => r.msisdn.length > 0);
    if (valid.length === 0) {
      setErr("Add at least one voter with a phone number.");
      return;
    }
    // Require an ID number for every voter — this is the identity that
    // survives phone/SIM changes and dedupes across aliases.
    const missingId = valid.findIndex((r) => !r.voterRef);
    if (missingId >= 0) {
      setErr(
        `Row ${missingId + 1} is missing an ID number (student/national). Every voter needs one.`,
      );
      return;
    }
    const seenPhone = new Set<string>();
    for (const r of valid) {
      if (seenPhone.has(r.msisdn)) {
        setErr(`Duplicate phone number: ${r.msisdn}`);
        return;
      }
      seenPhone.add(r.msisdn);
    }
    setBusy(true);
    try {
      const res = await bulkProvision(valid, mode);
      setResult({ root: res.root, members: res.members, assignments: res.assignments });
      setCurrent({ count: res.total, root: res.root });
      clearRows();
      refreshEnrolled().catch(() => {});
      refreshLists().catch(() => {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- voter deletion (single + bulk) -----------------------------------
  async function performDeleteOne() {
    if (!confirmDeleteOne) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await deleteVoter(confirmDeleteOne.msisdn);
      setCurrent({ count: r.total, root: r.root });
      setConfirmDeleteOne(null);
      await refreshEnrolled();
      await refreshLists();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function performDeleteMany() {
    if (selected.size === 0) return;
    setBusy(true);
    setErr(null);
    try {
      // Delete sequentially so the bridge sees each removal in isolation
      // (safer than trusting concurrent slot-compaction).
      let last: { count: number; root: string } | null = null;
      for (const msisdn of Array.from(selected)) {
        const r = await deleteVoter(msisdn);
        last = { count: r.total, root: r.root };
      }
      if (last) setCurrent(last);
      setSelected(new Set());
      setConfirmDeleteMany(false);
      await refreshEnrolled();
      await refreshLists();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    if (!enrolled) return [];
    const q = search.trim().toLowerCase();
    if (!q) return enrolled;
    return enrolled.filter(
      (v) =>
        v.msisdn.toLowerCase().includes(q) ||
        (v.voterRef ?? "").toLowerCase().includes(q) ||
        v.publicKey.toLowerCase().includes(q) ||
        String(v.memberIndex).includes(q),
    );
  }, [enrolled, search]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((v) => selected.has(v.msisdn));

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const v of filtered) next.delete(v.msisdn);
      } else {
        for (const v of filtered) next.add(v.msisdn);
      }
      return next;
    });
  }

  function toggleOne(msisdn: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(msisdn)) next.delete(msisdn);
      else next.add(msisdn);
      return next;
    });
  }

  const draftCount = rows.filter((r) => r.msisdn.trim()).length;

  return (
    <>
      <PageHeader
        backTo="/organise"
        backLabel="Organise"
        title="Enrol voters"
      />

      {err && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="flex-1">{err}</span>
          <button
            className="text-destructive/70 hover:text-destructive"
            onClick={() => setErr(null)}
            aria-label="Dismiss"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* -------- Context strip: which list + bridge status -------- */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">Voter list</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNewListName("");
                setShowNewList(true);
              }}
            >
              <FolderPlus className="size-4" />
              New list
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {lists ? (
            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor="list-picker"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                Active list
              </label>
              <select
                id="list-picker"
                value={activeId}
                onChange={(e) => switchList(e.target.value)}
                disabled={busy}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} · {l.memberCount} voter{l.memberCount === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
              {activeList && lists.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDeleteList(activeList)}
                >
                  <Trash2 className="size-4" />
                  Delete this list
                </Button>
              )}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">
              <Loader2 className="mr-1 inline size-3.5 animate-spin" />
              Loading lists…
            </span>
          )}

          {/* Bridge status inline row */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs">
            {current ? (
              <>
                <Badge variant="success">Bridge online</Badge>
                <span className="text-muted-foreground">
                  <b className="text-foreground">{current.count}</b> voter
                  {current.count === 1 ? "" : "s"} enrolled in{" "}
                  <b className="text-foreground">{activeList?.name ?? "…"}</b>
                </span>
                <span
                  className="ml-auto font-mono text-[11px] text-muted-foreground/70"
                  title={current.root}
                >
                  Merkle root {current.root.slice(0, 8)}…{current.root.slice(-6)}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                <Loader2 className="mr-1 inline size-3.5 animate-spin" />
                Contacting bridge at{" "}
                <span className="font-mono">{config.bridgeUrl}</span>…
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* -------- Add voters -------- */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">
            Add voters {activeList && <span className="text-muted-foreground">to {activeList.name}</span>}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* ---- Step 1: source ---- */}
          <section>
            <SectionLabel step={1} title="Source" />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
                <Upload className="size-4" />
                Import spreadsheet
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                className="hidden"
                onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
              />
              <Button
                variant={showImport ? "secondary" : "outline"}
                onClick={() => setShowImport((v) => !v)}
              >
                {showImport ? "Hide paste box" : "Paste CSV"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Columns: <span className="font-medium">Name, Phone, ID</span>
              </span>
            </div>

            {showImport && (
              <textarea
                placeholder={"Alice,+256700000001,STU-2026-001\nBob,+256700000002,STU-2026-002"}
                className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                rows={4}
                onBlur={(e) => {
                  pasteCsv(e.target.value);
                  e.target.value = "";
                }}
              />
            )}
          </section>

          {/* ---- Step 2: review rows ---- */}
          <section>
            <SectionLabel
              step={2}
              title="Review"
              hint={`${draftCount} ready`}
            />
            <div className="overflow-x-auto rounded-md border border-border/70">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Name (optional)</th>
                    <th className="px-3 py-2 text-left font-medium">
                      ID number <span className="text-destructive">*</span>
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Phone (E.164) <span className="text-destructive">*</span>
                    </th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-2">
                        <input
                          value={r.name}
                          onChange={(e) => updateRow(i, { name: e.target.value })}
                          placeholder="Alice"
                          className="w-full rounded-md border border-input bg-background px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={r.idNumber}
                          onChange={(e) => updateRow(i, { idNumber: e.target.value })}
                          placeholder="STU-2026-001 or CM-99887766"
                          className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={r.msisdn}
                          onChange={(e) => updateRow(i, { msisdn: e.target.value })}
                          placeholder="+2567..."
                          className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeRow(i)}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label="Remove row"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={addRow}>
                <Plus className="size-4" />
                Add another row
              </Button>
              {rows.some((r) => r.msisdn || r.name || r.idNumber) && (
                <Button variant="ghost" size="sm" onClick={clearRows}>
                  Clear all rows
                </Button>
              )}
            </div>
          </section>

          {/* ---- Step 3: enrol ---- */}
          <section className="border-t border-border/60 pt-4">
            <SectionLabel step={3} title="Enrol" />

            {/* Danger toggle: replace-mode. Off by default. */}
            <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={mode === "replace"}
                onChange={(e) => setMode(e.target.checked ? "replace" : "append")}
              />
              <span className="flex-1">
                <span
                  className={
                    mode === "replace"
                      ? "font-semibold text-destructive"
                      : "font-medium"
                  }
                >
                  Replace the entire list
                </span>
                <span className="ml-1 text-xs text-muted-foreground">
                  Wipes <b>{activeList?.name ?? "this list"}</b> before enrolling.
                </span>
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={provision}
                disabled={busy || !current || draftCount === 0}
                size="lg"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy
                  ? "Enrolling…"
                  : mode === "replace"
                    ? `Replace list with ${draftCount} voter${draftCount === 1 ? "" : "s"}`
                    : `Enrol ${draftCount} voter${draftCount === 1 ? "" : "s"}`}
              </Button>
            </div>
          </section>

          {result && (
            <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
              <div>
                Enrolled <b>{result.assignments.length}</b> phone binding
                {result.assignments.length === 1 ? "" : "s"} —{" "}
                <b>{result.members.length}</b> unique voter
                {result.members.length === 1 ? "" : "s"} now in {activeList?.name ?? "this list"}.
                {result.assignments.filter((a) => a.alias).length > 0 && (
                  <>
                    {" "}
                    <span className="opacity-80">
                      ({result.assignments.filter((a) => a.alias).length} additional phone
                      {result.assignments.filter((a) => a.alias).length === 1 ? "" : "s"} for an
                      already-enrolled voter.)
                    </span>
                  </>
                )}
              </div>
              <div className="mt-1 font-mono text-xs opacity-80">
                New Merkle root: {result.root.slice(0, 12)}…{result.root.slice(-8)}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* -------- Enrolled voters -------- */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <CardTitle className="text-base">
                Enrolled voters {activeList && <span className="text-muted-foreground">· {activeList.name}</span>}
              </CardTitle>
              {enrolled && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {enrolled.length} total
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={refreshEnrolled}
              disabled={loadingEnrolled}
            >
              <RefreshCw className={`size-4 ${loadingEnrolled ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {enrolledErr && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {enrolledErr}
            </div>
          )}

          {enrolled && enrolled.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search phone, ID number, or public key…"
                    className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm"
                  />
                </div>
                {selected.size > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmDeleteMany(true)}
                    disabled={busy}
                  >
                    <Trash2 className="size-4" />
                    Remove {selected.size}
                  </Button>
                )}
              </div>

              <div className="overflow-x-auto rounded-md border border-border/70">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="w-10 px-3 py-2 text-left">
                        <input
                          type="checkbox"
                          checked={allFilteredSelected}
                          onChange={toggleAllFiltered}
                          aria-label="Select all"
                        />
                      </th>
                      <th className="px-3 py-2 text-left font-medium">#</th>
                      <th className="px-3 py-2 text-left font-medium">ID number</th>
                      <th className="px-3 py-2 text-left font-medium">Phone</th>
                      <th className="px-3 py-2 text-left font-medium">Public key</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((v) => (
                      <tr
                        key={v.msisdn}
                        className={`border-t border-border/60 ${
                          selected.has(v.msisdn) ? "bg-primary/5" : ""
                        }`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selected.has(v.msisdn)}
                            onChange={() => toggleOne(v.msisdn)}
                            aria-label={`Select ${v.msisdn}`}
                          />
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{v.memberIndex}</td>
                        <td className="px-3 py-2 font-mono">
                          {v.voterRef || <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 font-mono">{v.msisdn}</td>
                        <td className="px-3 py-2 font-mono text-xs" title={v.publicKey}>
                          {v.publicKey.slice(0, 6)}…{v.publicKey.slice(-6)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteOne(v)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`Remove ${v.msisdn}`}
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-4 text-center text-sm text-muted-foreground">
                          No voters match “{search}”.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {enrolled && enrolled.length === 0 && !loadingEnrolled && (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
              <FileSpreadsheet className="size-10 opacity-40" />
              <div className="space-y-1">
                <div className="text-base font-medium text-foreground">
                  No voters yet in {activeList?.name ?? "this list"}
                </div>
                <div>
                  Start by importing a spreadsheet or typing rows in the
                  “Add voters” card above.
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {result && (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base">Next: register the community on-chain</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="lg">
              <Link to="/community">
                Register community <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ---- New list dialog ---- */}
      <Dialog
        open={showNewList}
        onClose={() => setShowNewList(false)}
        title="Create a new list"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitNewList();
          }}
          className="space-y-4"
        >
          <div>
            <label className="mb-1 block text-sm font-medium">List name</label>
            <input
              type="text"
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              placeholder="e.g. Class of 2026"
              autoFocus
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowNewList(false)}
              disabled={creatingList}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creatingList || !newListName.trim()}>
              {creatingList && <Loader2 className="size-4 animate-spin" />}
              Create list
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ---- Delete list confirm ---- */}
      <ConfirmDialog
        open={!!confirmDeleteList}
        onClose={() => setConfirmDeleteList(null)}
        onConfirm={performDeleteList}
        title={`Delete "${confirmDeleteList?.name ?? ""}"?`}
        description={`All ${confirmDeleteList?.memberCount ?? 0} voter${
          confirmDeleteList?.memberCount === 1 ? "" : "s"
        } in this list will be permanently removed from the bridge. On-chain votes already cast are not affected. This can't be undone.`}
        confirmLabel="Delete list"
        busy={busy}
      />

      {/* ---- Delete single voter confirm ---- */}
      <ConfirmDialog
        open={!!confirmDeleteOne}
        onClose={() => setConfirmDeleteOne(null)}
        onConfirm={performDeleteOne}
        title="Remove this voter?"
        description={
          confirmDeleteOne
            ? `Remove ${confirmDeleteOne.msisdn}${
                confirmDeleteOne.voterRef ? ` (${confirmDeleteOne.voterRef})` : ""
              } from ${activeList?.name ?? "the list"}. The community must be re-registered on-chain before the next ballot.`
            : ""
        }
        confirmLabel="Remove voter"
        busy={busy}
      />

      {/* ---- Delete many voters confirm ---- */}
      <ConfirmDialog
        open={confirmDeleteMany}
        onClose={() => setConfirmDeleteMany(false)}
        onConfirm={performDeleteMany}
        title={`Remove ${selected.size} voter${selected.size === 1 ? "" : "s"}?`}
        description={`This removes the selected voter${
          selected.size === 1 ? "" : "s"
        } from ${activeList?.name ?? "the list"}. The community must be re-registered on-chain before the next ballot.`}
        confirmLabel={`Remove ${selected.size}`}
        busy={busy}
      />
    </>
  );
}

/**
 * A numbered section heading used inside the "Add voters" card so the
 * organiser sees an unambiguous 1 -> 2 -> 3 flow.
 */
function SectionLabel({
  step,
  title,
  hint,
}: {
  step: number;
  title: string;
  hint?: string;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
        {step}
      </span>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {hint && (
        <span className="ml-auto text-xs text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}
