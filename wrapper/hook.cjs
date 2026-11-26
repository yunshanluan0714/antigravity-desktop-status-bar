'use strict';
/**
 * Antigravity 桌面端 DSH 风格状态栏 — 注入入口（hook）。
 *
 * 由 watcher.js 通过 V8 inspector（--inspect）在主进程内 require 本文件。
 * 职责：加载 statusbar.js 钩子；随后关闭 inspector 监听端口，
 * 把 --inspect 带来的本地调试暴露面缩到启动后的几秒钟。
 */
function hookFailLog(msg) {
  try {
    const path = require('path');
    const dir = process.env.APPDATA && path.join(process.env.APPDATA, 'Antigravity');
    if (dir) {
      require('fs').mkdirSync(dir, { recursive: true });
      require('fs').appendFileSync(path.join(dir, 'antigravity-statusbar.log'), msg + '\n');
    }
  } catch (_) {}
}

try {
  require('./statusbar');
} catch (e) {
  hookFailLog('[hook-load-fail] ' + String((e && e.stack) || e));
}

try {
  const inspector = require('inspector');
  setTimeout(() => {
    try {
      inspector.close();
      hookFailLog('[watcher-port] inspector closed (debug surface removed)');
    } catch (e) {
      hookFailLog('[watcher-port] inspector close failed: ' + String((e && e.message) || e));
    }
  }, 8000);
} catch (_) {}
