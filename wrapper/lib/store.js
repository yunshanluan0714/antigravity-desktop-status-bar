'use strict';
/**
 * 数据源聚合：读取并汇总指定会话（或启发式活跃会话）的统计段。
 *
 * snapshotForId(convId)：按会话 id 出快照（界面绑定用 修正 B）。
 * snapshot()：启发式挑活跃会话（保留作兜底，判定按优先级）：
 *  1. summaries 中 status=CASCADE_RUN_STATUS_RUNNING / not_fully_idle 的会话
 *  2. summaries 里最近被用户输入的会话（last_user_input_time）
 *  3. 全局 last_modified_time 最新的会话
 *
 * 缓存：summaries 与会话 db 的解析结果都按「文件 mtime+size」缓存，
 * 保证 2s 轮询开销不随会话数膨胀。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { snapshotKey } = require('./sqlite');
const summaries = require('./summaries');
const conversation = require('./conversation');

/** Antigravity 主程序数据目录（桌面 App 与 IDE 共用） */
function antigravityDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

/** summaries 里的时间格式：'YYYY-MM-DD HH:mm:ss.ffffff+00:00'（UTC） */
function parseSummariesTime(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(.*)$/.exec(text);
  if (!m) {
    const t = Date.parse(text);
    return Number.isFinite(t) ? t : null;
  }
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (frac) ms += Math.round(Number(`0.${frac}`) * 1000);
  if (zone && zone !== 'Z' && !/^(\+00:00|-00:00)$/.test(zone)) {
    const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (zm) {
      const offset = (+zm[2] * 60 + +zm[3]) * 60 * 1000 * (zm[1] === '-' ? -1 : 1);
      ms -= offset;
    }
  }
  return ms;
}

function isActiveStatus(status) {
  return typeof status === 'string' && /RUN_STATUS_RUNNING|RUN_STATUS_WORKING/.test(status);
}

/**
 * 挑选活跃会话 id。rows 为 summaries 行。
 * 返回 conversationId 或 null。
 */
function pickActiveConversation(rows) {
  const alive = rows.filter((row) => !row.killed);
  if (alive.length === 0) return null;
  const running = alive.filter((row) => isActiveStatus(row.status));
  if (running.length > 0) {
    running.sort((a, b) => (parseSummariesTime(b.lastModifiedTime) || 0) - (parseSummariesTime(a.lastModifiedTime) || 0));
    return running[0].conversationId;
  }
  // 无运行中的会话：最近被用户输入的；都没有则最近修改的
  const byInput = [...alive].sort((a, b) => {
    const ta = parseSummariesTime(a.lastUserInputTime) || parseSummariesTime(a.lastModifiedTime) || 0;
    const tb = parseSummariesTime(b.lastUserInputTime) || parseSummariesTime(b.lastModifiedTime) || 0;
    return tb - ta;
  });
  return byInput[0].conversationId;
}

/** 扫描 conversations 目录，返回 { id: 文件路径 }（只含 .db）。 */
function listConversationFiles(dir) {
  const out = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.db')) {
      out.set(entry.name.slice(0, -3), path.join(dir, entry.name));
    }
  }
  return out;
}

/** summaries 解析缓存：key = mtimeMs:size，文件没变直接复用上次结果。 */
let summariesCache = { key: null, rows: null };
function parseSummariesCached(base) {
  const file = path.join(base, 'conversation_summaries.db');
  let key = null;
  try {
    key = snapshotKey(file);
  } catch (_) {
    return [];
  }
  if (key !== summariesCache.key || !summariesCache.rows) {
    summariesCache = { key, rows: summaries.parseFile(file) };
  }
  return summariesCache.rows;
}

/** 会话 db 解析缓存：convId -> { key: mtimeMs:size, conv }，上限 64 个会话。 */
const convCache = new Map();
const CONV_CACHE_MAX = 64;

function parseConversationCached(dbPath, convId) {
  const key = snapshotKey(dbPath);
  const hit = convCache.get(convId);
  if (hit && hit.key === key) return hit.conv;
  const conv = conversation.parseFile(dbPath);
  convCache.set(convId, { key, conv });
  if (convCache.size > CONV_CACHE_MAX) {
    const oldest = convCache.keys().next().value; // Map 迭代序 = 插入序
    convCache.delete(oldest);
  }
  return conv;
}

/** 把 conversation.parseFile 的结果映射进快照字段（snapshot / snapshotForId 共用）。 */
function applyConversation(result, conv) {
  if (conv.userTurns > 0 || conv.agentSteps > 0) {
    result.turns = conv.completedTurns;
    result.steps = conv.agentSteps;
  }
  if (conv.totals && (conv.totals.freshInput + conv.totals.cachedInput + conv.totals.output) > 0) {
    const billedInput = conv.totals.freshInput + conv.totals.cachedInput;
    result.tokens = {
      fresh: conv.totals.freshInput,
      cached: conv.totals.cachedInput,
      output: conv.totals.output,
      total: billedInput + conv.totals.output,
      cachePercent: billedInput > 0 ? (conv.totals.cachedInput / billedInput) * 100 : null,
    };
  }
  if (conv.context?.awaitingSample) {
    result.context = { used: null, limit: conv.context.limit, percent: null, awaitingSample: true };
  } else if (conv.context && (conv.context.limit > 0)) {
    result.context = {
      used: conv.context.used,
      limit: conv.context.limit,
      percent: conv.context.used !== null && conv.context.limit > 0
        ? (conv.context.used / conv.context.limit) * 100
        : null,
    };
  } else if (conv.context && conv.context.used > 0) {
    result.context = { used: conv.context.used, limit: null, percent: null };
  }
  if (conv.timing) {
    result.speed = { llmMs: conv.timing.llmMs || null, toolMs: conv.timing.toolMs ?? null };
    if (conv.latestSpeed) {
      result.speed.latest = conv.latestSpeed;
      result.speed.average = conv.averageSpeed;
    }
  }
}

/** Aggregate only independently recorded descendants, never historical trajectory IDs. */
function applySubagents(result, rows, files) {
  const childIds = new Set([result.conversationId]);
  const entries = [];
  let fresh = 0, cached = 0, output = 0;
  for (const id of childIds) {
    for (const row of rows) {
      if (row.parentConversationId !== id || childIds.has(row.conversationId)) continue;
      childIds.add(row.conversationId);
      let total = null;
      const file = files.get(row.conversationId);
      try {
        const usage = file && parseConversationCached(file, row.conversationId).totals;
        if (usage) {
          fresh += usage.freshInput;
          cached += usage.cachedInput;
          output += usage.output;
          total = usage.freshInput + usage.cachedInput + usage.output;
        }
      } catch (_) { /* An unavailable child must not hide the parent stats. */ }
      entries.push({ id: row.conversationId, name: row.title?.trim() || row.agentName?.trim() || null, total });
    }
  }
  if (!entries.length) return;
  const total = fresh + cached + output;
  const mainTotal = result.tokens?.total || 0;
  result.subagents = { total, fresh, cached, output, entries,
    cachePercent: fresh + cached ? 100 * cached / (fresh + cached) : null,
    percent: mainTotal ? 100 * total / (mainTotal + total) : null };
}
function emptySnapshot() {
  return {
    ok: false,
    conversationId: null,
    title: null,
    running: false,
    turns: null,
    steps: null,
    tokens: null,
    context: null,
    subagents: null,
  };
}

/**
 * 按会话 id 出快照。会话不存在（summaries 无记录且无 db）返回 ok=true 的空快照。
 * 解析失败整包 ok=false（error 字段），由界面降级。
 */
function snapshotForId(convId) {
  const result = emptySnapshot();
  result.ok = true;
  if (!convId || typeof convId !== 'string') return result;
  try {
    const base = antigravityDir();
    const rows = parseSummariesCached(base);
    const row = rows.find((r) => r.conversationId === convId);
    result.conversationId = convId;
    result.title = row ? row.title : null;
    result.running = row ? isActiveStatus(row.status) : false;

    const files = listConversationFiles(path.join(base, 'conversations'));
    const dbPath = files.get(convId);
    if (!dbPath) return result; // summaries 有记录但 db 已删除：无数据，各段显示 --
    const conv = parseConversationCached(dbPath, convId);
    applyConversation(result, conv);
    applySubagents(result, rows, files);
    return result;
  } catch (error) {
    result.ok = false;
    result.error = String((error && error.message) || error);
    return result;
  }
}

/**
 * 按标题在 summaries 里匹配会话（界面只拿到标题时的绑定路径）。
 * 归一化：trim + 小写；全等优先，其次前缀，再次包含；
 * 同分（重名会话实测存在）取 lastModifiedTime 最新的。
 * 返回 { conversationId, title } 或 null。
 */
function findByTitle(title) {
  if (!title || typeof title !== 'string') return null;
  const needle = title.trim().toLowerCase();
  if (!needle) return null;
  let rows;
  try {
    rows = parseSummariesCached(antigravityDir());
  } catch (_) {
    return null;
  }
  let best = null; // { conversationId, title, rank, time }
  for (const row of rows) {
    if (row.killed) continue;
    const hay = typeof row.title === 'string' ? row.title.trim().toLowerCase() : '';
    if (!hay) continue;
    let rank = null;
    if (hay === needle) rank = 0;
    // 界面行文本常为「标题+相对时间后缀」：db 标题是界面文本的前缀
    else if (hay.startsWith(needle) || needle.startsWith(hay)) rank = 1;
    else if (hay.includes(needle) || needle.includes(hay)) rank = 2;
    if (rank === null) continue;
    const time = parseSummariesTime(row.lastModifiedTime) || 0;
    if (!best || rank < best.rank || (rank === best.rank && time > best.time)) {
      best = { conversationId: row.conversationId, title: row.title, rank, time };
    }
  }
  return best ? { conversationId: best.conversationId, title: best.title } : null;
}

/**
 * 启发式挑活跃会话并汇总其完整快照（兜底路径）。
 * 返回 { ok, conversationId, title, turns, steps, tokens, context, subagents,
 *        running, error }
 */
function snapshot() {
  try {
    const rows = parseSummariesCached(antigravityDir());
    const activeId = pickActiveConversation(rows);
    if (!activeId) {
      const result = emptySnapshot();
      result.ok = true;
      return result;
    }
    return snapshotForId(activeId);
  } catch (error) {
    const result = emptySnapshot();
    result.error = String((error && error.message) || error);
    return result; // ok=false，界面降级
  }
}

module.exports = {
  snapshot,
  snapshotForId,
  findByTitle,
  pickActiveConversation,
  parseSummariesTime,
  antigravityDir,
};
