// Minimal CSV parser shared by admin import flows.
//
// Handles quoted fields with commas, escaped double quotes,
// CRLF/LF endings, leading UTF-8 BOM. Sufficient for the
// admin-prepared CSVs we see in practice (Numbers / Excel / Google
// Sheets exports).

export function parseCsv(text: string): string[][] {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      cur.push(field);
      if (!(cur.length === 1 && cur[0] === "")) {
        rows.push(cur);
      }
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

export function indexHeaders(headerRow: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const norm = headerRow[i].trim().toLowerCase();
    if (norm) map[norm] = i;
  }
  return map;
}

export function getCol(
  row: string[],
  headerIdx: Record<string, number>,
  name: string,
): string | null {
  const i = headerIdx[name];
  if (i === undefined) return null;
  const v = row[i];
  if (v === undefined) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}
