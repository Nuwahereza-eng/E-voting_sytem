import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  loadRegistry as loadRegistryFile,
  loadMembers as loadMembersFile,
} from "./registry.js";

// -----------------------------------------------------------------------
// Voter lists
//
// A "list" is one community roll. Each list owns its own members.json,
// members.json.secrets.json, and registry.json under
//   data/lists/<listId>/...
//
// Only one list is ACTIVE at a time. All existing endpoints operate on
// the active list; switching lists reloads the registry + members in
// place so no server restart is needed.
//
// The index file (data/lists.json) is:
//   { activeId: "<uuid>", lists: [{ id, name, createdAt }] }
// -----------------------------------------------------------------------

export interface VoterList {
  id: string;
  name: string;
  createdAt: number;
}

export interface ListsIndex {
  activeId: string;
  lists: VoterList[];
}

let index: ListsIndex | null = null;
let indexPath = "";
let dataRoot = "";

function newId(): string {
  return `list_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "list";
}

function listDir(listId: string): string {
  return path.join(dataRoot, "lists", listId);
}

/** File paths a list's data lives at. */
export function pathsForList(listId: string): { registryPath: string; membersPath: string } {
  const dir = listDir(listId);
  return {
    registryPath: path.join(dir, "registry.json"),
    membersPath: path.join(dir, "members.json"),
  };
}

function readIndex(): ListsIndex {
  if (!fs.existsSync(indexPath)) return { activeId: "", lists: [] };
  const raw = fs.readFileSync(indexPath, "utf8");
  return JSON.parse(raw) as ListsIndex;
}

function writeIndex(next: ListsIndex): void {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(next, null, 2) + "\n");
  index = next;
}

function ensureListDir(id: string): void {
  const dir = listDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const { registryPath, membersPath } = pathsForList(id);
  if (!fs.existsSync(registryPath)) fs.writeFileSync(registryPath, "{}\n");
  if (!fs.existsSync(membersPath)) fs.writeFileSync(membersPath, "[]\n");
  const secretsPath = membersPath + ".secrets.json";
  if (!fs.existsSync(secretsPath)) fs.writeFileSync(secretsPath, "[]\n");
}

/** Initialise the lists system. Migrates any pre-existing single-file
 *  registry/members from data/registry.json + data/members.json into a
 *  "Default" list so upgrades don't lose data. Called once on startup. */
export function initLists(): ListsIndex {
  // Anchor at the directory containing the legacy files.
  dataRoot = path.dirname(path.resolve(config.registryPath));
  indexPath = path.join(dataRoot, "lists.json");

  if (fs.existsSync(indexPath)) {
    index = readIndex();
    if (!index.lists.length) {
      // Corrupt / empty — treat as first-run.
      index = { activeId: "", lists: [] };
    }
  } else {
    index = { activeId: "", lists: [] };
  }

  if (index.lists.length === 0) {
    const id = "default";
    const defaultList: VoterList = { id, name: "Default", createdAt: Date.now() };
    // Create the directory but NOT the empty JSON files — we may be
    // about to copy legacy data on top of them. ensureListDir() after
    // copy fills in any missing pieces.
    fs.mkdirSync(listDir(id), { recursive: true });

    // Migrate legacy files if present.
    const legacyRegistry = path.resolve(config.registryPath);
    const legacyMembers = path.resolve(config.membersPath);
    const legacySecrets = legacyMembers + ".secrets.json";
    const { registryPath, membersPath } = pathsForList(id);
    const secretsPath = membersPath + ".secrets.json";

    if (fs.existsSync(legacyRegistry) && !fs.existsSync(registryPath)) {
      fs.copyFileSync(legacyRegistry, registryPath);
    }
    if (fs.existsSync(legacyMembers) && !fs.existsSync(membersPath)) {
      fs.copyFileSync(legacyMembers, membersPath);
    }
    if (fs.existsSync(legacySecrets) && !fs.existsSync(secretsPath)) {
      fs.copyFileSync(legacySecrets, secretsPath);
    }

    // Now backfill anything the legacy migration didn't provide.
    ensureListDir(id);

    writeIndex({ activeId: id, lists: [defaultList] });
  }

  return index!;
}

export function getIndex(): ListsIndex {
  if (!index) throw new Error("Lists not initialised");
  return index;
}

export function getActive(): VoterList {
  const i = getIndex();
  const found = i.lists.find((l) => l.id === i.activeId) ?? i.lists[0];
  if (!found) throw new Error("No lists exist");
  return found;
}

/** Create a new empty list. Returns the created list without activating it. */
export function createList(name: string): VoterList {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("List name required");
  const i = getIndex();
  if (i.lists.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`A list named "${trimmed}" already exists`);
  }
  // Make an id from the name for readability, disambiguating with a short suffix.
  const base = slugify(trimmed);
  let id = base;
  let n = 1;
  while (i.lists.some((l) => l.id === id)) {
    n += 1;
    id = `${base}-${n}`;
  }
  if (!id) id = newId();
  ensureListDir(id);
  const rec: VoterList = { id, name: trimmed, createdAt: Date.now() };
  writeIndex({ activeId: i.activeId || id, lists: [...i.lists, rec] });
  return rec;
}

/** Switch the active list and reload its registry + members. Returns
 *  the new members[] so callers can update their in-memory copy. */
export function activateList(id: string): { list: VoterList; members: string[] } {
  const i = getIndex();
  const target = i.lists.find((l) => l.id === id);
  if (!target) throw new Error(`Unknown list: ${id}`);
  ensureListDir(id);
  const { registryPath, membersPath } = pathsForList(id);
  loadRegistryFile(registryPath);
  const members = loadMembersFile(membersPath);
  writeIndex({ ...i, activeId: id });
  return { list: target, members };
}

/** Delete a list. Fails if it's the only one. If it was active,
 *  activation flips to the first remaining list. */
export function deleteList(id: string): { activeId: string; deleted: VoterList } {
  const i = getIndex();
  if (i.lists.length <= 1) throw new Error("Cannot delete the only list");
  const target = i.lists.find((l) => l.id === id);
  if (!target) throw new Error(`Unknown list: ${id}`);
  const remaining = i.lists.filter((l) => l.id !== id);
  const activeId = i.activeId === id ? remaining[0].id : i.activeId;
  writeIndex({ activeId, lists: remaining });
  // Best-effort cleanup of the on-disk directory. Never fatal.
  try {
    fs.rmSync(listDir(id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { activeId, deleted: target };
}

/** Rename a list. */
export function renameList(id: string, name: string): VoterList {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("List name required");
  const i = getIndex();
  const target = i.lists.find((l) => l.id === id);
  if (!target) throw new Error(`Unknown list: ${id}`);
  if (
    i.lists.some(
      (l) => l.id !== id && l.name.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    throw new Error(`A list named "${trimmed}" already exists`);
  }
  const updated = { ...target, name: trimmed };
  writeIndex({
    ...i,
    lists: i.lists.map((l) => (l.id === id ? updated : l)),
  });
  return updated;
}

/** Return each list plus its current member count. */
export function listsWithCounts(): Array<VoterList & { memberCount: number; active: boolean; communityId: number | null }> {
  const i = getIndex();
  return i.lists.map((l) => {
    let count = 0;
    try {
      const { membersPath } = pathsForList(l.id);
      if (fs.existsSync(membersPath)) {
        const raw = JSON.parse(fs.readFileSync(membersPath, "utf8"));
        if (Array.isArray(raw)) count = raw.length;
      }
    } catch {
      /* ignore */
    }
    return {
      ...l,
      memberCount: count,
      active: l.id === i.activeId,
      communityId: getListCommunity(l.id),
    };
  });
}

// ---------------------------------------------------------------------
// listId -> on-chain communityId binding
// ---------------------------------------------------------------------

function communityPath(listId: string): string {
  return path.join(listDir(listId), "community.json");
}

/** Read the on-chain community id this list was registered as, if any. */
export function getListCommunity(listId: string): number | null {
  const p = communityPath(listId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { communityId?: number };
    return typeof raw.communityId === "number" ? raw.communityId : null;
  } catch {
    return null;
  }
}

/** Remember which on-chain community this list corresponds to. Called
 *  by the web after a successful register_community so that later
 *  election-eligibility queries can filter by community. */
export function setListCommunity(listId: string, communityId: number): void {
  ensureListDir(listId);
  fs.writeFileSync(
    communityPath(listId),
    JSON.stringify({ communityId }, null, 2) + "\n",
  );
}

// ---------------------------------------------------------------------
// Cross-list voter search (by voterRef / national ID / student number)
// ---------------------------------------------------------------------

export interface VoterHit {
  listId: string;
  listName: string;
  communityId: number | null;
  memberIndex: number;
  publicKey: string;
  secret: string;
  msisdns: string[];
  voterRef: string;
  /** The list's full public-key roll, so callers can build a merkle
   *  proof without re-reading the file. */
  members: string[];
}

/** Find every occurrence of `ref` across every list. A voter can be on
 *  multiple lists (e.g. a national election AND a SACCO election) and
 *  we want to show them all their eligible elections at once. */
export function findVoterAcrossLists(refNormalized: string): VoterHit[] {
  const hits: VoterHit[] = [];
  const i = getIndex();
  for (const l of i.lists) {
    const { registryPath, membersPath } = pathsForList(l.id);
    if (!fs.existsSync(registryPath)) continue;
    let reg: Record<string, {
      publicKey: string;
      secret: string;
      memberIndex: number;
      voterRef?: string;
    }>;
    try {
      reg = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    } catch {
      continue;
    }
    let members: string[] = [];
    try {
      members = JSON.parse(fs.readFileSync(membersPath, "utf8"));
    } catch {
      /* ignore */
    }
    const msisdnsByIdx = new Map<number, string[]>();
    let matched: { publicKey: string; secret: string; memberIndex: number; voterRef?: string } | null = null;
    for (const [msisdn, rec] of Object.entries(reg)) {
      if (rec.voterRef === refNormalized) {
        matched = rec;
        const arr = msisdnsByIdx.get(rec.memberIndex) ?? [];
        arr.push(msisdn);
        msisdnsByIdx.set(rec.memberIndex, arr);
      }
    }
    if (!matched) continue;
    hits.push({
      listId: l.id,
      listName: l.name,
      communityId: getListCommunity(l.id),
      memberIndex: matched.memberIndex,
      publicKey: matched.publicKey,
      secret: matched.secret,
      msisdns: msisdnsByIdx.get(matched.memberIndex) ?? [],
      voterRef: refNormalized,
      members,
    });
  }
  return hits;
}
