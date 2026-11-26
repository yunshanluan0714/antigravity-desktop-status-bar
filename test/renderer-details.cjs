'use strict';
// Run with Node; JSDOM is already available in the workspace's localization project.
const assert = require('node:assert/strict');
const { JSDOM } = require('../../antigravity2-cn-main/node_modules/jsdom');
const renderer = require('../wrapper/renderer');
const id = 'aaaaaaaa-0000-4000-8000-000000000001';
const nextId = 'aaaaaaaa-0000-4000-8000-000000000002';
const { window } = new JSDOM(`<div class="composer-shell" style="padding-bottom:24px"><div id="antigravity.agentSidePanelInputBox" class="surface-composer"><div id="composer-toolbar" style="display:flex;flex-direction:row;width:100%"><button id="model-picker">Gemini 4 Hydrogen High</button><button id="toolbar-action">Send</button></div></div></div>
<div data-testid="conversation-row-sidebar" data-selected="true" data-cascade-id="${id}"><span>测试会话</span></div>
<div id="outside"></div>`, { runScripts: 'outside-only' });
(async () => {
  try {
    const doc = window.document;
    const html = window.HTMLElement.prototype;
    html.getBoundingClientRect = function () { return { left: 400, top: 400, bottom: this.classList.contains('composer-shell') ? 446 : 422, width: 160, height: 22 }; };
    html.showPopover = function () { this.dataset.open = 'true'; };
    html.hidePopover = function () { delete this.dataset.open; };
    const signals = [];
    window.console.info = (message) => signals.push(message);
    window.eval(renderer);
    const p = {
      conversationId: id, title: '测试会话', turns: 4, steps: 15, modelName: 'Gemini 4 Hydrogen High', modelFamily: 'gemini',
      speed: { llmMs: 10000, toolMs: 80400,
        latest: { stream: 267.94350938285936, endToEnd: 85.91012002605217, show: 267.94350938285936, ttftMs: 21905, streamMs: 10338, output: 2770 },
        average: { stream: 136.59, endToEnd: 26.89, show: 136.59, ttftMs: 20100 } },
      quotaPools: [
        { kind: 'gemini', name: 'Gemini Models', fiveHour: { remainingFraction: 0.93, resetTime: '2026-11-25T18:01:13Z' }, weekly: { remainingFraction: 0.968, resetTime: '2026-12-01T03:25:06Z' } },
        { kind: 'claude-gpt', name: 'Claude and GPT models', fiveHour: { remainingFraction: 0.8, resetTime: '2026-11-25T18:22:28Z' }, weekly: { remainingFraction: 0.212, resetTime: '2026-11-26T02:52:55Z' } },
      ],
      tokens: { total: 4000, fresh: 1300, cached: 2000, output: 700, cachePercent: 60.6 },
      subagents: { total: 500, percent: 11.1, entries: [{ id: '123456789', name: 'DeepInvestigator', total: 500 }, { id: 'fedcba987654', total: null }] },
      context: { used: 700, limit: 1000, percent: 70 },
    };
    window.__agySb(p);
    const bar = doc.getElementById('agy-sb');
    const panel = doc.getElementById('agy-sb-details');
    const [quotaRing, speed, usage, sub, ctx] = bar.querySelectorAll('button');
    assert.equal(bar.parentElement.id, 'composer-toolbar');
    assert.equal(bar.style.fontSize, '12px');
    assert.equal(panel.style.fontSize, '13px');
    assert.equal(bar.firstElementChild, quotaRing);
    assert.equal(bar.previousElementSibling.id, 'model-picker');
    assert.equal(bar.nextElementSibling.id, 'toolbar-action');
    assert.equal(quotaRing.querySelector('.agy-quota-ring').querySelectorAll('circle').length, 2);
    assert.ok([...bar.querySelectorAll('button')].every((button) => !button.hasAttribute('title')));
    assert.match(speed.textContent, /268 tok\/s/);
    assert.doesNotMatch(speed.textContent, /4 轮|15 步/);
    assert.equal(usage.querySelector('svg'), null, 'token segment has no leading icon');
    assert.equal(quotaRing.querySelector('.agy-quota-weekly').getAttribute('d').startsWith('M12 12'), true);
    assert.match(quotaRing.querySelector('.agy-quota-five').getAttribute('stroke-dasharray'), /^60\.7/);
    speed.click();
    assert.equal(speed.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.dataset.open, 'true');
    assert.match(panel.textContent, /速度详情268 tok\/s/);
    assert.match(panel.textContent, /轮数4 轮.*步数15 步.*模型用时10秒.*工具调用用时1分20秒.*首 token 平均（TTFT）20.1秒.*平均输出速度137 tok\/s/);
    assert.doesNotMatch(panel.textContent, /流式速度|端到端/);
    assert.doesNotMatch(panel.textContent, /最近一轮(?:输入|缓存|输出)/);
    window.__agySb({ ...p, speed: { ...p.speed, toolMs: null } });
    assert.match(panel.textContent, /工具调用用时—/);
    assert.ok(Number.parseInt(panel.style.top, 10) < 400);
    window.__agySb({ ...p, speed: { llmMs: 10000, toolMs: 80400 } });
    assert.match(panel.textContent, /速度详情轮数4 轮步数15 步模型用时10秒工具调用用时1分20秒/);
    assert.match(speed.textContent, /— tok\/s/);
    usage.click();
    assert.equal(speed.getAttribute('aria-expanded'), 'false');
    assert.match(panel.textContent, /输入1,300.*缓存.*2,000.*输出700/);
    sub.click();
    assert.match(panel.textContent, /DeepInvestigator500 tok/);
    assert.match(panel.textContent, /未命名子代理 fedcba98—/);
    ctx.click();
    assert.match(panel.textContent, /上下文已用 70%.*700.*1.0K/);
    window.__agySb({ ...p, context: { used: null, limit: 1000, percent: null, awaitingSample: true } });
    assert.match(ctx.textContent, /待采样/);
    assert.equal(ctx.querySelector('.agy-ring').style.visibility, 'hidden');
    assert.match(panel.textContent, /上下文已压缩.*等待下一次模型请求/);
    assert.doesNotMatch(panel.textContent, /70%/);
    window.__agySb({ ...p, context: { used: 200, limit: 1000, percent: 20 } });
    assert.match(ctx.textContent, /20%/);
    assert.equal(ctx.querySelector('.agy-ring').style.visibility, '');
    assert.match(panel.textContent, /上下文已用 20%/);
    quotaRing.click();
    assert.match(panel.textContent, /额度Gemini 4 Hydrogen High五小时剩余93%.*周额度剩余96.8%/);
    assert.doesNotMatch(panel.textContent, /Claude/);
    window.__agySb({ ...p, modelName: 'Claude Sonnet', modelFamily: 'claude-gpt' });
    assert.match(panel.textContent, /额度Claude Sonnet五小时剩余80%.*周额度剩余21.2%/);
    assert.equal(quotaRing.getAttribute('aria-label').includes('Claude Sonnet'), true);
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(panel.dataset.open, undefined);
    assert.equal(doc.activeElement, quotaRing);
    ctx.click();
    doc.getElementById('outside').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    assert.equal(panel.dataset.open, undefined);
    usage.click();
    usage.click();
    assert.equal(panel.dataset.open, undefined);
    speed.click();
    doc.querySelector('[data-cascade-id]').setAttribute('data-cascade-id', nextId);
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(signals.at(-1), '[agy-statusbar:selection]');
    assert.equal(panel.dataset.open, undefined);
    assert.equal(bar.hidden, true);
    window.__agySb({ ...p, conversationId: nextId, title: '另一个会话', turns: 6 });
    assert.equal(bar.hidden, false);
    assert.doesNotMatch(bar.textContent, /测试会话|另一个会话|6 轮|15 步/);
    assert.equal(bar.childElementCount, 5);
    assert.match(speed.textContent, /268 tok\/s/);
    console.log('PASS: inline placement, compact controls, speed/quota details, pool switch and exact session binding');
  } finally { window.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
