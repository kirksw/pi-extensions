/** Conservative automatic detection, not a general CSV parser: ambiguous text stays inline. */
export function looksDelimited(raw: string, delimiter: "," | "\t"): boolean {
  let columns = 0;
  let rows = 0;
  let field = "";
  let fields: string[] = [];
  let quoted = false;
  let afterQuote = false;
  let rowStarted = false;
  const endField = () => { fields.push(field); field = ""; afterQuote = false; };
  const endRow = () => {
    endField();
    if (rows === 0) {
      // A simple, unique header avoids treating ordinary comma-rich sentences as a table.
      if (fields.length < 2 || fields.some((value) => !/^[A-Za-z_][A-Za-z0-9_ .-]{0,127}$/.test(value)) || new Set(fields).size !== fields.length) return false;
      columns = fields.length;
    } else if (fields.length !== columns) return false;
    rows++;
    fields = [];
    rowStarted = false;
    return true;
  };
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quoted) {
      if (char === '"') {
        if (raw[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else field += char;
      continue;
    }
    if (char === delimiter) { endField(); rowStarted = true; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && raw[index + 1] === "\n") index++;
      if (!rowStarted || !endRow()) return false;
    } else if (afterQuote) return false;
    else if (char === '"') {
      if (field.length) return false;
      quoted = true; rowStarted = true;
    } else { field += char; rowStarted = true; }
  }
  if (quoted || (rowStarted && !endRow())) return false;
  return rows >= 2;
}
