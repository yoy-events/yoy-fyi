// Minimal RFC 4180 CSV for importing and exporting links.

// Rows of cells; blank lines are skipped. A leading UTF-8 BOM (Excel) is ignored.
export function parseCsv(text: string): string[][] | { error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    cell = "";
  };
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (quoted) return { error: "Unclosed quote in the CSV." };
  if (cell !== "" || row.length) endRow();
  return rows;
}

// A cell starting with = + - or @ is prefixed with ' so spreadsheets show it instead of running it.
const cellText = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const toCsv = (rows: unknown[][]) => rows.map((r) => `${r.map(cellText).join(",")}\r\n`).join("");
