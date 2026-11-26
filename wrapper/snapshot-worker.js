'use strict';
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

if (!isMainThread) {
  const { snapshotForId } = require('./lib/store');
  parentPort.on('message', ({ seq, id }) => parentPort.postMessage({ seq, snapshot: snapshotForId(id) }));
} else {
  let worker;
  let seq = 0;
  const pending = new Map();

  function close(reason = new Error('Statistics worker closed')) {
    const current = worker;
    worker = null;
    for (const { timer, reject } of pending.values()) {
      clearTimeout(timer);
      reject(reason);
    }
    pending.clear();
    if (current) current.terminate().catch(() => {});
  }

  function snapshotForId(id) {
    if (!worker) {
      const current = new Worker(__filename);
      worker = current;
      current.on('message', ({ seq, snapshot }) => {
        if (worker !== current || !pending.has(seq)) return;
        const request = pending.get(seq);
        pending.delete(seq);
        clearTimeout(request.timer);
        request.resolve(snapshot);
      });
      current.on('error', error => { if (worker === current) close(error); });
      current.on('exit', () => { if (worker === current) close(); });
      current.unref();
    }
    return new Promise((resolve, reject) => {
      const request = ++seq;
      const timer = setTimeout(() => close(new Error('Statistics snapshot timed out')), 10000);
      pending.set(request, { timer, resolve, reject });
      try { worker.postMessage({ seq: request, id }); } catch (error) { close(error); }
    });
  }
  module.exports = { snapshotForId, close };
}
