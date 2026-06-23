## 2026-06-23 GitHub Gist クロスデバイス同期機能を追加

**担当エージェント:** programmer

**変更ファイル:**
- `C:\Users\Masashi\OneDrive\reader\index.html`（1,159行 → 1,240行、+81行）

**何を:**
PC と iPhone 間で読書データ（しおり・進捗・スクロール位置）を GitHub Gist 経由で自動同期する機能を追加。

**実装内容（9ステップ）:**
1. CSS: `#syncBadge` のスピンアニメ・ok/error 色（line 155〜158）
2. ヘッダー: `💾` バッジ（syncBadge）を spacer 直後に配置。クリックで即時 Pull
3. 設定モーダル: GitHub トークン（password input）・Gist ID・「今すぐ同期」「Gist IDリセット」ボタンを追加
4. `persist()`: `updatedAt` タイムスタンプ更新 + `schedulePush()` 呼び出しを追加
5. 同期ロジック一式（`gistPush` / `gistPull` / `mergeFromRemote` / `schedulePush`）を `uid()` 直前に挿入
6. `openSettings()`: ghToken・ghGistId を読み込んでフォームに反映。`saveSettings()`: localStorage へ保存
7. `btnSyncNow`（Pull→Push）・`btnGistClear`（Gist ID リセット）のイベントリスナー追加
8. `visibilitychange`（フォアグラウンド復帰で Pull）・`beforeunload`（離脱時に即 Push）を登録
9. 起動時: `migrateUpdatedAt` IIFE（既存ドキュメントに `updatedAt` 追記）＋ `gistPull()` 起動

**マージ戦略:** `updatedAt`（なければ `createdAt`）の新しい方を優先。ローカルのみ / リモートのみ ID は両方を保持。

**なぜ:**
localStorage 単体ではデバイスをまたいでデータが共有できない。GitHub Gist（gist スコープのみのトークン）を使いサーバーレス・無料で実現。

**ハマりどころ・次回への注意:**
- `schedulePush` は `let` 変数のため `persist()` より後に定義する必要があるが、`persist()` が呼ばれる時点では JS の実行順序上 `schedulePush` は定義済みのため問題なし（同一 `<script>` ブロック内のホイスト非対象の let は、定義前参照するとエラーになるが、`persist()` の呼び出しはすべて同期ロジック挿入後に発生する）。
- `migrateColors` の `persist()` 呼び出し内でも `schedulePush` が呼ばれるが、`_syncSuppressPush = true` で抑制しているため問題なし。`migrateUpdatedAt` も同様。
- gistPull は `async function` で Promise を返すため、`btnSyncNow.onclick` は `.then(gistPush)` でチェーン可能。
- Gist ファイルが 10MB を超えると `truncated: true` になり `raw_url` フェッチが必要（対応済み）。
