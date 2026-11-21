'use strict';
/**
 * 会话目录解析：conversation_summaries.db 快照 → 会话列表。
 *
 * 表 conversation_summaries 实测列（schema 声明顺序）：
 *   0 conversation_id, 1 title, 2 preview, 3 step_count, 4 last_modified_time,
 *   5 workspace_uris, 6 status, 7 source, 8 project_id, 9 agent_name,
 *   10 parent_conversation_id, 11 nesting_depth, 12 battle_id,
 *   13 winning_conversation_id, 14 not_fully_idle, 15 killed,
 *   16 last_user_input_time, 17 last_user_input_step_index, 18 app_data_dir,
 *   19 raw_summary, 20 group_id
 */
const fs = require('fs');
const path = require('path');
const sqlite = require('./sqlite');

/**
 * 解析单个快照。注意真实文件里列 1/2 都存标题、列 3 才是 step_count
 * （CREATE TABLE 语句里的 step_count 在第 4 列位置：conversation_id,
 * title, preview, step_count, ...）。
 */
function parseSummariesDb(buffer) {
  const db = sqlite.open(buffer);
  const objects = db.schema();
  const tableEntry = objects.get('conversation_summaries');
  if (!tableEntry || tableEntry.type !== 'table') throw new Error('缺少表 conversation_summaries');

  const rows = [];
  db.walkTable(tableEntry.rootpage, (rowid, values) => {
    const row = {
      conversationId: values[0] ?? '',
      title: values[1] ?? '',
      preview: values[2] ?? '',
      stepCount: values[3] ?? 0,
      lastModifiedTime: values[4] ?? '',
      status: values[6] ?? '',
      agentName: values[9] ?? '',
      parentConversationId: values[10] ?? '',
      nestingDepth: values[11] ?? 0,
      killed: values[15] ?? 0,
      lastUserInputTime: values[16] ?? '',
    };
    if (typeof row.conversationId === 'string' && row.conversationId) rows.push(row);
    return false;
  });
  return rows;
}

function parseFile(filePath) {
  return parseSummariesDb(fs.readFileSync(filePath));
}

module.exports = { parseSummariesDb, parseFile };
