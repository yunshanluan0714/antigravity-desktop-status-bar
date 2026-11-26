'use strict';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wal-test-'));
const originalHome = os.homedir;
const id = 'aaaaaaaa-0000-4000-8000-000000000001';
const base = path.join(home, '.gemini', 'antigravity');
const dir = path.join(base, 'conversations');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, id + '.db');
const writer = new DatabaseSync(file);
try {
  os.homedir = () => home;
  const { snapshotForId } = require('../wrapper/lib/store');
  const usage = (output) => Buffer.from([10, 8, 34, 6, 16, 10, 24, output, 40, 3]);
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY);
  `);
  writer.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run(id, id);
  const insert = writer.prepare('INSERT INTO gen_metadata (data) VALUES (?)');
  insert.run(usage(2));
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = fs.readFileSync(file);
  const total = () => {
    const snapshot = snapshotForId(id);
    assert.equal(snapshot.ok, true, snapshot.error);
    return snapshot.tokens.total;
  };
  assert.equal(total(), 15);
  writer.exec('BEGIN');
  insert.run(usage(7));
  assert.equal(total(), 15, 'uncommitted writes are excluded');
  writer.exec('COMMIT');
  assert.deepEqual(fs.readFileSync(file), before, 'WAL was not checkpointed');
  assert.ok(fs.statSync(file + '-wal').size > 32);
  assert.equal(total(), 35, 'first committed WAL update is read without checkpoint');
  insert.run(usage(9));
  assert.equal(total(), 57, 'new WAL commit invalidates cache');
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(total(), 57, 'checkpoint does not double-count tokens');
  console.log('PASS: committed WAL updates are visible instantly; uncommitted writes are excluded.');
} finally {
  os.homedir = originalHome;
  writer.close();
  fs.rmSync(home, { recursive: true, force: true });
}
