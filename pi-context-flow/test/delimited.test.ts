import assert from "node:assert/strict";
import test from "node:test";
import { looksDelimited } from "../src/delimited.js";

test("automatic delimited detection validates complete quote-aware tables", () => {
  for (const raw of ['id,state\n1,open\n', 'id,state\r\n1,open', '"id","state"\n1,"open, pending"\n', 'id,state\n1,"multi\nline"\n', 'id,state\n1,"escaped ""quote"""\n', 'id,state\n1,\n']) {
    assert.equal(looksDelimited(raw, ","), true, raw);
  }
  assert.equal(looksDelimited('id\tstate\n1\topen\n', "\t"), true);
  for (const raw of ['id,state\n1,open\n2,closed\nnot a record', 'id,state\n1,"unclosed', 'id,state\n1,"value"junk', 'id,state\n1,un"quoted', 'id,id\n1,2', 'id,state\n\n1,open', 'First sentence, with a comma.\nSecond sentence, with another.']) {
    assert.equal(looksDelimited(raw, ","), false, raw);
  }
});
