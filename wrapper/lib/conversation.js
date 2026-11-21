'use strict';
/**
 * 会话数据库解析：从 conversations/<id>.db 快照提取统计所需的字段。
 *
 * 所有「字段号」均为对 Antigravity 2.33.0 真实文件的实测结论（见 README），
 * 解析失败一律抛错，由 store 层捕获降级。
 */
const fs = require('fs');
const path = require('path');
const sqlite = require('./sqlite');
const proto = require('./proto');

// steps.step_type 实测值：14=用户消息、15=助手回复（含模型用量）、其余为工具/事件步骤
const STEP_USER = 14;
const STEP_ASSISTANT = 15;
const STEP_CHECKPOINT = 23;
const STEP_DONE = 3;

/** Google protobuf Timestamp 语义：秒 + 纳秒，换算成毫秒。 */
function timestampMs(msg) {
  if (!msg) return null;
  const seconds = proto.last(msg, 1);
  const nanos = proto.last(msg, 2);
  if (typeof seconds !== 'number') return null;
  return seconds * 1000 + Math.floor((nanos || 0) / 1e6);
}

/**
 * 模型用量消息（gen_metadata f1.f4 / steps f9）实测字段：
 *   f1 模型枚举编号、f2 非缓存提示 token（新计费输入）、f3 输出 token、
 *   f5 缓存命中 token（可缺省）、f9 会话内累计上下文 token、
 *   f10 输出进度计数（微任务块数，非 token）
 */
function readUsage(msg) {
  if (!msg) return null;
  const out = {
    freshInput: num(proto.last(msg, 2)),
    output: num(proto.last(msg, 3)),
    cachedInput: num(proto.last(msg, 5)),
    contextUsed: num(proto.last(msg, 9)),
  };
  return out;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 解析单个会话数据库快照（Buffer）。
 * 返回 { conversationId, turns, steps, userTurns, agentSteps, totals, context, latestStep }
 * 字段可能缺失（如 gen_metadata 表为空），缺失即 null/0，调用方按无数据处理。
 */
function parseConversationDb(buffer) {
  const db = sqlite.open(buffer);
  const objects = db.schema();
  const table = (name) => {
    const entry = objects.get(name);
    if (!entry || entry.type !== 'table') throw new Error(`缺少表 ${name}`);
    return entry.rootpage;
  };

  const result = {
    conversationId: null,
    trajectoryId: null,
    userTurns: 0,
    completedTurns: 0,
    agentSteps: 0,
    totals: { freshInput: 0, cachedInput: 0, output: 0 },
    context: { used: null, limit: null },
    latestStep: null, // newest completed round with measured output
  };

  // trajectory_meta：列 = trajectory_id, cascade_id（会话 id）, trajectory_type, source
  // cascade_id 才是会话标识；trajectory_id 是轨迹自己的 id
  const metaRoot = table('trajectory_meta');
  db.walkTable(metaRoot, (rowid, values) => {
    result.cascadeId = typeof values[1] === 'string' ? values[1] : null;
    result.conversationId = typeof values[1] === 'string' ? values[1] : result.conversationId;
    result.trajectoryId = typeof values[0] === 'string' ? values[0] : null;
    return true; // 只要第一行
  });

  // gen_metadata：data = GenMeta { f1: TrajectoryGenMeta{ f3: 模型枚举, f4: usage,
  //   f9{f10{f1 已用上下文, f4 上限}}, f19 模型名, f20[k,v] 标签, f21 agent 显示名 } }
  const genRoot = table('gen_metadata');
  const mainGen = [];
  db.walkTable(genRoot, (rowid, values) => {
    // gen_metadata 列：idx INTEGER PRIMARY KEY（即 rowid，serial 0 存 NULL）、data BLOB、size
    const data = values[1];
    if (!Buffer.isBuffer(data)) return false;
    let outer;
    try {
      outer = proto.parse(data);
    } catch (error) {
      return false; // 单行损坏不影响其余
    }
    const f1 = proto.last(outer, 1);
    if (!Buffer.isBuffer(f1)) return false;
    let gen;
    try {
      gen = proto.parse(f1);
    } catch (error) {
      return false;
    }
    const usage = readUsage(proto.asMessage(proto.last(gen, 4)));
    if (!usage) return false;

    // 上下文占用：gen.f9{ f10{ f1 已用, f4 上限 } }（与 usage 无关的独立子消息）
    let contextUsed = null;
    let contextLimit = null;
    const f9 = proto.asMessage(proto.last(gen, 9));
    if (f9) {
      const f10 = proto.asMessage(proto.last(f9, 10));
      if (f10) {
        const used = proto.last(f10, 1);
        const limit = proto.last(f10, 4);
        if (typeof used === 'number' && used >= 0) contextUsed = used;
        if (typeof limit === 'number' && limit > 0) contextLimit = limit;
      }
    }

    // One cascade can rotate trajectory IDs after a restart or compaction.
    // Only a different cascade_id is evidence the row belongs to a different conversation.
    const cascadeId = proto.all(gen, 20).map((raw) => {
      try { return proto.asMessage(raw); } catch (_) { return null; }
    }).find((label) => label && proto.asString(proto.last(label, 1)) === 'cascade_id');
    if (!cascadeId || !result.conversationId || proto.asString(proto.last(cascadeId, 2)) === result.conversationId) {
      mainGen.push({ rowid, usage, contextUsed, contextLimit, checkpointStep: f9 ? proto.last(f9, 1) : null });
    }
    return false;
  });

  // 步数：type14=用户轮，type15=助手步（其余步骤类型计入步数之外的展示口径由 store 决定）
  const stepsRoot = table('steps');
  const emptyRound = () => ({ decodeMs: 0, outputTokens: 0 });
  const timing = result.timing = { decodeMs: 0, outputTokens: 0, llmMs: 0, toolMs: null, ttftMs: 0, ttftCount: 0 };
  let round = emptyRound();
  let startedRound = false;
  let settledSteps = 0;
  let lastCompaction = null;
  const finishRound = () => {
    if (startedRound && settledSteps > 0) result.completedTurns++;
    if (round.decodeMs > 0) result.latestStep = round;
  };
  const visitStep = (rowid, values) => {
    // 列：idx, step_type, status, has_subtrajectory, metadata, error_details,
    //     permissions, task_details, render_info, step_payload, step_format
    const stepType = values[1];
    const metadata = values[4];
    if (stepType === STEP_USER) {
      result.userTurns += 1;
      finishRound();
      round = emptyRound();
      startedRound = true;
      settledSteps = 0;
      return false;
    }
    if (!Buffer.isBuffer(metadata)) return false;
    let meta;
    try { meta = proto.parse(metadata); } catch (_) { return false; }
    const stamp = (field) => {
      try { return timestampMs(proto.asMessage(proto.last(meta, field))); } catch (_) { return null; }
    };
    if (stepType === STEP_CHECKPOINT && values[2] === STEP_DONE && Buffer.isBuffer(values[9])) {
      try {
        // CortexTrajectoryStep.checkpoint (30); a full summary (5), not intent-only (9).
        const checkpoint = proto.asMessage(proto.last(proto.parse(values[9]), 30));
        const summary = checkpoint && proto.last(checkpoint, 5);
        if (Buffer.isBuffer(summary) && summary.length && !proto.last(checkpoint, 9)) lastCompaction = rowid;
      } catch (_) { /* No trustworthy checkpoint marker. */ }
      return false;
    }
    if (stepType !== STEP_ASSISTANT) {
      // CortexStepMetadata: 4 tool_call, 32 started_at, 8 completed_at.
      // Do not count generation, scheduling, or steps without both markers.
      const call = proto.last(meta, 4);
      if (Buffer.isBuffer(call) && call.length) {
        const started = stamp(32), completed = stamp(8);
        if (started !== null && completed !== null && completed >= started) {
          timing.toolMs = (timing.toolMs ?? 0) + completed - started;
        }
      }
      return false;
    }
    const started = stamp(1), settled = stamp(7) ?? stamp(8), first = stamp(6);
    if (settled === null) return false;
    settledSteps++;
    result.agentSteps++;
    if (started === null || settled <= started) return false;
    const hasFirst = first !== null && first >= started && first < settled;
    timing.llmMs += settled - started;
    if (hasFirst) {
      timing.ttftMs += first - started;
      timing.ttftCount++;
    }
    const usage = readUsage(proto.asMessage(proto.last(meta, 9)));
    if (usage && usage.output > 0) {
      // When no first-token stamp survives in the log, use the whole step interval.
      const elapsed = settled - (hasFirst ? first : started);
      timing.decodeMs += elapsed;
      timing.outputTokens += usage.output;
      round.decodeMs += elapsed;
      round.outputTokens += usage.output;
    }
    return false;
  };
  db.walkTable(stepsRoot, visitStep);
  finishRound();
  // The last model sample may still refer to the checkpoint before a manual compaction.
  result.context.awaitingSample = lastCompaction !== null;
  mainGen.sort((a, b) => a.rowid - b.rowid);
  for (const entry of mainGen) {
    if (entry.contextUsed !== null && (lastCompaction === null || entry.checkpointStep >= lastCompaction)) {
      result.context.used = entry.contextUsed;
      result.context.awaitingSample = false;
    }
    if (entry.contextLimit !== null) result.context.limit = entry.contextLimit;
  }

  for (const entry of mainGen) {
    result.totals.freshInput += entry.usage.freshInput;
    result.totals.cachedInput += entry.usage.cachedInput;
    result.totals.output += entry.usage.output;
  }
  return result;
}

/** 读取并解析一个会话 db 文件；任何失败抛错。 */
function parseFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return parseConversationDb(buffer);
}

module.exports = { parseConversationDb, parseFile, STEP_USER, STEP_ASSISTANT };
