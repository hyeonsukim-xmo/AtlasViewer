// Real imaging backend and Python worker; only Electron picker/IPC are replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/bulk-import-check');
const engineRoot = process.env.EXMO_ENGINE_ROOT || process.argv[2];
assert.ok(engineRoot, 'Set EXMO_ENGINE_ROOT');
const fixture = path.join(output, 'fixture.nrrd');
const packageResources = process.argv[3];
const scriptsRoot = packageResources ? path.join(packageResources, 'imaging') : path.join(root, 'desktop');
const source = packageResources
  ? require('@electron/asar').extractFile(path.join(packageResources, 'app.asar'), 'desktop/imaging.cjs').toString('utf8')
  : fs.readFileSync(path.join(scriptsRoot, 'imaging.cjs'), 'utf8');
const localRequire = createRequire(path.join(root, 'desktop/imaging.cjs'));
async function session(storageRoot, choices, forceSecondTimeout = false) {
  const handlers = new Map();
  const frame = {url: 'atlas://app/'};
  const progressEvents = [];
  const window = {webContents: {mainFrame: frame, send: (_channel, event) => progressEvents.push(event)}};
  const event = {sender: window.webContents, senderFrame: frame};
  const electron = {
    dialog: {showOpenDialog: async () => ({canceled: false, filePaths: choices})},
    ipcMain: {handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key)},
  };
  let timers = 0;
  const context = {module: {exports: {}}, process, console, clearTimeout, URL,
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      if (forceSecondTimeout && ms === 300000 && ++timers === 2) queueMicrotask(fn);
      return timer;
    },
    require: name => name === 'electron' ? electron : name === 'node:fs/promises'
      ? new Proxy(fsp, {get: (target, key) => typeof target[key] !== 'function' ? target[key] : async (...args) => {
          try { return await target[key](...args); }
          catch (error) { console.error('Test filesystem operation:', key, error.code); throw error; }
        }}) : localRequire(name)};
  vm.runInNewContext(source, context, {filename: path.join(scriptsRoot, 'imaging.cjs')});
  const backend = context.module.exports.installImaging(window, {engineRoot, storageRoot, scriptsRoot,
    palette: packageResources ? path.join(scriptsRoot, 'imaging-palette.json') : path.join(root, 'dist-desktop/imaging-palette.json')});
  const call = (name, ...args) => handlers.get('exmo:imaging:' + name)(event, ...args);
  return {backend, call, progressEvents};
}
(async () => {
  const storage = await fsp.mkdtemp(path.join(output, 'library-'));
  let client;
  try {
    client = await session(storage, Array(118).fill(fixture));
    const started = performance.now();
    let intermediate = 0;
    const timer = setInterval(() => {
      try {
        const count = JSON.parse(fs.readFileSync(path.join(storage, 'library.json'), 'utf8')).length;
        if (count > 0 && count < 118) intermediate = count;
      } catch {}
    }, 20);
    let reply;
    try { reply = await client.call('choose', 'ct', false, 'en'); }
    finally { clearInterval(timer); }
    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.value.length, 118);
    const savedEvents = client.progressEvents.filter(event => event.rows.length);
    assert.equal(savedEvents.length, 118);
    assert.deepEqual(savedEvents.map(event => event.completed), Array.from({length:118}, (_, i) => i + 1));
    const firstSaved = client.progressEvents.findIndex(event => event.rows.length);
    assert.ok(client.progressEvents.slice(0, firstSaved).every(event => event.completed === 0));
    assert.equal(client.progressEvents.slice(0, firstSaved).filter(event => event.phase === 'copy').length, 2,
      'First file is published before starting the second copy');
    assert.ok(reply.value.every(row => row.ready && row.deferredValidation));
    assert.ok(intermediate > 0, 'Completed images must be saved before the batch ends');
    const seconds = (performance.now() - started) / 1000;
    const records = JSON.parse(await fsp.readFile(path.join(storage, 'library.json'), 'utf8'));
    assert.ok(records.every(row => row.input.endsWith('.nrrd')));
    assert.equal((await client.call('status', 'ct')).value.importProgress, null);
    await client.backend.dispose();
    client = await session(storage, [fixture, fixture, fixture], true);
    assert.equal((await client.call('list', 'ct')).value.length, 118, 'Saved inputs survive restart');
    const partial = await client.call('choose', 'ct', false, 'en');
    assert.equal(partial.ok, true);
    assert.equal(partial.value.length, 3);
    assert.equal(partial.value.filter(row => row.ready).length, 2);
    assert.ok(partial.value.some(row => row.error?.includes('시간이 초과')));
    assert.equal((await client.call('list', 'ct')).value.length, 121);
    const report = {passed: true, packaged: !!packageResources, files: 118, seconds, intermediateSavedCount: intermediate,
      sourceBytes: fs.statSync(fixture).size, timedOutFileIsolated: true, restartPersistence: true};
    await fsp.writeFile(path.join(output, 'bulk-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (client) await client.backend.dispose();
    // This unique test directory was created above, inside the workspace only.
    await fsp.rm(storage, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
