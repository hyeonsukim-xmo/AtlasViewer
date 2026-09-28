// Real Electron + saved sample results. No inference or changes to the user's library.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const output = path.resolve("outputs/language-check");
app.setPath("userData", path.join(output, "userdata"));
const appRoot = path.resolve(process.env.EXMO_TEST_APP_ROOT || ".");
const reopen = process.argv.includes("--reopen");
let pickerTitle = "";
let pickerFiles = [];
dialog.showOpenDialog = async (_window, options) => {
  pickerTitle = options.title;
  return { canceled: pickerFiles.length === 0, filePaths: pickerFiles };
};
const errors = [];
app.on("web-contents-created", (_, contents) => contents.on("console-message", (details) => {
  if (details.level === "error") errors.push(details.message);
}));
require(path.join(appRoot, "desktop/main.cjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error("Language validation timed out"); app.exit(1); }, 300000);
(async () => {
  await app.whenReady();
  const window = BrowserWindow.getAllWindows()[0];
  const contents = window.webContents;
  if (contents.isLoading()) await new Promise(resolve => contents.once("did-finish-load", resolve));
  const run = async (fn, ...args) => {
    try { return await contents.executeJavaScript(`(${fn})(${args.map(v => JSON.stringify(v)).join(",")})`); }
    catch (error) { throw new Error(`Renderer check failed: ${fn}\n${JSON.stringify(args)}\n${errors.join('\n')}`, {cause: error}); }
  };
  const wait = async (fn) => {
    for (let i = 0; i < 300; i++) { if (await run(fn)) return; await sleep(100); }
    throw new Error("UI timeout: " + fn);
  };
  const click = text => run(text => {
    const button = [...document.querySelectorAll("button")].find(b => b.getClientRects().length && (b.getAttribute('role') === 'tab' ? b.textContent.trim().startsWith(text) : b.textContent.trim() === text));
    if (!button || button.disabled) throw new Error("Unavailable button: " + text);
    button.click();
  }, text);
  const language = async value => {
    await run(value => {
      const select = document.querySelector('[data-language-switch] select');
      select.value = value;
      select.dispatchEvent(new Event("change", {bubbles: true}));
    }, value);
    await sleep(150);
    assert.equal(await run(() => document.documentElement.lang), value);
  };
  const capture = async name => {
    await sleep(350);
    fs.writeFileSync(path.join(output, name + ".png"), (await contents.capturePage()).toPNG());
  };
  const noKorean = async () => {
    const untranslated = await run(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const found = [];
      while (walker.nextNode()) {
        const node = walker.currentNode, host = node.parentElement;
        if (!host || host.closest('option[value="ko"],script,style') || !host.getClientRects().length || !/[가-힣]/.test(node.textContent)) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        if (range.getBoundingClientRect().height) found.push(node.textContent.trim());
      }
      for (const node of document.querySelectorAll('[title],[aria-label],[placeholder],[alt],[aria-description],[aria-valuetext]')) {
        if (!node.getClientRects().length) continue;
        for (const name of ['title','aria-label','placeholder','alt','aria-description','aria-valuetext']) {
          const text = node.getAttribute(name);
          if (text && /[가-힣]/.test(text)) found.push(name + ': ' + text);
        }
      }
      return [...new Set(found)];
    });
    assert.deepEqual(untranslated, [], "Visible UI / accessibility text must be English");
  };
  await wait(() => document.querySelector(".recent-section tbody tr"));
  if (reopen) {
    assert.equal(await run(() => document.documentElement.lang), "en");
    assert.equal(await run(() => document.querySelector('[data-language-switch] select').value), "en");
    await noKorean();
    await capture("english-reopened");
    fs.writeFileSync(path.join(output, "reopen-language-report.json"), JSON.stringify({passed: true, language: "en", freshProcess: true}));
  } else {
    await language("ko");
    assert.equal(await run(() => document.querySelector("h1").textContent), "분석 작업");
    const before = await run(async () => (await Promise.all(['ct','mri','xray'].map(m => window.exmoDesktop.results(m)))).map(r => r.value));
    await language("en");
    assert.equal(await run(() => document.querySelector("h1").textContent), "Analysis workspace");
    await noKorean();
    await capture("english-home");
    window.setSize(900, 660);
    await sleep(300);
    assert.ok(await run(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture("english-compact-home");
    window.setSize(1440, 960);
    await run(() => document.querySelector('[aria-label="MRI thigh muscle analysis"]').click());
    await wait(() => document.querySelector('.desktop-workspace:not([hidden]) .medical-image img'));
    await noKorean();
    await click("Add images");
    assert.equal(pickerTitle, "MRI · Add images");
    await capture("english-input");
    await run(() => document.querySelector('.desktop-workspace:not([hidden]) .series-table tbody input[type="checkbox"]').click());
    await click("Review selected images");
    await wait(() => document.querySelector('.desktop-workspace:not([hidden]) .review-case img'));
    await noKorean();
    await capture("english-review");
    await click("Analysis results");
    await run(() => [...document.querySelectorAll('.desktop-workspace:not([hidden]) .results-list input')].slice(0, 3).forEach(i => i.click()));
    await click("Compare selected (3/3)");
    await wait(() => document.querySelectorAll('.desktop-workspace:not([hidden]) .case-canvas img').length === 3);
    await noKorean();
    const selectionBefore = await run(() => [...document.querySelectorAll('.desktop-workspace:not([hidden]) [data-result-id]')].map(n => n.dataset.resultId));
    const sliceBefore = await run(() => [...document.querySelectorAll('.desktop-workspace:not([hidden]) input[aria-label="Slice"]')].map(n => n.value));
    await language("ko");
    assert.ok(await run(() => document.querySelector('.desktop-workspace:not([hidden]) h1').textContent.includes('3개 검사 비교')));
    await language("en");
    assert.deepEqual(await run(() => [...document.querySelectorAll('.desktop-workspace:not([hidden]) [data-result-id]')].map(n => n.dataset.resultId)), selectionBefore);
    assert.deepEqual(await run(() => [...document.querySelectorAll('.desktop-workspace:not([hidden]) input[aria-label="Slice"]')].map(n => n.value)), sliceBefore);
    await click("QC / postprocessing");
    await noKorean();
    await run(() => document.querySelector('.desktop-workspace:not([hidden]) .qc-details').open = true);
    await noKorean();
    await capture("english-mri-qc");
    await click("Measurements");
    await click("3D anatomy");
    await wait(() => document.querySelectorAll('.desktop-workspace:not([hidden]) .result-scene canvas').length === 3 && !document.querySelector('.desktop-workspace:not([hidden]) .scene-loading'));
    await noKorean();
    await capture("english-mri-3d");
    // Check each CT / AP / lateral saved result, including modality-specific QC text.
    for (const modality of ['CT', 'X-ray']) {
      await run(() => document.querySelector('.desktop-brand').click());
      await run(label => document.querySelector(`[aria-label="${label} thigh muscle analysis"]`).click(), modality);
      await wait(() => document.querySelector('.desktop-workspace:not([hidden]) .medical-image img'));
      await noKorean();
      if (modality === 'CT') {
        await click('DICOM folder');
        assert.equal(pickerTitle, 'CT · Add DICOM folder');
      } else {
        await run(() => document.querySelectorAll('.desktop-workspace:not([hidden]) details').forEach(n => n.open = true));
        await noKorean();
      }
      await click('Analysis results');
      const count = await run(() => document.querySelectorAll('.desktop-workspace:not([hidden]) .results-list tbody tr').length);
      for (let index = 0; index < count; index++) {
        await run(index => document.querySelectorAll('.desktop-workspace:not([hidden]) .results-list tbody tr')[index].querySelector('button').click(), index);
        await wait(() => document.querySelector('.desktop-workspace:not([hidden]) .case-canvas img'));
        await noKorean();
        await click('QC / postprocessing');
        await run(() => document.querySelector('.desktop-workspace:not([hidden]) .qc-details').open = true);
        await noKorean();
        await capture(`english-${modality === 'CT' ? 'ct' : 'xray'}-qc-${index}`);
        await click('← Results list');
      }
    }
    await run(() => document.querySelector('.desktop-brand').click());
    await run(() => document.querySelector('[aria-label="X-ray thigh muscle analysis"]').click());
    await click('Images / series');
    await wait(() => document.querySelector('.desktop-workspace:not([hidden]) .medical-image img'));
    await noKorean();
    await capture("english-xray-classification");
    const invalidFile = path.join(output, 'invalid-input.nrrd');
    fs.writeFileSync(invalidFile, 'Invalid test image');
    pickerFiles = [invalidFile];
    await click("Add images");
    await wait(() => document.querySelector('.desktop-workspace:not([hidden]) .clinical-empty p')?.textContent.includes('Could not read'));
    await noKorean();
    await capture("english-input-error");
    pickerFiles = [];
    await run(async () => {
      const response = await window.exmoDesktop.preview('ct', 'missing-input');
      if (response.ok) throw new Error('Expected invalid input rejection');
    });
    await run(() => document.querySelector('.desktop-brand').click());
    await click("3D demo");
    await wait(() => document.querySelector('.studio canvas'));
    await noKorean();
    await language("ko");
    await run(() => document.querySelector('.studio .brand').click());
    assert.equal(await run(() => document.querySelector('h1').textContent), '분석 작업');
    await language("en");
    const after = await run(async () => (await Promise.all(['ct','mri','xray'].map(m => window.exmoDesktop.results(m)))).map(r => r.value));
    assert.deepEqual(after, before, "Language changes must not alter results or measurement values");
    // Presentation-only fault injection in the isolated test process. No model runs,
    // user data writes, or changes to production IPC handlers/source.
    await run(() => document.querySelector('[aria-label="CT thigh muscle analysis"]').click());
    await click('Images / series');
    let simulatedJob = null;
    ipcMain.removeHandler('exmo:imaging:job');
    ipcMain.handle('exmo:imaging:job', () => ({ok: true, value: simulatedJob}));
    for (const stage of ['대기', '입력 확인', '모델 준비', '원본 좌표 복원', '측정·Overlay·3D 준비']) {
      simulatedJob = {id: stage, analysis: 'ct', state: 'running', stage, current: 'Audit fixture', progress: 40, completed: [], failed: [], total: 1};
      await sleep(1100);
      await wait(() => document.querySelector('.desktop-workspace:not([hidden]) .job-status'));
      await noKorean();
    }
    const dictionary = JSON.parse(fs.readFileSync('desktop/ui/locales/en.json', 'utf8'));
    const messages = new Set();
    for (const file of ['desktop/imaging.cjs', 'desktop/imaging-worker.py', 'desktop/classifier-worker.py']) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
        const key = match[1] ?? match[2];
        if (/[가-힣]/.test(key) && dictionary[key]) messages.add(key);
      }
    }
    simulatedJob = {id: 'audit-errors', analysis: 'ct', state: 'failed', stage: '완료', current: '', progress: 0, completed: [], total: messages.size,
      failed: [...messages].map((error, index) => ({id: String(index), name: 'Audit fixture ' + index, error}))};
    await wait(() => document.querySelector('.desktop-workspace:not([hidden]) .inline-error')?.textContent.includes('Audit fixture'));
    await noKorean();
    assert.equal(await run(() => document.querySelectorAll('.desktop-workspace:not([hidden]) .inline-error p').length), messages.size);
    simulatedJob = null;
    await run(() => document.querySelector('.desktop-brand').click());
    await wait(() => document.querySelector('.recent-section tbody tr'));
    await sleep(1200); // Let pending UI refreshes settle before disposing IPC handlers.
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "language-report.json"), JSON.stringify({passed: true, errors, simulatedBackendMessages: messages.size, simulatedProgressStages: 5, checks: ['Korean/English switching', 'accessible labels including language selector', 'English image and DICOM folder picker titles', 'input/review/results/QC/3D/classification', 'every saved CT/AP/LAT result QC', 'comparison and slices preserved', 'measurements unchanged', 'compact layout', 'demo language selector', 'simulated backend errors and progress presentation']}, null, 2));
  }
  clearTimeout(deadline);
  console.log("PASS: Desktop language " + (reopen ? "persistence in fresh process" : "switching and real-result views"));
  app.quit();
})().catch(error => {console.error(error); clearTimeout(deadline); app.exit(1);});
