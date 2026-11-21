'use strict';
/**
 * Antigravity 桌面端 DSH 风格状态栏 — 注入指挥器（watcher）。
 *
 * 背景：Electron 44 加载顺序为 app.asar → app 目录（官方文档），resources\app
 * wrapper 不会被加载；本机 fuse nodeCliInspect=1，因此用 --inspect 在启动
 * Antigravity 的同时暴露主进程 V8 inspector，本脚本解析其 stderr 里的
 * ws:// 端点，Runtime.evaluate 把 hook.cjs require 进主进程，然后退出。
 * hook 加载后 8s 自行 inspector.close()，调试端口只开放数秒。
 *
 * 以隐藏方式被 launch.vbs 调用；任何失败只写日志，绝不阻断应用启动
 * （应用先于一切等待逻辑被启动）。
 *
 * 测试钩子：AGY_SB_EXE / AGY_SB_HOOK / AGY_SB_LOG 环境变量可覆盖默认路径，
 * 额外 argv 透传给目标进程（e2e 测试用 node.exe 冒充 Antigravity.exe）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_EXE = process.env.AGY_SB_EXE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');
const HOOK = process.env.AGY_SB_HOOK || path.join(__dirname, 'hook.cjs');
const LOG = process.env.AGY_SB_LOG
  || path.join(process.env.APPDATA || '', 'Antigravity', 'antigravity-statusbar.log');
const URL_TIMEOUT_MS = 90000;   // 等 "Debugger listening on ws://..."
const INJECT_TIMEOUT_MS = 120000; // 等 process.mainModule 就绪（应用主入口加载完成）
const MAX_HARD_ERRORS = 5;

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] [watcher] ' + msg + '\n');
  } catch (_) {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 一次连接 + evaluate。返回 'ok' | 'pending' | 'err:<msg>' | 'socket:<msg>'。 */
function tryOnce(wsUrl, expr) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(v); } };
    const guard = setTimeout(() => done('socket:timeout'), 10000);
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { clearTimeout(guard); return done('socket:' + String((e && e.message) || e)); }
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
      } catch (e) { clearTimeout(guard); done('socket:' + String((e && e.message) || e)); }
    });
    ws.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (data.id !== 1) return;
        clearTimeout(guard);
        const r = data.result && data.result.result;
        if (data.result && data.result.exceptionDetails) {
          return done('err:' + String((data.result.exceptionDetails.text || 'exception')));
        }
        const value = r && r.value;
        if (value === 'OK') return done('ok');
        if (value === 'PENDING') return done('pending');
        done('err:' + String(value == null ? 'no value' : value));
      } catch (e) { clearTimeout(guard); done('socket:' + String((e && e.message) || e)); }
    });
    ws.addEventListener('error', () => { clearTimeout(guard); done('socket:error'); });
    ws.addEventListener('close', () => { clearTimeout(guard); done('socket:closed'); });
  });
}

async function main() {
  // 额外参数：AGY_SB_ARGS（空格分隔，e2e 测试给 node.exe 传脚本用）+ 本进程多余 argv
  const extraArgs = (process.env.AGY_SB_ARGS ? process.env.AGY_SB_ARGS.split(' ').filter(Boolean) : [])
    .concat(process.argv.slice(2));
  let child;
  try {
    // 剥离 ELECTRON_RUN_AS_NODE：带着它启动会让 exe 变成纯 Node（实测会发生）。
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    // 注意不能 windowsHide:true：会把 SW_HIDE 传给 GUI 子进程，主窗口直接隐藏。
    child = spawn(APP_EXE, ['--inspect=127.0.0.1:0', ...extraArgs], { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv });
  } catch (e) {
    log('spawn failed: ' + String((e && e.message) || e));
    process.exitCode = 1;
    return;
  }
  log('spawned pid=' + child.pid);
  let childExited = false;
  let childExitCode = null;

  const expr = '(function(){try{var m=process.mainModule;if(!m)return "PENDING";'
    + 'm.require(' + JSON.stringify(HOOK.replace(/\\/g, '/')) + ');return "OK";}catch(e){'
    + 'return "ERR:" + String((e && e.message) || e);}})()';

  const wsUrl = await new Promise((resolve) => {
    let acc = '';
    const timer = setTimeout(() => resolve(null), URL_TIMEOUT_MS);
    child.stderr.on('data', (d) => {
      acc += String(d);
      const m = /Debugger listening on (ws:\/\/[^\s"']+)/.exec(acc);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once('error', (error) => { clearTimeout(timer); log('spawn failed: ' + error.message); resolve(null); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      childExited = true;
      childExitCode = code;
      log('app exited (code=' + code + ')');
      resolve(null);
    });
  });
  if (!wsUrl) {
    const handoff = childExited && childExitCode === 0;
    log(handoff ? 'no inspector endpoint: likely handed off to an existing instance' : 'no inspector endpoint: status bar not attached');
    process.exitCode = handoff ? 2 : 1;
    return;
  }
  log('inspector endpoint received');

  child.stderr.removeAllListeners('data');
  child.stderr.resume(); // Drain stderr so the app never stalls on a full pipe.

  const deadline = Date.now() + INJECT_TIMEOUT_MS;
  let hardErrors = 0;
  let attempts = 0;
  while (Date.now() < deadline && !childExited) {
    attempts += 1;
    const outcome = await tryOnce(wsUrl, expr);
    if (outcome === 'ok') {
      log('injected hook into main process (attempts=' + attempts + ')');
      process.exitCode = 0;
      return;
    }
    if (outcome === 'pending') { await sleep(2000); continue; }
    hardErrors += 1;
    log('inject attempt ' + attempts + ' failed: ' + outcome);
    if (outcome.startsWith('err:') && hardErrors >= MAX_HARD_ERRORS) break;
    await sleep(2000);
  }
  log('injection failed after ' + attempts + ' attempts; app runs without status bar');
  process.exitCode = 1;
}

main().catch((e) => { log('watcher crashed: ' + String((e && e.stack) || e)); process.exitCode = 1; });
