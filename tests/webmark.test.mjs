import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");
const m = /\/\* WEBMARK:BEGIN \*\/([\s\S]*?)\/\* WEBMARK:END \*\//.exec(html);
assert.ok(m, "index.html に WEBMARK:BEGIN/END ブロックがない");
const api = new Function(
  m[1] + "; return {liveDocsOf,liveWebmarksOf,webmarkUrlKey,parseWebmarkHash,upsertWebmark,webmarkJumpUrl};"
)();

const enc = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

test("liveDocsOf: kindなしの既存docは残り、墓標とwebmarkは除かれる", () => {
  const list = [
    { id: "d1", title: "号1" },
    { id: "d2", title: "消した号", deleted: true },
    { id: "w1", kind: "webmark", title: "記事", url: "https://a.example/" },
  ];
  assert.deepEqual(api.liveDocsOf(list).map((d) => d.id), ["d1"]);
});

test("liveWebmarksOf: webmarkのみ・削除除外・updatedAt降順", () => {
  const list = [
    { id: "d1", title: "号" },
    { id: "w1", kind: "webmark", updatedAt: "2026-10-01T00:00:00Z" },
    { id: "w2", kind: "webmark", updatedAt: "2026-10-03T00:00:00Z" },
    { id: "w3", kind: "webmark", deleted: true, updatedAt: "2026-10-05T00:00:00Z" },
  ];
  assert.deepEqual(api.liveWebmarksOf(list).map((d) => d.id), ["w2", "w1"]);
});

test("parseWebmarkHash: 正常系（日本語・フラグメント除去）", () => {
  const h = "#webmark=" + enc({ u: "https://ex.com/a?x=1#frag", t: "題名あ", s: "段落の先頭" });
  assert.deepEqual(api.parseWebmarkHash(h), {
    u: "https://ex.com/a?x=1",
    t: "題名あ",
    s: "段落の先頭",
  });
});

test("parseWebmarkHash: タイトルが空ならURLにフォールバック", () => {
  const r = api.parseWebmarkHash("#webmark=" + enc({ u: "https://ex.com/", t: "", s: "" }));
  assert.equal(r.t, "https://ex.com/");
  assert.equal(r.s, "");
});

test("parseWebmarkHash: 壊れた・非http(s)・別のハッシュは null", () => {
  assert.equal(api.parseWebmarkHash("#webmark=!!!"), null);
  assert.equal(api.parseWebmarkHash("#webmark=" + Buffer.from("not json").toString("base64url")), null);
  assert.equal(api.parseWebmarkHash("#webmark=" + enc({ u: "javascript:alert(1)", t: "x", s: "" })), null);
  assert.equal(api.parseWebmarkHash("#webmark=" + enc({ t: "x" })), null);
  assert.equal(api.parseWebmarkHash("#other=1"), null);
  assert.equal(api.parseWebmarkHash(""), null);
});

test("parseWebmarkHash: 長すぎるタイトル・断片は切り詰める", () => {
  const r = api.parseWebmarkHash(
    "#webmark=" + enc({ u: "https://ex.com/", t: "あ".repeat(500), s: "い".repeat(500) })
  );
  assert.equal(r.t.length, 200);
  assert.equal(r.s.length, 120);
});

test("upsertWebmark: 新規は先頭に追加され元の配列は変わらない", () => {
  const list = [{ id: "d1", title: "号" }];
  const r = api.upsertWebmark(list, { u: "https://ex.com/a", t: "A", s: "段落" }, "2026-10-11T00:00:00Z", "w1");
  assert.equal(list.length, 1);
  assert.equal(r.docs.length, 2);
  assert.equal(r.docs[0].id, "w1");
  assert.deepEqual(
    { kind: r.doc.kind, url: r.doc.url, site: r.doc.site, snippet: r.doc.snippet, title: r.doc.title },
    { kind: "webmark", url: "https://ex.com/a", site: "ex.com", snippet: "段落", title: "A" }
  );
  assert.equal(r.doc.createdAt, "2026-10-11T00:00:00Z");
  assert.equal(r.doc.updatedAt, "2026-10-11T00:00:00Z");
});

test("upsertWebmark: 同一URL(フラグメント違い)は重複せず上書きし、createdAt/idは維持", () => {
  const first = api.upsertWebmark([], { u: "https://ex.com/a", t: "A", s: "旧" }, "2026-10-01T00:00:00Z", "w1");
  const second = api.upsertWebmark(
    first.docs,
    { u: "https://ex.com/a#:~:text=zzz", t: "A2", s: "新" },
    "2026-10-02T00:00:00Z",
    "w2"
  );
  assert.equal(second.docs.length, 1);
  assert.equal(second.doc.id, "w1");
  assert.equal(second.doc.snippet, "新");
  assert.equal(second.doc.title, "A2");
  assert.equal(second.doc.createdAt, "2026-10-01T00:00:00Z");
  assert.equal(second.doc.updatedAt, "2026-10-02T00:00:00Z");
});

test("upsertWebmark: 削除済み(墓標)の同一URLを再記録すると復活する", () => {
  const list = [{ id: "w1", kind: "webmark", title: "A", url: "https://ex.com/a", deleted: true, updatedAt: "2026-10-01T00:00:00Z" }];
  const r = api.upsertWebmark(list, { u: "https://ex.com/a", t: "A", s: "段" }, "2026-10-02T00:00:00Z", "wX");
  assert.equal(r.docs.length, 1);
  assert.equal(r.doc.id, "w1");
  assert.equal(r.doc.deleted, undefined);
  assert.equal(api.liveWebmarksOf(r.docs).length, 1);
});

test("upsertWebmark: kindなしの号と同じURLでも号は上書きされない", () => {
  const list = [{ id: "d1", title: "号", url: "https://ex.com/a" }];
  const r = api.upsertWebmark(list, { u: "https://ex.com/a", t: "A", s: "" }, "2026-10-02T00:00:00Z", "w1");
  assert.equal(r.docs.length, 2);
  assert.equal(r.docs[1].id, "d1");
});

test("webmarkJumpUrl: 日本語・- , & をエンコードしてテキストフラグメントを付ける", () => {
  const u = api.webmarkJumpUrl({ url: "https://ex.com/a?x=1", snippet: "A-B, C&D 日本語" });
  assert.ok(u.startsWith("https://ex.com/a?x=1#:~:text="));
  const frag = u.slice(u.indexOf("#:~:text=") + "#:~:text=".length);
  assert.ok(!/[-,& ]/.test(frag), "生の - , & 空白が残っている: " + frag);
  assert.equal(decodeURIComponent(frag), "A-B, C&D 日本語");
});

test("webmarkJumpUrl: 断片が空ならフラグメントを付けない", () => {
  assert.equal(api.webmarkJumpUrl({ url: "https://ex.com/a#old", snippet: "  " }), "https://ex.com/a");
});
