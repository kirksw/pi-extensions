import assert from "node:assert/strict";
import test from "node:test";
import { looksLog } from "../src/log-format.js";

test("log detection requires recognizable records throughout the payload", () => {
  for (const raw of ['INFO service ready\nWARN retrying\n', '[INFO] service ready\r\n', '2026-03-01 INFO ready\n', '2026-03-01T10:20:30.123Z [ERROR] failed\n']) assert.equal(looksLog(raw), true, raw);
  for (const raw of ['', 'const INFO = "message";', 'This prose mentions ERROR here.', '[link](https://example.com)', '2026-03-01 is a date in prose', 'INFO ready\nexport function run() {}', 'INFO', 'INFO ready\n\n']) assert.equal(looksLog(raw), false, raw);
});
