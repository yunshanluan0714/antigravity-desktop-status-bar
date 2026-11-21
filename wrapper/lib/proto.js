'use strict';
/**
 * 通用 protobuf wire-format 解码。
 *
 * Antigravity 的会话文件里没有任何 .proto 描述文件，这里按 wire format
 * 逐字段解码，再按「实测字段号」提取用量数据。字段号是 2026-11 实测于
 * Antigravity 2.33.0 的 conversations/*.db，升级后若失配请重新核对
 * README「字段对照」一节。
 */

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    if (shift < 28) {
      value |= (byte & 0x7f) << shift;
    } else {
      // 高位用乘法，避免 32 位溢出
      value += (byte & 0x7f) * 2 ** shift;
    }
    if ((byte & 0x80) === 0) return { value, end: i };
    shift += 7;
    if (shift > 63) break;
  }
  throw new Error('proto: varint 越界');
}

/** 解析一条消息为 { field: number, wireType: number, value }[]，value: number|string|Buffer */
function parse(buffer) {
  const fields = [];
  let i = 0;
  while (i < buffer.length) {
    const key = readVarint(buffer, i);
    i = key.end;
    const fieldNumber = key.value >>> 3;
    const wireType = key.value & 7;
    if (fieldNumber === 0) throw new Error('proto: 字段号为 0');
    if (wireType === 0) {
      const v = readVarint(buffer, i);
      i = v.end;
      fields.push({ field: fieldNumber, wireType, value: v.value });
    } else if (wireType === 1) {
      if (i + 8 > buffer.length) throw new Error('proto: fixed64 越界');
      fields.push({ field: fieldNumber, wireType, value: buffer.slice(i, i + 8) });
      i += 8;
    } else if (wireType === 2) {
      const len = readVarint(buffer, i);
      i = len.end;
      if (i + len.value > buffer.length) throw new Error('proto: 长度字段越界');
      fields.push({ field: fieldNumber, wireType, value: buffer.slice(i, i + len.value) });
      i += len.value;
    } else if (wireType === 5) {
      if (i + 4 > buffer.length) throw new Error('proto: fixed32 越界');
      fields.push({ field: fieldNumber, wireType, value: buffer.slice(i, i + 4) });
      i += 4;
    } else {
      throw new Error(`proto: 不支持的 wire type ${wireType}`);
    }
  }
  return fields;
}

/** 取某字段全部出现（repeated）。 */
function all(fields, fieldNumber) {
  const out = [];
  for (const f of fields) {
    if (f.field === fieldNumber) out.push(f.value);
  }
  return out;
}

/** 取某字段最后一次出现（repeated 语义 = 最后生效；optional 语义 = 该值）。 */
function last(fields, fieldNumber) {
  let found;
  for (const f of fields) {
    if (f.field === fieldNumber) found = f.value;
  }
  return found;
}

function asMessage(value) {
  if (value === undefined || value === null) return undefined;
  if (!Buffer.isBuffer(value)) throw new Error('proto: 期望嵌套消息');
  return parse(value);
}

function asString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8');
    // 探测：若包含大量控制字符，视为二进制
    let bad = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad += 1;
    }
    if (bad > text.length * 0.1) throw new Error('proto: 字符串字段含二进制');
    return text;
  }
  return String(value);
}

module.exports = { parse, all, last, asMessage, asString, readVarint };
