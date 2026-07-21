## 2026-07-21 クラウド同期の削除復活バグを修正（削除の墓標化）

**担当エージェント:** programmer

**変更ファイル:**
- `C:\Users\Masashi\OneDrive\reader\index.html`（本体アプリのJS部のみ。約60行の追加・変更）

**何を:**
記事を削除しても他端末（または自端末の次回Pull）で復活するバグを修正。削除を「配列から消す」のではなく「墓標（tombstone）」オブジェクトに置換し、削除の事実自体を同期対象にした。

**原因（調査済み・修正前の状態）:**
- 削除ハンドラは `docs=docs.filter(...)` で配列から消すだけで、削除の事実が記録されない。
- `mergeFromRemote` は「ローカルに無い && リモートにあるID」を無条件復活させるunionマージ（`if (!ld){ changed=true; return rd; }`）。
- Pushは `schedulePush()` の5秒デバウンスで、iOS Safariでは背面遷移時に飛ばないことがある。
- 結果、削除は構造的に同期に負ける。

**実装内容:**
1. `#btnDelete` ハンドラ: docを配列から消す代わりに `{ id, title, deleted:true, updatedAt }` の墓標に置換（`html`/`lines`/`bookmarks`等の重いフィールドは落としてGist容量を節約）。`currentId=null` にしてから `persist()` するため、墓標自身の `updatedAt` は削除ハンドラ内で明示的にセット（`persist()`のcurrentId連動更新には乗らない）。
2. `mergeFromRemote` は変更なし。LWW（`updatedAt`比較）がそのまま墓標にも効くため、削除が新しければ削除が全端末に伝播する。
3. `liveDocs()`（`docs.filter(d=>!d.deleted)`）を新設し、UI表示・フォールバック選択を全て置換: `renderDocSelect()`、`gistPull`内のPull後フォールバック選択、削除ハンドラのフォールバック選択、起動時の初期 `openDoc`。`getDoc`/`uid()`/`persist()`内の`docs.find/length`は用途が違う（currentId照合・連番用）ためそのまま。
4. 削除時は `persist()` 後に `gistPush()` を直接呼び、5秒デバウンス（`schedulePush`）を待たず即Push。
5. 起動時（`migrateUpdatedAt` IIFEの直後）に `gcTombstones()` IIFEを追加。`deleted && updatedAtが30日以上前` の墓標を物理削除。変更時は `_syncSuppressPush` でPush抑制しつつlocalStorage保存（既存migrateと同じパターン）。
6. `gistPush(opts)` に `keepalive` オプションを追加し、`visibilitychange`(hidden時)・`beforeunload` からの呼び出しで `{keepalive:true}` を指定。iOS Safariの背面遷移でも送信が継続しやすくなる。body が64KB超だとkeepalive fetchが失敗しうるが、既存の`try/catch`で従来通り"error"表示にフォールバックするだけで壊れない。

**なぜ:**
Gist同期は「最後に触った方が勝つ」LWW設計だが、削除だけは「更新」ではなく「消滅」なので、そのままでは同期プロトコルに乗らなかった。削除も墓標という一種の"更新"として扱うことで既存のLWWロジックに自然に統合した。

**検証:**
- `node --check` で本体スクリプトブロック（`<script>`3つ中、最後の約65,000文字＝本体アプリ。前2つはTurndown/turndown-plugin-gfm同梱ライブラリ）の構文OK。
- `mergeFromRemote`/`liveDocs`/`gcTombstones`のロジックをindex.htmlから抜き出しNode単体テストで検証、全PASS: (1)削除ハンドラで配列長は維持されつつ墓標化・重いフィールド除去、(2)liveDocsが墓標を除外、(3)リモート側の新しい墓標がローカルに伝播し削除が勝つ、(4)ローカルに無い生きたdocは従来通りunion復活する（正常系は壊れていない）、(5)30日超の墓標だけGCされ30日以内・生存中docは残る。
- 実ブラウザでのGist実push確認（トークンがlocalStorageにある実機依存）はユーザー確認待ち。

**既知のトレードオフ:**
- 30日以上オフラインだった端末が復帰し、その端末にだけ古い（削除前の）状態が残っている場合、GC後の墓標が消えているため復活しうる（削除の再現に失敗する）。日常利用（PC+iPhoneの定期同期）では問題にならない想定。
- `beforeunload`/`visibilitychange`の`keepalive`送信もiOS Safari側の実装次第で確実性は100%ではない（あくまで従来の5秒デバウンスより間に合う確率を上げる対策）。

**ハマりどころ・次回への注意:**
- このファイルは「本体アプリのJS/CSS」と「書き出しHTML用テンプレート文字列 `PORTABLE_TEMPLATE`」が同居している。今回変更した箇所（`renderDocSelect`/`getDoc`/`mergeFromRemote`/`gistPush`/削除ハンドラ/起動時IIFE群）はすべて`PORTABLE_TEMPLATE`文字列（2682〜2728行付近）より前または後ろの本体側で、テンプレート内には該当識別子の重複はないことをgrepで確認済み。
- `persist()`は`currentId`のdocの`updatedAt`のみ更新する仕組みなので、削除ハンドラでは「`currentId=null`にしてから`persist()`を呼ぶ」順序を崩さないこと（先に`persist()`すると墓標のupdatedAtが上書きされたり、逆に消したはずのdocのupdatedAtが更新されたりする）。
- リポジトリは git 管理（OneDrive\reader\.git, remote kero77/reader）。push でNetlify (https://long-email-reader.netlify.app/) に自動デプロイされる。

## 2026-07-14 iOS セーフエリア（ダイナミックアイランド）対応

**担当エージェント:** programmer

**変更ファイル:**
- `C:\Users\Masashi\OneDrive\reader\index.html`（CSSのみ、6行程度の追加）

**何を:**
ダイナミックアイランド搭載iPhoneでリーダーを開くと、ヘッダー（文書選択ドロップダウン等）がステータスバー/ダイナミックアイランド領域に隠れて操作不能になる不具合を修正。

**調査結果:**
- `<meta viewport>` の `viewport-fit=cover` と `apple-mobile-web-app-*` 系metaは既に設定済み（今回の不具合はCSS側のみが原因）。
- 本体アプリの `header{}`（通常フロー先頭要素、`position` 未指定）に `env(safe-area-inset-*)` 対応のpaddingが無かった。
- 加えて、同ファイル内の「自己完結ビューア書き出しテンプレート」（`PORTABLE_TEMPLATE` 変数、記事を1ファイルのHTMLとして書き出しiOSで参照する機能）にも同型の `header{position:sticky;top:0;...}` があり、同じ症状が起きる作りだったため、`#fab`（右下固定ボタン）・`#panel .pbox`（右端ドロワー）とあわせて修正。

**実装内容:**
- 本体 `header{}`: `padding-top:calc(8px + env(safe-area-inset-top))` / `padding-left:max(14px, env(safe-area-inset-left))` / `padding-right:max(14px, env(safe-area-inset-right))` を追加。既存の `padding:8px 14px;` を先に書いてあるため、`env()` 非対応環境ではその行がまるごと無視され元のpaddingにフォールバックする（CSS仕様上、未解決の`env()`を含む宣言はプロパティごと無効になり前の宣言が生きる）。
- `PORTABLE_TEMPLATE` 内の `header` / `.pbox` / `#fab` にも同様の safe-area padding を追加。
- PC/非対応環境は `env()` が `0px` に解決されるため見た目は無変化（確認済み、`calc(8px+0px)=8px`）。

**なぜ:**
`viewport-fit=cover` を指定した以上、コンテンツはノッチ/ダイナミックアイランド領域まで描画されるため、固定・先頭配置のUI要素側で `env(safe-area-inset-*)` によるpadding補正が必須。metaだけでは解決しない典型パターン。

**検証:**
- 構文目視確認のみ。実機（iPhone Safari）での見た目確認はユーザー依頼。

**ハマりどころ・次回への注意:**
- このファイルには「本体アプリのCSS」と「書き出しHTML用テンプレート文字列（JS内の文字列リテラル）」の2つのCSSが同居しており、後者は `grep` で見落としやすい。UI系の修正をする際は両方を確認すること。
- リポジトリは git 管理（OneDrive\reader\.git, remote kero77/reader）。push でNetlify (https://long-email-reader.netlify.app/) に自動デプロイされる。

## 2026-06-30 Obsidian Vault 保存機能を追加（記事→Markdownノート）

**担当エージェント:** programmer

**変更ファイル:**
- `C:\Users\Masashi\OneDrive\reader\index.html`（Turndown同梱 約31KB + Obsidian保存ロジック 約280行を追加）

**何を:**
気に入った記事を 1記事=1 Markdownノート（`.md`）として Obsidian Vault へ保存する機能を追加。ヘッダーに `🟣 Obsidianに保存` ボタンを新設。

**実装内容:**
- PC Chrome: File System Access API（`showDirectoryPicker({mode:"readwrite"})` → ディレクトリハンドルを IndexedDB に永続化）で Vault 内フォルダへ直接書き込み。
- 既存しおりを本物の見出しへ昇格: HTML形式は `doc.bookmarks[].aid`（`id="rdrbmN"`）要素を `lvl1→##` / `lvl2→###` に昇格（小要素は `replaceWith`、`<br>`/ブロック子/`<img>` を含む大コンテナは直前に見出し挿入で本文を保持）。テキスト形式は `lines`+bookmarks から直接生成（改行は行末スペース2で保持、`isSep`→`---`）。これで `[[ノート#見出し]]` と `[[記事タイトル]]`（aliasに正式タイトル）が Obsidian で解決する。
- frontmatter: title / aliases / source(=出典URL) / created / saved / tags / type / **reader_id（=doc.id。重複・上書き判定の鍵）**。
- HTML→Markdown は **Turndown.js v7.2.0 + turndown-plugin-gfm v1.0.2 をインライン同梱**（外部CDN非依存・自己完結維持。MIT、出所コメント明記）。`</main>` 直後に独立 `<script>` 2本で `window.TurndownService` / `window.turndownPluginGfm` を定義。
- 画像: `inlineImages` の fetch 部を流用し `r.blob()` を `attachments/`（既定名）へ書き出して `![[ファイル名]]`（`{slug}-{n}.{ext}`、拡張子は blob.type 由来）。img src を英数マーカーに置換→Turndown後に正規表現で `![[...]]` へ置換（Turndownのembed非対応を回避）。CORS不可・取得失敗は元URLのまま `![](url)`。
- 重複/衝突: `getFileHandle`（create無）で存在判定→既存frontmatterの `reader_id` が一致なら上書き、不一致は ` (2)` ` (3)` 連番。
- iOS / FSA非対応（`typeof window.showDirectoryPicker!=="function"`）: 単一 `.md` ダウンロード（画像は `inlineImages` で data URI 埋め込み）に自動フォールバック。
- 追加関数: `saveToObsidian`（ボタンハンドラ）/ `obsBuildMarkdown` / `obsPromoteHtmlHeadings` / `obsExtractImagesToVault` / `obsHtmlToMarkdown` / `obsTextDocToMarkdown` / `obsBuildFrontmatter` / `obsResolveTargetFile` / `obsWriteNote` / `obsSaveDownload` / `obsPickVaultFolder` / `obsEnsureRW` / `obsIdbGet` / `obsIdbSet` ほかヘルパー。
- UI: ヘッダー `#btnObsidian`、取り込みカードに出典URL欄 `#inUrl`（`newDoc`/`newHtmlDoc` に `url`/`obsidianSavedPath` 追加）、設定モーダルに保存先フォルダ選択 `#btnObsPickFolder`・`#obsAttFolder`・`#obsTags`・表示用 `#obsFolderName`。
- localStorageキー: `mr_obs_attfolder` / `mr_obs_tags` / `mr_obs_foldername`。IndexedDB: `mr_obsidian`/`handles`/`vaultDir`（ハンドル本体のみ）。ステータスは既存 `flashPill` 流用（Gist専用の `setSyncStatus`/syncBadge には非干渉）。

**なぜ:**
リッチHTML記事（画像・表入り）をナレッジベースとして貯め、後で `[[wikilink]]`・`[[#見出し]]` 参照したい。Notionは画像/リッチ再現とCORSが難点で見送り、ローカルMarkdown+双方向リンクのObsidianを採用。

**検証:**
- 3スクリプト（turndown / gfm / 主スクリプト）すべて `node --check` で構文OK。
- jsdom で変換パイプラインを実テスト: 見出し昇格(##/###)・太字・リンク・GFM表・画像マーカー→`![[...]]`・attachments書き込み・拡張子(blob.type由来 png/jpg/webp)・テキスト変換(見出し/行末スペース2改行/`---`)・frontmatter・tags(既定/カスタム)・衝突解決(同reader_id上書き/連番/空き名)すべてPASS。
- ブラウザ実機での FSA フォルダ書き込み・Obsidianでの `[[#見出し]]` 解決はユーザー確認待ち。

**ハマりどころ・次回への注意:**
- **ユーザージェスチャ**: `requestPermission`/`showDirectoryPicker` は transient activation（click から約5秒）必須。`saveToObsidian` は click→`await obsIdbGet()`（数ms）→権限確保の順で、`prompt()`（出典URL補完）は権限確保の後に置いた。順序を変えると権限要求が弾かれうる。
- **file:// 起動**: `showDirectoryPicker` が `function` でなければ自動で `.md` ダウンロードにフォールバックするので、file:// でFSA不可でも壊れない。FSAが使える環境（http(s)/対応Chrome）ではそちらを使う。実機で `typeof window.showDirectoryPicker` を要確認。
- **Turndownの globalは別`<script>`**: 主スクリプトは `new TurndownService()` を click時にのみ参照するので、`<script>`分離でも問題なし。`PORTABLE_TEMPLATE` 内の文字列 `'<script>'`/`'<\/script>'`（エスケープ）は壊さないこと。
- **既知の制約**: (1) `<a>` で囲まれた画像は `[![[file]]](href)` となりObsidian embedとしては崩れる（稀）。(2) メールのレイアウト用テーブルはGFM表として認識されないとフラット化されうる（ベストエフォート）。(3) iOSフォールバックの data URI 画像はObsidianモバイルで表示されない場合あり。
- リポジトリは git 管理（OneDrive\reader\.git, remote kero77/reader）。今回はコミットせず差分のみ。

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
