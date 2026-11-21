'use strict';
/**
 * Antigravity 桌面端 DSH 风格状态栏 — 主进程侧。
 *
 * 注入目标：应用自身页面（实测 Hub UI 跑在 http(s)://127.0.0.1:<LS端口> 的
 * WebContentsView 里，顶层窗口 webContents 停在 about:blank），因此除
 * browser-window-created 外还挂 app 的 web-contents-created 以覆盖视图层。
 * 数据：每 2s 按各视图选中的会话 ID 读取快照，不跨视图共享。
 */
const path = require('path');
const fs = require('fs');
const electron = require('electron');
const store = require('./lib/store');
const renderer = require('./renderer');

const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const POLL_MS = 2000;
const CTX_TIMEOUT_MS = 1500;
const LOG_MAX_BYTES = 1 << 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const attached = new WeakSet(); // 已挂 did-finish-load 的 webContents（去重）
const seenUrl = new WeakMap();  // webContents -> 最近一次记录过的 URL
let lastFrameKey = '';
let lastBindKey = ''; // 上次绑定 (convId|source)，变化才记 [ctx] 日志
let lastInjectErr = { msg: '', at: 0 };
let pumping = false; // pump 变异步后防重入

function log(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'antigravity-statusbar.log');
    try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.unlinkSync(file); } catch (_) {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch (_) { /* 日志失败不影响宿主 */ }
}

function safeUrl(wc) {
  try { return wc.getURL() || ''; } catch (_) { return ''; }
}

/** 过滤：仅对应用自身页面注入；外部 http(s) 网页窗（agent 浏览器）与 data:/plugin: 跳过。 */
function shouldInject(url) {
  try {
    const target = new URL(url);
    return target.protocol === 'https:' && target.hostname === '127.0.0.1';
  } catch (_) { return false; }
}

/** 首次见到每个窗口 URL 时记日志（无论注入与否），URL 变化（导航）再记。 */
function noteUrl(wc) {
  const url = safeUrl(wc);
  if (seenUrl.get(wc) === url) return;
  seenUrl.set(wc, url);
  log('[win] inject=' + (shouldInject(url) ? 'yes' : 'no(filtered)'));
}

function logInjectErr(url, e) {
  const msg = String((e && e.message) || e || 'unknown');
  const now = Date.now();
  if (msg === lastInjectErr.msg && now - lastInjectErr.at < 60000) return; // 同错限频 60s
  lastInjectErr = { msg, at: now };
  log('[inject-fail] renderer load failed');
}

/** 收集全部应注入的 webContents。实测（test/diag-electron-api.cjs，Antigravity
 * 2.33.0）：BrowserWindow.getAllWindows() 恒为 0（Hub UI 全在 WebContentsView，
 * 不在任何 BrowserWindow 里），因此必须走 electron.webContents.getAllWebContents()；
 * 旧实现（遍历窗口 contentView 树）返回空集，导致 2s 轮询从未推送——状态栏能显示
 * 只是因为注入瞬间补发了 lastPayload。这里以 getAllWebContents() 为主。 */
function collectWebContents() {
  const out = [];
  try {
    const wcModule = electron.webContents;
    if (wcModule && typeof wcModule.getAllWebContents === 'function') {
      for (const wc of wcModule.getAllWebContents()) {
        try { if (wc && !wc.isDestroyed()) out.push(wc); } catch (_) {}
      }
      return out;
    }
  } catch (_) {}
  // 极旧版本兜底：窗口树遍历（getAllWebContents 不可用时）
  let wins = [];
  try { wins = BrowserWindow.getAllWindows(); } catch (_) { return out; }
  for (const win of wins) {
    try { if (win.webContents) out.push(win.webContents); } catch (_) {}
    try {
      const stack = win.contentView && win.contentView.getChildren ? Array.from(win.contentView.getChildren()) : [];
      while (stack.length) {
        const view = stack.pop();
        try { if (view.webContents) out.push(view.webContents); } catch (_) {}
        try { if (view.getChildren) stack.push(...view.getChildren()); } catch (_) {}
      }
    } catch (_) {}
  }
  return out;
}

function pushTo(wc, payload) {
  try {
    const js = 'window.__agySb&&window.__agySb(' + JSON.stringify(payload) + ')';
    const p = wc.executeJavaScript(js);
    if (p && typeof p.catch === 'function') p.catch(() => {}); // 失败静默跳过该帧
  } catch (_) { /* 已销毁等：跳过该帧 */ }
}

function injectNow(wc) {
  const url = safeUrl(wc);
  try {
    const p = wc.executeJavaScript(renderer);
    const done = () => {
      log('[inject-ok] renderer installed');
      requestRefresh();
    };
    const fail = (e) => logInjectErr(url, e);
    if (p && typeof p.then === 'function') p.then(done, fail); else done();
  } catch (e) { logInjectErr(url, e); }
}

/** 挂监听 + 视情况立即注入；WeakSet 去重：同一 webContents 只挂一次。 */
function attach(wc) {
  if (!wc || attached.has(wc)) return;
  attached.add(wc);
  try {
    wc.on('console-message', (_event, details, legacyMessage) => {
      // A wake-up only; read and validate the conversation ID as usual.
      if ((details?.message ?? legacyMessage) === '[agy-statusbar:selection]' && shouldInject(safeUrl(wc))) {
        requestRefresh();
      }
    });
    wc.on('did-finish-load', () => {
      try {
        if (wc.isDestroyed()) return;
        noteUrl(wc);
        if (shouldInject(safeUrl(wc))) injectNow(wc); // 渲染脚本幂等，导航后重注入即更新
      } catch (_) {}
    });
  } catch (e) {
    log('[attach-fail] ' + ((e && e.message) || e));
    return;
  }
  noteUrl(wc);
  try {
    if (shouldInject(safeUrl(wc)) && !wc.isLoading()) injectNow(wc);
  } catch (_) {}
}

/** 带超时的 executeJavaScript；超时/失败返回 fallback，绝不卡轮询。 */
function evalWithTimeout(wc, expr, timeoutMs, fallback) {
  let p;
  try { p = wc.executeJavaScript(expr); } catch (_) { return Promise.resolve(fallback); }
  if (!p || typeof p.then !== 'function') return Promise.resolve(fallback);
  return Promise.race([
    p.then((v) => (v == null ? fallback : v), () => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

const CTX_EXPR = 'JSON.stringify(window.__agySbCtx&&window.__agySbCtx()||null)';
async function readCtx(wc) {
  const raw = await evalWithTimeout(wc, CTX_EXPR, CTX_TIMEOUT_MS, null);
  try { return JSON.parse(raw); } catch (_) { return null; }
}
function buildPayload(ctx) {
  if (!ctx || typeof ctx.convId !== 'string' || !UUID_RE.test(ctx.convId)) return null;
  const payload = store.snapshotForId(ctx.convId.toLowerCase());
  if (!payload || !payload.ok) return null;
  return { ...payload, bindSource: 'uuid', title: ctx.title || payload.title };
}
let refreshQueued = false;
function requestRefresh() {
  if (pumping) { refreshQueued = true; return; }
  pump().catch(() => {});
}

async function pump() {
  if (pumping) return; // 上一轮未完成（ctx 超时等）：跳过本轮，避免堆积
  pumping = true;
  try {
    await Promise.all(collectWebContents().filter((wc) =>
      attached.has(wc) && shouldInject(safeUrl(wc))).map(async (wc) => {
      const url = safeUrl(wc);
      let payload = null;
      try { payload = buildPayload(await readCtx(wc)); }
      catch (e) { log('[frame-fail] ' + ((e && e.message) || e)); }
      if (safeUrl(wc) !== url || wc.isDestroyed()) return;
      pushTo(wc, payload);
      if (!payload) return;
      const t = payload.tokens;
      const c = payload.context;
      const s = payload.subagents;
      const bindKey = (payload.conversationId || '-') + '|' + payload.bindSource;
      if (bindKey !== lastBindKey) { // 绑定变化才记日志（SPEC-2 验证节要求的绑定行）
        lastBindKey = bindKey;
        log('[ctx] session binding changed');
      }
      const key = [payload.conversationId, payload.turns, payload.steps, payload.latestSpeed,
        t && t.total, t && t.cachePercent, s && s.total, c && c.used, c && c.limit, c?.awaitingSample].join('|');
      if (key !== lastFrameKey) { // 数值变化才记日志
        lastFrameKey = key;
        log('[frame] statistics refreshed');
      }
    }));
  } finally {
    pumping = false;
    if (refreshQueued) {
      refreshQueued = false;
      requestRefresh();
    }
  }
}

/** ready 后补挂：扫描全部已存在窗口（含缺失时机创建的）。 */
function scan() {
  for (const wc of collectWebContents()) attach(wc);
}

try {
  log('[hook] loaded (antigravity-statusbar desktop wrapper, poll ' + POLL_MS + 'ms)');
  app.on('browser-window-created', (event, win) => { try { attach(win && win.webContents); } catch (_) {} });
  // web-contents-created 覆盖 WebContentsView（Hub UI 实际所在）与 webview guest；
  // 外部网页仍由 shouldInject 过滤。
  app.on('web-contents-created', (event, wc) => { try { attach(wc); } catch (_) {} });
  if (app.isReady()) { scan(); pump(); } else {
    app.on('ready', () => { try { scan(); pump(); } catch (_) {} });
  }
  const timer = setInterval(() => pump().catch(() => {}), POLL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
} catch (e) {
  log('[init-fail] ' + ((e && e.stack) || e));
}


