'use strict';
/** Composer 内嵌状态栏。对齐模型选择器与右侧工具栏之间，不占用卡片外宽度。 */
function agyStatusBarInstall() {
  if (window.__agySb) return;
  var ICON_CLOCK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.4 12.4a6.4 6.4 0 1 1 11.2 0M8 9.9 10.6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="10.2" r="1.1" fill="currentColor"/></svg>';
  var ICON_FORK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="8" r="2.4"/><path d="M6 8.4v7.2M18 10.4c0 3.6-4 4.6-9.4 5.4"/></svg>';
  var RING_C = 2 * Math.PI * 5;
  var QUOTA_OUTER_C = 2 * Math.PI * 10.4;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var bar = document.createElement('div');
  bar.id = 'agy-sb';
  bar.className = 'text-muted-foreground';
  bar.hidden = true;
  bar.style.cssText = 'position:static;display:inline-flex;width:auto;max-width:56%;margin:0 auto;'
    + 'box-sizing:border-box;align-items:center;justify-content:center;gap:3px;padding:0 3px;'
    + 'font:12px "Segoe UI",sans-serif;font-variant-numeric:tabular-nums;pointer-events:none;user-select:none;'
    + 'line-height:24px;height:30px;white-space:nowrap;vertical-align:middle;flex:0 1 auto;min-width:0;';

  function seg(iconSvg) {
    var s = document.createElement('button');
    s.type = 'button';
    s.className = 'bg-transparent hover:bg-secondary hover:text-foreground';
    s.setAttribute('aria-haspopup', 'dialog');
    s.setAttribute('aria-expanded', 'false');
    s.style.cssText = 'display:inline-flex;align-items:center;gap:5px;pointer-events:auto;cursor:pointer;'
      + 'flex:0 1 auto;min-width:0;border:0;border-radius:5px;padding:1px 6px;font:inherit;line-height:24px;white-space:nowrap;';
    s.innerHTML = (iconSvg || '') + '<span class="agy-sb-v" style="overflow:hidden;text-overflow:ellipsis"></span>';
    const icon = s.querySelector('svg');
    if (icon) icon.style.flexShrink = '0';
    bar.appendChild(s);
    return s;
  }
  var s5 = seg('<svg class="agy-quota-ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="10.4" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="1.5"/>'
    + '<circle class="agy-quota-five" cx="12" cy="12" r="10.4" fill="none" stroke="currentColor" stroke-width="1.5"'
    + ' stroke-linecap="round" stroke-dasharray="0 ' + QUOTA_OUTER_C.toFixed(2) + '" transform="rotate(-90 12 12)"/>'
    + '<path class="agy-quota-weekly" fill="currentColor" fill-opacity=".45" d=""/>'
    + '</svg>');
  var s1 = seg(ICON_CLOCK);
  var s2 = seg(''); // token count has no leading database icon
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
    + 'min-width:min(300px,calc(100vw - 24px));max-width:min(460px,calc(100vw - 24px));'
    + 'max-height:calc(100vh - 24px);width:max-content;overflow:auto;padding:18px;'
    + 'border:1px solid var(--card-border,transparent);border-radius:10px;'
    + 'box-shadow:0 8px 28px rgba(0,0,0,.18);font:13px/20px "Segoe UI",sans-serif;';
  document.body.appendChild(panel);
  const heading = document.createElement('div');
  heading.className = 'text-foreground';
  heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:18px;'
    + 'font-size:14px;font-weight:500;border-bottom:1px solid var(--card-border,transparent);padding-bottom:10px;margin-bottom:12px;';
  const headingLabel = document.createElement('span');
  headingLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
  const headingValue = document.createElement('span');
  headingValue.style.cssText = 'font-variant-numeric:tabular-nums;white-space:nowrap;';
  heading.append(headingLabel, headingValue);
  const details = document.createElement('dl');
  details.style.cssText = 'display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:8px 18px;margin:0;';
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
  function duration(ms) {
    if (!Number.isFinite(ms)) return null;
    const seconds = ms / 1000;
    if (seconds < 60) return Math.round(seconds * 10) / 10 + '秒';
    const whole = Math.round(seconds);
    return Math.floor(whole / 60) + '分' + whole % 60 + '秒';
  }
  const tokens = (n) => Number.isFinite(n) ? exact(n) + ' tok' : null;
  const tps = (n) => Number.isFinite(n) ? (n < 10 ? n.toFixed(1) : Math.round(n)) + ' tok/s' : null;
  const usageRows = (u) => [
    ['缓存命中', pct(u?.cachePercent)], ['未缓存输入', tokens(u?.fresh)],
    ['缓存读取', tokens(u?.cached)], ['输出', tokens(u?.output)],
  ];
  function quotaSector(fraction) {
    if (!Number.isFinite(fraction) || fraction <= 0) return '';
    const r = 6.25, cx = 12, cy = 12;
    if (fraction >= 0.9999) return 'M12 12 m0 -' + r + ' a' + r + ' ' + r + ' 0 1 1 0 ' + (2 * r) + ' a' + r + ' ' + r + ' 0 1 1 0 -' + (2 * r) + ' Z';
    const angle = fraction * Math.PI * 2;
    const x = cx + r * Math.sin(angle), y = cy - r * Math.cos(angle);
    return 'M' + cx + ' ' + cy + ' L' + cx + ' ' + (cy - r) + ' A' + r + ' ' + r + ' 0 '
      + (fraction > 0.5 ? 1 : 0) + ' 1 ' + x.toFixed(3) + ' ' + y.toFixed(3) + ' Z';
  }
  function resetTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function panelData(trigger, p) {
    const d = p.speed;
    const t = p.tokens;
    const c = p.context;
    const sub = p.subagents;
    const pool = (p.quotaPools || []).find((item) => item.kind === p.modelFamily);
    if (trigger === s1) return ['速度详情', tps(d?.latest?.show), [
      ['轮数', p.turns == null ? null : p.turns + ' 轮'],
      ['步数', p.steps == null ? null : p.steps + ' 步'],
      ['模型用时', duration(d?.llmMs)],
      ['工具调用用时', duration(d?.toolMs) ?? '—'],
      ['首 token 平均（TTFT）', duration(d?.average?.ttftMs)],
      ['平均输出速度', tps(d?.average?.show)],
    ]];
    if (trigger === s2) return ['Token 用量', tokens(t?.total), usageRows(t)];
    if (trigger === s3) return ['子代理用量', tokens(sub?.total), [
      ['子代理', sub?.entries ? sub.entries.length + ' 个' : null], ...usageRows(sub),
      ...(sub?.entries || []).map((entry) => [entry.name || '未命名子代理 ' + entry.id.slice(0, 8), entry.total == null ? '—' : fmt(entry.total) + ' tok']),
    ]];
    if (trigger === s5) return ['额度', p.modelName || pool?.name || null, [
      ['五小时剩余', pool?.fiveHour ? pct(pool.fiveHour.remainingFraction * 100) : '暂无数据'],
      ['五小时重置', resetTime(pool?.fiveHour?.resetTime)],
      ['周额度剩余', pool?.weekly ? pct(pool.weekly.remainingFraction * 100) : '暂无数据'],
      ['周额度重置', resetTime(pool?.weekly?.resetTime)],
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
      headingLabel.replaceChildren(...(active.querySelector('svg') ? [active.querySelector('svg').cloneNode(true)] : []), document.createTextNode(title));
      headingValue.textContent = value || '';
      headingValue.title = active === s1 ? '最近一次已完成的模型请求的输出速度' : '';
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
  for (const trigger of [s1, s2, s3, s4, s5]) {
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


  function findComposerCard() {
    const card = document.getElementById('antigravity.agentSidePanelInputBox');
    return card && card.classList.contains('surface-composer') && visible(card) ? card : null;
  }
  function findModelControl(card) {
    return [...card.querySelectorAll('button,[role="button"]')].find((el) => {
      if (!visible(el)) return false;
      const label = [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean).join(' ');
      return /\b(?:Gemini|Claude|GPT)\b/i.test(label);
    }) || null;
  }
  function findToolbar(card, modelControl) {
    const cardWidth = card.getBoundingClientRect().width;
    for (let el = modelControl.parentElement; el && el !== card; el = el.parentElement) {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      if (style.display === 'flex' && style.flexDirection !== 'column'
          && rect.width >= cardWidth * 0.82 && rect.height >= 22 && rect.height <= 64) return el;
    }
    return null;
  }
  function childContaining(parent, target) {
    let node = target;
    while (node && node.parentElement !== parent) node = node.parentElement;
    return node?.parentElement === parent ? node : null;
  }
  function findPlacement() {
    let card = null, control = null, row = null, leftGroup = null;
    try {
      card = findComposerCard();
      control = card && findModelControl(card);
      row = control && findToolbar(card, control);
      leftGroup = row && childContaining(row, control);
    } catch (_) {}
    return card && control && row && leftGroup ? { card, control, row, leftGroup } : null;
  }
  let placedFor = null;
  let placedAfter = null;
  function place() {
    const placement = findPlacement();
    if (!placement) {
      closePanel();
      bar.hidden = true;
      placedFor = placedAfter = null;
      return false;
    }
    const { row, leftGroup } = placement;
    if (placedFor === row && placedAfter === leftGroup && bar.parentElement === row
        && bar.previousElementSibling === leftGroup) return true;
    try {
      row.insertBefore(bar, leftGroup.nextSibling);
      placedFor = row;
      placedAfter = leftGroup;
      if (ro) { try { ro.disconnect(); ro.observe(row); } catch (_) {} }
      return true;
    } catch (_) {
      placedFor = placedAfter = null;
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
        if (!matchesCurrent(lastPayload)) { closePanel(); bar.hidden = true; return; }
        const placement = findPlacement();
        if (!placement) {
          placedFor = placedAfter = null;
          closePanel();
          bar.hidden = true;
          return;
        }
        if (!bar.isConnected || bar.parentElement !== placement.row || bar.previousElementSibling !== placement.leftGroup) {
          placedFor = placedAfter = null;
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
    const modelControl = findModelControl(findComposerCard());
    const modelName = [modelControl?.innerText, modelControl?.textContent, modelControl?.getAttribute('aria-label'), modelControl?.getAttribute('title')]
      .find((value) => value && /\b(?:Gemini|Claude|GPT)\b/i.test(value))?.replace(/\s+/g, ' ').trim() || null;
    const modelFamily = modelName && /\b(?:Claude|GPT)\b/i.test(modelName) ? 'claude-gpt'
      : modelName && /\bGemini\b/i.test(modelName) ? 'gemini' : null;
    return { convId: convId.toLowerCase(), title, modelName, modelFamily };
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
  function show(segEl, text) {
    segEl.style.display = 'inline-flex';
    segEl.querySelector('.agy-sb-v').textContent = text;
    segEl.removeAttribute('title');
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
    // ① 最近一次速度；轮数与步数只放在详情里。
    if (p.turns != null || p.steps != null || Number.isFinite(p.speed?.latest?.show)) {
      const latest = tps(p.speed?.latest?.show);
      show(s1, latest || '— tok/s');
      shown += 1;
    } else { hide(s1); }
    // ② Token：无前置图标，缩短占宽。
    if (p.tokens && p.tokens.total != null) {
      show(s2, fmt(p.tokens.total) + ' tok');
      shown += 1;
    } else { hide(s2); }
    // ③ 子代理：图标 + 总量即可；明细留给弹层。
    if (p.subagents && p.subagents.total != null) {
      show(s3, fmt(p.subagents.total) + ' tok');
      shown += 1;
    } else { hide(s3); }
    // ④ 圆环：上下文占用。
    const ring = s4.querySelector('.agy-ring');
    ring.style.visibility = Number.isFinite(p.context?.percent) ? '' : 'hidden';
    if (p.context?.awaitingSample) {
      show(s4, '待采样');
      shown += 1;
    } else if (p.context && p.context.percent != null) {
      var on = Math.max(0, Math.min(100, p.context.percent)) / 100 * RING_C;
      ring.setAttribute('stroke-dasharray', on.toFixed(2) + ' ' + RING_C.toFixed(2));
      show(s4, Math.round(p.context.percent) + '%');
      shown += 1;
    } else { hide(s4); }
    // ⑤ 同心额度环：外圈五小时，内扇形为周剩余。未识别模型时不猜额度池。
    const pool = (p.quotaPools || []).find((item) => item.kind === p.modelFamily);
    const five = s5.querySelector('.agy-quota-five');
    const weekly = s5.querySelector('.agy-quota-weekly');
    const fiveFraction = pool?.fiveHour?.remainingFraction;
    const weeklyFraction = pool?.weekly?.remainingFraction;
    five.setAttribute('stroke-dasharray', Number.isFinite(fiveFraction)
      ? (QUOTA_OUTER_C * fiveFraction).toFixed(2) + ' ' + QUOTA_OUTER_C.toFixed(2)
      : '0 ' + QUOTA_OUTER_C.toFixed(2));
    weekly.setAttribute('d', quotaSector(weeklyFraction));
    if (p.modelFamily) {
      const fiveText = Number.isFinite(fiveFraction) ? pct(fiveFraction * 100) : '暂无数据';
      const weeklyText = Number.isFinite(weeklyFraction) ? pct(weeklyFraction * 100) : '暂无数据';
      show(s5, '');
      s5.setAttribute('aria-label', (p.modelName || '当前模型') + '额度：五小时 ' + fiveText + '，周额度 ' + weeklyText);
      shown += 1;
    } else { hide(s5); }
    bar.hidden = shown === 0;
    if (active?.style.display === 'none') closePanel();
    else if (active) renderPanel();
  }

  window.__agySb = update;
}

module.exports = '(' + agyStatusBarInstall.toString() + ')();';

