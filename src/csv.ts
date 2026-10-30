// Minimal RFC 4180 CSV for importing and exporting links.

// Rows of cells; blank lines are skipped. A leading UTF-8 BOM (Excel) is ignored. `lines`, when
// given, gets the line each row starts on, so messages can point at the file's own lines.
export function parseCsv(text: string, lines: number[] = []): string[][] | { error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") {
      rows.push(row);
      lines.push(rowLine);
    }
    row = [];
    cell = "";
  };
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
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
      if (ch === "\r" && text[i + 1] === "\n") {
        i++;
        line++;
      }
      endRow();
      rowLine = line;
    } else cell += ch;
  }
  if (quoted) return { error: "У CSV не закрита лапка." };
  if (cell !== "" || row.length) endRow();
  return rows;
}

// A cell a spreadsheet could run as a formula (= + - @, also after leading whitespace, or one
// starting with a tab, CR or |) is prefixed with ' so it is shown instead.
const cellText = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^(\s*[=+\-@]|[\t\r|])/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const toCsv = (rows: unknown[][]) => rows.map((r) => `${r.map(cellText).join(",")}\r\n`).join("");
