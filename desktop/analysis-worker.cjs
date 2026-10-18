const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { workerError } = require('./diagnostics.cjs');

class AnalysisWorker {
  constructor({ python, args, env, logPath, artifactStorage, logResponses=true }) {
    Object.assign(this, { python, args, env, logPath, artifactStorage, logResponses });
    this.pending = new Map(); this.child = null; this.closed = false;
  }
  start() {
    if (this.closed) throw new Error("Analysis worker closed");
    if (this.child) return;
    const child = spawn(this.python, this.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: this.env });
    this.child = child;
    const log = fs.createWriteStream(this.logPath, { flags: "a" });
    log.on('error', error => {
      for (const task of this.pending.values()) task.reject(error);
      void this.stop();
    });
    child.stderr.pipe(log, { end: false });
    const fail = (cause) => {
      if (this.child !== child) return;
      for (const task of this.pending.values()) task.reject(workerError({error:'Analysis process stopped', errorCode:cause?.code === 'ENOENT' ? 'ENGINE_MISSING' : cause instanceof Error ? 'ENGINE_START' : 'ENGINE_STOPPED'}));
      this.pending.clear();
    };
    child.stdin.on("error", () => { fail(); void this.stop(); });
    child.once("error", fail);
    child.once("close", () => { fail(); if (this.child === child) this.child = null; log.end(); });
    if (this.artifactStorage) child.stdin.write(JSON.stringify({operation:'storage_init',...this.artifactStorage})+'\n');
    readline.createInterface({ input: child.stdout }).on("line", line => {
      if(this.logResponses)log.write(line + "\n");
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const id = event.job_id || event.id;
      const task = this.pending.get(id);
      if (!task) return;
      if (event.exmo) {
        task.log?.write(line + "\n");
        // Resume may wait for the CPU slot. Handle rejection without an unhandled promise.
        Promise.resolve().then(() => task.onEvent?.(event)).catch(error => {
          task.reject(error);
          // Never leave a Python job waiting forever for an unfulfilled handoff.
          void this.stop();
        });
        if (event.stage === "complete") task.resolve(event);
        if (event.stage === "failed") task.reject(workerError(event));
      } else if (Object.hasOwn(event, "result") || event.error) {
        event.error ? task.reject(workerError(event)) : task.resolve(event.result);
      }
    });
  }
  send(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Analysis worker disconnected");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(message, { id = randomUUID(), onEvent, logPath, timeout = 0 } = {}) {
    if (this.pending.has(id)) return Promise.reject(new Error("Duplicate analysis request"));
    this.start();
    return new Promise((resolve, reject) => {
      let settled = false;
      const log = logPath ? fs.createWriteStream(logPath) : null;
      log?.on('error', error => { this.pending.get(id)?.reject(error); void this.stop(); });
      const timer = timeout ? setTimeout(() => {
        this.pending.get(id)?.reject(workerError({error:'Analysis timeout',errorCode:'TIMEOUT'}));
        void this.stop();
      }, timeout) : null;
      const finish = (handler, value) => { if (settled) return; settled = true; clearTimeout(timer); this.pending.delete(id); log?.end(); handler(value); };
      this.pending.set(id, { onEvent, log, resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      try { this.send({ ...message, id, requestId: id }); }
      catch (error) { this.pending.get(id)?.reject(error); }
    });
  }
  stop() {
    if (!this.shutdownPromise) this.shutdownPromise = this.shutdown(true);
    return this.shutdownPromise;
  }
  close() {
    if (!this.shutdownPromise) this.shutdownPromise = this.shutdown(false);
    return this.shutdownPromise;
  }
  async shutdown(force) {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    const closed = new Promise(resolve => child.once("close", resolve));
    if (!force) {
      child.stdin.end();
    } else if (process.platform === "win32") {
      await new Promise(resolve => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => { child.kill(); resolve(); });
        killer.once("exit", code => { if (code) child.kill(); resolve(); });
      });
    } else child.kill();
    await closed;
  }
}

module.exports = { AnalysisWorker };
