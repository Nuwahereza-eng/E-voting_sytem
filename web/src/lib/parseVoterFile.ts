import * as XLSX from "xlsx";

// A single parsed voter row from any imported file.
export interface ParsedVoter {
  name: string;
  msisdn: string;
  voterRef: string;
}

// Header aliases we accept in row 1 of an .xlsx / .csv upload. Everything
// is case- and whitespace-insensitive. Any column whose header matches
// one of these lists is mapped to the corresponding field; unknown
// columns are ignored.
const HEADER_ALIASES: Record<keyof ParsedVoter, string[]> = {
  msisdn: ["msisdn", "phone", "phonenumber", "phone number", "mobile", "cell", "tel", "telephone"],
  name: ["name", "fullname", "full name", "voter", "voter name"],
  voterRef: [
    "voterref",
    "voter ref",
    "ref",
    "reference",
    "id",
    "national id",
    "nationalid",
    "student id",
    "studentid",
    "student number",
    "studentnumber",
    "membership",
    "membership number",
    "member id",
    "member number",
  ],
};

function normHeader(h: string): string {
  return h.toString().trim().toLowerCase().replace(/[_\-.]/g, " ").replace(/\s+/g, " ");
}

function fieldFor(header: string): keyof ParsedVoter | null {
  const key = normHeader(header);
  const keyNoSpaces = key.replace(/\s+/g, "");
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [
    keyof ParsedVoter,
    string[],
  ][]) {
    for (const a of aliases) {
      if (key === a || keyNoSpaces === a.replace(/\s+/g, "")) return field;
    }
  }
  return null;
}

// Best-effort phone detector for header-less spreadsheets. A phone starts
// with `+` or with 8+ digits.
function looksLikePhone(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).replace(/[^\d+]/g, "");
  return /^\+?\d{7,}$/.test(s);
}

// Parse the first non-empty sheet of an xlsx/xls/csv workbook. Returns
// an array of ParsedVoter rows. If the first row looks like a header
// (contains at least one recognised alias), we treat it as such and use
// column names to map fields. Otherwise we fall back to positional
// parsing: first column that looks like a phone → msisdn, the two other
// non-phone columns → name and voterRef in that order.
function parseSheet(sheet: XLSX.WorkSheet): ParsedVoter[] {
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
  });
  if (rows.length === 0) return [];

  // Detect header row: at least one cell must match a known alias.
  const first = rows[0].map((c) => String(c ?? "").trim());
  const headerMap = first.map((h) => fieldFor(h));
  const hasHeader = headerMap.some((f) => f !== null);

  const dataRows = hasHeader ? rows.slice(1) : rows;

  const out: ParsedVoter[] = [];
  for (const raw of dataRows) {
    const cells = raw.map((c) => (c == null ? "" : String(c).trim()));
    if (cells.every((c) => c === "")) continue;

    let row: ParsedVoter = { name: "", msisdn: "", voterRef: "" };

    if (hasHeader) {
      for (let i = 0; i < headerMap.length; i++) {
        const field = headerMap[i];
        if (!field) continue;
        row[field] = cells[i] ?? "";
      }
    } else {
      const phoneIdx = cells.findIndex(looksLikePhone);
      row.msisdn = phoneIdx >= 0 ? cells[phoneIdx] : "";
      const rest = cells.filter((_, i) => i !== phoneIdx);
      row.name = rest[0] ?? "";
      row.voterRef = rest[1] ?? "";
    }

    row.msisdn = row.msisdn.replace(/[^\d+]/g, "");
    if (row.msisdn) out.push(row);
  }
  return out;
}

// Parse a File dropped or selected by the organiser. Supports .xlsx,
// .xls, .csv, .tsv, and anything SheetJS can read.
export async function parseVoterFile(file: File): Promise<ParsedVoter[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  if (wb.SheetNames.length === 0) return [];
  // Prefer the first sheet that yields any rows; falls back to the first
  // sheet so an empty file returns [].
  for (const name of wb.SheetNames) {
    const parsed = parseSheet(wb.Sheets[name]);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

// Parse a pasted CSV/TSV string using the same rules as the file parser.
export function parseVoterCsv(text: string): ParsedVoter[] {
  const wb = XLSX.read(text, { type: "string" });
  if (wb.SheetNames.length === 0) return [];
  return parseSheet(wb.Sheets[wb.SheetNames[0]]);
}
