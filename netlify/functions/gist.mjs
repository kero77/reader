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

// CORS用ヘッダ。本番は index.html と同一オリジンから叩くため通常は不要だが、
// カスタムドメイン併用やデプロイプレビューなど別オリジンから呼ばれた場合でも
// ブラウザのプリフライト(OPTIONS)とレスポンスが弾かれないようにする防御的措置。
// Origin丸ごと反映(*ではなく)＋Varyで、認証（x-app-keyの一致）自体は従来どおり必須のまま。
function corsHeaders(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-app-key",
    "Vary": "Origin",
  };
}

function jsonResponse(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

export default async (req) => {
  // プリフライトはヘッダ検証（x-app-key）をスキップして即204で返す。
  // ここで認証チェックに巻き込むと、ブラウザが送らないx-app-keyヘッダ無しのOPTIONSが
  // 常に401になり、実リクエスト（GET/PATCH）が発火する前に失敗したように見えてしまう。
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const cors = corsHeaders(req);
  const appKeyEnv = process.env.APP_KEY || "";
  const githubToken = process.env.GITHUB_TOKEN || "";
  const gistId = process.env.GIST_ID || "";

  if (!appKeyEnv || !githubToken || !gistId) {
    // サーバー側の設定不備。原因の詳細はクライアントに出さない。
    return jsonResponse(500, { error: "server not configured" }, cors);
  }

  const provided = req.headers.get("x-app-key") || "";
  if (!provided || !safeEqual(provided, appKeyEnv)) {
    return jsonResponse(401, { error: "unauthorized" }, cors);
  }

  const upstreamHeaders = {
    Authorization: "token " + githubToken,
    "User-Agent": "mailmag-reader-gist-proxy",
  };

  try {
    if (req.method === "GET") {
      const res = await fetch(`${GITHUB_API}/gists/${gistId}`, { headers: upstreamHeaders });
      if (!res.ok) return jsonResponse(res.status, { error: "github get failed" }, cors);
      const data = await res.json();
      const file = (data.files || {})[GIST_FILENAME];
      if (!file) {
        // ファイルがまだ無い（空のGist）。空配列相当を返す。
        return jsonResponse(200, { files: { [GIST_FILENAME]: { content: "[]", truncated: false } } }, cors);
      }
      let content = file.content;
      if (file.truncated) {
        // 1MB超のGistはcontentが省略されraw_urlのみ返る。クライアントに直接触らせず、
        // サーバー側で解決してから通常のcontent文字列として返す。
        const rawRes = await fetch(file.raw_url, { headers: upstreamHeaders });
        if (!rawRes.ok) return jsonResponse(502, { error: "github raw fetch failed" }, cors);
        content = await rawRes.text();
      }
      return jsonResponse(200, { files: { [GIST_FILENAME]: { content, truncated: false } } }, cors);
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
      if (!res.ok) return jsonResponse(res.status, { error: "github patch failed" }, cors);
      return jsonResponse(200, { ok: true }, cors);
    }

    return jsonResponse(405, { error: "method not allowed" }, cors);
  } catch (e) {
    return jsonResponse(502, { error: "proxy error" }, cors);
  }
};
