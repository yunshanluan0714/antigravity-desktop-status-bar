'use strict';
// Official gen_metadata carries time_to_first_token (f11) and streaming_duration
// (f12); measured f11+f12 equals the step wall time in every row.
// Regression: an early build used steps.viewable_at as the decode start and
// reported 1510 tok/s. Now stream speed uses f12, and a buffered flush that
// exceeds the plausibility ceiling falls back to end-to-end speed.
const assert = require('node:assert/strict');
const path = require('node:path');
const conversation = require(path.join(__dirname, '..', 'wrapper', 'lib', 'conversation'));

function varint(value) {
  const out = [];
  do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value);
  return Buffer.from(out);
}
function field(fieldNumber, wireType, payload) {
  return wireType === 2
    ? Buffer.concat([varint(fieldNumber << 3 | wireType), varint(payload.length), payload])
    : Buffer.concat([varint(fieldNumber << 3 | wireType), payload]);
}
// Timestamp and Duration share { seconds: 1, nanos: 2 }.
function duration(ms) {
  return Buffer.concat([
    field(1, 0, varint(Math.trunc(ms / 1000))),
    field(2, 0, varint(Math.round(ms % 1000 * 1e6))),
  ]);
}
function step({ created, end, out }) {
  return Buffer.concat([
    field(1, 2, duration(created)),
    field(7, 2, duration(end)),
    field(8, 2, duration(end)),
    field(9, 2, Buffer.concat([field(3, 0, varint(out))])),
  ]);
}
function gen({ out, ttftMs, streamMs }) {
  const usage = Buffer.concat([
    field(1, 0, varint(1668)), field(2, 0, varint(1000)), field(3, 0, varint(out)),
  ]);
  return Buffer.concat([field(1, 2, Buffer.concat([
    field(3, 0, varint(1668)),
    field(4, 2, usage),
    field(11, 2, duration(ttftMs)),
    field(12, 2, duration(streamMs)),
  ]))]);
}

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-speed-'));
const file = path.join(dir, 'fixture.db');
const writer = new DatabaseSync(file);
writer.exec("CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);\nCREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);\nCREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB, step_payload BLOB, step_format INTEGER)");
const stepInsert = writer.prepare('INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata) VALUES (?, 15, 3, 0, ?)');
const genInsert = writer.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
const base = 1_700_000_000_000;
// Buffered flush: 900 tokens in a 300 ms stream window — implausible, falls back.
stepInsert.run(1, step({ created: base, end: base + 2300, out: 900 }));
genInsert.run(1, gen({ out: 900, ttftMs: 2000, streamMs: 300 }));
// Ordinary generation: 2770 tokens, 21.9 s to first token, 10.3 s of streaming.
stepInsert.run(2, step({ created: base + 10000, end: base + 42243, out: 2770 }));
genInsert.run(2, gen({ out: 2770, ttftMs: 21905, streamMs: 10338 }));
writer.close();

const parsed = conversation.parseConversationDb(fs.readFileSync(file));
assert.equal(parsed.agentSteps, 2);
assert.ok(Math.abs(parsed.latestSpeed.stream - 2770 * 1000 / 10338) < 0.01, 'latest stream=' + parsed.latestSpeed.stream);
assert.ok(Math.abs(parsed.latestSpeed.endToEnd - 2770 * 1000 / 32243) < 0.01);
assert.equal(parsed.latestSpeed.show, parsed.latestSpeed.stream);
assert.equal(parsed.latestSpeed.output, 2770);
assert.ok(parsed.latestSpeed.ttftMs > 20000 && parsed.latestSpeed.streamMs > 10000);
fs.rmSync(dir, { recursive: true, force: true });

// Single buffered generation: 900 tok / 300 ms = 3000 tok/s is not believable.
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-speed-flush-'));
const file2 = path.join(dir2, 'fixture.db');
const w2 = new DatabaseSync(file2);
w2.exec("CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);\nCREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);\nCREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB, step_payload BLOB, step_format INTEGER)");
w2.prepare('INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata) VALUES (?, 15, 3, 0, ?)').run(1, step({ created: base, end: base + 2300, out: 900 }));
w2.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, gen({ out: 900, ttftMs: 2000, streamMs: 300 }));
w2.close();
const flushed = conversation.parseConversationDb(fs.readFileSync(file2));
assert.ok(flushed.latestSpeed.stream > 1000, 'stream=' + flushed.latestSpeed.stream);
assert.ok(Math.abs(flushed.latestSpeed.show - 900 * 1000 / 2300) < 0.01, 'show=' + flushed.latestSpeed.show);
fs.rmSync(dir2, { recursive: true, force: true });
console.log('PASS: stream speed uses streaming_duration and falls back to end-to-end when buffered.');
