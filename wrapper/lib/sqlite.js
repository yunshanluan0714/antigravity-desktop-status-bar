'use strict';
/**
 * Minimal read-only SQLite reader for one in-memory snapshot of a database file.
 *
 * 只支持本扩展需要的操作：
 *  - 读取 sqlite_master，按名字找表/索引的 rootpage
 *  - 顺序遍历表 b-tree（逐行回调，返回 true 可提前终止）
 *  - 遍历索引 b-tree（拿到索引列值 + rowid）
 *  - 按 rowid 精确查找表中的某一行（利用内部节点键范围下钻）
 *
 * 设计约束：任何解析失败都抛出普通 Error，由上层 store 捕获并降级，
 * 绝不让扩展宿主崩溃。只读主 .db 文件（WAL 模式下主文件是上次
 * checkpoint 的一致性快照，可能略旧但不撕裂）。
 */

const fs = require('node:fs');

const HEADER_MAGIC = 'SQLite format 3\0';

function fail(message) {
  throw new Error(`sqlite-reader: ${message}`);
}

function readVarint(buf, offset) {
  let result = 0;
  let i = offset;
  for (let count = 0; count < 9; count += 1) {
    const byte = buf[i];
    i += 1;
    if (count === 8) {
      // 第 9 个字节贡献全部 8 位
      result = result * 256 + byte;
    } else {
      result = result * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    if (i >= buf.length) fail('varint 越界');
  }
  return { value: result, end: i };
}

function serialSize(serialType) {
  if (serialType >= 12) {
    return (serialType - 12) >> 1; // blob/text：偶/奇长度公式相同（ (n-12)/2 与 (n-13)/2 均等于此向下取整再修正 )
  }
  switch (serialType) {
    case 0: case 8: case 9: return 0;
    case 1: return 1;
    case 2: return 2;
    case 3: return 3;
    case 4: return 4;
    case 5: return 6;
    case 6: case 7: return 8;
    case 10: case 11: return 0; // 保留类型，按零长处理（真实库中不出现）
    default: fail(`未知 serial type ${serialType}`);
  }
  return 0;
}

function readInt(buf, offset, size) {
  let value = 0;
  for (let i = 0; i < size; i += 1) {
    value = value * 256 + buf[offset + i];
  }
  const bits = size * 8;
  if (size < 8 && value >= 2 ** (bits - 1)) value -= 2 ** bits; // 有符号
  return value;
}

/**
 * 解析一条记录（record）。返回数组，blob/text 以 Buffer/字符串给出，
 * 未读取的列给 undefined 占位。传 `want`（列号集合）可跳过不需要的列。
 */
function readRecord(buf, offset = 0, want) {
  const headerSize = readVarint(buf, offset);
  const headerEnd = offset + headerSize.value;
  const serialTypes = [];
  let h = offset + 1; // 跳过 1 字节的 varint 头长（头长恒 < 128）
  while (h < headerEnd) {
    const t = readVarint(buf, h);
    serialTypes.push(t.value);
    h = t.end;
  }
  const values = new Array(serialTypes.length);
  let p = headerEnd;
  for (let col = 0; col < serialTypes.length; col += 1) {
    const st = serialTypes[col];
    let size = st >= 12
      ? ((st & 1) === 1 ? (st - 13) / 2 : (st - 12) / 2)
      : serialSize(st);
    const needed = want === undefined || want.has(col);
    if (st === 0) {
      if (needed) values[col] = null;
    } else if (st === 8) {
      if (needed) values[col] = 0;
    } else if (st === 9) {
      if (needed) values[col] = 1;
    } else if (st >= 1 && st <= 6) {
      if (needed) values[col] = readInt(buf, p, size);
    } else if (st === 7) {
      if (needed) values[col] = buf.readDoubleBE(p);
    } else if (st >= 12 && (st & 1) === 0) {
      if (needed) values[col] = buf.slice(p, p + size);
    } else if (st >= 13) {
      if (needed) values[col] = buf.slice(p, p + size).toString('utf8');
    }
    p += size;
  }
  return { values, end: p };
}

function open(buffer) {
  if (buffer.length < 100 || buffer.toString('latin1', 0, 16) !== HEADER_MAGIC) {
    fail('不是 SQLite 3 数据库文件');
  }
  const pageSize = buffer.readUInt16BE(16);
  const reservedPerPage = buffer.readUInt8(20);
  const textEncoding = buffer.readUInt32BE(56);
  if (textEncoding !== 1) fail('仅支持 UTF-8 编码的数据库');

  const usable = pageSize - reservedPerPage;
  const pageCount = Math.floor(buffer.length / pageSize);

  const page = (pgno) => {
    if (pgno < 1 || pgno > pageCount) fail(`页号越界 ${pgno}`);
    return buffer.slice((pgno - 1) * pageSize, pgno * pageSize);
  };

  /** 读溢出链，拼接 payload。local 是本页内的字节数。 */
  function readOverflow(firstPage, totalSize, localBuf, localOffset, localSize) {
    const parts = [localBuf.slice(localOffset, localOffset + localSize)];
    let remaining = totalSize - localSize;
    let pgno = firstPage;
    const seen = new Set();
    while (remaining > 0 && pgno !== 0) {
      if (seen.has(pgno)) fail('溢出链成环');
      seen.add(pgno);
      const pageBuf = page(pgno);
      const next = pageBuf.readUInt32BE(0);
      const chunk = Math.min(remaining, usable - 4);
      parts.push(pageBuf.slice(4, 4 + chunk));
      remaining -= chunk;
      pgno = next;
    }
    if (remaining > 0) fail('溢出链不完整');
    return Buffer.concat(parts);
  }

  /** 计算 b-tree cell 里 payload 的本页字节数（区分表/索引）。 */
  function localPayloadSize(total, isTable) {
    if (total <= usable - 35) return total;
    const minLocal = isTable
      ? Math.floor(((usable - 12) * 32) / 255) - 23
      : Math.floor(((usable - 12) * 64) / 255) - 23;
    const maxLocal = isTable ? usable - 35 : minLocal;
    let local = minLocal + ((total - minLocal) % (usable - 4));
    if (local > maxLocal) local = minLocal;
    return local;
  }

  /** 解析 cell 拿到完整 payload Buffer（已拼好溢出）。 */
  function cellPayload(pageBuf, cellOffset, isTable) {
    const payloadSize = readVarint(pageBuf, cellOffset);
    const local = localPayloadSize(payloadSize.value, isTable);
    const dataStart = payloadSize.end + local;
    if (local === payloadSize.value) {
      return pageBuf.slice(payloadSize.end, dataStart);
    }
    const overflowPage = pageBuf.readUInt32BE(dataStart);
    return readOverflow(overflowPage, payloadSize.value, pageBuf, payloadSize.end, local);
  }

  /** 遍历表 b-tree，cb(rowid, values) 返回 true 时提前终止。 */
  function walkTable(rootPage, cb) {
    const seen = new Set();
    function visit(pgno) {
      if (seen.has(pgno)) fail('表 b-tree 成环');
      seen.add(pgno);
      const buf = page(pgno);
      const base = pgno === 1 ? 100 : 0;
      const type = buf.readUInt8(base);
      const cellCount = buf.readUInt16BE(base + 3);
      const headerLen = (type === 2 || type === 5) ? 12 : 8;
      if (type === 5) {
        const rightMost = buf.readUInt32BE(base + 8);
        for (let i = 0; i < cellCount; i += 1) {
          const cellOffset = buf.readUInt16BE(base + headerLen + i * 2);
          const child = buf.readUInt32BE(cellOffset);
          visit(child);
        }
        visit(rightMost);
      } else if (type === 13) {
        for (let i = 0; i < cellCount; i += 1) {
          const cellOffset = buf.readUInt16BE(base + headerLen + i * 2);
          const payloadSize = readVarint(buf, cellOffset);
          const rowid = readVarint(buf, payloadSize.end);
          const local = localPayloadSize(payloadSize.value, true);
          let payload;
          if (local === payloadSize.value) {
            payload = buf.slice(rowid.end, rowid.end + local);
          } else {
            const overflowPage = buf.readUInt32BE(rowid.end + local);
            payload = readOverflow(overflowPage, payloadSize.value, buf, rowid.end, local);
          }
          const record = readRecord(payload);
          if (cb(rowid.value, record.values) === true) return true;
        }
      } else if (type === 2 || type === 10) {
        fail('期望表 b-tree，遇到索引页');
      } else {
        fail(`未知 b-tree 页类型 ${type}`);
      }
      return false;
    }
    visit(rootPage);
  }

  /** 遍历索引 b-tree，cb(values) —— 最后一个值是该索引对应表的 rowid。 */
  function walkIndex(rootPage, cb) {
    const seen = new Set();
    function visit(pgno) {
      if (seen.has(pgno)) fail('索引 b-tree 成环');
      seen.add(pgno);
      const buf = page(pgno);
      const base = pgno === 1 ? 100 : 0;
      const type = buf.readUInt8(base);
      const cellCount = buf.readUInt16BE(base + 3);
      const headerLen = (type === 2 || type === 5) ? 12 : 8;
      if (type === 2) {
        const rightMost = buf.readUInt32BE(base + 8);
        for (let i = 0; i < cellCount; i += 1) {
          const cellOffset = buf.readUInt16BE(base + headerLen + i * 2);
          const child = buf.readUInt32BE(cellOffset);
          visit(child);
          const payload = cellPayload(buf, cellOffset + 4, false);
          const record = readRecord(payload);
          if (cb(record.values) === true) return true;
        }
        visit(rightMost);
      } else if (type === 10) {
        for (let i = 0; i < cellCount; i += 1) {
          const cellOffset = buf.readUInt16BE(base + headerLen + i * 2);
          const payload = cellPayload(buf, cellOffset, false);
          const record = readRecord(payload);
          if (cb(record.values) === true) return true;
        }
      } else {
        fail(`期望索引 b-tree，遇到页类型 ${type}`);
      }
      return false;
    }
    visit(rootPage);
  }

  /** 表内部页 cell：[4 字节左孩子][rowid varint 键] */
  function seekRowid(rootPage, target) {
    const seen = new Set();
    function visit(pgno) {
      if (seen.has(pgno)) fail('查找路径成环');
      seen.add(pgno);
      const buf = page(pgno);
      const base = pgno === 1 ? 100 : 0;
      const type = buf.readUInt8(base);
      const cellCount = buf.readUInt16BE(base + 3);
      if (type === 5) {
        for (let i = 0; i < cellCount; i += 1) {
          const cellOffset = buf.readUInt16BE(base + 12 + i * 2);
          const child = buf.readUInt32BE(cellOffset);
          const key = readVarint(buf, cellOffset + 4);
          if (target <= key.value) return visit(child);
        }
        return visit(buf.readUInt32BE(base + 8));
      }
      if (type === 13) {
        for (let i = 0; i < cellCount; i += 1) {
          const cellOffset = buf.readUInt16BE(base + 8 + i * 2);
          const payloadSize = readVarint(buf, cellOffset);
          const rowid = readVarint(buf, payloadSize.end);
          if (rowid.value === target) {
            const local = localPayloadSize(payloadSize.value, true);
            let payload;
            if (local === payloadSize.value) {
              payload = buf.slice(rowid.end, rowid.end + local);
            } else {
              const overflowPage = buf.readUInt32BE(rowid.end + local);
              payload = readOverflow(overflowPage, payloadSize.value, buf, rowid.end, local);
            }
            return readRecord(payload).values;
          }
        }
        return null;
      }
      fail(`查找时遇到页类型 ${type}`);
      return null;
    }
    return visit(rootPage);
  }

  function schema() {
    const objects = new Map();
    walkTable(1, (rowid, values) => {
      const [type, name, , rootpage] = values;
      if (typeof name === 'string' && typeof rootpage === 'number') {
        objects.set(name, { type, rootpage });
      }
      return false;
    });
    return objects;
  }

  return { pageSize, pageCount, usable, page, schema, walkTable, walkIndex, seekRowid };
}

function walStat(file) {
  try { return fs.statSync(file + '-wal'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function snapshotKey(file) {
  const main = fs.statSync(file), wal = walStat(file);
  return [main.size, main.mtimeMs, wal?.size, wal?.mtimeMs].join(':');
}

function withSnapshot(file, consume) {
  if ((walStat(file)?.size || 0) <= 32) return consume(open(fs.readFileSync(file)));
  // A read transaction includes committed WAL frames and excludes in-flight writes.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
  try {
    db.exec('PRAGMA trusted_schema=OFF; BEGIN');
    const schema = new Map(db.prepare("SELECT name, rootpage FROM sqlite_schema WHERE type='table' AND rootpage > 0")
      .all().map(({ name, rootpage }) => [name, { type: 'table', rootpage }]));
    const names = new Map([...schema].map(([name, entry]) => [entry.rootpage, name]));
    return consume({ schema: () => schema, walkTable(rootpage, visit) {
      const name = names.get(rootpage);
      if (!name) throw new Error('SQLite snapshot table not found');
      const query = db.prepare('SELECT rowid, * FROM "' + name.replace(/"/g, '""') + '" ORDER BY rowid');
      query.setReturnArrays(true);
      for (const [rowid, ...values] of query.iterate()) {
        if (visit(rowid, values.map((v) => v instanceof Uint8Array
          ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v))) break;
      }
    } });
  } finally {
    db.close();
  }
}

module.exports = { open, readVarint, snapshotKey, withSnapshot };
