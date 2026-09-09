// Only complete record-shaped lines qualify; isolated severity words are not log evidence.
const RECORD = /^(?:(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)[ \t]+(?:\[(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\]|(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL))|\[(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\]|(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL))[ \t]+\S/;

export function looksLog(raw: string): boolean {
  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length > 0 && lines.every((line) => RECORD.test(line));
}
