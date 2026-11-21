'use strict';
/**
 * 注入用渲染脚本（DSH 风格四段状态栏）。
 * 导出值为 IIFE 字符串，主进程通过 webContents.executeJavaScript 执行。
 * 幂等：同一文档重复执行直接退出；导航后由主进程重注入。
 *
 * 位置（SPEC-2 修正 A）：状态栏插到对话输入框（composer 卡片）正下方的文档流里，
 * 不再是窗口底边的 fixed overlay；找不到 composer → 整条隐藏。
 * composer 定位（实测选择器，见 test/dom-probe.json 与 README-DESKTOP「绑定来源」）：
 *   主选 .surface-composer（含输入框 + 底部模型选择行的带边框卡片），
 *   兜底为输入框向上 6 层内第一个带边框/圆角的块级容器，最终兜底为输入框直接父级。
 *
 * 绑定（SPEC-2 修正 B）：window.__agySbCtx() 供主进程每轮轮询调用，返回 {convId?, title?}：
 *   1. 侧栏选中行 [data-testid="conversation-row-sidebar"][data-selected="true"]
 *      的 data-cascade-id（实测即会话 uuid）+ 行内首个 span 的纯标题；
 *   2. 顶栏面包屑标题（对话视图标题条 span.truncate 叶子，排除侧栏内部与窗口菜单区）。
 *
 * 数据契约（window.__agySb(payload)）：store.snapshotForId/snapshot 形状：
 *   { ok, conversationId, title, bindSource, turns, steps,
 *     tokens:{fresh,cached,output,total,cachePercent}|null,
 *     context:{used,limit,percent}|null,
 *     subagents:{total,percent}|null, latestSpeed, subTrails?:{count,ids[]} }
 * 某段数据 null/undefined → 该段整段隐藏；全部为空 → 整条隐藏。
 */

function agyStatusBarInstall() {
  if (window.__agySb) return; // 已注入：仅更新不重注
  var ICON_CLOCK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.4 12.4a6.4 6.4 0 1 1 11.2 0M8 9.9 10.6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="10.2" r="1.1" fill="currentColor"/></svg>';
  var ICON_DB = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>';
  var ICON_FORK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="8" r="2.4"/><path d="M6 8.4v7.2"/><path d="M18 10.4c0 3.6-4 4.6-9.4 5.4"/></svg>';
  var RING_C = 2 * Math.PI * 5;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var bar = document.createElement('div');
  bar.id = 'agy-sb';
  bar.className = 'text-muted-foreground';
  bar.hidden = true;
  const layout = document.createElement('style');
  layout.textContent = `
    #agy-sb:not([hidden]) { display: flex; }
    /* Keep the stock footer spacing on views without the status bar. */
    [data-agy-compact-footer]:has(.surface-composer + #agy-sb:not([hidden])) {
      padding-bottom: 4px;
    }
  `;
  document.head.appendChild(layout);
  // 文档流内嵌（不再 fixed）：宽度 100% 继承 composer 卡片宽度，紧跟其后
  bar.style.cssText = 'position:static;width:100%;margin:4px 0 0;'
    + 'box-sizing:border-box;align-items:center;justify-content:center;gap:min(12px,1vw);padding:0 4px;font-variant-numeric:tabular-nums;'
    + 'font:11px "Segoe UI",sans-serif;pointer-events:none;user-select:none;'
    + 'line-height:22px;height:22px;white-space:nowrap;';

  function seg(iconSvg) {
    var s = document.createElement('button');
    s.type = 'button';
    s.className = 'bg-transparent hover:bg-secondary hover:text-foreground';
    s.setAttribute('aria-haspopup', 'dialog');
    s.setAttribute('aria-expanded', 'false');
    s.style.cssText = 'display:inline-flex;align-items:center;gap:6px;pointer-events:auto;cursor:pointer;flex:0 1 auto;min-width:0;border:0;border-radius:6px;padding:1px 8px;font:inherit;line-height:20px;white-space:nowrap;';
    s.innerHTML = iconSvg + '<span class="agy-sb-v" style="overflow:hidden;text-overflow:ellipsis"></span>';
    s.querySelector('svg').style.flexShrink = '0';
    bar.appendChild(s);
    return s;
  }
  var s1 = seg(ICON_CLOCK);
  var s2 = seg(ICON_DB);
  var s3 = seg(ICON_FORK);
  var s4 = seg('<svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">'
    + '<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2"/>'
    + '<circle class="agy-ring" cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-dasharray="0 ' + RING_C.toFixed(2) + '" transform="rotate(-90 6 6)"/>'
    + '</svg>');
  (document.body || document.documentElement).appendChild(bar);

  const panel = document.createElement('div');
  panel.id = 'agy-sb-details';
  panel.setAttribute('popover', 'manual');
  panel.setAttribute('role', 'dialog');
  panel.tabIndex = -1;
  panel.className = 'bg-card text-muted-foreground';
  panel.style.cssText = 'position:fixed;inset:auto;margin:0;box-sizing:border-box;'
    + 'min-width:min(280px,calc(100vw - 24px));max-width:min(420px,calc(100vw - 24px));'
    + 'max-height:calc(100vh - 24px);width:max-content;overflow:auto;padding:16px;'
    + 'border:1px solid var(--card-border,transparent);border-radius:10px;'
    + 'box-shadow:0 8px 28px rgba(0,0,0,.18);font:12px/18px "Segoe UI",sans-serif;';
  document.body.appendChild(panel);
  const heading = document.createElement('div');
  heading.className = 'text-foreground';
  heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;'
    + 'font-weight:500;border-bottom:1px solid var(--card-border,transparent);padding-bottom:8px;margin-bottom:10px;';
  const headingLabel = document.createElement('span');
  headingLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
  const headingValue = document.createElement('span');
  headingValue.style.cssText = 'font-variant-numeric:tabular-nums;white-space:nowrap;';
  heading.append(headingLabel, headingValue);
  const details = document.createElement('dl');
  details.style.cssText = 'display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;';
  const meter = document.createElement('div');
  meter.className = 'bg-secondary';
  meter.style.cssText = 'height:4px;overflow:hidden;border-radius:4px;';
  meter.setAttribute('aria-hidden', 'true');
  const filled = document.createElement('div');
  filled.style.cssText = 'height:100%;background:currentColor;';
  filled.className = 'text-foreground';
  meter.appendChild(filled);
  panel.append(heading, meter, details);
  let active = null;
  let panelKey = '';
  const exact = (n) => Number.isFinite(n) ? n.toLocaleString('zh-CN') : null;
  const tps = (n) => Number.isFinite(n) ? (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + ' tok/s' : null;
  function duration(ms) {
    if (!Number.isFinite(ms)) return null;
    const seconds = ms / 1000;
    if (seconds < 60) return Math.round(seconds * 10) / 10 + '秒';
    const whole = Math.round(seconds);
    return Math.floor(whole / 60) + '分' + whole % 60 + '秒';
  }
  const tokens = (n) => Number.isFinite(n) ? exact(n) + ' tok' : null;
  const usageRows = (u) => [
    ['缓存命中', pct(u?.cachePercent)], ['未缓存输入', tokens(u?.fresh)],
    ['缓存读取', tokens(u?.cached)], ['输出', tokens(u?.output)],
  ];
  function panelData(trigger, p) {
    const d = p.speed;
    const t = p.tokens;
    const c = p.context;
    const sub = p.subagents;
    if (trigger === s1) return ['速度详情', tps(p.latestSpeed ?? d?.average), [
      ['模型用时', duration(d?.llmMs)], ['工具调用用时', duration(d?.toolMs) ?? '—'],
      ['首 token 平均（TTFT）', duration(d?.ttftMs)],
      ['平均输出速度', tps(d?.average)],
    ]];
    if (trigger === s2) return ['Token 用量', tokens(t?.total), usageRows(t)];
    if (trigger === s3) return ['子代理用量', tokens(sub?.total), [
      ['子代理', sub?.entries ? sub.entries.length + ' 个' : null], ...usageRows(sub),
      ...(sub?.entries || []).map((entry) => [entry.name || '未命名子代理 ' + entry.id.slice(0, 8), entry.total == null ? '—' : fmt(entry.total) + ' tok']),
    ]];
    if (c?.awaitingSample) return ['上下文已压缩', null, [['占用率', '等待下一次模型请求']]];
    const contextValue = Number.isFinite(c?.used) && Number.isFinite(c?.limit) ? '~' + fmt(c.used) + ' / ' + fmt(c.limit) : null;
    return ['上下文已用 ' + (pct(c?.percent) || '—'), contextValue, [], c?.percent];
  }
  function positionPanel() {
    if (!active) return;
    const rect = active.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
    const clamp = (value, size, viewport) => Math.max(12, Math.min(value, viewport - size - 12));
    panel.style.left = Math.round(clamp(rect.left + (rect.width - width) / 2, width, window.innerWidth)) + 'px';
    const above = rect.top - height - 8;
    panel.style.top = Math.round(clamp(above < 12 ? rect.bottom + 8 : above, height, window.innerHeight)) + 'px';
  }
  function renderPanel() {
    const info = panelData(active, lastPayload);
    const key = JSON.stringify(info);
    if (key !== panelKey) {
      panelKey = key;
      const [title, value, rows, percent] = info;
      const isContext = active === s4;
      panel.style.minWidth = `min(${isContext ? 264 : active === s2 ? 300 : 280}px, calc(100vw - 24px))`;
      panel.style.maxWidth = `min(${active === s2 ? 440 : 420}px, calc(100vw - 24px))`;
      panel.style.padding = isContext ? '12px' : '16px';
      meter.style.display = isContext && Number.isFinite(percent) ? 'block' : 'none';
      filled.style.width = Math.min(100, Math.max(0, percent || 0)) + '%';
      panel.setAttribute('aria-label', title);
      headingLabel.replaceChildren(active.querySelector('svg').cloneNode(true), document.createTextNode(title));
      headingValue.textContent = value || '';
      details.replaceChildren(...rows.filter(([, v]) => v != null).flatMap(([label, v]) => {
        const term = document.createElement('dt'), desc = document.createElement('dd');
        term.style.margin = '0';
        desc.style.cssText = 'margin:0;text-align:right;font-variant-numeric:tabular-nums;';
        desc.className = 'text-foreground';
        term.textContent = label;
        desc.textContent = v;
        return [term, desc];
      }));
    }
    positionPanel();
  }
  function closePanel(restoreFocus = false) {
    if (!active) return;
    const trigger = active;
    active = null;
    panelKey = '';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('bg-secondary', 'text-foreground');
    trigger.classList.add('bg-transparent');
    panel.hidePopover();
    if (restoreFocus) trigger.focus();
  }
  for (const trigger of [s1, s2, s3, s4]) {
    trigger.setAttribute('aria-controls', panel.id);
    trigger.addEventListener('click', () => {
      if (active === trigger) { closePanel(true); return; }
      closePanel();
      if (!matchesCurrent(lastPayload)) return;
      active = trigger;
      trigger.setAttribute('aria-expanded', 'true');
      trigger.classList.remove('bg-transparent');
      trigger.classList.add('bg-secondary', 'text-foreground');
      panel.showPopover();
      renderPanel();
      // Keep focus on the pill, like the DSH non-modal panel.
      if (document.activeElement === panel) trigger.focus();
    });
  }
  document.addEventListener('keydown', (event) => {
    if (active && event.key === 'Escape') { event.stopPropagation(); closePanel(true); }
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (active && !panel.contains(event.target) && !active.contains(event.target)) closePanel();
  }, true);
  window.addEventListener('resize', positionPanel);
  window.addEventListener('scroll', positionPanel, true);


  /** 输入框可见才算"有 composer"；否则整条隐藏（绝不退回窗口底边样式）。 */
  function findComposerCard() {
    const card = document.getElementById('antigravity.agentSidePanelInputBox');
    return card && card.classList.contains('surface-composer') && visible(card) ? card : null;
  }
  let compactFooter = null;
  function tightenFooter() {
    if (compactFooter?.contains(bar)) return;
    compactFooter?.removeAttribute('data-agy-compact-footer');
    compactFooter = null;
    const edge = bar.getBoundingClientRect().bottom;
    // shortcut: detect the footer by its existing bottom inset; recheck if the host adds a separate footer surface.
    for (let el = bar.parentElement; el && el !== document.body; el = el.parentElement) {
      const inset = parseFloat(getComputedStyle(el).paddingBottom);
      if (inset < 12 || !Number.isFinite(inset)) continue;
      if (Math.abs(el.getBoundingClientRect().bottom - edge - inset) > 4) continue;
      compactFooter = el;
      el.setAttribute('data-agy-compact-footer', '');
      break;
    }
  }
  var placedFor = null; // 上次放置时用的锚点（防重复 insertBefore）
  function place() {
    var anchor = null;
    try { anchor = findComposerCard(); } catch (_) { anchor = null; }
    if (!anchor) {
      closePanel();
      bar.hidden = true;
      placedFor = null;
      return false;
    }
    if (placedFor === anchor && bar.isConnected && bar.previousElementSibling === anchor) return true;
    try {
      if (anchor.parentElement) anchor.parentElement.insertBefore(bar, anchor.nextSibling);
      placedFor = anchor;
      if (ro) { try { ro.disconnect(); ro.observe(anchor); } catch (_) {} }
      return true;
    } catch (_) {
      placedFor = null;
      return false;
    }
  }

  // SPA 重渲染把状态栏节点移除 / composer 换节点 → 自动重新插回（MutationObserver）
  var moTimer = 0;
  let selectedId = null;
  function schedulePlace() {
    if (moTimer) return;
    moTimer = setTimeout(function () {
      moTimer = 0;
      try {
        const id = window.__agySbCtx()?.convId ?? null;
        if (id !== selectedId) {
          selectedId = id;
          console.info('[agy-statusbar:selection]');
        }
        var anchor = findComposerCard();
        if (!anchor) {
          placedFor = null;
          closePanel();
          bar.hidden = true;
          return;
        }
        if (!matchesCurrent(lastPayload)) { closePanel(); bar.hidden = true; return; }
        if (!bar.isConnected || bar.previousElementSibling !== anchor) {
          placedFor = null;
          if (place() && lastPayload) update(lastPayload);
        }
      } catch (_) {}
    }, 0);
  }
  var mo = null;
  try {
    mo = new MutationObserver(schedulePlace);
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-selected', 'data-cascade-id'] });
  } catch (_) {}
  // composer 宽度变化 → 状态栏 width:100% 自动跟随；RO 兜底重查一次锚点
  var ro = null;
  try {
    ro = new ResizeObserver(schedulePlace);
  } catch (_) {}

  /* ---------- 上下文提取（修正 B） ---------- */

  function visible(el) {
    try {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) { return false; }
  }

  window.__agySbCtx = function () {
    if (!findComposerCard()) return null;
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"][data-selected="true"]');
    if (rows.length !== 1) return null;
    const convId = rows[0].getAttribute('data-cascade-id') || '';
    if (!UUID_RE.test(convId)) return null;
    const title = rows[0].querySelector('span')?.textContent?.trim();
    return { convId: convId.toLowerCase(), title };
  };
  /* ---------- 渲染 ---------- */

  var lastPayload = null;
  function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '--';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function pct(p) {
    if (typeof p !== 'number' || !isFinite(p)) return null;
    return p.toFixed(1).replace(/\.0$/, '') + '%';
  }
  function convId(p) { return p.conversationId ? String(p.conversationId).slice(0, 8) : '--'; }
  function show(segEl, text, title) {
    segEl.style.display = 'inline-flex';
    segEl.querySelector('.agy-sb-v').textContent = text;
    if (title !== undefined) segEl.title = title;
  }
  function hide(segEl) { segEl.style.display = 'none'; }

  function matchesCurrent(p) {
    const current = p && window.__agySbCtx();
    return current && current.convId === p.conversationId;
  }

  function update(p) {
    if (lastPayload?.conversationId !== p?.conversationId) closePanel();
    lastPayload = p || null;
    if (!place()) return; // 无可见 composer → 整条隐藏
    if (!matchesCurrent(p)) { closePanel(); bar.hidden = true; return; }
    var shown = 0;
    // ① 时钟：N轮 M步 · S tok/s
    if (p.turns != null || p.steps != null) {
      var t1 = (p.turns ?? '--') + ' 轮 ' + (p.steps ?? '--') + ' 步';
      const latest = tps(p.latestSpeed ?? p.speed?.average);
      if (latest) t1 += ' · ' + latest;
      show(s1, t1);
      shown += 1;
    } else { hide(s1); }
    // ② 数据库：X tok · 缓存命中 P%
    if (p.tokens && p.tokens.total != null) {
      var t2 = fmt(p.tokens.total) + ' tok';
      var cp = pct(p.tokens.cachePercent);
      if (cp) t2 += ' · 缓存命中 ' + cp;
      var tip2 = '计费 token = 未缓存输入 + 缓存命中 + 输出'
        + '\n未缓存 ' + fmt(p.tokens.fresh) + ' · 缓存 ' + fmt(p.tokens.cached) + ' · 输出 ' + fmt(p.tokens.output)
        + '\n会话 ' + convId(p);
      show(s2, t2, tip2);
      shown += 1;
    } else { hide(s2); }
    // ③ 分叉：子代理 Y
    if (p.subagents && p.subagents.total != null) {
      var tip3 = '子代理实际消耗的 token';
      if (p.subagents.percent != null) tip3 += '（占全部 ' + pct(p.subagents.percent) + '）';
      if (p.subagents.entries?.length) {
        tip3 += '\n子代理 ' + p.subagents.entries.length + ' 条';
      }
      show(s3, '子代理 ' + fmt(p.subagents.total), tip3);
      shown += 1;
    } else { hide(s3); }
    // ④ 圆环：上下文占用 Z%
    const ring = s4.querySelector('.agy-ring');
    ring.style.visibility = Number.isFinite(p.context?.percent) ? '' : 'hidden';
    if (p.context?.awaitingSample) {
      show(s4, '待采样', '上下文已压缩，等待下一次模型请求记录新的占用量');
      shown += 1;
    } else if (p.context && p.context.percent != null) {
      var on = Math.max(0, Math.min(100, p.context.percent)) / 100 * RING_C;
      ring.setAttribute('stroke-dasharray', on.toFixed(2) + ' ' + RING_C.toFixed(2));
      var tip4 = '上下文窗口占用';
      if (p.context.used != null) {
        tip4 += '：已用 ' + p.context.used + (p.context.limit != null ? ' / 上限 ' + p.context.limit : '');
      }
      show(s4, Math.round(p.context.percent) + '%', tip4);
      shown += 1;
    } else { hide(s4); }
    bar.hidden = shown === 0;
    if (!bar.hidden) tightenFooter();
    if (active?.style.display === 'none') closePanel();
    else if (active) renderPanel();
  }

  window.__agySb = update;
}

module.exports = '(' + agyStatusBarInstall.toString() + ')();';

