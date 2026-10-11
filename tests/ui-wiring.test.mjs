import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");

test("すべての <script> ブロックが構文エラーなくコンパイルできる", () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  assert.ok(blocks.length >= 1);
  blocks.forEach((code, i) => {
    assert.doesNotThrow(() => new vm.Script(code, { filename: "script" + i }), "script#" + i);
  });
});

test("読みかけUIの要素とハンドラが配線されている", () => {
  for (const id of ["btnWebmarks", "webmarks", "wmList", "wmNote", "wmBookmarklet", "btnWmCopy", "btnWebmarksClose"]) {
    assert.ok(html.includes('id="' + id + '"'), "id=" + id + " がない");
  }
  for (const frag of [
    '$("#btnWebmarks").onclick=',
    '$("#btnWebmarksClose").onclick=',
    "intakeWebmarkFromHash()",
    "function renderWebmarks(",
    "function deleteWebmark(",
    'addEventListener("storage"',
    "webmarkIntakeNote(!!appKey())",
  ]) {
    assert.ok(html.includes(frag), frag + " がない");
  }
});

test("同期コードのPATCH呼び出しと mergeFromRemote は1箇所のまま(同期部を触っていない)", () => {
  assert.equal((html.match(/method:"PATCH"/g) || []).length, 1);
  assert.equal((html.match(/function mergeFromRemote\(/g) || []).length, 1);
});
