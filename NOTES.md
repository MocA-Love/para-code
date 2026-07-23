# Para Code - fork運用メモ

Para Code: VS Codeフォークの独自エディタ。`microsoft/vscode`を`upstream`としてfork。

## 経緯（サマリ）

1. VS Code拡張機能のプロトタイプとして以下3機能を作ろうとした
   - 複数リポジトリのワークスペース即時切り替え（状態維持、非アクティブなものは非表示）
   - ターミナルの田の字型（縦横自由）分割
   - ブラウザタブ（CDP）⇔AIエージェントセッションの動的紐づけ
2. 拡張機能の範囲で実装を進めた結果:
   - 機能1は「本物のworkspaceFoldersを操作し、常にインデックス0に触れないダミーのアンカーフォルダを置く」方式で、**Extension Host再起動なしに安定動作することを旧拡張プロトタイプで実証済み**。これは拡張機能のままで解決できた
   - 機能2（ターミナル2Dグリッド）は、旧拡張プロトタイプの`node-pty` + `xterm.js`による自作webviewターミナルで実現可能と確認した
   - 機能3（ブラウザ⇔エージェント）はCDP直結のWebviewPanelで拡張機能のまま実現可能と判明（未実装、設計のみ）
3. つまり**3機能とも技術的には拡張機能のままで実現可能**と分かった。それでもforkを選んだ理由は「今後増えるであろう要望に対して、拡張機能APIの境界に縛られない自由度が欲しい」という戦略的判断（バグドリブンではない）
4. fork方式は「VSCodium型パッチレイヤー」ではなく、LLM Agent（Claude Code）による開発 + 強いCI/テストを前提に、**機能の野心はフルフォーク相当に広げつつ、個々のパッチは可能な限り新規ファイル追加/薄いフック1箇所で完結させる**という設計方針を採用

## 重要な調査結果（今後のパッチ設計の前提）

- `src/vs/workbench/contrib/relauncher/browser/relauncher.contribution.ts`の`WorkspaceChangeExtHostRelauncher`が、`workspace.folders[0].uri`（インデックス0）の変化を検知してExtension Hostを再起動する。根拠は非推奨`workspace.rootPath`互換のみで、現行APIの必須要件ではない
- 2026年2月マージのPR #292783で、VS Code本体が`isSessionsWindow`という「Agent Sessions window」専用モードを追加し、この再起動を明示的にスキップしている。**Microsoft自身が同種のユースケースでこのパターンを実証済み**
- `isSessionsWindow`はcore限定のフラグで拡張機能からは設定できないため、拡張機能側では「インデックス0に触れない」という設計で同じ効果を得た（`ensureAnchorFolder`）
- `src/vs/sessions/`に実験的な「Agent Sessions window」機能が既にある（`WindowEnablement.Sessions`フラグ、安定版では無効）。調査の結論:
  - `contrib/workspace/browser/workspaceFolderManagement.ts`: `IWorkspaceEditingService.updateFolders(0, 1, [newFolder], true)`でインデックス0を都度**置き換え**。複数リポジトリを同時保持する設計ではない（私たちの要件とは異なる）
  - `contrib/browserView/`: CDP（CDPEvent/CDPRequest/CDPResponse）対応済み。`registerContextualFilter()`でアクティブセッションのみブラウザタブを絞る仕組みあり。**機能3の実装で参考・流用価値が高い**
  - `contrib/terminal/`: 1軸split view のみ。2Dグリッド未対応（機能2は自作webviewターミナルで代替する方針を維持）
  - 総合評価: 「薄く拡張するより、必要な部分だけ参考にしてゼロから作る方が早い」（複数リポジトリ同時保持・2Dグリッドが根本的に未実装のため）

## 【重要・実機で確認済み】sessions.common.main.tsは通常ウィンドウでロードされない（2026-07-01）

機能2（ターミナル2Dグリッド）の初回実装で、`sessions.common.main.ts`に登録したcommand（`registerAction2`）が通常のPara Codeウィンドウのコマンドパレットに一切出てこないバグが発生し、実機調査で原因を特定した。

- `src/vs/platform/windows/electron-main/windowImpl.ts:1213`: `configuration.isSessionsWindow`が真の場合のみ`vs/sessions/electron-browser/sessions(-dev).html`をロードし、それ以外（通常ウィンドウ）は`vs/workbench/workbench(-dev).html`経由で`vs/workbench/workbench.desktop.main.ts`（→upstream所有の`workbench.common.main.ts`）をロードする
- `isSessionsWindow`は`src/vs/platform/windows/electron-main/windowsMainService.ts:1599`で`options.workspace.configPath`が`environmentMainService.agentSessionsWorkspace`と一致する場合のみ真になる特殊なワークスペース。通常起動では真にならない
- つまり`src/vs/sessions/sessions.common.main.ts`への集約importは、**Agent Sessionsウィンドウ専用**であり、通常ウィンドウでは該当モジュールの`import`自体が実行されない（`registerAction2`等の副作用が一切発生しない）
- 修正: 通常ウィンドウでも有効にしたい機能（ターミナル2Dグリッドのsplit action等）は、`sessions.common.main.ts`ではなく、既存のDI差し替えポイント（`terminalGroupService.ts`、workbench側で常にロードされる）から直接副作用importするよう変更した。詳細は`CLAUDE.md`の「contributionの登録方法」を参照
- **教訓**: `src/vs/sessions/`配下は「Agent Sessions window専用のworkbenchレイヤー」という説明を字面通りに受け取ると見誤る。実際に通常ウィンドウで機能させたい場合は、必ず実機（`scripts/code.sh`で起動した通常ウィンドウ）でコマンドパレット等から動作確認すること。型チェック・lintが通ってもロードパスの問題は検出できない

## リポジトリ構成

- `upstream`: `https://github.com/microsoft/vscode.git`（push無効化済み、fetch専用）
- `origin`: このGitHubリポジトリ（public、2026-07-13確認）
- ブランチ運用は今後要検討（upstreamのタグを定期的に取り込む前提。マージ戦略は未確定）
- **`main`の起点はupstreamスナップショットを1コミットに圧縮したもの**（`git checkout --orphan` + `git add -A`）。以後のPara Code開発コミットは通常どおり積み上げている。Microsoft側のフル履歴は`upstream`から`git log upstream/main`等で参照可能。理由は下記「pushトラブル」参照
- **現在のツリーが対応するupstreamコミット: タグ `1.129.0`**（2026-07-18のsquashマージ `para: merge upstream 1.129.0` で取り込み済み。それ以前のベースはupstream `7ad5744c6852a42e070b6d6045e3e1215cc120fd`＝1.128系だった）。次回のupstream取り込み手順: (1) `git fetch upstream --tags` (2) `git replace --graft <1.129.0を取り込んだsquashコミット> <その実親> 1.129.0` で「squashコミットが1.129.0を第2親に持つマージコミットだった」とローカルに教える（replace refはpushされないためリモートには影響しない） (3) `git merge --squash <新タグ>` で3-wayマージ→解消→`para: merge upstream <新タグ>` でコミット (4) `git replace -d`で後片付けし、この行を新タグで更新する。1.129取り込み時の実績: コンフリクト10ファイル/20hunk、解消方針の詳細はgit log参照。**マージ前に必ず監査（下記「upstream取り込み前監査」）とマージ後のtypecheck/valid-layers-check/意味的レビューを行うこと**

## upstream取り込み前監査の記録（2026-07-18、1.129取り込み準備）

1.129取り込み準備中に、ベースコミット（上記`7ad5744c685`）との全差分をマーカーと突き合わせる監査を実施した。結果と対処:

- upstream由来ファイルへのfork変更153ファイルのうち、**32個の.tsファイルにPARA-PATCHマーカーが無かった**。全て`para:`プレフィックスも無い一連のコミット由来（`ff54c8f7aa5` fix: harden Para Browser MCP isolation and recovery / `e07c045da85` fix: preserve terminal recovery and workspace ownership / `8f9c774d82f` fix: harden mobile relay routing and recovery / `b22aec2a71c` feat: pin auxiliary windows to spaces / `ae344defc3d` feat: scope unsaved editors to spaces / `fcbac0e0e4c` feat: optionally open a terminal when splitting editors / `fb3726df103` fix: make scoped retirement crash-safe / `e7ec0beb0a9` feat: add automatic Codex terminal titles / `478af1a1ea8` fix: redraw terminals after window moves）
- 対処: 32ファイル全てにPARA-PATCHマーカーを後付けした（コメント行のみ121行追加、挙動変更なし、typecheck-client通過）。コミットプレフィックス違反の過去履歴は書き換えない（force push回避）。**今後のコミットは必ず`para:`プレフィックスを付けること**
- 判明した副次的な問題: terminal系のupstream由来ファイル（`terminal.ts`等）のフィールド説明コメントに`PARA-CODE:`マーカーが使われている箇所がある。`PARA-CODE`は「fork新規作成ファイル全体」用のマーカーなので、`grep -rl "PARA-CODE:"`のfork所有ファイル一覧に誤って載る。将来の整理候補（実害は小さいので未修正）
- 監査の再現方法: `git diff --name-status <ベースコミット> HEAD` でM（変更）ファイルを列挙し、各ファイルの`PARA-PATCH`有無をgrep。コメント不能ファイルは本ファイルの台帳と突き合わせる

## pushトラブルの記録（2026-07-01）

フル履歴（2,222,499オブジェクト、1.30 GiB）のまま`git push`すると、TCP接続が`CLOSED`または`CLOSE_WAIT`になって進捗ゼロのままハングする現象が複数回発生（`http.version HTTP/1.1`固定、`http.postBuffer`拡大、`http.lowSpeedLimit`設定を試しても解消せず）。原因はネットワーク経路側の問題と推測されるが特定はできていない。

対策として履歴を1コミットに圧縮（`git checkout --orphan squashed-base` → `git add -A`（`node_modules`/`.build`は`.gitignore`済みで除外される）→ `git commit --no-verify`（huskyのpre-commitフックが200万ファイル規模のインデックスに対して固まったためスキップ。通常の開発コミットではフックを飛ばさないこと）→ `git branch -m main`）してから再push。転送対象が19,683オブジェクト・LFS 272MB + 通常オブジェクト46MBまで減り、成功した。

**今後もし大きな変更を一括で加える場合、同様に転送量に注意すること。**

## hygieneチェックとproduct.jsonの既知の衝突

`gulpfile.hygiene.js`に「`product.json`に`extensionsGallery`キーを含めてはいけない」というMicrosoft本家向けのチェックがある（本家では公式Marketplace設定を別経路で注入するため、独自混入を防ぐルール）。私たちのforkはOpen VSX切り替えのために意図的に`extensionsGallery`を追加しているので、このチェックには**恒常的に引っかかる**。`product.json`を変更するコミットは`--no-verify`が必要になる。将来的には`gulpfile.hygiene.js`側にこのチェックの除外条件を追加するパッチを検討してもよい。

`mise.toml`のような新規追加ファイルも「Missing or bad copyright statement」でhygieneに引っかかる。Microsoftのコピーライトヘッダーを付けるのは適切ではないので、自分たちの新規ファイルに対するhygieneルールの扱いは今後整理が必要（`CLAUDE.md`のコンフリクト最小化ルール策定と合わせて検討）。

## コメントを書けないファイルへの変更一覧（2026-07-02整備）

`PARA-PATCH:` / `PARA-CODE:` マーカーは、その形式で有効なコメント構文を持つファイルへ埋め込む。JSON（コメント非対応の厳密パース）、plist、entitlements、バイナリ資産等にはマーカーを埋め込めないため、代わりにこの一覧を更新すること。upstream取り込み時、この一覧に載っているファイルはコンフリクトしやすい・または本来の意味が変わっていないか要確認。

| ファイル | 変更内容 | 理由 |
|---|---|---|
| `product.json` | `nameShort`/`nameLong`/`applicationName`/`dataFolderName`/`win32*`/`darwinBundleIdentifier`等ブランディング全般を「Para Code」向けに変更、`extensionsGallery`を追加（Open VSX）、`voiceWsUrl`を削除 | Phase 2ブランディング + Open VSX切り替え |
| `product.json` | `quality: "stable"` / `updateUrl` / `downloadUrl` を追加。`updateUrl`はカスタムドメイン`https://paracode-updates.paradis.ltd`（初期デプロイ時の`https://para-code-update-server.cloudflare8234.workers.dev`から切り替え済み、動作確認済み）。**`downloadUrl`のみ`https://updates.paradis.ltd/download`の暫定プレースホルダーのまま**（linux用の「更新あり時に開く案内ページ」で必須ではない） | 自動アップデート基盤の有効化。`quality`未設定だと`abstractUpdateService.ts`の`getProductQuality()`がundefinedを返し更新機構自体が無効化される |
| `build/lib/i18n.resources.json` | `vs/sessions/contrib/terminalGrid` エントリを追加 | 新規contributionディレクトリの`localize()`利用に伴うi18nリソース登録 |
| `extensions/theme-defaults/themes/2026-dark.json` | primary accent色を`#3994BC`系→`#09AFD9`系（button/focusBorder/badge/選択背景等、約25箇所、アルファ値は維持）に置換 | ユーザー指定のブランドカラーへの統一 |
| `extensions/theme-defaults/themes/2026-light.json` | primary accent色を`#0069CC`系→`#0598BD`系（同上、白背景に対するコントラストを保つため若干暗めに調整）に置換 | 同上（ダーク/ライト両テーマでの一貫性） |
| `resources/darwin/code.icns` | アプリアイコンをユーザー指定画像に差し替え | ブランディング |
| `src/vs/paradis/contrib/watermark/browser/media/paradisWatermark.png` | 新規追加（fork所有バイナリ）。空エディタグループwatermarkのletterpress画像の差し替え先（`paradisWatermark.css`から参照） | ユーザー指定のwatermark画像への変更 |
| `src/vs/paradis/contrib/notifications/browser/media/sounds/*.mp3`（11ファイル: shamisen/arcade/ping/supersetquick/supersetdoowap/agentisdonewoman/codecompleteafrican/codecompleteafrobeat/codecompleteedm/comebacktothecode/shabalabadingdong） | 新規追加（fork所有バイナリ）。Superset (`apps/desktop/src/resources/sounds/`) のビルトイン着信音をそのまま移植。`FileAccess.asBrowserUri('vs/paradis/contrib/notifications/browser/media/sounds/<file>.mp3')` で参照（`paradisNotificationSoundPlayer.ts`） | 通知サウンド機能（Phase D）のビルトイン着信音アセット |
| `resources/paradis/extensions/*.vsix`（標準同梱9ファイル: mosapride.zenkaku / AntiAntiSepticeye.vscode-color-picker / netcorext.uuid-generator / ms-vsliveshare.vsliveshare / jeff-hykin.polacode-2019 / yudai1204.polacode-button / VisualStudioExptTeam.vscodeintellicode（68MB） / VisualStudioExptTeam.intellicode-api-usage-examples / evondev.indent-rainbow-palettes（18MB）。後段のContainer Toolsパッチ版1ファイルと合わせて実体は計10ファイル） | 新規追加（Open VSX未公開のため同梱するサードパーティ拡張のVSIX。標準同梱分は合計約92MB）。`paradisDefaultExtensions.contribution.ts` が起動時に `appRoot` 相対で解決し `IExtensionManagementService.install()` でインストール。ビルド時は `build/gulpfile.vscode.ts` の `packageTask` が成果物へコピー | 既定拡張自動インストール機能（VSIX同梱分）。IntelliCodeはMicrosoft独自ライセンス（再配布時は要確認）。サイズが大きいためGit LFS化を将来検討 |
| `extensions/git/package.json` | `git.autofetch` の `agentsWindow.default` を upstream の `true` から `false` へ変更 | GitHubレートリミット対策。Agent Sessionsウィンドウで数百worktreeを開くと180秒ごとに全リポジトリへ `git fetch` が走り、GitHub側の濫用検知（二次制限）に掛かるため。既存ユーザーの明示設定は `sessionParaGithubSettingsMigration.ts` の一回限りマイグレーションでリセット |
| `extensions/github/package.json` | `github.branchProtection` に `agentsWindow: { "default": false }` を追加し、`enabledApiProposals` に `agentsWindowConfiguration` を追加（未宣言だと設定ポイントが `agentsWindow` をエラー付きで削除する。git拡張はupstreamが宣言済み） | GitHubレートリミット対策。既定ONだと開いたリポジトリ×remoteごとに起動時GraphQLが2本以上走り、数百worktreeで一斉バーストするため（通常ウィンドウの既定はupstreamのまま `true`） |
| `build/lib/stylelint/vscode-known-variables.json` | `others` に `--paradis-transparency-opacity` / `--paradis-titlebar-bg` / `--paradis-statusbar-bg` / `--paradis-workspace-color` / `--paradis-pr-color` を追加。**注意: 初回追加時に `others` 配列全体（約70行）をアルファベット順に再ソートしたため、diffは純増分より大幅に広い（±70行超）**。upstream取り込みでこのファイルがコンフリクトした場合、upstream側の配列を丸ごと採用し、上記paradis 5変数だけ再挿入するのが最も安全 | ウィンドウ透過機能・Workspacesビュー色バー・PR状態チップのカスタムCSS変数。hygiene の stylelint (Unknown variable) を通すため |
| `package.json` / `package-lock.json` | `dependencies` に `exceljs@^4.4.0` と `jszip@^3.10.1` を追加（`npm install ... --save --ignore-scripts`） | Excelビューア/差分機能。exceljs は xlsx のセル/スタイル/結合のパース（Buffer/stream 依存のため shared process `src/vs/paradis/contrib/fileViewers/node/` でのみ使用）。jszip は xlsx(ZIP) から図形(斜線コネクタ)の drawing XML を取り出すため（同じく shared process）。eslint の node層import許可リスト（`eslint.config.js` の hasNode `allow`）にも `'exceljs'` `'jszip'` を PARA-PATCH で追加済み |
| `package.json` / `package-lock.json` | `@sentry/electron` / `@sentry/node-native` / `@sentry/cli` を追加し、公式CLIとnative stacktrace補助のinstall scriptだけを`allowScripts`で許可 | Para CodeデスクトップのJS例外・Electron native crash収集、Debug ID付きsource mapアップロード |
| `src/vs/code/electron-browser/workbench/workbench.html` / `workbench-dev.html` | CSP の `trusted-types` 許可ポリシー一覧に `paradisSpreadsheetDrawings` を1トークン追加（`content` 属性内のため行内コメント不可） | Excel図形(斜線)を drawing XML から SVG 化する際、renderer の `DOMParser.parseFromString` が Trusted Types 強制でブロックされる。`createTrustedTypesPolicy('paradisSpreadsheetDrawings', ...)`（`paradisSpreadsheetDrawings.ts`）で作るポリシー名を CSP 許可リストに載せないと `createPolicy` が例外→生文字列fallback→ブロックとなる。通常ウィンドウ(workbench.html)専用機能のため sessions html は対象外 |
| `cloudflare/update-server/package.json` / `package-lock.json` / `tsconfig.json` | 新規追加（fork所有、upstreamに同パスなし）。自動アップデートサーバー（Cloudflare Worker）のマニフェスト・lockファイル・tsconfig。同ディレクトリの `src/*.ts` / `wrangler.toml` にはPARA-CODEマーカー記載済み | 自動アップデート基盤（`updateUrl`が指すWorker）の付帯設定ファイル。JSONのためマーカーを埋め込めない |
| `src/vs/paradis/contrib/browserExtensions/electron-main/media/react-devtools/**`（61ファイル） | 新規追加（vendoredサードパーティ成果物、MIT）。React Developer Tools 7.0.1 のChrome拡張をCRX3から展開してそのまま同梱。取得元・更新手順は `src/vs/paradis/contrib/browserExtensions/README.md` 参照 | 内蔵ブラウザへReact DevToolsを既定ロードする機能。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslint/stylelintから除外（`build/filters.ts`・`.eslint-ignore` のPARA-PATCH） |
| `app/mobile/package.json` / `app/mobile/tsconfig.json` / `app/pnpm-lock.yaml` | Expo SDKを52→57へ移行（react-native 0.76→0.86、react 19.0.0→19.2.3）、`@expo/vector-icons` と `react-native-get-random-values` を新規依存として追加。`tsconfig.json` には `expo install --fix` が自動付与した `"extends": "expo/tsconfig.base"` を追加。`pnpm-lock.yaml` は `app/` pnpmワークスペース全体でこれらの依存解決を更新 | SDK 52がXcode 26.6/iOS 26.5ツールチェーンと非互換で、アプリがそもそも起動しなかった（「App entry point not found」）。動作確認済みのvanilla baselineに一致するSDK 57へ切り替えて解決 |
| `app/package.json` | 新規追加（fork所有）。`app/` pnpmワークスペース全体のprivateルートマニフェストと共通scripts | Para Codeモバイルアプリ・protocol・relayを単一ワークスペースとして管理するため |
| `app/protocol/package.json` / `app/protocol/tsconfig.json` | 新規追加（fork所有）。モバイルリレープロトコル共有パッケージのマニフェストとTypeScript設定 | PC・relay・モバイル間で型とプロトコル定義を共有するため |
| `app/relay/package.json` / `app/relay/tsconfig.json` | 新規追加（fork所有）。モバイルリレーサーバーのマニフェストとTypeScript設定 | Para Codeモバイルリレーをビルド・実行するため |
| `app/mobile/modules/para-live-activity/expo-module.config.json` | 新規追加（fork所有）。Para Live Activity Expo moduleのプラットフォーム・モジュール登録設定 | iOS Live ActivityネイティブモジュールをExpoから検出・読み込みするため |
| `app/mobile/assets/icon.png` / `app/mobile/assets/pairing-logo.png` | 新規追加（fork所有バイナリ）。モバイルアプリアイコンとペアリング画面用ロゴ | Para CodeモバイルのブランディングとペアリングUI表示のため |
| `app/mobile/native/ParaCodeWidgets/Info.plist` | 新規追加（fork所有）。Live Activity / Dynamic Island Widget Extensionの設定ファイル | ParaCodeWidgets拡張のbundle情報と実行設定を追跡・復元するため |
| `mise.toml` | 新規追加（fork所有）。Node.jsツールチェーンのバージョン固定。コメント構文はあるが、`PARA-CODE`を冒頭へ置くとupstream hygieneのcopyright検査に失敗するためファイル内マーカーの代わりに本台帳で管理 | Para Code開発環境のNode.jsバージョンを統一しつつ、不適切なMicrosoft copyrightを付与しないため |
| `app/mobile/assets/xterm/xtermBundle.json` | 新規追加（vendoredサードパーティ、MIT）。`@xterm/xterm@6.1.0-beta.288`（リポジトリroot `node_modules` から取得）の `lib/xterm.js` と `css/xterm.css`、および `@xterm/addon-unicode11@0.10.0-beta.288` の `lib/addon-unicode11.js` を `{version, js, css, unicode11Js, unicode11Version}` の1 JSONにバンドル。`app/mobile/src/components/termView.tsx` がWebViewへ埋め込むHTMLに展開する。更新時は同じ手順で再生成（`</script` を含まないことを確認する） | モバイルのターミナル表示をxterm.jsで行うため（TUI対応、オフライン完結・CDN不要）。unicode11はPC側と文字幅表（絵文字・CJK記号の桁数）を一致させるため必須。JSONのためマーカーを埋め込めない |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `marked` を依存に追加 | モバイルのファイルビューアの `.md` レンダー表示（レンダー/Raw切り替え）用 |
| `src/vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs/**`（約190ファイル: pdf.min.mjs / pdf.worker.min.mjs / cmaps / standard_fonts / LICENSE） | 新規追加（vendoredサードパーティ成果物、Apache-2.0）。`pdfjs-dist@6.1.200` の build 成果物と CMap/標準フォントをそのまま同梱。取得元・更新手順は同ディレクトリの `README.md` 参照 | PC版PDFビューア（`paradisPdfFileEditor.ts`）が webview 内で pdf.js を実行するため。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslintから除外（`build/filters.ts`・`.eslint-ignore`・`.eslint-allowed-javascript-files` のPARA-PATCH）。パッケージ同梱は `build/next/index.ts` と `build/gulpfile.vscode.ts` の両方に glob 追加済み |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-file-system@~57.0.0` を依存に追加 | モバイルのPDFビューア。リレー経由で受けたPDFバイナリをキャッシュファイルへ書き出し、WKWebViewのネイティブPDF表示に file:// URI で渡すため |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` / `app/mobile/app.json` | `@sentry/react-native` とExpo config pluginを追加。native build scriptsはfork所有のラッパー経由に変更し、repo root `.env` の `SENTRY_PAT` を子Expoプロセスの `SENTRY_AUTH_TOKEN` だけへ渡す | Para Code MobileのJS例外・native crash・app hang収集とHermes source map/native symbolアップロード（トークン自体は成果物・設定ファイルへ保存しない） |
| `resources/paradis/extensions/ms-azuretools.vscode-containers-2.4.107.vsix` | 新規追加（Para Codeパッチ版のContainer Tools拡張、MIT）。upstream `microsoft/vscode-containers` v2.4.5 をベースに、Containers系ビュー（Containers/Images/Volumes/Networks）をワークスペーススコープに絞る機能（設定 `containers.containers.scopeToWorkspace`、既定オン）と、フォルダ入れ替え時の全ビュー即時リフレッシュを追加。**コンテナ**はcomposeの `com.docker.compose.project.working_dir` ラベルが現在のワークスペースフォルダと無関係なものを隠す（composeでないコンテナは常に表示）。**ボリューム/ネットワーク**は `com.docker.compose.project` ラベルが「許可プロジェクト集合」に含まれる場合のみ表示（許可集合＝ワークスペースフォルダのbasenameをcompose正規化した名前 ∪ working_dirが現在ワークスペースに一致するコンテナのプロジェクト名。composeラベルの無いリソース＝ビルトインnetwork等は常に表示）。**イメージ**はcomposeビルドイメージが `<project>-<service>`/`<project>` 命名になる性質を利用し、ホスト上に存在する全composeプロジェクト名（コンテナ/ボリューム/ネットワークのラベルから収集）のうち許可集合に無いプロジェクト名 P について、リポジトリ名が `P-` 始まり or `P` 完全一致のイメージのみを隠す（alpine等の共有ベースイメージや無関係イメージは常に表示。「他スペースのものと確実に分かるものだけ隠す」方針）。WSLのUNCパス（`\\wsl$\...` / `\\wsl.localhost\...`）はLinuxパスへ変換して照合。バージョンはforkを示すためpatch+100系の `2.4.107`。forkソースは別管理のContainer Tools fork（ブランチ `paradis-workspace-scope`。変更点: `src/tree/containers/paradisWorkspaceScope.ts`（コンテナ+新規のimages/volumes/networksフィルタ）、`ContainersTreeItem.ts`/`ImagesTreeItem.ts`/`VolumesTreeItem.ts`/`NetworksTreeItem.ts` へのPARA-PATCH、`package.json`/`package.nls.json` の設定追加）。再ビルドは `npm ci && npm run build:esbuild && npm run package`。`installGivenVersion: true` によりpinnedとなり自動更新では上書きされない（既存のギャラリー版が入っていてもVSIXインストールが置き換える）。upstream拡張の新版へ追従する際はタグにrebaseして同手順で再生成 | スペース切り替え後もContainers系ビューに他スペースのcomposeリソース（コンテナ/イメージ/ボリューム/ネットワーク）が表示され続ける問題の解消（SCMの `paradisScmRepoScope` に相当する拡張側の対応） |
| `resources/win32/code.ico` / `resources/win32/code_150x150.png` / `resources/win32/code_70x70.png` / `resources/linux/code.png` | アプリアイコンを darwin と同じユーザー指定画像に差し替え（`resources/darwin/code.icns` から ImageMagick で生成。ico は 16/20/24/32/48/64/96/128/256px、linux png は 1024px） | ブランディング。darwin のみ差し替え済みで Windows/Linux が本家アイコンのままだった問題の解消 |
| `resources/win32/inno-big-{100..250}.bmp` / `inno-small-{100..250}.bmp`（計14ファイル） | Windowsインストーラー（Inno Setup）のウィザード画像を、白背景中央に Para Code アイコンを配置した画像へ差し替え（icns由来の1024px PNGから ImageMagick で各DPIスケールの寸法どおりに生成、BMP3形式） | ブランディング（インストーラー画面のみ影響）。`resources/win32/appx/` はマニフェストのみで画像アセット無しのため対象外 |
| `app/mobile/app.json` | `expo-notifications` プラグイン追加、iOS `UIBackgroundModes: [remote-notification]` 追加 | APNsリモートプッシュ（アプリ未起動時の通知配送）。**注意: `app/mobile/ios/` は `app/.gitignore` で無視されるため、NSEターゲット等のネイティブ変更はリポジトリに残らない**。NSEのソースと復元手順は `app/mobile/native/NotifyExtension/README.md` 参照 |
| `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/**`（docx-preview.min.js / jszip.min.js / LICENSE-docx-preview / LICENSE-jszip / README.md） | 新規追加（vendoredサードパーティ成果物）。`docx-preview@0.3.7`（Apache-2.0）と `jszip@3.10.1`（MIT/GPL-3.0デュアル、MITで使用）のUMD版 dist をそのまま同梱。取得元・更新手順は同ディレクトリの `README.md` 参照 | PC版Word(.docx)ビューア（`paradisDocxFileEditor.ts`）が webview 内で docx-preview を実行し .docx を HTML レンダリングするため。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslintから除外（`build/filters.ts`・`.eslint-ignore`・`.eslint-allowed-javascript-files` のPARA-PATCH）。パッケージ同梱は `build/next/index.ts` と `build/gulpfile.vscode.ts` の両方に glob 追加済み |
| `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/docx-preview.min.js` | vendored本体への手動パッチ（2026-07-06〜07、7件）。①`HtmlRenderer.levelTextToContent()` が番号付き/箇条書きリストの CSS `content` 値をテンプレートリテラルの二重ネストで壊して生成する既知バグ（docx-preview GitHub masterでも未修正）を正しい実装に置換。②VML図形パーサ（`Ce`関数）が`strokecolor`/`strokeweight`属性形式（実務文書で一般的）に対応しておらず、斜線コネクタ等の罫線装飾が透明になり完全に見えなくなる不具合を修正。③縦書き指定`<w:textDirection>`のVバリアント(`tbRlV`等)がマッピングに無く横書きにフォールバックし、セルが横方向にはみ出す不具合を修正。④`valueOfTblLayout`が`<w:tblLayout>`の属性名を`val`ではなく`type`を見るべきところを誤っており、`tblLayout=fixed`指定が常に無視されテーブル・ページ全体が異常な幅に拡大される不具合を修正（本件の核心バグ）。⑤`tblW=auto`かつ`tblLayout=fixed`の場合にgridCol合計から明示的widthを補完、および`tblLayout`省略時にwidth明示があれば`fixed`をデフォルト化。⑥ページ基準(`mso-position-*-relative:page`)のVML図形にleft/top:0を与え、アンカー段落位置との二重オフセットで別ページ上に描かれる位置ズレを修正（ビューア側CSSの`section.docx{position:relative}`とセット）。⑦hanging indent段落の行頭タブがWord仕様(インデント位置へのジャンプ)にならず右端のリーダー付きストップへ飛んで目次レイアウトが崩れる問題を修正。詳細と再パッチ手順は同ディレクトリの `README.md`「既知のバグへの手動パッチ」参照 | ①により番号・箇条書きの記号がブラウザのCSSパースエラーで一切表示されなかった（`content: none`）。②により実務の契約書・重要事項説明書等で使われる斜線コネクタ(直線コネクタ)が完全に非表示だった。③④⑤により複数ページの実務文書でページごとに白紙の幅が大きく食い違って見える不具合があった。ビルド済み第三者コードでコメント不可のためここに記録 |
| `app/mobile/native/NotifyExtension/Info.plist` / `NotifyExtension.entitlements` | 新規追加（fork所有）。NSEターゲットの設定ファイル（追跡用コピー。実体は gitignore された `ios/` 内） | プッシュ通知本文のNSE復号。plistはコメント不可のためここに記録 |
| `app/mobile/assets/docxpreview/docxPreviewBundle.json` | 新規追加。PC版Wordビューアの vendored パッチ済み `jszip.min.js` + `docx-preview.min.js` を `{version, jszip, docxPreview}` として同梱（xtermBundle.json と同方式） | モバイルのWordビューア（WebView内レンダリング）用。**PC側の min.js を更新したら再生成が必要**。生成手順は `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/README.md`「モバイルアプリ用バンドル」参照 |
| `src/vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/**`（約350ファイル: package.json / LICENSE / build/**） | 新規追加（vendoredサードパーティ成果物、Apache-2.0）。`chrome-devtools-mcp@1.5.0`（Google）のnpm公開物をそのまま同梱（依存ゼロの自己完結パッケージ、上流README/skillsのみ除外）。取得元・更新手順は同ディレクトリの `README.md` 参照 | para-browser MCPサーバーがペイン毎の子プロセスとしてspawnし、DevToolsツール群をプロキシ合流させるため（`paradisDevtoolsMcpProxy.ts`）。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslintから除外（`build/filters.ts`・`.eslint-ignore`・`.eslint-allowed-javascript-files` のPARA-PATCH。パッケージ更新時は allowlist の再生成が必要、手順は同ファイル内コメント参照）。パッケージ同梱は `build/next/index.ts` と `build/gulpfile.vscode.ts` の両方に glob 追加済み |

| `app/mobile/native/ParaCodeWidgets/paracode-logo.png` | 新規追加（fork所有バイナリ）。`app/mobile/assets/pairing-logo.png` を `sips -Z 128` で縮小したコピー（gitignoreされた `ios/ParaCodeWidgets/` にも同一物を配置し、Widgetターゲットの Resources に pbxproj 手動登録済み） | Live Activity / Dynamic Island のロゴをホームタブのPCカードと同じPara Codeロゴにするため（`ParaCodeWidgetsBundle.swift` の LogoBadge が `UIImage(named:)` で読む。復元手順は同ディレクトリ README 参照）。PNGのためマーカーを埋め込めない |

`git log --grep '^para:'`（コミットメッセージからの追跡）と合わせた二重の安全網として運用する。新しくJSON/バイナリファイルに変更を加えた場合は、必ずこの表に1行追記すること（`CLAUDE.md`の「既存ファイルへの変更が避けられない場合」ルール参照）。

## CDPゲートウェイとリモートデバッグ（agentBrowser、2026-07-02追加）

ブラウザページ⇔ターミナルペイン紐付け機能（`src/vs/paradis/contrib/agentBrowser/`）に、chrome-devtools-mcp / browser-use 等の既存ブラウザ自動化MCPをCDPで直結させる**CDPゲートウェイ**を追加した（Superset `apps/desktop` の cdp-gateway / cdp-filter-proxy 方式の移植）。

- **生のリモートデバッグポート（要注意）**: `src/main.ts` のPARA-PATCHで、Electron本体が常に `--remote-debugging-port=0`（動的割当）+ `--remote-debugging-address=127.0.0.1` で起動する。実ポートは `<userDataDir>/DevToolsActivePort` の1行目に書かれる。**この生ポートはフィルタ無しで全webContents（ワークベンチウィンドウ本体を含む）にアタッチできる**。Chromiumのremote-debuggingは127.0.0.1にのみバインドされる（`remote-debugging-address` でも明示済み）ため同一マシン内に限定されるが、リモートからのポートフォワード等でこのポートを外部公開してはならない。argv.json / CLI でユーザーが `remote-debugging-port` を明示した場合はそちらが優先される
- **ゲートウェイ**: shared processのagent-browser HTTPサーバー（固定既定ポート `47286`、専有時のみ動的フォールバック＋警告ログ。実ポートは常に `<userDataDir>/paradis-browser-mcp.json`）が `/json/*`・`/cdp/json/*`（GET）と `/devtools/{browser,page}/…`・`/cdp/devtools/…`（WebSocket upgrade）を提供し、上流＝生ポートへのプロキシ時に「呼び出し元ペインにバインドされたページのtargetId（とその子孫）以外は見えない・触れない」フィルタを適用する。`/cdp` プレフィックス無しも受けるのは、puppeteerが `--browserUrl` のパスを落として `/json/version` をルート直下に取りに来るため
- **呼び出し元ペインの識別（3段構え）**: (1) URLクエリ `?pane=<token>`、(2) loopbackピアPID（macOS: `lsof`、Linux: `ss`→`lsof`、Windows: `Get-NetTCPConnection`→`netstat -ano`）の祖先チェーンからenv `PARA_CODE_TERMINAL_PANE_ID` を読む（macOS: `ps eww`、Linux: `/proc/<pid>/environ`。Windowsは不可）、(3) workbenchから同期される「シェルPID⇔トークン」表と祖先チェーンの突合（Windowsの主経路）。実機検証はmacOSのみ、Linux/Windows経路は未検証
- ターミナルenvには `PARA_CODE_CDP_URL=http://127.0.0.1:47286/cdp` が注入される（chrome-devtools-mcpの `--browserUrl` にそのまま渡せる。再起動を跨いで同一文字列）。MCPツール `get_cdp_endpoint` で実URLを取得できる

### chrome-devtools-mcp 対応改善（2026-07-03追加）

CDPフィルタプロキシ（`paradisCdpFilterProxy.ts`）に以下を追加した（変更はすべて `src/vs/paradis/contrib/agentBrowser/` 内で完結、upstreamファイルへの新規PARA-PATCHなし）:

- **take_screenshot委譲**: セッションスコープの `Page.captureScreenshot` は、対象がバインド済みprimaryページなら electron-main のupstream実装 `BrowserView.captureScreenshot()`（可視化キック + `capturePage(stayHidden)` + UnknownVizErrorリトライ + fullPage時のピンチズーム復元）へ `PARADIS_CDP_TARGET_CHANNEL` 経由で委譲し、`{ data: <base64> }` を合成して返す。WebContentsView非表示時（背面タブ/オーバーレイ/最小化）のサーフェスコピー失敗を回避。マッピング不能な組合せ（webp / fromSurface:false / clip.scale≠1 / clip+captureBeyondViewport併用=puppeteerの要素スクショ経路）と委譲失敗時のみ上流へ素通し
- **Input.*直前のフォーカス強制**: sessionId→targetId対応表を維持し、`Input.*` 転送直前に `webContents.focus()` を強制（Chromium内部フォーカスが別webContentsにあると合成入力がターミナルへ飛ぶElectron既知問題。Superset移植）
- **backgroundThrottling**: バインド確立時に `setBackgroundThrottling(false)`、アンバインド時（同ページが他ペインから未参照なら）trueへ復帰。非表示時のnavigate/wait_for停滞対策
- **denylist補強**: `Target.closeTarget` / `Page.close`（共有ビュー破壊防止、close_pageは非対応化） / `Page.setWebLifecycleState` / `Storage.clearDataForOrigin` / `Storage.clearDataForStorageKey` / `Storage.clearCookies` / `Network.clearBrowserCookies` / `Network.clearBrowserCache`（共有パーティション保護、lighthouse_auditの既定フロー対策）を常時拒否に追加。ページレベル透過プロキシもclient→upstream方向のみ同じdenylistを適用
- **resize_page明示エラー**: `Browser.getWindowForTarget` / `Browser.{get,set}WindowBounds` / `Browser.setContentsSize` はElectron未実装（-32601）を素通しせず、-32000で「ワークベンチがレイアウト管理するため非対応、ビューポート変更はemulateを使え」を返す
- **ガイダンス**: `get_cdp_endpoint` 応答に `limitations`（new_page/resize_page/close_page非対応等）を追加

**ツール対応マトリクス（コード根拠ベース、2026-07-03時点）**:

| 判定 | ツール |
|---|---|
| 動く | take_snapshot, wait_for, evaluate_script, navigate_page, list_pages, select_page, upload_file, list_network_requests, get_network_request, list_console_messages, get_console_message, take_heapsnapshot, emulate(CPU/network/UA/viewport), fill, fill_form, click, drag, hover, press_key, type_text（フォーカス強制済み）, take_screenshot（委譲実装済み。要素スクショのみ素通しフォールバック） |
| 条件付き/未検証 | handle_dialog（ElectronのJSダイアログ発火未検証）, performance_start/stop_trace, lighthouse_audit（多domain依存。ストレージ消去は拒否済みなので既定フローの一部が失敗する可能性）, emulate(geolocation)（Browser.grantPermissions依存） |
| 非対応（明示エラー） | new_page（Target.createTarget拒否）, close_page（Target.closeTarget拒否、Para Code UIから閉じる）, resize_page（emulateへ誘導） |

### エージェント通知hookの自動設置（agentBrowser、2026-07-03追加）

Claude Code / Codex の動作完了・要対応通知（Workspacesアイコン変化・通知音・Aivis読み上げ）の唯一の信号源は shared process の `GET /agent-hook` だが、これを叩くhookがどこにも設置されていなかった（Supersetの `setupAgentHooks()` 相当の移植漏れ）。`src/vs/paradis/contrib/agentBrowser/node/paradisAgentHooksSetup.ts`（fork所有）で自動設置を実装し、`ParadisAgentBrowserService` 起動時に冪等実行する:

- **`~/.para-code/hooks/notify.sh` を冪等生成**（0755）。`PARA_CODE_TERMINAL_PANE_ID` / `PARA_CODE_MCP_PORT_FILE` env が無ければ即 exit 0（Para Code外の全Claude/Codexセッションから呼ばれても無害）。あればポートファイルから port を読み、stdin JSON の `hook_event_name`（Claude）/ `type`（Codex notify）を grep/sed でパース（jq非依存）して `curl -s -m 3 ".../agent-hook?pane=$TOKEN&event=$EVENT" || true`。パース失敗時は黙って捨てる（誤った完了通知より安全）
- **`~/.claude/settings.json` へ冪等マージ**。登録イベント: SessionStart / SessionEnd / UserPromptSubmit / Stop / PostToolUse(matcher:*) / PermissionRequest(matcher:*) / Notification。**PreToolUse は登録しない**（permission に正規化されツール実行毎に誤通知になる）。自hookの識別マーカーはスクリプトパス（`.para-code/hooks/notify.sh`）+ 旧手動スニペット形式（`PARA_CODE_MCP_PORT_FILE` かつ `/agent-hook?pane=`）。既存のユーザーhook（Superset notify.sh / AGI_COCKPIT等）は構造ごと保持。**JSONパース失敗時は一切書き込まない**
- **`~/.codex/hooks.json` へ冪等マージ**（SessionStart / UserPromptSubmit / Stop。Supersetの `createCodexHooksJson` と同じ）
- hookコマンドは `$HOME` 参照の固定文字列（`[ -x "$HOME/.para-code/hooks/notify.sh" ] && ... || true`）なので dev/製品ビルドで同一・スクリプト未設置環境でも無害。イベント一覧・コマンド定義は `common/paradisAgentHooks.ts` に集約し、手動フォールバックの「Copy Agent Hooks Setup (Claude Code)」アクションも同一内容を生成する
- Windows は現状スキップ（notify.sh がPOSIX sh前提。必要になったらSupersetの notify.ps1 方式を移植）

あわせて二次問題2件を修正: (1) `paradisNotificationTrigger.contribution.ts` — スコープ未解決（Workspacesビュー未登録フォルダ/エディタ領域ターミナル）でも、ウィンドウが可視+フォーカス中でなければワークスペースフォルダ名をプレースホルダに音+OS通知+Aivisを発火（アイコン変化はスコープ概念依存のため対象外のまま）。(2) `paradisAgentStatus.contribution.ts` — アクティブスコープの review 即acknowledge に「ウィンドウが可視かつフォーカス中」条件を追加（非フォーカス時に通知トリガーの遷移検知を先食いして握り潰す競合の解消）。

## 機能1: ワークスペース即時切り替え（workspaceSwitch、2026-07-02追加）

`src/vs/paradis/contrib/workspaceSwitch/` に実装。単一ウィンドウ・単一 `.code-workspace`（identity固定）のまま `updateFolders` で folders を丸ごと入れ替え、エディタ/ターミナル/ブラウザの状態をリポジトリごとに退避・復元する（Superset方式: 破棄せず隠す）。実装時に判明した落とし穴:

- **`isSessionsWindow` は通常ウィンドウに転用不可（確定）**: フラグは `windowsMainService.ts:1599` で「開くworkspaceのconfigPathが `agentSessionsWorkspace` と一致するか」で自動決定され、trueだとHTMLエントリ自体が `sessions.html` に切り替わる。再起動スキップは `relauncher.contribution.ts` の early return への1行PARA-PATCH（`isParadisManagedWorkspaceWindow()`、module スコープのフラグ。DI注入はコンフリクト面が広がるため意図的に避けた）で解決
- **workspace id は configPath のみ依存**（`workspaces.ts` "IDENTIFIERS HAVE TO REMAIN STABLE"）。folders を何度入れ替えても WORKSPACE スコープ storage は同一。**必ずマルチルート状態で運用**（単一フォルダ状態から `updateFolders` すると `createAndEnterWorkspace` で別workspace化して状態が分断される。サービス側で WORKSPACE 状態を強制）
- **エディタ退避は upstream 純正の working set API**（`saveWorkingSet`/`applyWorkingSet`、雛形は `baseSessionLayoutController.ts`）。dirty エディタは閉じられず切り替え先へ持ち越される仕様（データ保護、確認ダイアログなし）
- **切り替え順序が重要**: `applyWorkingSet`（エディタ入れ替え）を `updateFolders` より**先**に行うこと。逆にすると Git 拡張のフォルダ削除処理（`extensions/git/src/model.ts` の `onDidChangeWorkspaceFolders`）が「可視エディタが使用中」と判定して旧リポジトリを close せず、SCMビューにリポジトリが残留する
- **ターミナルは park/unpark 方式**（`terminalGroupService.ts` にPARA-PATCHで非破壊 park/unpark を追加）。`moveToBackground` は2Dグリッドが空になると自己破棄するため使えない。**park中のグループはレイアウト永続化から漏れる**ため、`terminalService.ts` の `_saveState`（ptyHostへのレイアウト保存）と `_onWillShutdown`（リロード時のdetach対象）にも park 中グループを含めるPARA-PATCHが必須（これを怠るとリロードで退避中ターミナルが消える。`_saveState` はシャットダウン中スキップされるので「シャットダウン時に全unpark」では解決できない）
- **リロード後の再parkは保存済みマッピング（persistentProcessId→リポジトリID）を起動時に一度だけ読む**こと。グループ出現のたびに読み直すと、起動直後の一律タグ付けの persist が正しい対応を上書きして repark が効かなくなる
- **ブラウザは dispose veto + 同一idの getOrCreateLazy で無リロード復帰**: `BrowserEditorInput.onBeforeDispose` の veto（upstream純正フック）を切り替え中(`isSwitching`)だけ効かせると、input と WebContentsView が `_known` に生存したまま。working set 復元時に serializer が同一idを `getOrCreateLazy` して生きた実体へ再接続する（`window.__marker` 一致で無リロードを実証）。ユーザーの手動クローズは veto しない（正しく破棄される）
- **ビュー登録の罠**: `registerViews` の `openCommandActionDescriptor.id` に `<viewId>.focus` を指定してはいけない（ビュー登録が自動生成する focus コマンドと衝突して **workbench 全体が起動不能**になる）
- **キーバインド**: mac の `ctrl+cmd+1`/`ctrl+cmd+9` は upstream の Move Editor into First/Last Group と衝突するため weight +1 で上書き（1〜9の一貫性を優先）。切り替えは `ctrl+cmd+1..9` / `ctrl+cmd+[` `]`（win/linux: `ctrl+alt+…`）
- **SCMコミットメッセージ入力**はリポジトリ close で消える唯一の transient 状態。`onWillSwitchRepository` で退避し、Git再スキャン完了（`onDidAddRepository`）を待って復元する
- 既知の制限: ブラウザページはウィンドウリロードを跨ぐと再ロードされる（WebContentsViewがウィンドウに紐づくため。URLはworking set経由で復元）。ブラウザのCookieパーティションは全リポジトリ共有。2Dグリッドの正確な比率はpark/unparkでは保持されるがウィンドウリロードでは1D劣化（機能2の既知の制約と同じ）

## リリース手順（runbook、2026-07-03確立・v1.128.0-paracode-2で全自動を実証済み）

新しいリリースを出すのに必要な操作は**タグを打ってpushするだけ**:

```bash
git tag -a v1.128.0-paracode-3 -m "para: v1.128.0-paracode-3"   # 番号をインクリメント
git push origin v1.128.0-paracode-3
```

これで `.github/workflows/para-release.yml` が起動し、以下がすべて自動で走る（所要40〜60分）:
1. 5プラットフォーム（darwin x64/arm64・win32 x64/arm64・linux x64）のビルド。macのみコード署名+公証、Windowsは現状無署名
2. publishジョブが成果物をR2（S3互換APIでアップロード）→ 更新フィードKVにメタデータ書き込み（この順序厳守: 先にオブジェクト、後にメタ）
3. 完了した瞬間から、既存インストールの次回更新チェック（起動時または1時間毎）で自動アップデートが配信される

**ルール・注意**:
- タグ名は `v{upstreamバージョン}-paracode-{N}` 形式。`package.json`のversionは**触らない**（`+paracode.N`等のサフィックスはvsce/hygieneが拒否する。詳細は下記の試行1の記録）
- タグは**push済みのcommit**に打つこと。ビルド失敗でタグを付け直す場合は `git tag -d <tag> && git push origin :refs/tags/<tag>` で消してから再作成（このワークフローはタグの上書きを検知しない）
- 進捗確認: `gh run list --workflow=para-release.yml`、失敗調査: `gh run view <id> --log-failed`
- 単一プラットフォームだけ再検証したい場合: `gh workflow run para-release.yml -f platforms=win32`（`darwin`/`linux`も可、カンマ区切り。publishはスキップされる）
- リリース後の動作確認（フィードが新commitを配信しているか）:
  ```bash
  # 1つ前のリリースのcommitを名乗って照会 → 新commitのURLを含むJSONが返ればOK（要Accessヘッダー、値はGitHub Secrets参照）
  curl -H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..." \
    "https://paracode-updates.paradis.ltd/api/update/darwin-arm64/stable/<旧commit>"
  ```
- publishだけ失敗した場合（ビルドは成功）: CIを回し直さず、成果物を `gh run download <run-id>` でローカルに落として手動publishできる。手順は下記「リリース完了（2026-07-03）」の記録参照（S3クレデンシャルはCF APIトークンから導出: access key=トークンid、secret=トークン値のSHA-256）

## 配布・自動アップデート基盤（2026-07-03着手）

win/mac/linuxへの配布と自動アップデートの実装。設計の経緯・判断根拠（Cloudflare Access範囲、R2直送を選んだ理由、mac/win署名コスト比較等）はこのセッションの会話ログ参照。ここには実装状態と再開に必要な情報のみ記す。

**方針**: GitHub Actions（`.github/workflows/para-release.yml`、fork所有）でビルド・パッケージング → macのみ署名・公証 → Cloudflare R2へ成果物を直送（設計当時はprivate repoで、GitHub Releasesの`browser_download_url`が未認証404になるため配布経路にしなかった。現在のリポジトリはpublic） → Cloudflare Workers（`cloudflare/update-server/`、fork所有）がKVを引いて更新フィードAPIを返す。フィードAPIのみCloudflare Accessのサービストークンで保護し、R2アセットは非推測パス（`{quality}/{platform}/{commit}/...`）でヘッダーなし公開（macOSのSquirrel.Macがフィード用headersをアセットDLへ転送しない前提のため。R2アセット公開のみで個人認証はしない＝カジュアルアクセス遮断程度の割り切り）。

**実装済み**（以下はコード実装時点の記録。Cloudflare側の反映状況は後続節を参照）:
- `src/vs/base/common/product.ts`: `updateAccessClientId`/`updateAccessClientSecret`フィールド追加（PARA-PATCH）
- `product.json`: `quality: "stable"` / `updateUrl` / `downloadUrl` 追加。`updateUrl`は`https://paracode-updates.paradis.ltd`（カスタムドメイン、動作確認済み。旧`*.workers.dev`のURLからの切り替え履歴は下記参照）。`downloadUrl`のみ`https://updates.paradis.ltd/download`の暫定プレースホルダーのまま（実在しない。ドメインの一貫性も無いので要修正、NOTES.md表の該当行も参照）
- `build/gulpfile.vscode.ts`: `productJsonStream`に、環境変数`PARA_UPDATE_ACCESS_CLIENT_ID`/`PARA_UPDATE_ACCESS_CLIENT_SECRET`が存在する場合のみ`updateAccessClientId`/`updateAccessClientSecret`をproduct.jsonへstampするPARA-PATCH（`agentSdks`スタンプと同じパターン）。ローカル/PRビルドでは常に未設定＝ヘッダー無し
- `src/vs/platform/update/electron-main/abstractUpdateService.ts`: 新規`export function getUpdateAccessHeaders(productService)`を追加（既存`getUpdateRequestHeaders`のシグネチャは不変）。`isLatestVersion()`内の1箇所をPARA-PATCHでマージ
- `updateService.win32.ts`（1箇所）/ `updateService.darwin.ts`（`buildUpdateFeedUrl`と`checkForUpdateNoDownload`の2箇所）/ `updateService.linux.ts`（従来headers未送信だったため新規追加）: いずれも`getUpdateAccessHeaders`をPARA-PATCHで配線済み
- `cloudflare/update-server/`: `GET /api/update/:platform/:quality/:commit`を実装するWorker（`src/index.ts`）。KVスキーマは`{quality}:{platform}`キーで`IReleaseRecord`（commit/version/productVersion/url/sha256hash/timestamp）を格納。`npm run typecheck`通過確認済み
- `.github/workflows/para-release.yml`: tag push(`v*`)/手動dispatchで3プラットフォームをビルド。mac署名は`build/darwin/sign.ts`をそのまま再利用（`AGENT_TEMPDIRECTORY`/`VSCODE_ARCH`/`CODESIGN_IDENTITY`必須）+ `notarytool`公証。**Windowsは意図的に無署名**（SmartScreen警告・AV誤検知リスクは許容、Azure Trusted Signingは後続フェーズ）。publishジョブがR2アップロード→KV更新の順で実行（メタ先行によるURL 404を防ぐため）。**ワークフローが参照する13個のGitHub Actions secretsはすべて登録済み**（2026-07-03、下記参照）。tag pushによる全自動実行は`v1.128.0-paracode-2`で実証済み

**Cloudflareデプロイ先アカウント側（2026-07-03、ユーザー許可の上で実施）**:
- KV namespace: `para-code-update-releases`。**namespaceの命名について**: 当初は汎用名で作成したが、複数プロジェクトが同居するアカウントで識別しにくいため、空のまま削除してプロジェクト名付きで作り直した。**教訓: 複数プロジェクトが同居するCloudflareアカウントでは、KV/R2/Worker等のリソース名に最初からプロジェクトプレフィックス（`para-code-`）を付けること**。wrangler.tomlの`binding`名（`RELEASES`）はWorkerコード内だけのローカルな参照なので、この問題とは無関係（変更不要）
- R2バケット: `para-code-releases`を作成済み。匿名公開（`dev-url enable`）も実施済み。**公開URL: `https://pub-753b4bcb636d45bfad234cefc4414031.r2.dev`**（存在しないキーへのGETは404、一覧性は無いことを確認済み）。GitHub Actions secrets登録時、`CF_R2_PUBLIC_BASE_URL`にこの値をセットする
- Worker: `para-code-update-server`をデプロイ済み。既定URLに加え、カスタムドメイン`https://paracode-updates.paradis.ltd`をCustom Domain機能（`wrangler.toml`の`[[routes]] pattern = "paracode-updates.paradis.ltd", custom_domain = true` → `wrangler deploy`）で紐付け済み。同一アカウント内のゾーンであることを確認し、カスタムドメインの`/api/update/darwin-arm64/stable/<commit>`へ疎通確認済み。サブドメインは`updates.paradis.ltd`ではなく`paracode-updates.paradis.ltd`（KV namespace命名の教訓と同じ理由でプロダクト名プレフィックスを採用）

**GitHub Actions secrets（2026-07-03、このリポジトリに全13個登録済み）**:
- `CF_ACCOUNT_ID` / `CF_API_TOKEN`（トークン名: `para-code-deploy`。`/user/tokens/verify`でactiveと確認済み） / `CF_R2_BUCKET` / `CF_R2_PUBLIC_BASE_URL` / `CF_KV_NAMESPACE_ID`
- `APPLE_TEAM_ID` / `APPLE_CODESIGN_IDENTITY` / `APPLE_CERTIFICATE_P12_BASE64` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`（値はGitHub Secretsのみに保持。ここには書かない）
- `PARA_UPDATE_ACCESS_CLIENT_ID` / `PARA_UPDATE_ACCESS_CLIENT_SECRET`（Service Token名: `para-code-update-client`、Non-expiring。Access Applicationは後続節のとおり設定・動作確認済み）
- 署名証明書とパスワードはGitHub Secretsでのみ管理し、ローカルの保存先・ユーザー名・キーチェーン情報は公開リポジトリへ記録しない

**Cloudflare Access Application（2026-07-03、完了）**:
- ダッシュボードではなく、Cloudflare API（`curl`、一時的に発行した`Access: Apps and Policies`+`Access: Service Tokens`権限のAPIトークン経由）で作成した。`wrangler`はAccess関連のリソースを一切扱えないため不可避
- Application: domain `paracode-updates.paradis.ltd/api/update`（ドメイン全体ではなくパスを絞った。内部IDは公開文書へ記録しない）
- Policy: `decision: "non_identity"`（ダッシュボードの「Service Auth」に相当するAPI上の値）、`include`に`para-code-update-client`のservice token idを指定（内部IDは公開文書へ記録しない）
- **service tokenの内部id（policyのinclude用）はclient_id（`xxxx.access`の`xxxx`部分）とは別物**。`GET /accounts/{id}/access/service_tokens`で引く必要があり、`Access: Service Tokens`権限が別途要る（`Access: Apps and Policies`だけでは403になる）。素朴に「client_idの先頭部分をid扱いする」のは誤り（実際に一度失敗した）
- 動作確認済み: 認証ヘッダー無し→403、正しい`CF-Access-Client-Id`/`CF-Access-Client-Secret`付き→204
- **副産物（意図せず発生、結果的に必要な修正）**: カスタムドメインroute追加時に`workers_dev`を明示していなかったため、`para-code-update-server.cloudflare8234.workers.dev`側が自動的に無効化された（Cloudflareエラー1042）。**これは望ましい**——もし無効化されていなければ、Access保護はカスタムドメイン経由のみに効き、旧workers.dev URLからAccessを完全に迂回できてしまうところだった
- Access設定用に発行した一時APIトークン（`para-code-for-setting-temp`）は、今後Applicationやポリシーを変更しない限り不要。ユーザー側でCloudflareダッシュボードから削除するかの判断待ち（エージェント側からは削除しない）

**残件**:
- `downloadUrl`のドメイン不一致（`updates.paradis.ltd` vs 実際に使っている`paracode-updates.paradis.ltd`）の解消。まだ実在するページが無いため後回し中

**リリースワークフロー試行の記録（2026-07-03、複数回の失敗→原因特定・修正済み）**:

試行1（tag `v1.128.0+paracode.1`、run 28630772747、全ジョブ失敗）:
- **バージョン採番の教訓**: semver build metadata方式（`1.128.0+paracode.1`）は理論上正しいが、このリポジトリでは2重に不採用となった。(1) `build/hygiene.ts`の`checkCopilotEnginesVersion`がroot package.jsonと`extensions/copilot/package.json`の`engines.vscode`の完全一致を要求する。(2) それを合わせても、`build/node_modules/@vscode/vsce/out/validation.js`の`validateEngineCompatibility`の正規表現が`-`サフィックスのみ許可で`+`(build metadata)を弾き、darwin/win32のパッケージング中にvsce（`fromLocalEsbuild`→`vsce.listFiles`のmanifest検証）が落ちる。**結論: package.jsonはupstreamのプレーンなバージョンのまま触らず、fork独自リリースの識別はgitタグ名のみで行う**（タグ形式: `v1.128.0-paracode-1`。更新フィードはcommitハッシュ比較なのでバージョン文字列は表示専用）
- linux: `npm ci`が`kerberos`ネイティブモジュールのビルドで失敗（`gssapi/gssapi.h`欠落）→ `pr-linux-test.yml`と同じ`libkrb5-dev`等のapt installステップを追加して解決

試行2（tag `v1.128.0-paracode-1`、run 28631291130、darwin-x64のみ成功=署名・公証込みで成功実績あり）で判明した3つの新しい問題と対処:
1. **win32（両arch）**: 2026年6月のGitHub公式移行で`windows-latest`が`windows-2025-vs2026`イメージ（VS 2026搭載）になり、upstream `build/npm/preinstall.ts`の`hasSupportedVisualStudioVersion()`（VS 2022/2019のみ許可）が失敗する。**対処: `runs-on: windows-2022`に固定**（GitHubの公式案内どおり。windows-2022はLTSポリシーで当面維持される）。upstreamのファイルは無改変
2. **linux**: `.deb`生成の`dpkg-shlibdeps`スキャンが`VSCode-linux-x64/bin/para-code-tunnel`（Rust製トンネルCLI、`cli/`のcargo bin `code`）を必須として要求（`build/linux/dependencies-generator.ts`にハードコード）。upstreamは別パイプライン（`build/azure-pipelines/cli/cli-compile.yml`）でビルドして配置している。**対処: ワークフローにrustupインストール→`cargo build --release --bin=code`（`VSCODE_CLI_PRODUCT_JSON`指定）→`bin/para-code-tunnel`へ配置、を追加**。加えて`dependencies-generator.ts`の`FAIL_BUILD_FOR_NEW_DEPENDENCIES`を`false`にPARA-PATCH（依存リストがupstreamのMS基準環境の参照リストと完全一致しないとビルド失敗する仕組みで、GitHubランナー上のfork buildでは恒久的に成立しないため警告化。副作用として生成される.debの`libc6`要求バージョンがランナーのglibc（ubuntu-24.04=2.39相当）に引き上がる=古いディストロでは.debがインストール不可な点は許容）
3. **darwin-arm64のみ**: パッケージ済みアプリ内の`extensions/copilot/node_modules/@github/copilot/sdk`が見つからず`prepareBuiltInCopilotRipgrepShim`で失敗。徹底調査の結果: (a) 同一runで**x64は署名・公証込みで完全成功**、(b) 両ジョブの`npm ci`ログはパッケージ数まで完全一致（ソースツリー同一）、(c) ローカル（同じarm64 mac）で`compile-copilot-extension-build`を実行するとsdkは正しく出力される、(d) `npm_config_arch`はoptional dependencyのcpu選択に影響しないことを実験で確認（platform package `@github/copilot-darwin-arm64`は両ジョブとも同じものが入る）。対処: ワークフローに「npm ci直後のSDK存在検証（fail-fast）」と「パッケージング失敗時の3層診断ダンプ（ソース/.build/アプリ内のそれぞれの@github配下）」を追加し、再発時に即座に切り分けられるようにした。`workflow_dispatch`に`platforms`入力（例: `darwin`だけ再実行）も追加してイテレーションコストを削減

試行3（tag付け直し、run 28633263239、**linux成功（CLI修正が有効）**・darwin-x64成功2回目）で残り2問題の根本原因が確定・修正済み:
1. **darwin-arm64（試行2の再発、今回は診断で原因確定）**: 3層診断の結果、ソースは正常・**`.build/extensions/copilot`は診断時点(02:02)ではsdk含め完全**・アプリ内だけsdk欠落、かつ`compile-copilot-extension-build`タスクは01:59:29に完了報告済みなのにパッケージング(02:01:31開始)が取りこぼす、という物証が揃った。**根本原因: `packageCopilotExtensionStream`（`build/lib/extensions.ts`）が拡張バンドルと production node_modules コピー（実測70秒かかる大容量コピー）を`es.merge()`で1本のストリームに束ねており、マージ後のストリームの完了シグナルが依存関係コピーの実書き込み完了より先に発火し得る**（gulpタスクは完了扱い→同一プロセス内の後続packageTaskが書き込み途中の`.build`をglobで読む）。x64ジョブやローカルで再現しなかったのは純粋にタイミング依存のため。upstreamのCIはこのコードパスを使わない（copilotはVSIXダウンロード。「non-CI local builds」用のパス）ので上流では顕在化しにくい。**修正: PARA-PATCHで2つの逐次gulpパイプラインに分割**（`bundle-copilot-extension-build`→`copy-copilot-extension-dependencies-build`、それぞれのdest完了を個別にawait。`build/lib/extensions.ts`+`build/gulpfile.extensions.ts`）。ローカルで分割後の動作とsdk出力を確認済み
2. **win32（両arch、VS2022ランナー修正で前進した先の新問題）**: `package-win32-{arch}`が`gulpfile.vscode.ts`の`quality === 'stable'`分岐で`product.win32ContextMenu![arch]`を非nullアサーション参照して`TypeError: Cannot read properties of undefined`。`win32ContextMenu`（Windows 11エクスプローラのコンテキストメニュー統合のCLSID）と対応するappxアセット（`.build/win32/appx`、explorer command DLL）は**Microsoftの内部distro mixin/パイプラインだけが供給するもので、fork には存在しない**。さらに同じ問題が`gulpfile.vscode.win32.ts`のInno Setup定義（`AppxPackageName`を#defineすると`code.iss`が`skipifsourcedoesntexist`なしでappxファイルを参照→ISCCが失敗）にも潜んでいた。**修正: 両箇所とも`quality`条件に`product.win32ContextMenu`の存在チェックをPARA-PATCHで追加**（fork ではエクスプローラ統合を単に無効化。本体機能に影響なし）

試行4（run 28634483948）: **darwin両arch（ストリーム分割修正が有効と実証）とlinuxが成功**。win32のみ次の層で失敗:
- `patchWin32DependenciesTask`の`stripAuthenticodeSignature`（MSの再署名前に既存Authenticode署名を剥がす工程）が`signtool.exe`をspawnするが、GitHub HostedランナーではWindows SDK内にあるだけでPATHに無く`ENOENT`。無署名配布のforkには署名剥がし自体が不要なので、**`hasAuthenticodeSignature`のspawnエラーがENOENTの場合「署名なし」として扱うPARA-PATCH**で修正済み（commit 65fe25af1ab）。なお`code.iss`の`SignTool=esrp`は`#ifdef Sign`（`--sign`フラグ時のみ）なので無署名ビルドには無害と確認済み
- **win32単独の検証runを`workflow_dispatch platforms=win32`で試行したところ、GitHub Actionsの支払い上限到達で起動不可**（macOSジョブ=分数10倍消費のフルランを4回実行したため）→ リポジトリをpublic化して解消（ユーザー判断。public化前に単語「Paradis」「社内」の除去を実施、commit d33785a4beb）

**リリース完了（2026-07-03、`v1.128.0-paracode-1` = commit 674411c1829）**:
- public化後のwin32検証で2層の追加修正: (1) `patchWin32DependenciesTask`のrcedit が copilot拡張同梱の`@anthropic-ai/claude-agent-sdk/vendor/audio-capture/arm64-darwin/audio-capture.node`（Mach-O）を処理できず失敗 → **MZヘッダの無いファイル（非PE）をスキップするPARA-PATCH**（`gulpfile.vscode.ts`）。(2) ワークフローのsha256収集ステップのパス誤り（Inno Setup出力は`.build/win32-<arch>/user-setup/`、`../VSCode-win32-<arch>-user/`ではない）
- **フルラン（run 28654273918）で史上初の全5ビルドジョブ成功**（darwin×2は署名・公証込み）。publishジョブのみ失敗: **`wrangler r2 object put`は300MiB上限**があり、全成果物（315〜336MB）が超過
- **回避策 兼 恒久修正: R2のS3互換API（マルチパート、サイズ上限実質なし）を使う。CloudflareのAPIトークン（R2 Write権限付きなら何でも）はそのままS3クレデンシャルになる: access key id = トークンのid（`/user/tokens/verify`で取得）、secret access key = トークン値のSHA-256 hex**。aws cliは`AWS_DEFAULT_REGION=auto`と`AWS_REQUEST_CHECKSUM_CALCULATION=when_required`を設定。ワークフローのpublishステップはこの方式に書き換え、`v1.128.0-paracode-2`で全自動publishを実証済み
- 初回リリース自体は、run 28654273918の成果物（sha256検証済み）をローカルにダウンロードし、aws s3 cpでR2へアップロード → `wrangler kv key put`でメタデータ書き込み、という手動publishで完了。**落とし穴: ローカルwranglerはOAuthで複数アカウントが見えるため、`CLOUDFLARE_ACCOUNT_ID`環境変数を指定しないと非対話モードでエラーになる（しかも当初これをパイプで握りつぶして書き込み成功と誤認した。wranglerの成否は必ず出力全体で確認すること）**
- E2E検証済み: 旧commit照会→更新JSON（全5プラットフォーム）、最新commit照会→204、無認証→403、フィードの`url`から実バイナリ取得（zipマジックナンバー確認）
- dependabot PR 2件（actions/cache 5→6、actions/checkout 6→7）もsquashマージ済み（upstream由来ワークフローへの変更なので将来の取り込みで軽微なコンフリクトの可能性あり）
- **SDKの実体に関する知見**: `@github/copilot`のnpmパッケージ本体は`npm-loader.js`のみの空殻で、`sdk/`等の実体は`extensions/copilot/script/postinstall.ts`（`materializeCopilotCliSdkLayout`）が`process.arch`で選ばれたplatform package（`@github/copilot-darwin-arm64`等）からコピーして生成する。パッケージング時は`.build/extensions/copilot`経由で（`packageCopilotExtensionStream`の`getProductionDependencies`ストリーム）アプリに入る
- GitHub Actions側のsecrets登録一式（Apple署名・公証用6種、`CF_API_TOKEN`/`CF_ACCOUNT_ID`/`CF_R2_BUCKET`/`CF_R2_PUBLIC_BASE_URL`/`CF_KV_NAMESPACE_ID`/`PARA_UPDATE_ACCESS_CLIENT_ID`/`_SECRET`）。具体値はGitHub Secretsとデプロイ設定で管理し、公開文書へ重複記載しない

**当時の次アクション（履歴）**: GitHub Actions secrets登録 → Access Application作成 → 実リリースでのE2E確認。secrets登録と初回リリースのE2E確認は上記のとおり完了済み。

## モバイルリレー: Cloudflare Workers/DOデプロイ（2026-07-05）

「Para Code Mobile」（iPhone遠隔操作機能、`src/vs/paradis/contrib/mobileRelay/`）がPCとモバイルの間を中継するリレーサーバー（`app/relay/`、Cloudflare Workers + Durable Objects）を、開発時のプレースホルダーURLのまま放置していたのを本番デプロイした。設計・実装の詳細は設計書（`app/design/mobile-design.md`）参照。ここには配置場所と再開に必要な情報のみ記す。

- **デプロイ先**: 上記の更新配信基盤と同じCloudflareアカウント。ユーザーが明示的に指定して選定
- **デプロイ済みURL**: `wss://para-mobile-relay.cloudflare8234.workers.dev`（`app/relay/`の既定`workers.dev`サブドメイン。カスタムドメインは未設定）。PC側の既定値`PARADIS_MOBILE_DEFAULT_RELAY_URL`（`src/vs/paradis/contrib/mobileRelay/common/paradisMobileRelay.ts`）をこの実URLに更新済み。**それ以前は`wss://para-mobile-relay.paradis.workers.dev`という、実際には一度もデプロイされたことのないプレースホルダーURLのままだった**（セルフホスト設定`paradis.mobile.relayUrl`で上書きしない限り、初回起動時のペアリングが到達不能で必ず失敗する状態だった）
- **account_id固定**: `app/relay/wrangler.jsonc`に`"account_id": "979dbe0328e903a34bb6291b06cca0da"`を追記（PARA-CODEコメント付き）。複数Cloudflareアカウントを持つユーザーの環境では、これが無いと`wrangler deploy`が「More than one account available」で失敗する
- デプロイVersion IDはCloudflare側で確認し、公開文書へ固定値を記録しない
- デプロイ確認: `curl -X POST https://para-mobile-relay.cloudflare8234.workers.dev/device/new/provision`が200 `{"ok":true,"deviceId":"..."}`を返すことを確認済み
- DeviceDO（SQLite-backed、`app/relay/wrangler.jsonc`の`migrations`で`new_sqlite_classes`指定）は初回デプロイ時に自動でマイグレーションされる。以降の再デプロイでスキーマ変更が必要な場合は`migrations`に新しい`tag`エントリを追加すること

## Codexペインapp-serverのWindows対応（loopback ws方式、2026-07-21）

macOS/Linuxの「ペインごとのCodex app-server」（`resources/paradis/bin/codex`のshランチャー + `unix://`ソケット）はWindowsでは使えないため、Windowsだけ別トランスポートで同等機能を実装した。判断根拠はすべてWindows 10.0.26100 / codex-cli 0.144.6 実機での事前調査に基づく。

- **`unix://`を使わない理由**: codex（Rust）自体はWindowsのAF_UNIXで待ち受けできるが、接続側のPara Code shared process（Node/libuv）がWindowsのAF_UNIX接続を未サポートのため、モバイル連携が成立しない。よってWindowsは `--listen ws://127.0.0.1:0`（動的ポート）一本
- **認証**: loopbackでも `--ws-auth capability-token` は有効（実測）。capability tokenには**ペイントークン（`PARA_CODE_TERMINAL_PANE_ID`）をそのまま流用**し、app-serverには `--ws-token-sha256 <hex>` でダイジェストだけを渡す（平文トークンはディスクへ書かない。ポートを記載するendpointファイルに秘密は含まれない）。接続は `Authorization: Bearer <ペイントークン>`。トークン無しはWebSocket upgrade時に401
- **構成**: ランチャーは `codex.cmd`（cmd用）/`codex.ps1`（PowerShell用）の薄い入口 + `paradisCodexPaneLauncher.cjs`（本体）。JSの実行体は**PATH上の`node.exe`を最優先**し、無い場合のみ `PARA_CODE_CODEX_LAUNCHER_NODE`（Para Code自身のexe）+`ELECTRON_RUN_AS_NODE=1` へフォールバックする。**Para Code exeを常用してはならない（2026-07-22実機で発覚）**: WindowsのElectronはGUIサブシステムのため、シェルが待たずに即復帰し、コンソールが継承されず対話TUIが `stdin is not a terminal` で死ぬ。npmでcodexを入れた環境にはnode.exeが必ずあるので、実運用ではフォールバックにほぼ落ちない。`.cmd`は`call`を使わずexeを直接呼ぶ（`call ... %*`は埋め込み引用符・`&`で引数が壊れることを実測済み）。実ポートは `userData\pcx\<token>.endpoint.json` に書き、shared process（`paradisCodexLiveClient`）がそれを読んで `ws://127.0.0.1:<port>` へBearer付きで直接続する
- **実Codexの解決**: PATHからランチャー自身のディレクトリを除外した上で、`codex.exe`直接 → npmインストールのvendored `codex.exe`を探索 → `node_modules/@openai/codex/bin/codex.js`を自Nodeで実行 → 拡張子なし`codex`（非Windowsのdev/test用）の順。**vendored exeをcodex.jsより優先するのは必須**: codex.jsは`process.arch`でネイティブパッケージを選ぶため、自Node（Para Code exe）とnpmのNodeのアーキが異なる環境（例: Windows ARM上でarm64 Para Code + x64 Node）では「Missing optional dependency @openai/codex-win32-arm64」で即死する（2026-07-21実機で発生）。x64のvendored exeはARM64 Windowsのエミュレーションでそのまま動く
- **黒窓の罠（2026-07-22実機で発覚）**: app-serverを`detached`/`windowsHide`でコンソール無し起動すると、app-serverがspawnする各MCPサーバー（コンソールアプリ）が自前のコンソールを確保して黒いウィンドウが乱立する。app-serverはターミナルのコンソールを共有して起動すること（タブを閉じたときの自動道連れという利点もある。TUIがraw modeの間はCtrl+CがコンソールイベントにならないためCtrl+C巻き添えは実用上問題にならない）
- **後始末**: TUI終了時にランチャーが所有するapp-serverをkill（Windowsは`taskkill /T /F`）。Windows Terminalのタブ閉じはNodeがSIGHUP（CTRL_CLOSE_EVENT）として受けるためそこでも掃除する。それでも残った孤児は「pidが死んでいるendpointファイルの起動時sweep」と「同一ペインの次回起動時のowner死亡検出→採用(adopt)→終了時掃除」で回収する
- **梱包**: `build/gulpfile.vscode.ts` で win32 のみ `.cmd`/`.ps1`/`.js` の3点を、非win32はshランチャーのみを同梱（PARA-PATCH済）

## ビルド環境（macOS / Apple Silicon）

- Node: `.nvmrc`が指定する`24.17.0`を`mise`でプロジェクト固定（`mise.toml`）。システムのNode（v26.3.0）とは別
- 依存関係: `mise exec -- npm install`（約7分、1559パッケージ、致命的エラーなし）
- 開発起動: `mise exec -- bash scripts/code.sh`（初回はElectronダウンロード+コンパイルで時間がかかる。起動確認済み: 2026-07-01）

## 今後の方針候補（未確定、要議論）

- 優先実装ターゲットの選定（機能1〜3のうちfork版でしか解決できない部分から着手すべきか）
- ブランディング（`product.json`のnameShort/nameLong/アイコン等、名称は「Para Code」）
- ~~配布方式（Marketplace代替のOpen VSX方針、CI/署名/配布）~~ → 実装着手済み。詳細は「配布・自動アップデート基盤」セクション参照
