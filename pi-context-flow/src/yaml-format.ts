import { parseDocument } from "yaml";

/** Automatic capture must validate the whole document, not one prose-like line. */
export function looksYaml(raw: string, conservative = false): boolean {
  if (!/^(?:---\s*$|[A-Za-z_][\w-]*:\s*[^\n]*)/m.test(raw)) return false;
  try {
    const document = parseDocument(raw, { prettyErrors: false });
    if (document.errors.length || document.warnings.length) return false;
    const value = document.toJS({ maxAliasCount: 0 });
    if (value === null || typeof value !== "object") return false;
    // One scalar field with continuation is indistinguishable from prose/stack traces.
    if (conservative && !Array.isArray(value)) {
      const values = Object.values(value);
      if (values.length === 1 && (values[0] === null || typeof values[0] !== "object")) return false;
    }
    return true;
  } catch { return false; }
}
