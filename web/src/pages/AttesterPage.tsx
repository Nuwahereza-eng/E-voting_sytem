import { useEffect, useState } from "react";
import {
  BadgeCheck,
  Check,
  Fingerprint,
  Loader2,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
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
import { useWallet } from "../wallet";
import { config } from "../config";
import {
  attestPerson,
  authorizeAttester,
  computeNullifier,
  deauthorizeAttester,
  isPerson,
  readAttesterInfo,
  readCurator,
  readPersonInfo,
  revokePerson,
  type AttesterInfo,
  type PersonEntry,
} from "../registry";

// ---------- helpers --------------------------------------------------------

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function formatDate(unix: number): string {
  if (!unix) return "-";
  return new Date(unix * 1000).toLocaleString();
}

// Default expiry: 1 year from now, formatted for <input type="datetime-local">.
function defaultExpiry(): string {
  const d = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- page -----------------------------------------------------------

// Proof-of-personhood console. Three audiences, one page:
//   - The **curator** (contract admin): authorise / revoke attesters.
//   - An **attester** (KYC gateway operator, in-person enroller):
//     issue personhood attestations for real people.
//   - Anyone: look up whether an address has been verified as a real human.
export function AttesterPage() {
  const wallet = useWallet();

  const [curator, setCurator] = useState<string | null>(null);
  const [myAttester, setMyAttester] = useState<AttesterInfo | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Refresh on wallet change or after any successful write.
  useEffect(() => {
    let cancelled = false;
    readCurator().then((c) => {
      if (!cancelled) setCurator(c);
    });
    if (wallet.address) {
      readAttesterInfo(wallet.address).then((a) => {
        if (!cancelled) setMyAttester(a);
      });
    } else {
      setMyAttester(null);
    }
    return () => {
      cancelled = true;
    };
  }, [wallet.address, refreshCounter]);

  const isCurator =
    !!curator && !!wallet.address && curator === wallet.address;
  const iAmActiveAttester = !!myAttester && !myAttester.deauthorized;

  return (
    <>
      <PageHeader
        backTo="/organise"
        backLabel="Organise"
        title="Proof-of-Personhood"
        subtitle="Attest that a Stellar address belongs to a real, unique human — without putting any PII on-chain."
      />

      {!config.registryId && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <strong>Registry not configured.</strong> Set{" "}
          <code>VITE_REGISTRY_ID</code> in <code>web/.env</code> to the deployed
          registry contract ID and reload.
        </div>
      )}

      {/* Who am I on this page? */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Your role</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!wallet.address ? (
            <div className="flex items-center gap-3">
              <Button onClick={wallet.connect} disabled={wallet.connecting}>
                {wallet.connecting ? "Connecting…" : "Connect Freighter"}
              </Button>
              <span className="text-sm text-muted-foreground">
                Connect a wallet to see which actions you can perform.
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground">
                {short(wallet.address)}
              </span>
              {isCurator && (
                <Badge variant="success" className="gap-1">
                  <ShieldCheck className="size-3" /> Curator
                </Badge>
              )}
              {iAmActiveAttester && (
                <Badge variant="secondary" className="gap-1">
                  <BadgeCheck className="size-3" /> Attester · {myAttester!.name}
                </Badge>
              )}
              {myAttester?.deauthorized && (
                <Badge variant="destructive" className="gap-1">
                  <ShieldAlert className="size-3" /> Deauthorised attester
                </Badge>
              )}
              {!isCurator && !myAttester && (
                <span className="text-muted-foreground">
                  You can look up personhood status below, but only the curator
                  and authorised attesters can write to the registry.
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Public lookup — always available. */}
      <LookupCard />

      {/* Attester actions — only useful if the wallet is an active attester. */}
      {iAmActiveAttester && (
        <AttesterActions
          attester={wallet.address!}
          sign={wallet.sign}
          onChange={() => setRefreshCounter((n) => n + 1)}
        />
      )}

      {/* Curator actions — only useful if the wallet is the curator. */}
      {isCurator && (
        <CuratorActions
          curator={wallet.address!}
          sign={wallet.sign}
          onChange={() => setRefreshCounter((n) => n + 1)}
        />
      )}
    </>
  );
}

// ---------- Lookup ---------------------------------------------------------

function LookupCard() {
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    subject: string;
    verified: boolean;
    entry: PersonEntry | null;
    attester: AttesterInfo | null;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function doLookup() {
    if (!subject.trim()) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const verified = await isPerson(subject.trim());
      const entry = await readPersonInfo(subject.trim());
      const attesterInfo = entry ? await readAttesterInfo(entry.attester) : null;
      setResult({ subject: subject.trim(), verified, entry, attester: attesterInfo });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Lookup — is this address a verified human?</CardTitle>
        <CardDescription>
          Anyone can check. Returns true only if a live, non-revoked personhood
          attestation exists and the issuing attester is still authorised.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="G… Stellar address"
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            onKeyDown={(e) => e.key === "Enter" && doLookup()}
          />
          <Button onClick={doLookup} disabled={busy || !subject.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            Check
          </Button>
        </div>

        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}

        {result && (
          <div
            className={`rounded-md border px-3 py-3 text-sm ${
              result.verified
                ? "border-success/40 bg-success/10"
                : "border-border/60 bg-muted/40"
            }`}
          >
            <div className="mb-2 flex items-center gap-2">
              {result.verified ? (
                <>
                  <UserCheck className="size-5 text-success" />
                  <span className="font-medium text-success">Verified human</span>
                </>
              ) : (
                <>
                  <UserX className="size-5 text-muted-foreground" />
                  <span className="font-medium">Not verified</span>
                </>
              )}
              <code className="ml-auto text-xs text-muted-foreground">
                {short(result.subject)}
              </code>
            </div>

            {result.entry ? (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Attester</dt>
                <dd className="font-mono">
                  {result.attester?.name ?? short(result.entry.attester)}
                </dd>
                <dt className="text-muted-foreground">Scheme</dt>
                <dd>{result.entry.scheme}</dd>
                <dt className="text-muted-foreground">Issued</dt>
                <dd>{formatDate(result.entry.issuedAt)}</dd>
                <dt className="text-muted-foreground">Expires</dt>
                <dd>{formatDate(result.entry.expiresAt)}</dd>
                <dt className="text-muted-foreground">Revoked</dt>
                <dd>{result.entry.revoked ? "yes" : "no"}</dd>
                <dt className="text-muted-foreground">Nullifier</dt>
                <dd className="truncate font-mono" title={result.entry.nullifier}>
                  {result.entry.nullifier.slice(0, 16)}…
                </dd>
              </dl>
            ) : (
              <div className="text-xs text-muted-foreground">
                No personhood attestation on file for this address.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Attester actions -----------------------------------------------

function AttesterActions({
  attester,
  sign,
  onChange,
}: {
  attester: string;
  sign: ReturnType<typeof useWallet>["sign"];
  onChange: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [offchainId, setOffchainId] = useState("");
  const [salt, setSalt] = useState("");
  const [scheme, setScheme] = useState("nin-v1");
  const [expiryLocal, setExpiryLocal] = useState<string>(defaultExpiry);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>("");

  async function updatePreview(nextId: string, nextSalt: string) {
    if (!nextId || !nextSalt) {
      setPreview("");
      return;
    }
    try {
      const n = await computeNullifier(nextId, nextSalt);
      setPreview(n);
    } catch {
      setPreview("");
    }
  }

  async function doAttest() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (!subject.trim()) throw new Error("Subject address required.");
      if (!offchainId.trim()) throw new Error("Off-chain identifier required.");
      if (!salt.trim())
        throw new Error("Attester salt required (keep this secret in your systems).");
      const expiresAt = Math.floor(new Date(expiryLocal).getTime() / 1000);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) {
        throw new Error("Expiry must be a future date/time.");
      }
      const nullifier = await computeNullifier(offchainId.trim(), salt);
      await attestPerson(attester, subject.trim(), nullifier, scheme.trim(), expiresAt, sign);
      setMsg(`Attested ${short(subject.trim())} as a verified human until ${formatDate(expiresAt)}.`);
      setSubject("");
      setOffchainId("");
      // keep salt + scheme — they're per-enroller stable
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRevoke() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (!subject.trim()) throw new Error("Enter the subject address to revoke.");
      await revokePerson(attester, subject.trim(), sign);
      setMsg(`Revoked personhood attestation for ${short(subject.trim())}.`);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Fingerprint className="size-4" />
          Attester console — issue a personhood attestation
        </CardTitle>
        <CardDescription>
          You (an authorised attester) bind a Stellar address to a real, unique
          human. The off-chain identifier + your secret salt are hashed
          <em> in the browser</em>; only the 32-byte nullifier reaches the chain.
          Same identifier + same salt = same nullifier, so a second address
          trying to use the same identity is rejected on-chain.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Subject Stellar address</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="G… (the human's wallet)"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Scheme label</label>
            <input
              value={scheme}
              onChange={(e) => setScheme(e.target.value)}
              placeholder="nin-v1, biometric-in-person, world-id-orb…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Off-chain identifier
            </label>
            <input
              value={offchainId}
              onChange={(e) => {
                setOffchainId(e.target.value);
                updatePreview(e.target.value, salt);
              }}
              placeholder="NIN number, passport number, etc."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Never leaves this browser. Hashed before submit.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Attester salt</label>
            <input
              value={salt}
              onChange={(e) => {
                setSalt(e.target.value);
                updatePreview(offchainId, e.target.value);
              }}
              type="password"
              placeholder="Long random string, kept secret by your agency"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Prevents cross-attester linkability. Persist per-agency in your
              own systems.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Expires at</label>
            <input
              type="datetime-local"
              value={expiryLocal}
              onChange={(e) => setExpiryLocal(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Nullifier preview</label>
            <div className="rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
              {preview ? preview : <span className="text-muted-foreground">…</span>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={doAttest} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            <UserCheck className="size-4" /> Attest as human
          </Button>
          <Button onClick={doRevoke} variant="destructive" disabled={busy}>
            <UserX className="size-4" /> Revoke this subject
          </Button>
        </div>

        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}
        {msg && (
          <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
            {msg}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Curator actions ------------------------------------------------

function CuratorActions({
  curator,
  sign,
  onChange,
}: {
  curator: string;
  sign: ReturnType<typeof useWallet>["sign"];
  onChange: () => void;
}) {
  const [addr, setAddr] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lookup, setLookup] = useState<AttesterInfo | null>(null);
  const [lookupChecked, setLookupChecked] = useState(false);

  async function refreshLookup(a: string) {
    if (!a) {
      setLookup(null);
      setLookupChecked(false);
      return;
    }
    const info = await readAttesterInfo(a);
    setLookup(info);
    setLookupChecked(true);
  }

  async function doAuthorize() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (!addr.trim() || !name.trim() || !url.trim()) {
        throw new Error("All three fields required.");
      }
      await authorizeAttester(curator, addr.trim(), name.trim(), url.trim(), sign);
      setMsg(`Authorised ${short(addr.trim())} as attester "${name.trim()}".`);
      onChange();
      refreshLookup(addr.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doDeauthorize() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (!addr.trim()) throw new Error("Attester address required.");
      const ok = window.confirm(
        `Deauthorise ${short(addr.trim())}?\n\n` +
          `Every personhood attestation they issued will start returning false ` +
          `from is_person(). Existing records stay on-chain for audit.`,
      );
      if (!ok) return;
      await deauthorizeAttester(curator, addr.trim(), sign);
      setMsg(`Deauthorised ${short(addr.trim())}.`);
      onChange();
      refreshLookup(addr.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="size-4" />
          Curator console — manage attesters
        </CardTitle>
        <CardDescription>
          Only the curator can add or revoke attesters. Attesters are the
          issuers you trust to bind Stellar addresses to real humans.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium">Attester address</label>
            <input
              value={addr}
              onChange={(e) => {
                setAddr(e.target.value);
                setLookupChecked(false);
              }}
              onBlur={(e) => refreshLookup(e.target.value.trim())}
              placeholder="G… (the KYC gateway / enroller wallet)"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
            {lookupChecked && lookup && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <Badge variant={lookup.deauthorized ? "destructive" : "success"} className="gap-1">
                  {lookup.deauthorized ? (
                    <X className="size-3" />
                  ) : (
                    <Check className="size-3" />
                  )}
                  {lookup.deauthorized ? "currently deauthorised" : "currently authorised"}
                </Badge>
                <span className="text-muted-foreground">
                  {lookup.name} · added {formatDate(lookup.addedAt)}
                </span>
              </div>
            )}
            {lookupChecked && !lookup && addr.trim() && (
              <div className="mt-2 text-xs text-muted-foreground">
                No prior record for this address.
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Display name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Uganda NIRA gateway"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Methodology URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://nira.go.ug/verify"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={doAuthorize} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            <ShieldCheck className="size-4" /> Authorise
          </Button>
          <Button onClick={doDeauthorize} disabled={busy} variant="destructive">
            <ShieldAlert className="size-4" /> Deauthorise
          </Button>
        </div>

        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}
        {msg && (
          <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
            {msg}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
