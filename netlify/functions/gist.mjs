// Gist読み書きプロキシ（Netlify Functions）
//
// 目的: GitHub Personal Access Token(PAT) をこの関数の環境変数にのみ保持し、
// リーダー本体(index.html)や各端末のlocalStorageには一切渡さない。
// PATが失効しても、更新箇所は Netlify の環境変数1箇所だけで済む。
//
// 認証: クライアントは無期限の自作キー(APP_KEY)を x-app-key ヘッダで送る。
// サーバー側の環境変数 APP_KEY とタイミング安全比較し、不一致は401を返す
// （読み取り側も認証必須。ここを無認証にすると誰でも本文を読めてしまうため）。
//
// 必要な環境変数（Netlify管理画面 > Site configuration > Environment variables）:
//   GITHUB_TOKEN : Gistの読み書き権限を持つ GitHub PAT（scope: gist のみで可）
//   GIST_ID      : 同期対象の Gist ID（reader_data.json を含むもの）
//   APP_KEY      : 端末側と共有する無期限の合言葉（自分で決める。十分長くランダムに）
//
// エンドポイント: GET /api/gist（読み取り）/ PATCH /api/gist（書き込み・素通し転送）

import { timingSafeEqual } from "node:crypto";

const GIST_FILENAME = "reader_data.json";
const GITHUB_API = "https://api.github.com";

// 文字列比較のタイミング攻撃対策。長さが違う場合もダミー比較で処理時間をならしてから false を返す。
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default async (req) => {
  const appKeyEnv = process.env.APP_KEY || "";
  const githubToken = process.env.GITHUB_TOKEN || "";
  const gistId = process.env.GIST_ID || "";

  if (!appKeyEnv || !githubToken || !gistId) {
    // サーバー側の設定不備。原因の詳細はクライアントに出さない。
    return jsonResponse(500, { error: "server not configured" });
  }

  const provided = req.headers.get("x-app-key") || "";
  if (!provided || !safeEqual(provided, appKeyEnv)) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const upstreamHeaders = {
    Authorization: "token " + githubToken,
    "User-Agent": "mailmag-reader-gist-proxy",
  };

  try {
    if (req.method === "GET") {
      const res = await fetch(`${GITHUB_API}/gists/${gistId}`, { headers: upstreamHeaders });
      if (!res.ok) return jsonResponse(res.status, { error: "github get failed" });
      const data = await res.json();
      const file = (data.files || {})[GIST_FILENAME];
      if (!file) {
        // ファイルがまだ無い（空のGist）。空配列相当を返す。
        return jsonResponse(200, { files: { [GIST_FILENAME]: { content: "[]", truncated: false } } });
      }
      let content = file.content;
      if (file.truncated) {
        // 1MB超のGistはcontentが省略されraw_urlのみ返る。クライアントに直接触らせず、
        // サーバー側で解決してから通常のcontent文字列として返す。
        const rawRes = await fetch(file.raw_url, { headers: upstreamHeaders });
        if (!rawRes.ok) return jsonResponse(502, { error: "github raw fetch failed" });
        content = await rawRes.text();
      }
      return jsonResponse(200, { files: { [GIST_FILENAME]: { content, truncated: false } } });
    }

    if (req.method === "PATCH") {
      // クライアントは従来のGist API互換の body（{files:{"reader_data.json":{content:"<JSON文字列>"}}}）
      // をそのまま送ってくる。中身の墓標/マージ判断はクライアント側の責務のため、素通しで転送する。
      const bodyText = await req.text();
      const res = await fetch(`${GITHUB_API}/gists/${gistId}`, {
        method: "PATCH",
        headers: { ...upstreamHeaders, "Content-Type": "application/json" },
        body: bodyText,
      });
      if (!res.ok) return jsonResponse(res.status, { error: "github patch failed" });
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(405, { error: "method not allowed" });
  } catch (e) {
    return jsonResponse(502, { error: "proxy error" });
  }
};
