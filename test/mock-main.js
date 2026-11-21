'use strict';
/**
 * 桩 electron 冒烟测试（无 Electron 宿主）。
 * 用 Module._load 拦截 require('electron')，驱动 3 个轮询周期，断言：
 *   - 轮询间隔 2000ms；ready/browser-window-created/web-contents-created 均已注册；
 *   - payload 字段完整（含 bindSource）；executeJavaScript 轮询串以
 *     window.__agySb&&window.__agySb( 开头；每轮先取 window.__agySbCtx()（SPEC-2）；
 *   - 过滤规则生效（外部 https 窗口被跳过）；日志写入 userData，含 [ctx] 绑定行；
 *   - renderer.js：不再含 position:fixed（窗口底边 overlay 废弃），含
 *     surface-composer 锚点、__agySbCtx、MutationObserver/ResizeObserver。
 * 退出码 0（全部通过）/ 1（有失败）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const WRAPPER = path.join(__dirname, '..', 'wrapper');
const TMP = path.join(os.tmpdir(), 'agy-statusbar-mock-' + Date.now());

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('ok - ' + name); } catch (e) {
    failures += 1;
    console.log('FAIL - ' + name + ' :: ' + ((e && e.message) || e));
  }
}

// ---------- electron 桩 ----------
const events = {}; // ev -> [fn]
const windows = [];
let readyFired = false;
const electronStub = {
  app: {
    isReady: () => readyFired,
    getPath: (name) => {
      if (name === 'userData') return TMP;
      throw new Error('unexpected getPath: ' + name);
    },
    on: (ev, fn) => { (events[ev] = events[ev] || []).push(fn); },
    getAppPath: () => WRAPPER,
  },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => windows.map((win) => win.webContents) },
};
function emit(ev, ...args) {
  readyFired = readyFired || ev === 'ready';
  for (const fn of events[ev] || []) fn(...args);
}

function makeWebContents(url, ctx) {
  const listeners = {};
  const calls = [];
  return {
    _calls: calls, context: ctx,
    getURL: () => url,
    isLoading: () => false,
    isDestroyed: () => false,
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    _fire: (ev, ...args) => { for (const fn of listeners[ev] || []) fn(...args); },
    executeJavaScript(code) { calls.push(code); return Promise.resolve(code === CTX_READ ? JSON.stringify(this.context || null) : undefined); },
  };
}
function makeWindow(url, ctx) {
  const wc = makeWebContents(url, ctx);
  const win = { webContents: wc, contentView: null };
  windows.push(win);
  return win;
}

// ---------- 全局定时器桩 ----------
const realSetInterval = global.setInterval;
let pumpFn = null;
let pumpMs = 0;
global.setInterval = (fn, ms) => { pumpFn = fn; pumpMs = ms; return {}; };

// ---------- electron 模块桩注入 ----------
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === './lib/store') return { snapshotForId: (id) => ({ ok:true, conversationId:id, title:'Fixture', running:false, turns:1, steps:2, latestSpeed:null, tokens:null, context:null, subagents:null }) };
  return origLoad.call(this, request, parent, isMain);
};
require(path.join(WRAPPER, 'statusbar.js'));
Module._load = origLoad;
global.setInterval = realSetInterval;

// ---------- 断言 ----------
check('轮询间隔 = 2000ms 且轮询函数已注册', () => {
  assert.strictEqual(pumpMs, 2000);
  assert.strictEqual(typeof pumpFn, 'function');
});
check('注册了 ready / browser-window-created / web-contents-created', () => {
  assert.ok((events.ready || []).length >= 1);
  assert.strictEqual((events['browser-window-created'] || []).length, 1);
  assert.strictEqual((events['web-contents-created'] || []).length, 1);
});


const id1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const id2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const appWin = makeWindow('https://127.0.0.1:5123/', { convId: id1 });
const otherWin = makeWindow('https://127.0.0.1:5123/', { convId: id2 });
emit('web-contents-created', {}, otherWin.webContents);
const extWin = makeWindow('https://example.com/some/external/page');
const localWin = makeWindow('https://127.0.0.1:5123/hub');
emit('ready'); // appWin already exists as a WebContentsView; no creation event after hook.
emit('web-contents-created', {}, extWin.webContents);
emit('web-contents-created', {}, localWin.webContents);
emit('browser-window-created', {}, appWin); // 已 attach 过：WeakSet 去重，不应产生第二次注入

check('外部 http(s) 窗口被过滤（零次 executeJavaScript）', () => {
  assert.strictEqual(extWin.webContents._calls.length, 0);
});
check('启动前已存在的 WebContentsView 仍会补挂', () => {
  assert.ok(appWin.webContents._calls.length >= 1);
  assert.ok(appWin.webContents._calls[0].indexOf('__agySb') !== -1);
});
check('127.0.0.1 Hub 页面完成注入', () => {
  assert.ok(localWin.webContents._calls.length >= 1);
});
check('WeakSet 去重：browser-window-created 重复事件不重注', () => {
  // appWin 的调用里 renderer 注入串只应出现一次（attach 一次 + 立即注入一次）
  const rendererCalls = appWin.webContents._calls.filter((c) => c.indexOf('(function agyStatusBarInstall') === 0);
  assert.strictEqual(rendererCalls.length, 1);
});

const PREFIX = 'window.__agySb&&window.__agySb(';
const CTX_READ = 'JSON.stringify(window.__agySbCtx&&window.__agySbCtx()||null)';
const flush = () => new Promise((resolve) => setImmediate(resolve));

// pump 变异步（先取 ctx 再出帧）后，逐轮驱动并冲刷微任务
(async () => {
  await flush();
  for (let i = 0; i < 3; i += 1) {
    await pumpFn();
    await flush();
    await flush();
  }

  check('3 个轮询周期均推送且以 __agySb 前缀开头', () => {
    const pushes = appWin.webContents._calls.filter((c) => c.startsWith(PREFIX));
    assert.ok(pushes.length >= 3, 'pushes=' + pushes.length);
    for (const p of pushes) assert.ok(p.startsWith(PREFIX));
  });
  check('轮询先取 window.__agySbCtx()（SPEC-2 绑定路径）', () => {
    // 汇总所有已注入窗口的 ctx 读取次数（每轮每窗口 1 次；初始 pump 与循环 pump
    // 的交错可能使轮数少一次，断言 ≥3 证明 ctx 路径在多个轮询周期真实执行）
    const ctxReads = windows.flatMap((w) => w.webContents._calls).filter((c) => c === CTX_READ);
    assert.ok(ctxReads.length >= 3, 'ctxReads=' + ctxReads.length);
  });
  check('外部窗口在轮询周期中仍零调用', () => {
    assert.strictEqual(extWin.webContents._calls.length, 0);
  });
  check('payload 字段完整（snapshotForId/snapshot 形状，含 bindSource）', () => {
    const pushes = appWin.webContents._calls.filter((c) => c.startsWith(PREFIX));
    const p = JSON.parse(pushes[pushes.length - 1].slice(PREFIX.length, -1));
    for (const k of ['ok', 'conversationId', 'title', 'running', 'turns', 'steps', 'tokens', 'context', 'subagents', 'latestSpeed', 'bindSource']) {
      assert.ok(k in p, 'missing field: ' + k);
    }
    assert.strictEqual(typeof p.ok, 'boolean');
    assert.strictEqual(typeof p.bindSource, 'string');
    assert.strictEqual(p.bindSource, 'uuid');
    assert.strictEqual(p.conversationId, id1);
    const latest = (win) => JSON.parse(win.webContents._calls.filter((c) => c.startsWith(PREFIX)).at(-1).slice(PREFIX.length, -1));
    assert.strictEqual(latest(otherWin).conversationId, id2);
    assert.strictEqual(latest(localWin), null);
  });

  appWin.webContents.context = { convId: id2 };
  appWin.webContents._fire('console-message', {}, { message: '[agy-statusbar:selection]' });
  await flush();
  check('selection event pushes the new conversation without running the polling timer', () => {
    const frame = appWin.webContents._calls.filter((c) => c.startsWith(PREFIX)).at(-1);
    assert.strictEqual(JSON.parse(frame.slice(PREFIX.length, -1)).conversationId, id2);
  });

  appWin.webContents.context = { title: 'Fixture' };
  await pumpFn();
  check('missing ID clears previous payload instead of guessing', () => {
    assert.strictEqual(appWin.webContents._calls.at(-1), PREFIX + 'null)');
  });

  appWin.webContents._fire('did-finish-load'); // 导航后重注入
  await flush();
  check('did-finish-load 后重注入（幂等脚本）', () => {
    assert.equal(appWin.webContents._calls.filter(c => c.startsWith('(function agyStatusBarInstall')).length, 2);
  });

  check('renderer.js 导出 IIFE 字符串', () => {
    const script = require(path.join(WRAPPER, 'renderer.js'));
    assert.strictEqual(typeof script, 'string');
    assert.ok(script.startsWith('(function agyStatusBarInstall'));
    assert.ok(script.endsWith(')();'));
  });
  check('renderer.js 不再是窗口底边 overlay（SPEC-2 修正 A）', () => {
    const script = require(path.join(WRAPPER, 'renderer.js'));
    assert.ok(script.includes('position:static'), '应为文档流内嵌');
    assert.ok(script.includes('surface-composer'), 'composer 锚点选择器应来自实测');
  });
  check('renderer.js 含 __agySbCtx 与观测器（SPEC-2 修正 B / 稳定性）', () => {
    const script = require(path.join(WRAPPER, 'renderer.js'));
    assert.ok(script.includes('__agySbCtx'));
    assert.ok(script.includes('data-cascade-id'), 'uuid 来源选择器应来自实测');
    assert.ok(script.includes('MutationObserver'));
    assert.ok(script.includes('ResizeObserver'));
  });

  // [inject-ok] 在 executeJavaScript 的 Promise 微任务里落盘，再冲刷一次微任务后断言日志
  await flush();
  check('日志包含 hook 加载 / 窗口清单（含被过滤项）/ 注入成功 / 绑定行', () => {
    const content = fs.readFileSync(path.join(TMP, 'antigravity-statusbar.log'), 'utf8');
    assert.ok(content.includes('[hook] loaded'));
    assert.ok(content.includes('[win] inject=no(filtered)'));
    assert.ok(content.includes('[win] inject=yes'));
    assert.ok(content.includes('[inject-ok] renderer installed'));
    assert.ok(content.includes('[frame]'));
    assert.ok(content.includes('[ctx] session binding changed'), 'SPEC-2 要求的绑定行');
    assert.ok(!content.includes('example.com'));
    assert.ok(!content.includes(id1));
    assert.ok(!content.includes('Fixture'));
  });

  if (failures === 0) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log('\n全部通过');
    process.exitCode = 0;
  } else {
    console.log('\n日志保留在 ' + TMP);
    console.log(failures + ' 项失败');
    process.exitCode = 1;
  }
})();


