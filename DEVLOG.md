## 2026-08-04 ブラウザ同期失敗の切り分け（同期失敗理由の可視化＋CORS防御を追加）

**担当エージェント:** programmer

**事象:** PCブラウザで同期ボタン押下時「✗が一瞬変わってもとに戻る」＝即失敗。一方 `mailmag_to_reader.py` の proxy モード（GET）は成功していた。

**切り分け結果（本番エンドポイントに実アクセスして検証。PATCHは一切実行せず）:**
- ページ本体 `https://long-email-reader.netlify.app/` と `/api/gist` は**同一オリジン**であることを確認（`curl -L` で最終URL一致）。ブラウザのCORSプリフライトはそもそも同一オリジンでは発生しないため、**CORS/プリフライトは今回の直接原因ではない**と判断（最有力候補として検証したが棄却）。
- `OPTIONS /api/gist`・キー無し/ダミーキーでの `GET /api/gist` はいずれも `401 {"error":"unauthorized"}`。認証チェック自体は仕様どおり機能している。
- CSPメタタグ・Service Workerは存在せず（登録コード自体がない）、それらによるブロックも該当なし。
- 正規キーでの200確認はAPP_KEY実値に触れられないため未検証（ユーザー確認事項として残す）。有力な残り仮説は「ブラウザに保存されたアプリキーが実際は空/不一致（ブラウザのパスワードマネージャ誤補完・入力ミス等）」。

**実施した修正:**
1. `index.html`（`setSyncStatus`/`gistFetchMerge`/`gistPull`/`gistPush`）: 同期失敗時にバッジの`title`属性（ホバーで表示）とconsole.errorに具体的な失敗理由（アプリキー未設定／HTTPステータス／401ならその旨／ネットワークエラー本文）を出すよう変更。`_pullOk`ガード・read-modify-write・keepalive・墓標マージの制御フロー自体は一切変更していない（診断用の副変数`_lastSyncError`を追加しただけ）。
2. `netlify/functions/gist.mjs`: `OPTIONS`を204で即応答するハンドラと`Access-Control-Allow-*`ヘッダを全レスポンスに追加（防御的措置。現状は同一オリジンのため不要だが、カスタムドメイン併用等で将来オリジンが分岐した場合に備える）。認証ロジック（`x-app-key`のタイミング安全比較）・GET/PATCHの処理内容は変更なし。

**デプロイ・検証:** `node --check`（gist.mjs）＋index.html内3つの`<script>`ブロックをそれぞれ抽出して`node --check` PASS。コミット後push→Netlify自動デプロイを確認。本番で `OPTIONS /api/gist` が204＋`Access-Control-Allow-Origin`付きで返ることを確認、GET/PATCHの401挙動が変わっていないことも再確認。

**ユーザーが次にやること:**
1. 設定画面のアプリキー欄を一度空にして、`.env`（`C:\Users\Masashi\Documents\Scripts\reader_sync\.env`）のAPP_KEYと**同じ値をコピペ**して保存し直す（ブラウザのパスワードマネージャの誤補完を避けるため、貼り付け後に欄の中身を目視確認）。
2. 保存後「今すぐ同期」を押し、失敗したらバッジにマウスホバー（PCなら）→ title に出る具体的理由を確認。またはF12→Consoleタブに`[gist sync] ...`で理由が出る。F12→Networkタブで`/api/gist`のステータスコード（401なら鍵不一致、その他ならサーバー/ネットワーク側）も確認可能。
3. 直っても直らなくても、次回はホバー/コンソールの理由メッセージで一次切り分けが可能になったはず。

---

## 2026-08-04 Netlifyデプロイ実施・接続確認（無認証GET→401を確認）

**担当エージェント:** programmer

**前提:** ユーザーがNetlify管理画面で環境変数 `GITHUB_TOKEN`/`GIST_ID`/`APP_KEY` の登録を完了。

**実施内容:**
1. `C:\Users\Masashi\OneDrive\reader` の git 状態確認。remote は `origin = https://github.com/kero77/reader.git`（既存。過去のDEVLOGエントリでも「push でNetlify自動デプロイされる」と明記済み）、ブランチ `main`。`.netlify` CLIリンクは無いが、Netlify側のWeb UIでこのGitHubリポジトリ/mainブランチに紐付いた自動デプロイ運用と判断（過去4回のpushで同様に反映されている実績あり）。
2. 未コミットだった `index.html`（同期系のプロキシ化差分）・`DEVLOG.md`（前セッションの記述）・新規 `netlify.toml`・`netlify\functions\gist.mjs` をコミット（`706cc0d`）してpush。
3. デプロイ完了をポーリングで確認（push後 `/api/gist` が404→401に変わった時点でデプロイ反映と判断。約20〜30秒）。
4. 接続確認（**すべてGETのみ、PATCHは一切実行していない**）:
   - `x-app-key` ヘッダ無しで `GET /api/gist` → **401** `{"error":"unauthorized"}`（要件どおり第三者は読めない）。
   - 誤った `x-app-key`（ダミー文字列）でも同様に **401**。
   - トップページ `https://long-email-reader.netlify.app/` は **200** で正常配信継続。
   - デプロイ後の `index.html` を実際にダウンロードしてローカルのコミット版と `diff` → **完全一致**。`_pullOk` ガード・`GIST_PROXY_URL`（`/api/gist`）・`x-app-key` 送信・PATCH前提条件（`_pullOk`必須）が本番にそのまま反映されていることをgrepで確認。
   - **正しいAPP_KEYでの200確認・PATCHの実行はいずれも未実施**（APP_KEYの実値はユーザーのみが把握。本セッションでは推測・詮索しない方針のため、ユーザー自身の確認に委ねた）。

**ユーザーが次にやること:**
1. 各端末（PC/iPhone）のリーダー設定画面 → 「アプリキー」欄に、Netlifyへ登録した `APP_KEY` と同じ値を入力して保存。保存後「🔄 今すぐ同期」を押し、200で同期が動く（8/4号 `dxa3ra8q7` が表示され続ける・7/28号 `dboiqu3e2` は墓標のまま）ことを確認。
2. `mailmag_to_reader.py`（`C:\Users\Masashi\Documents\Scripts\reader_sync\.env`、programmerのアクセス許可外のため今回内容未確認）で `GITHUB_TOKEN` をコメントアウトし、`PROXY_URL=https://long-email-reader.netlify.app/api/gist` と `APP_KEY=<同じ合言葉>` を設定してproxyモードへ切替。切替後はまず `--dry-run`（あれば）または実行前にログのみで直接/プロキシいずれのモードか確認してから本番実行することを推奨。

**残作業:** 401検証は完了、200（正規キー）検証とproxyモードでのPython側実書き込みはユーザー確認待ち。

---

## 2026-08-04 GitHub PATをNetlify Functionsプロキシに集約（端末はアプリキーのみ保持）

**担当エージェント:** programmer

**背景:** GitHub PAT が `.env`（reader_sync）と全デバイスの localStorage（`mr_gh_token`）に複製されており、
失効のたび（実際に2026-07-28・2026-08-04と繰り返し発生）全箇所を巡回更新する必要があった。
Netlify Functions にプロキシを立て、PATの保持箇所を Netlify の環境変数1箇所に集約した。

**変更ファイル（新規）:**
- `C:\Users\Masashi\OneDrive\reader\netlify.toml` — `publish="."`, `functions="netlify/functions"`,
  `/api/gist` → `/.netlify/functions/gist` のリダイレクト。
- `C:\Users\Masashi\OneDrive\reader\netlify\functions\gist.mjs` — GET/PATCH の薄いプロキシ関数。
  サーバー環境変数 `GITHUB_TOKEN`/`GIST_ID`/`APP_KEY` を読み、クライアントの `x-app-key` ヘッダを
  `crypto.timingSafeEqual` でタイミング安全比較。不一致・未設定は401（読み取り側も認証必須。
  Gistはsecretだが未認証GETで200が返る＝URLを知れば読める状態だったため、GET/PATCHどちらも
  ゲートする。public化は絶対にしない）。GET は Gist API のレスポンス形（`{files:{...}}`）を
  維持したまま返し、`truncated:true`（1MB超）の場合は `raw_url` をサーバー側で解決してから
  返すため、クライアントは GitHub の生URLに一切触れない。PATCHはクライアントのGist API互換
  body（`{files:{"reader_data.json":{content}}}`）を素通しでGitHubへ転送するだけ（墓標/マージ
  判断はクライアント側の責務のまま変更なし）。

**変更ファイル（既存）:**
- `index.html`:
  - 同期系の定数・関数を全面差し替え。`GH_TOKEN_KEY`/`GH_GIST_KEY`/`ghToken()`/`ghGistId()` を廃止し、
    `APP_KEY_KEY`("mr_app_key")/`appKey()` に統一。通信先は GitHub API 直叩きから `GIST_PROXY_URL`("/api/gist")
    に変更し、`Authorization: token ...` の代わりに `x-app-key` ヘッダを送る。
  - **`_pullOk`ガード・read-modify-write（PATCH直前の再GET→マージ）・墓標(tombstone)マージ・keepalive設計は
    一切変更していない**（過去2回の事故対策そのものを維持。差し替えたのは通信先とヘッダのみ）。
  - Gist IDはNetlify側の環境変数（サーバー管理）に一本化されたため、クライアント側の「Gist ID未設定→
    自動Push時は新規作成禁止／`allowCreate`時のみ許可」という分岐（2026-07-28の2件目の事故＝空Gist誤バインドの
    原因だった仕組み）は**構造的に不要になったため削除**。これにより「端末ごとに別のGistへ誤ってバインドする」
    という事故のクラス自体が発生しなくなった（副次効果。安全機構を弱めたのではなく、原因となっていた
    可変性そのものをサーバー管理に移して無くした）。
  - 設定モーダル: 「GitHub トークン」欄と「Gist ID」欄・「Gist IDをリセット」ボタンを廃止し、
    「アプリキー」欄（`#appKeyInput`）のみに簡素化。
  - 旧キー `mr_gh_token`/`mr_gist_id` が端末のlocalStorageに残っていても読み込まなくなっただけで、
    エラーにはならない（無害な残骸として放置してよい）。

**なぜ:** GitHub PATは30〜90日等で失効し、複製箇所が多いほど失効時の復旧コストが線形に増える。
プロキシに集約すればPAT保持箇所は1箇所（Netlify環境変数）になり、失効時の更新もそこだけで済む。
一方、読み取りを無認証にするとNetlifyの公開URLから誰でも有料メルマガ本文を読めてしまうため、
GET/PATCH双方に無期限の自作キー(APP_KEY)を必須にして従来のアクセス制御を維持した。

**検証（すべてモック。実GitHub/Netlifyへの通信・実Gist書き込みは一切発生させていない）:**
- `node --check`: `netlify/functions/gist.mjs` 構文OK、`index.html` の本体script（66,061字）構文OK。
- `gist.mjs` の単体テスト10項目すべてPASS: 認証ヘッダ無し/不一致→401でupstream fetch自体が発生しないこと
  （＝間違ったAPP_KEYでは絶対にGitHubへ到達しない）、GET通常系のプロキシ転送、GET truncated時のraw_url
  サーバー側解決（クライアントに露出しない）、GETファイル無し→空配列フォールバック、GET/PATCHのupstream
  失敗時のステータス伝播、PATCH素通し転送とトークンの非露出、未対応メソッド→405、環境変数未設定→500。
- `index.html` の同期ロジック（差し替え後）を切り出したNode単体テスト4項目PASS: アプリキー未設定時は
  fetch自体が一切発生しないこと、GETが`/api/gist`へ`x-app-key`で飛びGitHubへ直接アクセスしないこと、
  **`_pullOk`がfalseのままではPATCHが発行されないこと（2026-07-28事故の再発防止ロジックが健在）**、
  Pull成功後のPushがread-modify-write（PATCH直前にGET→マージ）を維持していること。

**ユーザーがNetlify側でやるべき設定（未実施・デプロイ待ち）:**
1. Netlify管理画面 → 対象サイト（`long-email-reader`）→ Site configuration → Environment variables で以下を登録:
   - `GITHUB_TOKEN` … Gist読み書き権限を持つGitHub PAT（scope: gist のみで可。可能なら No expiration か長期のものを推奨）
   - `GIST_ID` … 現在使用中のGist ID（設定画面や`.env`の`GIST_ID`を参照）
   - `APP_KEY` … 端末側と共有する無期限の合い言葉（長くランダムなものを推奨。自分で決める）
2. `git add/commit/push` でこのコミットをデプロイ（本セッションでは**未実施**。ユーザー確認後に実施すること）。
3. デプロイ後、各端末のリーダー設定画面で「GitHub トークン」欄が「アプリキー」欄に変わっているので、
   Netlifyに登録した`APP_KEY`と同じ値を入力→保存。旧Gist ID欄は無くなった（サーバー管理のため入力不要）。
4. 「🔄 今すぐ同期」または自動Pullで同期が動くことを確認。401が出る場合はAPP_KEYの不一致、
   500が出る場合はNetlify側の環境変数未設定を疑う（`gist.mjs`のエラーメッセージ参照）。

**残リスク・既知の制限:**
- 本セッションではNetlifyへのデプロイを行っていない（環境変数未登録のため、デプロイしても`gist.mjs`は
  500を返し続ける）。ユーザーが環境変数を登録し、git pushしてから初めて有効になる。
- `netlify/functions/gist.mjs`の実際のNetlifyランタイムでの動作（ESM default export + `Request`/`Response`）は
  ドキュメント準拠で実装したが、実機（Netlifyデプロイ環境）での動作確認はできていない
  （デプロイ自体が本セッションの対象外のため）。
- 旧`mr_gh_token`（GitHub PAT本体）が端末のlocalStorageに残っている場合、コード上は読まなくなったが
  値自体は消えない。気になる場合はブラウザの開発者ツールから手動で `localStorage.removeItem("mr_gh_token")`
  するか、次回の設定保存時に上書き整理する仕組みを別途検討してもよい（今回はスコープ外として未実装）。

---

## 2026-07-28 Push を非破壊化（Pull成功前のPush禁止＋PATCH直前の再取得マージ）

**担当エージェント:** programmer

**変更ファイル:**
- `C:\Users\Masashi\OneDrive\reader\index.html`（`gistPush` 全面改修・`gistPull` 簡素化・`gistFetchMerge`/`applyMergedToUi` 新設。+84/-30行）

**症状（実データで確認済みの事故）:**
2026-07-28 09:19 に Python(reader_sync) が Gist `45bd2b94…` に 3件（生きた7/28号＋墓標2件）を正しく書き込んだ。
その後リーダーを開くと 💾バッジが ✗（Pull失敗）。10:04（`updated_at` 2026-07-28T01:04:42Z）に**ブラウザが墓標2件だけのローカル docs で PATCH**し、
Python が入れた 7/28号 doc が Gist から消滅した。

**原因（構造的欠陥・前回エントリの `allowCreate` とは別問題）:**
`gistPush` は**ローカル docs 配列を丸ごと PATCH で上書き**する設計（read-modify-write ではない last-writer-wins-whole-file）。
しかも Push は `persist()`→`schedulePush()` の5秒デバウンス・`visibilitychange`・`beforeunload` から自動で走るため、
**Pull が一度も成功していない状態でも Push できてしまう**。結果、古い/欠けたローカル状態がリモートを破壊する。
Pull 失敗（オフライン・トークン期限切れ・レート制限）→ その後の自動 Push、で必ず再発する。

**実装内容:**
1. `_pullOk`（セッションフラグ）を新設。`gistFetchMerge()` がリモートの取得＋JSONパースに成功したときだけ true。
   既存 Gist への PATCH は `_pullOk===true` が**絶対条件**（false なら PATCH を発行せず `setSyncStatus("error")` で return）。
   Gist ID 未設定＋`allowCreate`（明示操作）の新規作成経路は「上書きするリモートが無い」ので `_pullOk` を問わず許可し、成功時に `_pullOk=true` にする。
2. **PATCH 直前に remote を GET して `mergeFromRemote()` でマージしてから書く**（read-modify-write）。
   GET 失敗・JSON破損時は**PATCHしない**（同期が遅れる方がデータ喪失より安全、という優先順位）。
3. `_pushPending`: Pull未成功等で見送った Push を記録し、次に Pull が成功したタイミングで `schedulePush()` し直す（送りっぱなしの取りこぼし防止）。
4. keepalive 経路（`visibilitychange` hidden / `beforeunload`）の設計判断:
   `await` をまたぐと後続の PATCH が発行されないままページが破棄されうるため、
   **`_pullOk` かつ最後のマージから60秒以内（`PUSH_MERGE_MAX_AGE_MS`）のときだけ GET を省略して直接 PATCH**。
   それ以外（マージが古い）は keepalive でも GET→マージ→PATCH を試みる（途中でページが死んでも PATCH は発行されないので破壊は起きない＝安全側）。
   通常の5秒デバウンス Push が毎回マージしているので、実運用で「60秒以内」は常に満たされ、取りこぼす差分は直近数秒ぶんだけ。
5. `gistPull()` は `gistFetchMerge(token, gistId, true)` を呼ぶだけに簡素化（Pull と Push でマージ処理を一本化）。
   Push 経路では `rerender=false` で `renderDocSelect()` のみ（`openDoc()` を呼ばないので読書中のスクロール位置が飛ばない）。
6. 前回セッションの `allowCreate` ガードはそのまま維持（同コミットに同梱）。

**検証:**
- 本体 `<script>`（3ブロック中の最後・67,537字）を切り出して `node --check` → 構文OK。`PORTABLE_TEMPLATE` は無変更。
- 同期ロジックを切り出した Node 単体テスト 23項目すべて PASS:
  (1) Pull未成功の Push は fetch 自体を出さない（今回の事故の再現テスト）、(2) Pull→ローカル追加→Push で「他端末の新doc・7/28号・自分の新規」がすべて残る、
  (3) Push直前GET失敗時はPATCHしない、(4) リモートJSON破損時もPATCHしない、(5) keepalive＋直近マージ済みはGET省略で即PATCH、
  (6) マージが古いkeepaliveはGET→PATCH、(7) `_pullOk`falseならkeepaliveでもPATCHしない、(8) `allowCreate`無しでは新規作成しない、
  (9) Pull成功で保留Pushが再予約、(10) Push中のマージでは `openDoc` を呼ばない。
- **Gist への PATCH/POST は一切していない**（現状確認の GET のみ）。

**ハマりどころ・次回への注意:**
- `_syncSuppressPush` / `schedulePush` は `gistFetchMerge` より**後方**で `let`/`function` 宣言されているが、実行時には必ず宣言後に呼ばれるので TDZ には当たらない（既存コードと同じ前提）。関数の並び替えをする場合は注意。
- Gist 同期は「ファイル丸ごと上書き」なので、**Pull を挟まない Push は常にデータ破壊の可能性がある**。今後 Push 経路を追加するときは必ず `gistPush()` 経由にすること（`fetch(...PATCH)` を直書きしない）。
- 事故の切り分けには `GET /gists/{id}` の `updated_at`（＝最後に誰が書いたか）と `GET /gists/{id}/commits` が有効。Python の実行ログ時刻と突き合わせると犯人がすぐ分かる。
- 7/28号の復旧は `reader_sync\state.json` の `processed_message_ids` から
  `<1628495750.32162304.1785190206216.tdm@cinnamon.mag2tegami.com>`（7/28 07:10配信）を消して再実行すればよい（Gist側にタイトル重複が無いことは GET で確認済み）。**本セッションでは未実行**。

## 2026-07-28 「記事が1件も表示されない」調査 → 自動Pushでの暗黙のGist新規作成を禁止

**担当エージェント:** programmer

**変更ファイル:**
- `C:\Users\Masashi\OneDrive\reader\index.html`（`gistPush` / `openSettings` / `btnSyncNow` / `btnGistClear` の計4箇所・7行程度）

**症状:** reader_sync（Python）が 7/28号 を Gist へ正常に書き込んだ（ログ上も成功・実データも健全）のに、リーダーを開くと1件も表示されない。

**調査で判明した事実（Gist API を GET のみで確認）:**
- `.env` の `GIST_ID=45bd2b9478710195ca5b458eddaa3d26`（2026-06-23作成・本番ストア）の `reader_data.json` は健全。
  docs 3件 = 生きた doc 1件（7/28号, html 29,879字, bookmarks 29件, キー集合は `newHtmlDoc` と一致）＋ 墓標2件（7/14号・7/21号, `deleted:true`）。
  制御文字・サロゲート・truncated いずれも無し。Python 側のスキーマ・墓標との相性に問題なし。
- ところが**同じアカウントに `reader_data.json` を持つ Gist がもう1つ存在した**:
  `3f0ca73da8b1d586b3a8e17c375357f3`（作成 2026-07-14T01:26:05Z、中身は空配列 `[]`、以後更新なし）。
- `mergeFromRemote` を実データで単体シミュレーションした結果、ローカルが「空」「墓標2件のみ」「自分の方が新しい」いずれのケースでも
  正しい Gist を pull すれば `live=1` で表示される。**アプリのマージ/墓標ロジックにバグはない。**

**原因（構造的欠陥）:**
`gistPush` は `ghGistId()` が空だと `POST /gists` で**新しい Gist を黙って作り、その ID を localStorage に固定**していた。
一方 Push は `persist()` の5秒デバウンス・`visibilitychange`・`beforeunload` から自動で走るため、
「Gist IDをリセット」を押した直後や localStorage が飛んだ直後に、ユーザーが何もしなくても
**空の docs（`[]`）で新しい Gist が生成され、その端末だけが空ストアに再バインドされる**。
上記 `3f0ca73d…` は 40秒間に3リビジョンという典型的なデバウンスPushの痕跡で、まさにこれ。
その端末では以後どれだけ Python が本番 Gist に書いても空 Gist を pull し続けるので何も表示されない
（`mergeFromRemote` は空配列リモートに対し `changed=false` で即 return するため、警告すら出ない）。

**実装内容:**
1. `gistPush(opts)` に `allowCreate` を追加。Gist ID が空のときの `POST`（新規作成）は `allowCreate:true` のときだけ許可し、
   自動Push経路では作成せず `setSyncStatus("error")` で返す（✗バッジで気づける）。
2. 新規作成に成功した場合は `alert()` で新しい Gist ID を表示（他端末へ同じIDを設定するよう促す）。
3. `btnSyncNow` を `.then(gistPush)` → `.then(()=>gistPush({allowCreate:true}))` に変更。
   ついでに `.then(gistPush)` が Promise の解決値を第1引数（=opts）として渡してしまう潜在バグも解消。
4. `openSettings()` で Gist ID 未設定時に placeholder に警告文を出す。`btnGistClear` の confirm 文言も実挙動に合わせて修正。

**検証:**
- 本体 `<script>`（最後のブロック, 65,360字）を `node --check` で構文OK。
- `mergeFromRemote` の Node 単体シミュレーション（実 Gist データ使用）で表示ロジックの正常性を確認。
- **Gist への書き込み（PATCH/POST）は一切行っていない。git commit / push も未実施＝Netlify 未デプロイ。**

**ユーザー側で必要な確認・復旧手順:**
1. 表示されない端末でリーダーを開き ⚙設定 → Gist ID 欄を確認。
   `3f0ca73da8b1d586b3a8e17c375357f3` または空 なら本件。`45bd2b9478710195ca5b458eddaa3d26` に書き換えて保存 →「🔄 今すぐ同期」。
2. 空 Gist `3f0ca73d…` は誤バインドの再発防止のため削除推奨（中身は `[]` なので消してよい）。

**ハマりどころ・次回への注意:**
- 「Gist IDリセット」は**押した瞬間ではなく次の自動Pushで**新Gistを作る遅延爆弾だった。今回の修正で明示操作限定になった。
- 端末ごとに localStorage は別（Netlify の https オリジンと `file://` でも別物）。「同期が効かない」系はまず設定画面の Gist ID を突き合わせること。
- Gist の事故調査には `GET /gists/{id}/commits`（リビジョン履歴）と `GET /gists`（同名ファイルの重複Gist検出）が非常に有効。

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
