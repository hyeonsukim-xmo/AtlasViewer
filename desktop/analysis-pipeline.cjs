const os = require("node:os");

function aborted() { const error = new Error("Analysis cancelled"); error.name = "AbortError"; return error; }

class Capacity {
  constructor(limit) { this.limit = limit; this.used = 0; this.waiters = []; }
  acquire(amount = 1, signal) {
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const waiter = { amount, resolve, reject, signal };
      waiter.abort = () => { this.waiters = this.waiters.filter(item => item !== waiter); reject(aborted()); this.drain(); };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter); this.drain();
    });
  }
  drain() {
    while (this.waiters.length) {
      const next = this.waiters[0];
      // An oversized case may run alone, never alongside another case.
      if (this.used && this.used + next.amount > this.limit) break;
      this.waiters.shift(); next.signal?.removeEventListener("abort", next.abort);
      if (next.signal?.aborted) { next.reject(aborted()); continue; }
      let held = next.amount, released = false;
      this.used += held;
      next.resolve({
        release: () => { if (released) return; released = true; this.used -= held; this.drain(); },
        resize: value => { if (released) return; if (value > held) throw new Error("Cannot grow an active reservation"); this.used -= held - value; held = value; this.drain(); },
      });
    }
  }
}

const GiB = 1024 ** 3;
function estimateMemory(file) {
  const size = file.metadata?.size || [512, 512, 512];
  const spacing = file.metadata?.spacing || [1, 1, 1];
  const native = size.reduce((a, b) => a * b, 1);
  if (file.analysis === "ct") {
    const grid = size.reduce((n, length, axis) => n * Math.max(96, Math.ceil(length * spacing[axis] / [1.5, 1.5, 2][axis])), 1);
    return { gpu: Math.max(2 * GiB, GiB + native * 8 + grid * 33 * 4 * 3), cpu: Math.max(2 * GiB, GiB + native * 8 + grid * 33 * 4 * 2), finalize: Math.max(2 * GiB, GiB + native * 12) };
  }
  if (file.analysis === "mri") return { gpu: Math.max(3 * GiB, GiB + native * (29 * 4 * 3 + 8)), cpu: Math.max(2 * GiB, GiB + native * (29 * 4 * 2 + 8)) };
  return { gpu: Math.max(2 * GiB, GiB + native * 48), cpu: Math.max(GiB, GiB / 2 + native * 32) };
}

function resources({ totalMemory = os.totalmem(), freeMemory = os.freemem() } = {}) {
  return { model: new Capacity(2), gpu: new Capacity(1), cpu: new Capacity(1), finalize: new Capacity(1), memory: new Capacity(Math.max(2 * GiB, Math.min(totalMemory * .7, freeMemory - 2 * GiB))) };
}

async function runPipeline(targets, { execute, failed, signal, concurrency = 2 }) {
  let index = 0;
  const worker = async () => {
    while (!signal.aborted && index < targets.length) {
      const file = targets[index++];
      try { await execute(file); }
      catch (error) { if (!signal.aborted) failed(file, error); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
}

module.exports = { Capacity, estimateMemory, resources, runPipeline, aborted };
