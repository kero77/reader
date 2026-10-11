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
  m[1] + "; return {liveDocsOf,liveWebmarksOf,webmarkUrlKey,parseWebmarkHash,upsertWebmark,webmarkJumpUrl,webmarkBookmarklet,webmarkResumeBookmarklet,webmarkIntakeNote,parseResumeHash,findWebmarkByUrl,webmarkResumeAllowed};"
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

test("webmarkJumpUrl: 日本語・- , & をエンコードし、wm=（続きへ用）とテキストフラグメントの両方に断片を載せる", () => {
  const u = api.webmarkJumpUrl({ url: "https://ex.com/a?x=1", snippet: "A-B, C&D 日本語" });
  assert.ok(u.startsWith("https://ex.com/a?x=1#wm="), u);
  const [wmPart, textPart] = u.slice(u.indexOf("#wm=") + "#wm=".length).split(":~:text=");
  for (const part of [wmPart, textPart]) {
    assert.ok(part && !/[-,& ]/.test(part), "生の - , & 空白が残っている: " + part);
    assert.equal(decodeURIComponent(part), "A-B, C&D 日本語");
  }
});

test("webmarkJumpUrl: 断片が空ならフラグメントを付けない", () => {
  assert.equal(api.webmarkJumpUrl({ url: "https://ex.com/a#old", snippet: "  " }), "https://ex.com/a");
});

function runBookmarklet({ elems, title = "題名", href = "https://ex.com/a?x=1#frag", scoped = null, og = null, h1 = null, winExtra = {}, docExtra = {} }) {
  const bm = api.webmarkBookmarklet("https://reader.example");
  assert.ok(bm.startsWith("javascript:"));
  const code = decodeURIComponent(bm.slice("javascript:".length));
  let opened = null;
  const doc = {
    title,
    querySelector: (sel) =>
      /og:title/.test(sel) ? (og ? { content: og } : null)
      : sel === "h1,h2" ? (h1 ? { innerText: h1 } : null)
      : (scoped && /article|main/.test(sel) ? scoped : null),
    querySelectorAll: () => elems,
    ...docExtra,
  };
  const win = { innerHeight: 800, open: (u, _t, features) => { opened = u; lastFeatures = features; }, ...winExtra };
  new Function("document", "window", "location", code)(doc, win, { href });
  return opened;
}
let lastFeatures;
const el = (text, top, bottom) => ({
  innerText: text,
  textContent: text,
  getBoundingClientRect: () => ({ top, bottom }),
});

test("bookmarklet: 画面上端の段落の先頭40文字を、リーダーへ#webmark=で渡す", () => {
  const opened = runBookmarklet({
    elems: [
      el("画面の上に隠れた段落はここに入りません。", -300, -10),
      el("目次", 0, 20),
      el("読んでいた段落です。ここから先を読む予定でした。" + "あ".repeat(60), -5, 120),
      el("次の段落もあります。次の段落もあります。", 130, 200),
    ],
  });
  assert.ok(opened.startsWith("https://reader.example/#webmark="));
  const r = api.parseWebmarkHash(new URL(opened).hash);
  assert.equal(r.u, "https://ex.com/a?x=1");
  assert.equal(r.t, "題名");
  assert.ok(r.s.length >= 12 && r.s.length <= 40, "長さ: " + r.s.length);
  assert.ok(r.s.startsWith("読んでいた段落です。"));
});

const wellFormed = (s) => s.isWellFormed();

test("bookmarklet: 40字目が絵文字・サロゲートペアの前半でも壊れた断片を作らない", () => {
  const text = "あ".repeat(39) + "😀" + "い".repeat(30);
  const opened = runBookmarklet({ elems: [el(text, 0, 100)] });
  const r = api.parseWebmarkHash(new URL(opened).hash);
  assert.ok(wellFormed(r.s), "孤立サロゲートが残っている");
  assert.doesNotThrow(() => api.webmarkJumpUrl({ url: r.u, snippet: r.s }));
});

test("bookmarklet: 英文は単語の途中で切らない（テキストフラグメントは語境界で一致するため）", () => {
  const full = "Alpha beta gamma delta epsilon zeta etalongword theta iota kappa";
  const opened = runBookmarklet({ elems: [el(full, 0, 100)] });
  const r = api.parseWebmarkHash(new URL(opened).hash);
  assert.ok(full.startsWith(r.s) && r.s.length >= 12);
  assert.ok(r.s.length === full.length || full[r.s.length] === " ", "単語の途中で切れた: [" + r.s + "]");
});

test("bookmarklet: 新規タブをnoopenerで開く（開いた先から元ページを操作されない）", () => {
  runBookmarklet({ elems: [el("本文の段落です。本文の段落です。", 0, 100)] });
  assert.match(String(lastFeatures), /noopener/);
});

test("parseWebmarkHash: 孤立サロゲートを含む断片・タイトルは除去され、ジャンプURLが例外を出さない", () => {
  const r = api.parseWebmarkHash(
    "#webmark=" + enc({ u: "https://ex.com/", t: "題" + "\uD842", s: "あ".repeat(39) + "\uD842" })
  );
  assert.ok(wellFormed(r.s) && wellFormed(r.t));
  assert.doesNotThrow(() => api.webmarkJumpUrl({ url: r.u, snippet: r.s }));
});

test("webmarkJumpUrl: リモート由来の孤立サロゲートでも例外を出さない", () => {
  assert.doesNotThrow(() => api.webmarkJumpUrl({ url: "https://ex.com/", snippet: "あ\uD842" }));
});

test("webmarkJumpUrl: http(s)以外のURL(javascript:など)は空文字を返す", () => {
  assert.equal(api.webmarkJumpUrl({ url: "javascript:alert(1)//", snippet: "x" }), "");
  assert.equal(api.webmarkJumpUrl({ url: "data:text/html,x", snippet: "" }), "");
});

const snippetOf = (opened) => api.parseWebmarkHash(new URL(opened).hash).s;
const pinnedEl = (text, pos) => ({
  nodeType: 1, parentElement: null, __pos: pos, innerText: text, textContent: text,
  getBoundingClientRect: () => ({ top: 0, bottom: 50 }),
});
const flowEl = (text, top, bottom, extra = {}) => ({
  nodeType: 1, parentElement: null, __pos: "static", innerText: text, textContent: text,
  getBoundingClientRect: () => ({ top, bottom, left: 0 }), ...extra,
});
const posWin = { getComputedStyle: (n) => ({ position: n.__pos || "static" }), innerWidth: 1000 };

test("bookmarklet: 固定(fixed)・追従(sticky)ヘッダーの文字は読み位置として拾わない", () => {
  for (const pos of ["fixed", "sticky"]) {
    const opened = runBookmarklet({
      elems: [pinnedEl("サイト名のヘッダーです。サイト名", pos), flowEl("読んでいた本文の段落です。続きがあります。", 60, 160)],
      winExtra: posWin,
    });
    assert.ok(snippetOf(opened).startsWith("読んでいた本文"), pos + ": " + snippetOf(opened));
  }
});

test("bookmarklet: header/nav/footer/aside の中の文字は拾わない", () => {
  const inNav = flowEl("ナビゲーションの項目テキスト", 0, 30, { closest: () => ({}) });
  const opened = runBookmarklet({ elems: [inNav, flowEl("本文の段落です。本文の段落です。", 40, 120, { closest: () => null })], winExtra: posWin });
  assert.ok(snippetOf(opened).startsWith("本文の段落"));
});

test("bookmarklet: 別の要素(ヘッダー等)に覆われて見えていない行は拾わない", () => {
  const covered = flowEl("ヘッダーの下に隠れている行です。", 5, 40, { contains: () => false });
  const shown = flowEl("実際に見えている本文の行です。", 70, 120);
  shown.contains = (h) => h === shown;
  const opened = runBookmarklet({
    elems: [covered, shown],
    winExtra: posWin,
    docExtra: { elementFromPoint: (_x, y) => (y < 60 ? { contains: () => false } : shown) },
  });
  assert.ok(snippetOf(opened).startsWith("実際に見えている"));
});

test("bookmarklet: 条件を満たす行がなければ、除外前の最初の可視行にフォールバックする", () => {
  const inHeader = flowEl("ヘッダーだけのページの文章です。", 0, 30, { closest: () => ({}) });
  const opened = runBookmarklet({ elems: [inHeader], winExtra: posWin });
  assert.ok(snippetOf(opened).startsWith("ヘッダーだけのページ"));
});

test("webmarkIntakeNote: 記録した位置の断片を表示する", () => {
  assert.match(api.webmarkIntakeNote(true, "読んでいた段落"), /位置:「読んでいた段落」/);
  assert.match(api.webmarkIntakeNote(false, "読んでいた段落"), /同期されません.*読んでいた段落/);
});

test("bookmarklet: document.titleが空ならog:title、次に最初の見出しをタイトルに使う", () => {
  const e = [el("本文の段落です。本文の段落です。", 0, 100)];
  const r1 = api.parseWebmarkHash(new URL(runBookmarklet({ elems: e, title: "", og: "OG題名" })).hash);
  assert.equal(r1.t, "OG題名");
  const r2 = api.parseWebmarkHash(new URL(runBookmarklet({ elems: e, title: "", h1: "  見出し\n題名 " })).hash);
  assert.equal(r2.t, "見出し 題名");
  const r3 = api.parseWebmarkHash(new URL(runBookmarklet({ elems: e, title: "", og: "OG題名", h1: "見出し" })).hash);
  assert.equal(r3.t, "OG題名");
  const r4 = api.parseWebmarkHash(new URL(runBookmarklet({ elems: e, title: "通常の題名", og: "OG題名" })).hash);
  assert.equal(r4.t, "通常の題名");
});

function runResume(hash, { found = true, popup = true } = {}) {
  const bm = api.webmarkResumeBookmarklet("https://reader.example");
  assert.ok(bm.startsWith("javascript:"));
  const code = decodeURIComponent(bm.slice("javascript:".length));
  const calls = { find: null, replaced: null, toasts: [], scrollIntoView: null, scrollBy: null, opened: null, listener: null };
  const doc = {
    createElement: () => ({ style: {}, remove() {} }),
    body: { appendChild: (d) => calls.toasts.push(d.textContent) },
  };
  const target = { nodeType: 1, scrollIntoView: (o) => { calls.scrollIntoView = o; } };
  const win = {
    find: (s) => { calls.find = s; return found; },
    getSelection: () => ({
      removeAllRanges() {},
      rangeCount: found ? 1 : 0,
      getRangeAt: () => ({ startContainer: { nodeType: 3, parentElement: target } }),
    }),
    scrollBy: (x, y) => { calls.scrollBy = [x, y]; },
    addEventListener: (type, fn) => { if (type === "message") calls.listener = fn; },
    open: (u, t, f) => { calls.opened = [u, t, f]; return popup ? {} : null; },
  };
  const hist = { replaceState: (_a, _b, url) => { calls.replaced = url; } };
  new Function("document", "window", "location", "history", "setTimeout", code)(
    doc, win, { hash, href: "https://ex.com/a?x=1" + hash, pathname: "/a" }, hist, () => {}
  );
  return calls;
}

test("resume: wm=の断片を探し、見つかればハッシュを消して移動を知らせる", () => {
  const u = api.webmarkJumpUrl({ url: "https://ex.com/a?x=1", snippet: "A-B, C&D 日本語" });
  const hash = new URL(u.split(":~:")[0]).hash;
  const c = runResume(hash);
  assert.equal(c.find, "A-B, C&D 日本語");
  assert.equal(c.replaced, "https://ex.com/a?x=1");
  assert.match(c.toasts.join(), /移動/);
});

test("resume: 見つけた行を画面の上端に合わせ(記録は上端の行)、固定ヘッダー分だけ戻す", () => {
  const c = runResume("#wm=" + encodeURIComponent("読んでいた段落"));
  assert.deepEqual(c.scrollIntoView, { block: "start" });
  assert.deepEqual(c.scrollBy, [0, -60]);
});

test("resume: 見つからなければハッシュを残し(押し直せる)、その旨を知らせる", () => {
  const c = runResume("#wm=" + encodeURIComponent("存在しない文"), { found: false });
  assert.equal(c.replaced, null);
  assert.match(c.toasts.join(), /見つかりませんでした/);
});

test("resume: wm=が無い(サイトがハッシュを消した)ときは、リーダーを開いて断片を受け取る(openerを残す)", () => {
  const c = runResume("");
  assert.equal(c.find, null);
  assert.equal(c.opened[0], "https://reader.example/#resume=" + encodeURIComponent("https://ex.com/a?x=1"));
  assert.equal(c.opened[1], "_blank");
  assert.ok(!/noopener/.test(String(c.opened[2])), "noopener だと断片を返せない");
  assert.equal(typeof c.listener, "function");
});

const msg = (over = {}) => ({ origin: "https://reader.example", data: { type: "wm-snippet", s: "受け取った断片" }, ...over });

test("resume: リーダーから断片が届いたら探して移動する(ハッシュは触らない)", () => {
  const c = runResume("");
  c.listener(msg());
  assert.equal(c.find, "受け取った断片");
  assert.match(c.toasts.join(), /移動/);
  assert.equal(c.replaced, null);
});

test("resume: リーダー以外のオリジン・別種のメッセージは無視する", () => {
  const c = runResume("");
  c.listener(msg({ origin: "https://evil.example" }));
  c.listener(msg({ data: { type: "other", s: "x" } }));
  c.listener(msg({ data: null }));
  assert.equal(c.find, null);
});

test("resume: リーダーに該当の読みかけが無ければ(断片が空)その旨を知らせる", () => {
  const c = runResume("");
  c.listener(msg({ data: { type: "wm-snippet", s: "" } }));
  assert.equal(c.find, null);
  assert.match(c.toasts.join(), /読みかけが見つかりません/);
});

test("resume: タブを開けない(ポップアップ拒否)ときは案内を出す", () => {
  const c = runResume("", { popup: false });
  assert.match(c.toasts.join(), /開けませんでした/);
});

test("parseResumeHash: #resume=<URL> を http(s) のみ受け付け、#以降を除く", () => {
  assert.equal(api.parseResumeHash("#resume=" + encodeURIComponent("https://ex.com/a?x=1#h")), "https://ex.com/a?x=1");
  assert.equal(api.parseResumeHash("#resume=" + encodeURIComponent("javascript:alert(1)")), null);
  assert.equal(api.parseResumeHash("#resume=%E3%81"), null);
  assert.equal(api.parseResumeHash("#webmark=abc"), null);
  assert.equal(api.parseResumeHash(""), null);
});

test("findWebmarkByUrl: 削除済み・kindなしは対象外、#以降は無視して一致", () => {
  const list = [
    { id: "d1", title: "号", url: "https://ex.com/a" },
    { id: "w1", kind: "webmark", url: "https://ex.com/a", snippet: "削除済み", deleted: true },
    { id: "w2", kind: "webmark", url: "https://ex.com/a", snippet: "生きている" },
  ];
  assert.equal(api.findWebmarkByUrl(list, "https://ex.com/a#frag").snippet, "生きている");
  assert.equal(api.findWebmarkByUrl(list, "https://ex.com/zzz"), null);
});

test("findWebmarkByUrl: 完全一致を優先し、なければクエリ・末尾スラッシュ違いを許す", () => {
  const list = [
    { id: "w1", kind: "webmark", url: "https://ex.com/a?s=20", snippet: "クエリ付き", updatedAt: "2026-10-02T00:00:00Z" },
    { id: "w2", kind: "webmark", url: "https://ex.com/a", snippet: "完全一致", updatedAt: "2026-10-01T00:00:00Z" },
  ];
  assert.equal(api.findWebmarkByUrl(list, "https://ex.com/a").snippet, "完全一致");
  assert.equal(api.findWebmarkByUrl(list, "https://ex.com/a/").snippet, "クエリ付き");
  assert.equal(api.findWebmarkByUrl(list, "https://ex.com/a?utm=1").snippet, "クエリ付き");
});

test("findWebmarkByUrl: 同じオリジンで同じ長い数字ID(Xのstatus/article等)なら別のパスでも一致する", () => {
  const list = [{ id: "w1", kind: "webmark", url: "https://x.com/gregisenberg/status/2103927365977928019", snippet: "断片", updatedAt: "2026-10-01T00:00:00Z" }];
  assert.equal(api.findWebmarkByUrl(list, "https://x.com/gregisenberg/article/2103927365977928019").snippet, "断片");
  assert.equal(api.findWebmarkByUrl(list, "https://x.com/i/article/2103927365977928019").snippet, "断片");
});

test("findWebmarkByUrl: 別オリジン・短い数字・IDなしの別パスは一致しない", () => {
  const list = [{ id: "w1", kind: "webmark", url: "https://x.com/a/status/2103927365977928019", snippet: "断片", updatedAt: "2026-10-01T00:00:00Z" }];
  assert.equal(api.findWebmarkByUrl(list, "https://twitter.com/a/status/2103927365977928019"), null);
  assert.equal(api.findWebmarkByUrl(list, "https://x.com/a/status/12345"), null);
  assert.equal(api.findWebmarkByUrl(list, "https://x.com/other/page"), null);
});

test("resume: 見つからないとき、押したページのパスを表示する(記録時のURLと見比べられるように)", () => {
  const c = runResume("");
  c.listener(msg({ data: { type: "wm-snippet", s: "" } }));
  assert.match(c.toasts.join(), /見つかりません（\/a）/);
});

test("webmarkResumeAllowed: 開いた元ページと同じオリジンのURLの断片だけ返す(他サイトの閲覧履歴を探られないため)", () => {
  assert.equal(api.webmarkResumeAllowed("https://x.com/", "https://x.com/a/status/1"), true);
  assert.equal(api.webmarkResumeAllowed("https://evil.example/", "https://x.com/a/status/1"), false);
  assert.equal(api.webmarkResumeAllowed("", "https://x.com/a"), false);
  assert.equal(api.webmarkResumeAllowed("not a url", "https://x.com/a"), false);
});

test("resume: 壊れたエンコードでも例外を出さない", () => {
  const c = runResume("#wm=%E3%81");
  assert.equal(c.find, null);
});

test("webmarkIntakeNote: アプリキー未設定なら同期されない旨を伝える", () => {
  assert.equal(api.webmarkIntakeNote(true), "読みかけを記録しました。");
  assert.match(api.webmarkIntakeNote(false), /同期されません/);
});

test("bookmarklet: 非表示の要素(innerTextが空でtextContentだけある)は拾わない", () => {
  const hidden = { innerText: "", textContent: "非表示メニューの項目テキストです", getBoundingClientRect: () => ({ top: 10, bottom: 40 }) };
  const opened = runBookmarklet({
    elems: [hidden, el("実際に表示されている本文の段落です。", 50, 120)],
  });
  const r = api.parseWebmarkHash(new URL(opened).hash);
  assert.ok(r.s.startsWith("実際に表示されている本文"), "取得した断片: " + r.s);
});

test("bookmarklet: article/mainがあればその中だけを探す", () => {
  const scoped = { querySelectorAll: () => [el("本文の段落です。本文の段落です。", 10, 90)] };
  const opened = runBookmarklet({
    elems: [el("ナビゲーションのリンク項目です。", 0, 30)],
    scoped,
  });
  assert.ok(api.parseWebmarkHash(new URL(opened).hash).s.startsWith("本文の段落"));
});

test("bookmarklet: 画面内に段落がなくても例外を出さず s は空、タイトル空はURLに", () => {
  const opened = runBookmarklet({ elems: [], title: "" });
  const r = api.parseWebmarkHash(new URL(opened).hash);
  assert.equal(r.s, "");
  assert.equal(r.t, "https://ex.com/a?x=1");
});
