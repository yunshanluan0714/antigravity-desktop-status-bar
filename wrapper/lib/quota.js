'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const RPC_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const CSRF_RE = /^[a-f0-9-]{32,}$/i;
const CACHE_MS = 60_000;
let cached = null;
let cachedAt = 0;
let lastAttemptAt = 0;
let pending = null;

function parseQuotaPools(payload) {
  const groups = payload?.response?.groups || payload?.groups;
  if (!Array.isArray(groups)) return null;
  const pools = groups.map((group) => {
    const name = String(group?.displayName || '');
    const kind = /gemini/i.test(name) ? 'gemini' : /claude|gpt/i.test(name) ? 'claude-gpt' : null;
    if (!kind || !Array.isArray(group.buckets)) return null;
    const read = (period) => {
      const bucket = group.buckets.find((item) => period === 'fiveHour'
        ? item?.window === '5h' || /-5h$/i.test(String(item?.bucketId || ''))
        : item?.window === 'weekly' || /-weekly$/i.test(String(item?.bucketId || '')));
      const fraction = bucket?.remainingFraction;
      if (!Number.isFinite(fraction)) return null;
      return { remainingFraction: Math.max(0, Math.min(1, fraction)), resetTime: bucket.resetTime || null };
    };
    const fiveHour = read('fiveHour'), weekly = read('weekly');
    return fiveHour || weekly ? { kind, name, fiveHour, weekly } : null;
  }).filter(Boolean);
  return pools.length ? pools : null;
}

function readHubDescriptors(homeDir = os.homedir()) {
  const directory = path.join(homeDir, '.gemini', 'antigravity', 'daemon');
  let names;
  try { names = fs.readdirSync(directory); } catch (_) { return []; }
  const candidates = [];
  for (const name of names) {
    const match = /^hub_(\d+)\.json$/.exec(name);
    if (!match) continue;
    const port = Number(match[1]);
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 4096) continue;
      const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0
          || descriptor.httpPort !== port || !(port > 0 && port < 65536)
          || typeof descriptor.csrfToken !== 'string' || !CSRF_RE.test(descriptor.csrfToken)) continue;
      try { process.kill(descriptor.pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; }
      candidates.push({ ...descriptor, modifiedAt: stat.mtimeMs });
    } catch (_) { /* The host may replace a descriptor during discovery. */ }
  }
  return candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function requestQuota(descriptor, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from('{"forceRefresh":true}');
    const req = http.request({
      host: '127.0.0.1',
      port: descriptor.httpPort,
      method: 'POST',
      path: RPC_PATH,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': descriptor.csrfToken,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('quota RPC HTTP ' + res.statusCode));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new Error('quota RPC returned invalid JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('quota RPC timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function loadQuotaPools() {
  for (const descriptor of readHubDescriptors()) {
    try {
      const pools = parseQuotaPools(await requestQuota(descriptor));
      if (pools) return pools;
    } catch (_) { /* Try the next live language-server hub. */ }
  }
  return null;
}

function getQuotaPools(now = Date.now()) {
  if (pending) return pending;
  if (now - lastAttemptAt < CACHE_MS) {
    return Promise.resolve(cached && now - cachedAt < CACHE_MS * 5 ? cached : null);
  }
  lastAttemptAt = now;
  pending = loadQuotaPools().then((result) => {
    if (result) { cached = result; cachedAt = Date.now(); }
    return result || (cached && Date.now() - cachedAt < CACHE_MS * 5 ? cached : null);
  }).finally(() => { pending = null; });
  return pending;
}

module.exports = { getQuotaPools, parseQuotaPools, readHubDescriptors, RPC_PATH };
