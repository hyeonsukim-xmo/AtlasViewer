import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const english = JSON.parse(fs.readFileSync("desktop/ui/locales/en.json", "utf8"));
const missing = new Set();
const hangul = /[\uac00-\ud7a3]/;
const files = ["desktop/ui", "app", "components"].flatMap(root =>
  fs.existsSync(root) ? fs.readdirSync(root, {recursive: true})
    .filter(name => /\.(tsx?|css)$/.test(name)).map(name => `${root}/${name}`) : []);
let calls = 0;
let literals = 0;
const unwrapped = [];
// These data constants are translated at their presentation sites, not at module load.
const delayedKeys = new Set(["NRRD · DICOM 방향 확인", "미분류"]);
for (const file of files) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  function visit(node) {
    if ((ts.isStringLiteralLike(node) || ts.isJsxText(node)) && hangul.test(node.text)) {
      literals++;
      const key = node.text;
      if (key !== "한국어" && !english[key]) missing.add(`${file}: ${key}`);
      let parent = node.parent;
      while (parent && !(ts.isCallExpression(parent) && parent.expression.getText(source) === "t")) parent = parent.parent;
      const languageName = file.endsWith("language-select.tsx") && key === "한국어";
      const deferred = (file.endsWith("main.tsx") || file.endsWith("result-view.tsx")) && delayedKeys.has(key);
      if (!parent && !languageName && !deferred) unwrapped.push(`${file}: ${key}`);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "t" &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const key = node.arguments[0].text;
      calls++;
      if (/[가-힣]/.test(key) && !english[key]) missing.add(key);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.deepEqual(unwrapped, [], "Korean UI literals must pass through t(), including accessibility attributes");
let backendMessages = 0;
// Backend files use plain quoted Korean messages. Scan all literals, not just errors:
// this also covers warnings, laterality reasons, progress stages and multiline calls.
const backendExceptions = new Set(["DICOM 폴더", "영상 파일", " · 미분류"]);
for (const file of [
  "desktop/imaging.cjs",
  "desktop/imaging-worker.py",
  "desktop/classifier-worker.py",
]) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
    const key = match[1] ?? match[2];
    if (!hangul.test(key)) continue;
    backendMessages++;
    if (!english[key] && !backendExceptions.has(key)) missing.add(`${file}: ${key}`);
  }
}
assert.deepEqual(
  [...missing],
  [],
  "Every UI key and application input error needs an English translation",
);
for (const [key, value] of Object.entries(english)) {
  assert.ok(value.trim() && !/[가-힣]/.test(value), `Untranslated English entry: ${key}`);
  const parameters = (text) => [...text.matchAll(/\{\{\w+\}\}/g)].map((match) => match[0]).sort();
  assert.deepEqual(parameters(value), parameters(key), `Interpolation mismatch: ${key}`);
}
console.log(
  `PASS: ${Object.keys(english).length} English translations, ${files.length} source files, ${literals} Korean UI literals, ${backendMessages} backend messages, ${calls} UI calls and interpolation parity`,
);
