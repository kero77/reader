# 読みかけ記事（webmark）設計書

日付: 2026-10-11 / 対象: `OneDrive\reader\index.html`（長文しおりリーダー）

## 目的
Web 記事の本文は保存せず、「どこまで読んだか」だけを覚えて、元サイトの該当段落へ戻れるようにする（Instapaper の再開機能のみ）。

## 要件（ユーザー確認済み）
- 記事の保存は不要。位置の記録と、そこへのジャンプだけ。
- 記録はブックマークレットを手動で押す方式（PC ブラウザ・iPhone Safari）。
- 端末間は既存の Gist 同期で共有する。

## 設計

### 1. 記録（ブックマークレット）
押すと、現在ページの URL・タイトル・画面上端にある段落の先頭テキスト（約60文字）を取得し、
`https://long-email-reader.netlify.app/#webmark=<base64url(JSON {u,t,s})>` を新しいタブで開く。
APP_KEY はブックマークレットに含めない（第三者サイト上で動くコードに鍵を触れさせないため）。書き込みは鍵を持つリーダー側が行う。

### 2. データ形式（承認済み設計からの変更点）
当初案は Gist に `marks` 配列を足す形だったが、`reader_data.json` はトップレベルが **docs 配列**で、
`mailmag_to_reader.py` も配列前提（`gist_get_docs` が配列でなければ例外）。トップレベルを変えると取込側が壊れるため、
**webmark も docs 配列の1要素として格納する**ことにした。

```json
{ "id":"w…", "kind":"webmark", "title":"記事タイトル", "url":"https://…",
  "snippet":"読んでいた段落の先頭", "site":"example.com",
  "createdAt":"ISO", "updatedAt":"ISO" }
```

- 同期（LWW マージ、tombstone 削除、`_pullOk` ガード、read-modify-write）は既存ロジックをそのまま使う。同期コードは変更しない。
- Python 側は `d.get("title")` だけを参照するため、webmark が混在しても無害（タイトル重複チェックに使われるのみ）。
- 同一 URL（フラグメント除去後）が既にあれば新規作成せず、`snippet`・`updatedAt` を上書きする。
- 削除は既存と同じ墓標（`deleted:true`）。

### 3. 画面
- `liveDocs()` は `kind==="webmark"` を除外する（号セレクト・フォールバック選択に出さない）。
- 「📖 読みかけ」パネルを追加。`updatedAt` 降順で、タイトル・サイト名・日時・削除ボタンを表示。
- タップで `url + "#:~:text=" + encodeURIComponent(snippet)` を新規タブで開く。
  断片が見つからない場合はページ先頭が開くだけ（壊れない）。
- 起動時に `location.hash` が `#webmark=` なら、デコードして登録し、ハッシュを `history.replaceState` で消す。
  アプリキー未設定・Pull 前の場合は登録を保留し、Pull 成功後に反映する。

### 4. 触らないもの
`netlify\functions\gist.mjs`、`reader_sync\mailmag_to_reader.py`、既存の号のスクロール保存、同期関数群。

## テスト
- Node でマージ・登録ロジックを単体検証（同一 URL 上書き、墓標、webmark が `liveDocs()` に出ない、不正ハッシュの無視）。
- `index.html` の `<script>` を抽出して `node --check`。
- 実 Gist・本番サイトへの書き込みはユーザーの指示があるまで行わない。

## 既知の制約
- テキストフラグメントは一部サイト（動的描画・無効化）で効かない。
- iPhone Safari はブックマークレット登録が手間。手順は README/DEVLOG に記載する。
- 巨大化対策: webmark は 1 件あたり約 0.5KB。墓標の 30 日 GC は既存処理が webmark にも効く。
