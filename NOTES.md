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
- **現在のツリーが対応するupstreamコミット: タグ `1.132.0`**（2026-08-11のsquashマージ `para: merge upstream 1.132.0` で取り込み済み。1.131.0は飛ばして1.130.0から直接1.132.0へ。それ以前のベースは `1.130.0` → `1.129.0` → upstream `7ad5744c6852a42e070b6d6045e3e1215cc120fd`＝1.128系）。次回のupstream取り込み手順: (1) `git fetch upstream --tags` (2) `git replace --graft <1.132.0を取り込んだsquashコミット> <その実親> 1.132.0` で「squashコミットが1.132.0を第2親に持つマージコミットだった」とローカルに教える（replace refはpushされないためリモートには影響しない） (3) `git merge --squash <新タグ>` で3-wayマージ→解消→`para: merge upstream <新タグ>` でコミット (4) `git replace -d`で後片付けし、この行を新タグで更新する。1.129取り込み時の実績: コンフリクト10ファイル/20hunk。1.130取り込み時の実績: コンフリクト9ファイル（うち5件はfork変更を含まない）。1.132取り込み時の実績: コンフリクト20ファイル（うち4件はfork変更を含まない=1.130 endgame由来）、解消方針の詳細はgit log参照。**マージ前に必ず監査（下記「upstream取り込み前監査」）とマージ後のtypecheck/valid-layers-check/意味的レビューを行うこと**
- **リリースタグを起点にマージすると、マージベースは前回タグそのものにはならない**（release/1.129 と release/1.130 は main から別々に枝分かれするため、`git merge-base` は分岐点＝1.130取り込み時は `be6ed528a43` を返す）。この結果、**前回タグの endgame チェリーピックが「fork側の変更」として扱われ、upstreamが次リリースで別の結論を出した箇所が半端にマージされる**。1.130取り込みでは `editorResolverService.ts` の `markdownDefaultEditorInAgentsWindow` が「コメントは1.130（Defaults to on.）、値は1.129 endgame（false）」という矛盾状態になった（upstream追従＝`true` で解消）。検出手順: `git diff --name-only <新タグ>...<前回タグ>` で endgame が触ったファイルを列挙し、`git diff --cached --name-only <新タグ> -- <それら>` に fork変更ファイル以外が出てこないか確認する。**1.132取り込みでも同じ罠を踏んだ**: `agentSideEffects.ts` で1.130 endgameが足したブロックと1.132本体のブロックが「どちらもfork側/upstream側の追加」と見なされ、コンフリクトにならないまま**同じ処理が2回並ぶ状態で自動マージされた**（fork変更ゼロのファイルなので1.132.0で上書きして解消）。コンフリクトした4ファイル（`telemetryServiceImpl.ts` / `agentService.test.ts` / `runInTerminalTool.ts` とそのtest）も全て同じ由来。**検出手順（必須）**: `git diff --name-only <新タグ>...<前回タグ>` でendgameが触ったファイルを列挙し、マージ後にそれぞれ `git diff <新タグ> -- <file>` が「fork変更のみ」になっているか確認する。fork変更が無いファイルで差分が出たら endgame の半端マージなので `git checkout <新タグ> -- <file>` で潰す

## upstream取り込み前監査の記録（2026-07-18、1.129取り込み準備）

1.129取り込み準備中に、ベースコミット（上記`7ad5744c685`）との全差分をマーカーと突き合わせる監査を実施した。結果と対処:

- upstream由来ファイルへのfork変更153ファイルのうち、**32個の.tsファイルにPARA-PATCHマーカーが無かった**。全て`para:`プレフィックスも無い一連のコミット由来（`ff54c8f7aa5` fix: harden Para Browser MCP isolation and recovery / `e07c045da85` fix: preserve terminal recovery and workspace ownership / `8f9c774d82f` fix: harden mobile relay routing and recovery / `b22aec2a71c` feat: pin auxiliary windows to spaces / `ae344defc3d` feat: scope unsaved editors to spaces / `fcbac0e0e4c` feat: optionally open a terminal when splitting editors / `fb3726df103` fix: make scoped retirement crash-safe / `e7ec0beb0a9` feat: add automatic Codex terminal titles / `478af1a1ea8` fix: redraw terminals after window moves）
- 対処: 32ファイル全てにPARA-PATCHマーカーを後付けした（コメント行のみ121行追加、挙動変更なし、typecheck-client通過）。コミットプレフィックス違反の過去履歴は書き換えない（force push回避）。**今後のコミットは必ず`para:`プレフィックスを付けること**
- 判明した副次的な問題: terminal系のupstream由来ファイル（`terminal.ts`等）のフィールド説明コメントに`PARA-CODE:`マーカーが使われている箇所がある。`PARA-CODE`は「fork新規作成ファイル全体」用のマーカーなので、`grep -rl "PARA-CODE:"`のfork所有ファイル一覧に誤って載る。将来の整理候補（実害は小さいので未修正）
- 監査の再現方法: `git diff --name-status <ベースコミット> HEAD` でM（変更）ファイルを列挙し、各ファイルの`PARA-PATCH`有無をgrep。コメント不能ファイルは本ファイルの台帳と突き合わせる

## upstream取り込み前監査の記録（2026-07-27、1.130取り込み準備）

ベースタグ`1.129.0`との全差分（upstream由来ファイルへのfork変更170ファイル）を監査した。結果:

- **PARA-PATCHマーカーの欠落はゼロ**。マーカーが無かった28ファイルは全てコメント不能ファイル（`product.json`・`package.json`/`package-lock.json`・テーマJSON・`i18n.resources.json`・`vscode-known-variables.json`・extensions配下のpackage.json 2件・アイコン/インストーラー画像19件）で、いずれも下記「コメントを書けないファイルへの変更一覧」に記載済みだった。1.129取り込み前に実施したマーカー後付けと`para:`プレフィックスの徹底が効いている
- 1.129監査で「将来の整理候補」とした`PARA-CODE:`のフィールドコメント誤用は**未修正のまま残っている**（`src/vs/platform/terminal/common/terminal.ts` 5箇所 / `src/vs/workbench/contrib/terminal/browser/terminal.ts` 3箇所 / `src/vs/workbench/contrib/terminal/browser/agentHostTerminalService.ts` 1箇所）。これらのファイルはファイル単位では`PARA-PATCH`も持つため監査は通る。実害は小さい
- `npm run valid-layers-check` の`layersChecker.ts`が既定の4GBヒープでOOMする。**これは1.130マージ起因ではなく`main`でも同様に再現する既存の問題**で、`NODE_OPTIONS=--max-old-space-size=8192`を付ければ通過する（fork のソース増加が原因。upstream自身も1.130で`tsec-compile-check`に同じ`--max-old-space-size=8192`を追加している）。恒久対応するなら`package.json`の`valid-layers-check`にPARA-PATCHで同オプションを足すのが自然

## upstream取り込み前監査の記録（2026-08-11、1.132取り込み準備）

ベースタグ`1.130.0`との全差分（upstream由来ファイルへのfork変更188ファイル、fork新規1513ファイル）を監査した。結果:

- **PARA-PATCHマーカーの欠落は1件**: `src/vs/platform/update/test/electron-main/abstractUpdateService.test.ts`（自己ホスト更新フィードのCloudflare Accessヘッダを検証するfork独自テスト108行）。由来コミットは`587361a6e62 test: cover Para Code fork features`で、**`para:`プレフィックスも欠けていた**（この1件のみ。他のコメント不能28ファイルは全て下記台帳に記載済みで1.130監査から増減なし）。対処: マーカー6箇所を後付け（コメント行のみ、挙動変更なし、typecheck-client通過）
- **`PARA-CODE:`マーカーの欠落を新たに検出**。fork新規ファイルのうち、**upstream由来ディレクトリに置かれた6ファイル**（`src/vs/platform/browserView/common/browserViewAutomationInput.ts`とそのtest 3件 / `src/vs/workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.ts`とそのtest 1件）にマーカーが無かった。ここはupstreamが将来同名ファイルを追加するとadd/add衝突になり、かつファイル単体では fork所有と判別できないため後付けした
- **未対処として残したPARA-CODE欠落**（実害が小さいため）: `src/vs/paradis/`・`src/vs/sessions/contrib/`配下のtestファイル約60件、`app/mobile/`のtest 4件、`cloudflare/update-server/`のtest 2件。いずれもディレクトリ構成でfork所有と判別でき、upstreamとのパス衝突リスクも無い。vendor同梱物（chrome-devtools-mcp / react-devtools のbuild成果物、docx-preview等のminified）は規約上マーカー対象外
- **リポジトリルートに用途不明のfork新規HTMLが2件コミットされている**（`mok.html` / `sw.html`）。デバッグ時の一時ファイルが残ったものと思われる。削除するかは未判断
- 1.129監査で挙げた`PARA-CODE:`のフィールドコメント誤用（terminal系3ファイル）は引き続き未修正
- 事前調査の結果: fork変更188ファイルのうちupstream(1.130→1.132)も触ったものは**62ファイル / 3386行**。add/add衝突・modify/delete衝突はいずれもゼロ。upstream churnの上位は`preload-browserView.ts`(1126行)・`package-lock.json`(1039行)・`browserViewInspector.ts`(145行)・`browserViewFrameInspector.ts`(109行)で、**browserView/CDP領域が最大の危険地帯**
- ビルド前提の変更: Electron `42.6.0` → `42.7.1`（`.npmrc`の`target`/`ms_build_id`も追従）。`.nvmrc`は変更なし。`valid-layers-check`スクリプトがupstream側で`layersTypeCheck.ts`方式に置き換わった

### 1.132マージで実際に踏んだ問題（2026-08-11追記）

- **upstreamのリファクタでfork機能が経路から落ちた（型エラーで検出）**: `browserViewInspector.ts` の `getElementHandle()` は1.130までフレームハンドルをそのまま返していたが、1.132で「メンバーを1つずつ転送するラッパーオブジェクト」に書き換えられた。forkが `IElementHandle` に足していた `getOuterHTML()`（ブラウザの右クリック「Copy Element」）がラッパーから漏れ、`typecheck-client` が `TS2741` で検出。ラッパーに1行足して解消。**インターフェースのコンフリクトを解消しただけで満足せず、その実装側がどう変わったかを必ず確認すること**
- **upstreamがCSSトークンを差し替えるとforkの上書きCSSが古い色を指し続ける（型では検出できない）**: 1.132で floating panels（モダンUI）の配色が `agentsPanel.*` → `surface.*` に移行した。fork の透過CSSは `!important` と高い詳細度で勝ち続けるため見た目が壊れることはないが、参照トークンが古いままだと本家と色がずれる。`paradisWindowTransparency.css` を `--vscode-surface-background` に追従させた
- **ソースからの開発ビルドは Sentry の renderer import で起動しない（1.132起因ではなく`main`でも同じ）**: `paradisSentryRenderer.ts` の `import * as Sentry from '@sentry/electron/renderer';` が bare specifier のままコンパイルされるため、`scripts/code.sh` 起動時に renderer が `Failed to resolve module specifier` で落ち、**ワークベンチがスプラッシュのまま止まる**。`main` のビルド成果物でも同一の症状を再現して確認済み（＝マージ由来ではない）。実機確認したいときの回避策は **`out/vs/paradis/paradis.electron-browser.contribution.js` から Sentry の import 1行を外して起動する**（ソースは触らない。検証後に戻す）。パッケージ版は build パイプラインが解決するので影響しない。恒久対応するなら動的importへ寄せる（`sentry-packaging-pitfall` の方針と同じ）
- **`npm install` は root が終わっても続きがある**: root完了後に build/ と extensions/ のサブインストールが走り、全体で1時間近くかかる。`node_modules` ができた時点で終わったと判断しないこと

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
| `product.json` | `builtInExtensions` の `ms-vscode.vscode-js-profile-table` の `sha256` を、upstream記録値（marketplace版 `a962a1e6…`）から **Open VSX版の実測値 `50d00270…`** に差し替え（`version` は upstream追従の `1.0.11` のまま） | forkは `extensionsGallery` を Open VSX に向けているため built-in拡張も Open VSX から取得する。1.0.10 までは Open VSX の成果物が marketplace版とバイト一致していたが、**1.0.11 で Open VSX が再パッケージしたため一致しなくなり、`npm run download-builtin-extensions` が `Checksum mismatch` で落ちる**（＝ローカルビルドもリリースCIも通らない）。1.132取り込み時に両方の成果物を展開して比較し、**実行コード（`out/*.js`・CSS）はバイト単位で同一**、差分は `extension.vsixmanifest`・`package.json` の整形・同梱ライセンスファイル（`ThirdPartyNotices.txt` vs `LICENSE.txt`）・`telemetry.json` の有無のみと確認済み。**upstreamがこの拡張のバージョンを上げるたびに同じ対応が要る**: `curl -fsSL https://open-vsx.org/vscode/gallery/publishers/ms-vscode/vsextensions/vscode-js-profile-table/<版>/vspackage | shasum -a 256` で実測して置き換える |
| `build/lib/i18n.resources.json` | `vs/sessions/contrib/terminalGrid` エントリを追加 | 新規contributionディレクトリの`localize()`利用に伴うi18nリソース登録 |
| `extensions/theme-defaults/themes/2026-dark.json` | primary accent色を`#3994BC`系→`#09AFD9`系（button/focusBorder/badge/選択背景等、約25箇所、アルファ値は維持）に置換 | ユーザー指定のブランドカラーへの統一 |
| `extensions/theme-defaults/themes/2026-light.json` | primary accent色を`#0069CC`系→`#0598BD`系（同上、白背景に対するコントラストを保つため若干暗めに調整）に置換 | 同上（ダーク/ライト両テーマでの一貫性） |
| `resources/darwin/code.icns` | アプリアイコンをユーザー指定画像に差し替え | ブランディング |
| `src/vs/paradis/contrib/watermark/browser/media/paradisWatermark.png` | 新規追加（fork所有バイナリ）。空エディタグループwatermarkのletterpress画像の差し替え先（`paradisWatermark.css`から参照） | ユーザー指定のwatermark画像への変更 |
| `src/vs/paradis/contrib/notifications/browser/media/sounds/*.mp3`（11ファイル: shamisen/arcade/ping/supersetquick/supersetdoowap/agentisdonewoman/codecompleteafrican/codecompleteafrobeat/codecompleteedm/comebacktothecode/shabalabadingdong） | 新規追加（fork所有バイナリ）。Superset (`apps/desktop/src/resources/sounds/`) のビルトイン着信音をそのまま移植。`FileAccess.asBrowserUri('vs/paradis/contrib/notifications/browser/media/sounds/<file>.mp3')` で参照（`paradisNotificationSoundPlayer.ts`） | 通知サウンド機能（Phase D）のビルトイン着信音アセット |
| `resources/paradis/extensions/*.vsix`（標準同梱9ファイル: mosapride.zenkaku / AntiAntiSepticeye.vscode-color-picker / netcorext.uuid-generator / ms-vsliveshare.vsliveshare / jeff-hykin.polacode-2019 / yudai1204.polacode-button / VisualStudioExptTeam.vscodeintellicode（68MB） / VisualStudioExptTeam.intellicode-api-usage-examples / evondev.indent-rainbow-palettes（18MB）。後段のContainer Toolsパッチ版1ファイルと合わせて実体は計10ファイル） | 新規追加（Open VSX未公開のため同梱するサードパーティ拡張のVSIX。標準同梱分は合計約92MB）。`paradisDefaultExtensions.contribution.ts` が起動時に `appRoot` 相対で解決し `IExtensionManagementService.install()` でインストール。ビルド時は `build/gulpfile.vscode.ts` の `packageTask` が成果物へコピー | 既定拡張自動インストール機能（VSIX同梱分）。IntelliCodeはMicrosoft独自ライセンス（再配布時は要確認）。サイズが大きいためGit LFS化を将来検討 |
| `extensions/git/package.json` | `git.autofetch` の `agentsWindow.default` を upstream の `true` から `false` へ変更 | GitHubレートリミット対策。Agent Sessionsウィンドウで数百worktreeを開くと180秒ごとに全リポジトリへ `git fetch` が走り、GitHub側の濫用検知（二次制限）に掛かるため。既存ユーザーの明示設定は `sessionParaGithubSettingsMigration.ts` の一回限りマイグレーションでリセット |
| `extensions/git/package.json` / `extensions/git/package.nls.json` | ソース管理の「分岐元ブランチからの差分」グループ用に、設定 `git.paraBranchDiff.enabled`（既定 `true`）、コマンド `git.paraSelectBranchDiffBase`、`scm/resourceGroup/context` と `scm/resourceState/context` への `scmResourceGroup == paraBranchDiff` 向けメニュー項目、対応する nls 文字列（`command.paraSelectBranchDiffBase` / `config.paraBranchDiff.enabled`）を追加 | 現在のブランチが分岐元から積み上げた差分（`git diff <base>...HEAD`）をSCMビューに出す独自グループ。実装本体は `extensions/git/src/paraBranchDiff.ts`（PARA-CODE）、`repository.ts` / `main.ts` 側は PARA-PATCH |
| `extensions/github/package.json` | `github.branchProtection` に `agentsWindow: { "default": false }` を追加し、`enabledApiProposals` に `agentsWindowConfiguration` を追加（未宣言だと設定ポイントが `agentsWindow` をエラー付きで削除する。git拡張はupstreamが宣言済み） | GitHubレートリミット対策。既定ONだと開いたリポジトリ×remoteごとに起動時GraphQLが2本以上走り、数百worktreeで一斉バーストするため（通常ウィンドウの既定はupstreamのまま `true`） |
| `build/lib/stylelint/vscode-known-variables.json` | `others` に `--paradis-transparency-opacity` / `--paradis-titlebar-bg` / `--paradis-statusbar-bg` / `--paradis-workspace-color` / `--paradis-pr-color` / `--paradis-agent-live-row-height` / `--paradis-preset-cluster-flyout-max-width` を追加。**注意: 初回追加時に `others` 配列全体（約70行）をアルファベット順に再ソートしたため、diffは純増分より大幅に広い（±70行超）**。upstream取り込みでこのファイルがコンフリクトした場合、upstream側の配列を丸ごと採用し、上記paradis 7変数だけ再挿入するのが最も安全 | ウィンドウ透過機能・Workspacesビュー色バー・PR状態チップ・エージェント一覧のタイル高さ・コマンドプリセットのクラスター展開幅上限のカスタムCSS変数（`--paradis-agent-live-row-height` は paracode-93 で `--paradis-agent-live-min-row` から改名）。hygiene の stylelint (Unknown variable) を通すため |
| `package.json` / `package-lock.json` | `dependencies` に `exceljs@^4.4.0` と `jszip@^3.10.1` を追加（`npm install ... --save --ignore-scripts`） | Excelビューア/差分機能。exceljs は xlsx のセル/スタイル/結合のパース（Buffer/stream 依存のため shared process `src/vs/paradis/contrib/fileViewers/node/` でのみ使用）。jszip は xlsx(ZIP) から図形(斜線コネクタ)の drawing XML を取り出すため（同じく shared process）。eslint の node層import許可リスト（`eslint.config.js` の hasNode `allow`）にも `'exceljs'` `'jszip'` を PARA-PATCH で追加済み |
| `package.json` / `package-lock.json` | `@sentry/electron` / `@sentry/node-native` / `@sentry/cli` を追加し、公式CLIとnative stacktrace補助のinstall scriptだけを`allowScripts`で許可 | Para CodeデスクトップのJS例外・Electron native crash収集、Debug ID付きsource mapアップロード |
| `package.json` | `scripts.valid-layers-check` の先頭を `node build/checker/layersChecker.ts` → `node --max-old-space-size=8192 build/checker/layersChecker.ts` に変更（2026-07-27、1.130取り込み時） | forkのソース増加により`layersChecker.ts`が既定4GBヒープで`Ineffective mark-compacts near heap limit`のOOM死する（1.130取り込み前の`main`でも再現する既存問題）。後続の`tsc`各ステップは既定ヒープのままで通るため、パッチはこの1コマンドのみ。upstream自身も同じ理由で`tsec-compile-check`に`--max-old-space-size=8192`を付けている |
| `src/vs/code/electron-browser/workbench/workbench.html` / `workbench-dev.html` | CSP の `trusted-types` 許可ポリシー一覧に `paradisSpreadsheetDrawings` を1トークン追加（`content` 属性内のため行内コメント不可） | Excel図形(斜線)を drawing XML から SVG 化する際、renderer の `DOMParser.parseFromString` が Trusted Types 強制でブロックされる。`createTrustedTypesPolicy('paradisSpreadsheetDrawings', ...)`（`paradisSpreadsheetDrawings.ts`）で作るポリシー名を CSP 許可リストに載せないと `createPolicy` が例外→生文字列fallback→ブロックとなる。通常ウィンドウ(workbench.html)専用機能のため sessions html は対象外 |
| `app/mobile/modules/para-glass-morph/expo-module.config.json` | 新規追加（ローカルExpoモジュールの定義JSON。`apple.modules: ["ParaGlassMorphModule"]`） | ＋メニューのLiquid Glass液体モーフ（SwiftUIのglassEffectID + withAnimation spring）用ネイティブビュー。JSONのためマーカー不可。同モジュールのSwift/podspec/index.tsにはPARA-CODEヘッダーあり |
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
| `app/mobile/app.json` | `expo-notifications` プラグイン追加、iOS `UIBackgroundModes: [remote-notification, audio]` 追加 | APNsリモートプッシュ（アプリ未起動時の通知配送）と、PCから届く音声通知のバックグラウンド再生（`modules/para-voice-session`）。`audio` はユーザーが音声通知を開始している間だけ使う（無音ループでプロセスを保つ）。**注意: `app/mobile/ios/` は `app/.gitignore` で無視されるため、NSEターゲット等のネイティブ変更はリポジトリに残らない**。NSEのソースと復元手順は `app/mobile/native/NotifyExtension/README.md` 参照 |
| `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/**`（docx-preview.min.js / jszip.min.js / LICENSE-docx-preview / LICENSE-jszip / README.md） | 新規追加（vendoredサードパーティ成果物）。`docx-preview@0.3.7`（Apache-2.0）と `jszip@3.10.1`（MIT/GPL-3.0デュアル、MITで使用）のUMD版 dist をそのまま同梱。取得元・更新手順は同ディレクトリの `README.md` 参照 | PC版Word(.docx)ビューア（`paradisDocxFileEditor.ts`）が webview 内で docx-preview を実行し .docx を HTML レンダリングするため。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslintから除外（`build/filters.ts`・`.eslint-ignore`・`.eslint-allowed-javascript-files` のPARA-PATCH）。パッケージ同梱は `build/next/index.ts` と `build/gulpfile.vscode.ts` の両方に glob 追加済み |
| `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/docx-preview.min.js` | vendored本体への手動パッチ（2026-07-06〜07、7件）。①`HtmlRenderer.levelTextToContent()` が番号付き/箇条書きリストの CSS `content` 値をテンプレートリテラルの二重ネストで壊して生成する既知バグ（docx-preview GitHub masterでも未修正）を正しい実装に置換。②VML図形パーサ（`Ce`関数）が`strokecolor`/`strokeweight`属性形式（実務文書で一般的）に対応しておらず、斜線コネクタ等の罫線装飾が透明になり完全に見えなくなる不具合を修正。③縦書き指定`<w:textDirection>`のVバリアント(`tbRlV`等)がマッピングに無く横書きにフォールバックし、セルが横方向にはみ出す不具合を修正。④`valueOfTblLayout`が`<w:tblLayout>`の属性名を`val`ではなく`type`を見るべきところを誤っており、`tblLayout=fixed`指定が常に無視されテーブル・ページ全体が異常な幅に拡大される不具合を修正（本件の核心バグ）。⑤`tblW=auto`かつ`tblLayout=fixed`の場合にgridCol合計から明示的widthを補完、および`tblLayout`省略時にwidth明示があれば`fixed`をデフォルト化。⑥ページ基準(`mso-position-*-relative:page`)のVML図形にleft/top:0を与え、アンカー段落位置との二重オフセットで別ページ上に描かれる位置ズレを修正（ビューア側CSSの`section.docx{position:relative}`とセット）。⑦hanging indent段落の行頭タブがWord仕様(インデント位置へのジャンプ)にならず右端のリーダー付きストップへ飛んで目次レイアウトが崩れる問題を修正。詳細と再パッチ手順は同ディレクトリの `README.md`「既知のバグへの手動パッチ」参照 | ①により番号・箇条書きの記号がブラウザのCSSパースエラーで一切表示されなかった（`content: none`）。②により実務の契約書・重要事項説明書等で使われる斜線コネクタ(直線コネクタ)が完全に非表示だった。③④⑤により複数ページの実務文書でページごとに白紙の幅が大きく食い違って見える不具合があった。ビルド済み第三者コードでコメント不可のためここに記録 |
| `app/mobile/native/NotifyExtension/Info.plist` / `NotifyExtension.entitlements` | 新規追加（fork所有）。NSEターゲットの設定ファイル（追跡用コピー。実体は gitignore された `ios/` 内） | プッシュ通知本文のNSE復号。plistはコメント不可のためここに記録 |
| `app/mobile/assets/docxpreview/docxPreviewBundle.json` | 新規追加。PC版Wordビューアの vendored パッチ済み `jszip.min.js` + `docx-preview.min.js` を `{version, jszip, docxPreview}` として同梱（xtermBundle.json と同方式） | モバイルのWordビューア（WebView内レンダリング）用。**PC側の min.js を更新したら再生成が必要**。生成手順は `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/README.md`「モバイルアプリ用バンドル」参照 |
| `src/vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/**`（約350ファイル: package.json / LICENSE / build/**） | 新規追加（vendoredサードパーティ成果物、Apache-2.0）。`chrome-devtools-mcp@1.5.0`（Google）のnpm公開物をそのまま同梱（依存ゼロの自己完結パッケージ、上流README/skillsのみ除外）。取得元・更新手順は同ディレクトリの `README.md` 参照 | para-browser MCPサーバーがペイン毎の子プロセスとしてspawnし、DevToolsツール群をプロキシ合流させるため（`paradisDevtoolsMcpProxy.ts`）。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslintから除外（`build/filters.ts`・`.eslint-ignore`・`.eslint-allowed-javascript-files` のPARA-PATCH。パッケージ更新時は allowlist の再生成が必要、手順は同ファイル内コメント参照）。パッケージ同梱は `build/next/index.ts` と `build/gulpfile.vscode.ts` の両方に glob 追加済み |

| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-screen-corner-radius@^1.1.0` を依存に追加 | ワークスペースドロワーを開いたときにコンテンツへ付ける角丸を、端末のディスプレイ角丸（iPhone 16 Pro=62pt、14 Pro〜16=55pt等）に一致させるため。iOSではプライベートAPI（`UIScreen._displayCornerRadius`）ではなく`uname()`のモデル識別子＋ルックアップテーブルで解決するためApp Store審査を通せる（同種の`react-native-screen-corner-radius`はプライベートAPIを難読化して使うため不採用）。JS側は`src/screenCornerRadius.ts`が`requireOptionalNativeModule`で引き、未リンク時はiOS 55pt/Android 0へフォールバックする |

| `app/mobile/app.json` | `expo.version` をリリースごとに上げる（`0.1.0` → `0.2.0` → `0.2.1` …） | アプリ内「アップデートのお知らせ」の導入にあわせた最初のバージョン。`src/changelog.ts` の `MOBILE_CHANGELOG` 先頭と一致していないとお知らせが出ない／古い内容が出るため、以後この2つは必ず同時に上げる（`src/changelog.test.ts` が一致を検査する） |
| `app/mobile/app.json` | `ios.supportsTablet` を `false` → `true`。あわせて `ios.infoPlist` に `UISupportedInterfaceOrientations`（iPhone: portraitのみ＝従来と同値）と `UISupportedInterfaceOrientations~ipad`（iPad: 4方向すべて）を明示追加 | iPad版対応。トップレベルの `expo.orientation` は `portrait` のまま残す（Androidの `screenOrientation` を従来どおり縦固定に保つため）。`@expo/config-plugins` の `withOrientation` は `createInfoPlistPluginWithPropertyGuard` 実装で、`ios.infoPlist.UISupportedInterfaceOrientations` が明示されている場合は上書きをスキップするため、この2キーがそのまま採用される。iPadだけ回転を許可し、幅が狭いSplit View/Slide Overでは `src/sizeClass.ts` の判定でiPhoneと同じ1カラムへ落ちる |

| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-clipboard@~57.0.1` を依存に追加 | エージェント詳細画面のタイムライン（`src/components/agentIoBlock.tsx`）で、ツールの入力・出力をコピーするボタンを出すため。RN本体の `Clipboard` は非推奨で、Expo SDK 57 の標準モジュールを使う。ネイティブモジュールのため追加後は iOS/Android の再ビルドが必要 |

| `app/mobile/native/ParaCodeWidgets/paracode-logo.png` | 新規追加（fork所有バイナリ）。`app/mobile/assets/pairing-logo.png` を `sips -Z 128` で縮小したコピー（gitignoreされた `ios/ParaCodeWidgets/` にも同一物を配置し、Widgetターゲットの Resources に pbxproj 手動登録済み） | Live Activity / Dynamic Island のロゴをホームタブのPCカードと同じPara Codeロゴにするため（`ParaCodeWidgetsBundle.swift` の LogoBadge が `UIImage(named:)` で読む。復元手順は同ディレクトリ README 参照）。PNGのためマーカーを埋め込めない |

| `product.json` | Remote-SSH（リモート開発）対応で4点追加。(1) `serverDownloadUrlTemplate` を新設し、固定タグ `reh` のGitHub Releaseから `para-code-server-${os}-${arch}-${commit}.tar.gz` を取得させる。(2) `builtInExtensions` に `jeanp413.open-remote-ssh@0.3.1` を追加（sha256はOpen VSX実測値 `c6f16b22…`、metadataのUUIDは `open-vsx.org/vscode/gallery` の extensionquery から取得）。(3) `extensionEnabledApiProposals` を新設し同拡張へ `resolvers`/`tunnels`/`terminalDataWriteEvent`/`contribRemoteHelp`/`contribViewsRemote` を許可。(4) `remoteExtensionTips` を新設し `ssh-remote` エントリを登録 | MS純正の `ms-vscode-remote.remote-ssh` はライセンス上forkで使えず、リモートへ入れるVS Code Serverも `update.code.visualstudio.com/commit:<commit>` にforkのcommitが存在しないため取得不能。OSS版の open-remote-ssh + 自前REH配布で代替する。**(3)は必須**: proposed APIを許可しないと接続そのものが始まらない（`extensionsProposedApi.ts` のコメント通り、product.json側の指定が拡張のpackage.json宣言を上書きするため、拡張が宣言している2つも含めて列挙する必要がある）。`serverApplicationName`/`serverDataFolderName` は拡張の `getVSCodeServerConfig()` が product.json を直接読むので追加設定は不要。URLに `${commit}` を使うのはクライアントとサーバーの版ずれを原理的に防ぐため（`remote.SSH.serverVersion` の既定 `match` ではGitHub APIを叩かないので任意ホストで動く）。ビルドは `.github/workflows/para-reh.yml` |
| `product.json` / `resources/paradis/builtin/mobile-canvas-vscode-0.1.16.vsix` | `builtInExtensions` に `mobile-canvas-vscode@0.1.16`（Marketplace上の実体は `redth.mobile-canvas`、MIT）を追加。**リポジトリに vendoring した「ランタイム非同梱版」VSIX（123KB）を `vsix` フィールドで指す**。metadataのUUIDは Visual Studio Marketplace の extensionquery から取得 | iOSシミュレータ/Androidエミュレータをライブ表示・操作する Mobile Canvas を標準同梱するため。**ネイティブランタイムを同梱してはいけない（paracode-116 で実際にリリースが落ちた）**: プラットフォーム別VSIX（12〜14MB）は `dist/runtimes/<rid>/mobile-canvas.gz` に実行ファイルを内包しており、これをアプリに入れると **Apple の公証が gzip を展開して中の Mach-O を検査し、`The binary is not signed.` / `The signature does not include a secure timestamp.` / `The executable does not have the hardened runtime enabled.` の3点で拒否する**（拒否パスは `Para Code.app/Contents/Resources/app/extensions/mobile-canvas-vscode/dist/runtimes/osx-x64/mobile-canvas.gz/mobile-canvas` と、.gz の内側まで具体的に示される）。非同梱版は manifest だけを持ち、ランタイムは初回利用時に `~/.mobile-canvas/runtimes/` へ展開されるため、アプリの外に出て公証の対象外になる。取得は `paradisMobileCanvasHostClient.ts` の `_downloadArchive()` が manifest の `distribution`（repository/tag）と各ファイルの `asset` から GitHub Release のURLを組み立てて行い、展開後のsha256をmanifestと突き合わせる。同梱に戻したい場合は、ビルド時に自前で Developer ID 署名＋hardened runtime を付与して再gzipし、manifest の sha256/id も書き換える工程が要る。**`name` を `redth.mobile-canvas` にしてはいけない**: `name` は `.build/extensions/<name>/` のフォルダ名にしか使われず拡張IDは同梱 `package.json` の `publisher`+`name` から決まるが、`vsix` パスやアセット名と揃えておかないと版上げのときに取り違える。版を上げる際は `gh release download <tag> --repo Redth/mobile-canvas-ghcp --pattern "mobile-canvas-vscode-thin.vsix"` で取り直し、`shasum -a 256` の値を `sha256` に反映する（リリース同梱の `SHA256SUMS` はランタイム `.gz` のみでvsixを含まない） |

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

## 内蔵ブラウザの前面オーバーレイ機構（overlayManager、2026-08-15整備）

内蔵ブラウザ（`src/vs/platform/browserView/`）はElectronのネイティブ `WebContentsView` として実装されている。ネイティブビューはOS合成レイヤーで描画されるため、通常のDOM要素はCSSの `z-index` では絶対に上書きできない。

これを回避しているのが `src/vs/workbench/contrib/browserView/electron-browser/overlayManager.ts` の `BrowserOverlayManager` で、`OVERLAY_DEFINITIONS`（決め打ちのDOMクラス名ホワイトリスト）に載っている要素がブラウザ領域に重なったことを検知すると、ネイティブビューを一時的に `setVisible(false)` で隠してスクリーンショットに差し替える。DOM側のダイアログはその隠れた瞬間に自然と「上」に描画される、というトリック。

**重要**: この重なり検知は汎用的なz-index判定ではなく、**クラス名の決め打ちホワイトリスト方式**。標準の `monaco-dialog-modal-block` / `quick-input-widget`（`IDialogService`/`IQuickInputService`経由）は最初から登録済みで無条件に機能するが、fork独自の「自前DOM + backdrop方式」のダイアログは、それぞれ固有のbackdropクラス名を持ち、**そのクラス名を `OVERLAY_DEFINITIONS` に個別追加しない限りブラウザの背後に隠れる**。

- 登録済み（問題なし）: `paradis-binding-dialog-backdrop`、`paradis-bookmark-dialog-backdrop`
- 2026-08-15時点で判明した未登録（＝ブラウザ表示中に開くと背後に隠れる）:
  1. `paradis-preset-editor-backdrop`（カスタムプリセットコマンドのモーダル、`src/vs/paradis/contrib/terminalPresets/browser/paradisPresetEditorDialog.ts`）
  2. `paradis-create-worktree-backdrop`（ワークスペース切替/worktree作成ダイアログ）
  3. `paradis-notif-settings-backdrop`（通知設定ダイアログ）
  4. `paradis-notif-nested-backdrop`（Aivis辞書設定・YouTubeインポートの入れ子ダイアログ）
  5. `paradis-limits-setup-overlay`（利用上限コード登録ダイアログ）
  - 境界事例（アンカー式ポップオーバーで全画面モーダルではないため優先度低）: `.paradis-limits-panel`、`.paradis-resource-monitor-panel`

**運用ルール**: 内蔵ブラウザと同時に開かれうる場面がある「自前DOM + backdrop方式」の新規ダイアログ・モーダルを追加したら、そのbackdropクラス名を必ず `overlayManager.ts` の `OVERLAY_DEFINITIONS` に追加すること（`{ className: '...', type: BrowserOverlayType.Dialog }` を1行足すだけ）。標準の `IDialogService`/`IQuickInputService` をそのまま使う場合はこの対応は不要（既存ホワイトリストでカバー済み）。

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
- **SCMリポジトリ一覧の残留は「閉じる」では解決しない（2026-07-29確定）**: 旧スペースのリポジトリを `git.close` で消そうとしても、GitHub Pull Requests 等の他拡張がそのリポジトリを掴んでいると即座に開き直され、close↔open が繰り返される（実機ログで3往復を確認: `[Model][close]` → 7秒後に `[Model][openRepository]`）。`paradisScmRepoScope` は無限ループ回避のため3回で諦めて「開いたまま非表示」に妥協するが、その非表示は `visibleRepositories`＝「変更」ビューにしか効かず、「リポジトリ」一覧セクションは `ISCMViewService.repositories` を直接描画するため残り続けていた。**対策は閉じることではなく、`ISCMViewService` を fork 実装（`paradisScopedScmViewService.ts`、upstream の `SCMViewService` を内包）へ差し替えて一覧そのものを絞ること**。あわせて `scmRepositoriesViewPane.ts` に1行 PARA-PATCH が必要 — ツリー再構築のトリガーは `ISCMService.onDidAddRepository/onDidRemoveRepository` だけで、`ISCMViewService.onDidChangeRepositories` は upstream では誰も購読していないため、リポジトリの開閉を伴わないフォルダ入れ替えでは一覧が更新されない
- **`git.close` は完全撤去（2026-08-03）**: 上記の対策で一覧を絞れるようになった時点で `git.close` は不要になっていたが、`paradisScmRepoScope` に呼び出しが残っており、モーダル「Git: 利用可能なリポジトリがありません」の原因になっていた。upstream の `git.close` は `{ repository: true }` 登録のため、第一引数からリポジトリを解決できないと `model.pickRepository()` にフォールバックし、git 拡張側で開いているリポジトリが 0件ならモーダル、**1件なら無確認でその1件を閉じ**、2件以上なら QuickPick を出す。解決に失敗するのは日常的で、フォルダ入れ替え時に git 拡張が外れたフォルダのリポジトリを `Model.close` ではなく `OpenRepository.dispose()` で直接破棄する（→ ログにも `closedRepositories` にも残らない）ため、renderer 側の `scmService.repositories` にはまだ見えるのに ext host にはもう無い、という窓が秒単位で開く（Windows は git のプロセス起動が遅く、実機ログでコマンド1本あたり数百ms〜1.7秒）。実機ログ17時間分で `[Model][close]` 2回に対し `Opened repository` 33回という非対称が出るのはこの dispose 経路のため。撤去の代償は「スコープ外リポジトリが git 拡張側では開いたまま残る」こと（`git.pull` 等のリポジトリピッカーに現れる／再帰ウォッチャーと AutoFetcher が回収されない）
- **復元中のparkはsplitを壊す（2026-08-03修正）**: upstreamのレイアウト復元はタブの2枚目以降を `{ parentTerminal: 直前のインスタンス }` で作り、split先を `getGroupForInstance`（`groups` しか見ない）で引く。したがって1枚目のペインが現れた瞬間にparkすると2枚目の復元が `Cannot split a terminal without a group` で落ち、非アクティブスペースのグループはペイン1枚しか復元されない。さらに `_recreateTerminalGroups` のPromiseがrejectして `terminalService.whenConnected` が永久に未完了になり、fork側の復元後処理（`sweepRestoredGroups`／孤児エディタターミナルの回収／台帳prune）とupstreamの `backend.setReady()` がまとめて実行されなくなる。対策は「復元完了まで park を保留し `whenConnected` 後にまとめて流す」（`_deferredParkGroups`）
- **エディタタブのターミナルは「番号」ではなく nonce で繋ぐ（2026-08-03修正、実機ログで確定）**: `persistentProcessId` は世代ローカルで、pty host は再起動のたびに採番を0から振り直す。実機ログでは旧ID 4,5,13,15,17… が新ID 1〜20 に写っており、**旧ID空間と新ID空間が完全に重なる**。エディタタブは working set に前世代のIDを持つため、対応表(`_revivedPtyIdMap`)で補正できないと生のIDで attach し、その番号を引き継いだ無関係な端末を掴む（実機ログに `Persistent process reconnection "84"/"131"/"139" failed` が残っている）。2つの修正を入れた:
  - `_expandTerminalInstance` が対応表のエントリを**消さない**ようにした。パネルのレイアウト復元とエディタタブの復元は別経路で同じ表を引くので、パネルが先に消費するとエディタ側が自分のIDを引けなくなっていた
  - `getRevivedPtyNewId` に `paradisExpectedNonce` を足し、**attach する直前に shell integration nonce で本人確認**する（`attachToRevivedProcess` → `terminalProcessManager` が working set 由来の nonce を渡す）。nonce は revive を跨いで保持されるので、世代に依存せず端末を同定できる。一致しなければ `PARADIS_UNRESOLVABLE_PTY_ID`(-1) を返し、upstream の「attach 失敗 → 新しいシェルを起動」経路に乗せる。**空で開く方が、他ウィンドウから端末を奪うより安全**という既存の方針（`paradisTerminalEditorRevive.ts`）に揃えた
  - 起動時のエディタ復元では fork の revive index（nonce → 現世代ID）がまだ登録されておらず守れない。この nonce 検証は pty host 側で同期的に効くため、その穴を起動シーケンスに手を入れずに塞げる
- **worktreeスコープの台帳は起動時に隔離するが、バリア後は未知のstateKeyも採用する（2026-08-03修正）**: 未知のまま捨てると、その端末はスコープ無し→initial cwdも登録ルート外→「起動時のアクティブスペース」へ恒久的に吸収され、別ディレクトリの端末が現スペースに紛れ込む。スコープが本当に消えた場合は `onDidRetireScope` が明示的に台帳を掃除する
- 2Dグリッドの配置と比率は、fork独自スナップショット（`sessions/contrib/terminalGrid/browser/sessionTerminalGridLayoutService.ts`、WORKSPACEスコープstorage）で復元する。upstreamのレイアウト情報は1タブ＝1次元の `relativeSize` 配列しか持てず2Dを表現できないため、`Grid` のserialize結果を別建てで持ち、復元後（`whenConnected`後）に一度だけ適用して組み直す
  - **persistentProcessIdは世代ローカル**（pty hostは再起動のたびに採番を0から振り直す）。したがって照合には必ず「そのエントリを書いたセッションのID」を使う: 保存は現世代の `persistentProcessId`、復元側は `attachPersistentProcess.paradisRevivedFromPersistentProcessId`（リロード時は `attachPersistentProcess.id`）。**今セッションで新規作成した端末は照合対象にしない**（新IDが前セッションの無関係な端末のIDと偶然一致し、他スペースのレイアウトを奪って消費してしまう）
  - 未claimのエントリは保存時に今世代IDへ**再キー**する（`sessionRekeyGridLayoutEntries`）。しないと、一度も訪問しないスペースのエントリは2世代前のIDのまま取り残されて二度と一致しない。再キーはstorageへ書く値だけに適用し、claim用のin-memory台帳は前世代IDのまま置く（順序に依存しないため）
  - 保存は毎回storageを読み直してマージする（同一ワークスペースを複数ウィンドウで開いたときのlost update回避）。自分のものと他ウィンドウのものは端末IDで判別し、**前世代・今世代の両方のIDを「自分のもの」として扱う**（でないと自分の古い版が他人のものとして温存される）。逆に、**live端末で説明のつかないエントリは書き戻さない**（起動時スナップショットは他ウィンドウの最新版より古い可能性があるため）
  - 既知の限界: 全ペインを閉じたグループのエントリは、説明のつく端末がいなくなるため再キーされず旧世代のIDのままstorageに残る（エントリ上限32件から押し出されるまで）。claimには「ID集合の完全一致」が要るので、古いエントリは無視されるだけで誤マッチはしない
- **WORKSPACEスコープのstorageは全スペースで共有される（2026-08-09整理）**: workspace idがconfigPath依存で固定なので、`state.vscdb`は1つしかない。`paradis.workspaceSwitch.*`（workingSets/terminalRepositories/browserScopes/scmInputs/spaceNotes）は最初から自前でスペースIDをキーに混ぜて分けてきたが、**upstream由来でWORKSPACEスコープを「1つの作業単位」と仮定しているものは混ざったまま**。実機の`state.vscdb`で確認した混在の例: `history.entries`（エディタ履歴、下記で対処済み）、`workbench.tasks.recentlyUsedTasks2`、`memento/workbench.view.search`、および**拡張機能の`workspaceState`**（`vscode.git`/`mhutchie.git-graph`/`GitHub.copilot-chat`等。`extensionStorage.ts`がWORKSPACEスコープへ直接書く）
  - `IStorageService.switch()`（`storage.ts`）でstorage自体を差し替える手はあり、renderer側の`RemoteStorageService.switchToWorkspace()`は実装済み（旧DBをclose→新DBをinit→`switchData`で全キーの変更イベント発火）。だが**upstreamの大半のコンポーネントは起動時に一度読んでメモリに持ち、変更イベントを購読していない**（`HistoryService.ensureHistoryLoaded`が典型）。差し替えても古い値が生き残り、次の保存で新スペースのDBを汚染する。upstreamがこのAPIを使う唯一の場面はuntitled workspaceの保存で、`preserveData`により中身が同一だから顕在化しないだけ。全コンポーネントを追随させるにはウィンドウリロードが必要で、それは機能1の存在意義そのものを否定する
  - したがって方針は「storageごと切り替える」ではなく、**スペース依存の状態を1つずつ、save→clear→loadのフックを書けるものから載せ替える**。拡張機能の`workspaceState`は値を持つのがext host側の拡張コードで、切り替え時に読み直させる手段がない（ext host再起動が必要）ため**現構造では対象外**
- **エディタ履歴のスペース分離（2026-08-09実装、`paradisHistoryScope.ts` + `historyService.ts`のPARA-PATCH）**: Ctrl+Pの「最近開いたもの」に別スペースのファイルが出る報告が発端。実機で`history.entries`178件に7リポジトリ分が混在していることを確認した。保存キーを`history.entries.<フォルダURIのhash>`に分け、`onDidChangeWorkspaceFolders`で「読み込み元のキーへ書き戻す→破棄→次の参照で新スペース分をロード」する。上限200件もスペースごとに独立する。実装で踏んだ/避けた落とし穴:
  - **書き戻し先は「今のキー」ではなく「読み込んだキー」**。メモリ上の履歴がどのスペースのものかを`paradisLoadedHistoryKey`で持つ。今のキーへ書くと切り替え先の履歴を切り替え元の内容で潰す
  - **未ロード状態で書かない**。`ensureHistoryLoaded`は`editorGroupService.isReady`がfalseのとき`history = []`を置いて`whenReady`後に`loadHistory()`する。この窓で`saveState`が走ると空配列でそのスペースの永続履歴を全消去する。`paradisLoadedHistoryKey === undefined`をガードにして塞いだ
  - **リセットの判定は「foldersが入れ替わったか」ではなく「保存先キーが変わったか」**。フォルダ0個からの遷移やマルチルートとの間の遷移でも取りこぼさないため
  - **LRU（上限24スペース）は「これから読むスペース」も必ず先頭へ寄せてから間引く**。保存したときだけ追跡すると、久しぶりに戻るスペースほど捨てられる側に溜まり、戻った瞬間に履歴を失う
  - 既知の制限: (1) 切り替え先スペースがフォルダ外のファイル（ユーザー設定等）を開いていた場合、切り替え元の履歴に残る（除去判定はフォルダ配下かどうかしか見られない。取り切るには切り替えの開始そのものを知る必要がある）。(2) 補助ウィンドウにピン留めしたエディタは`editorService.getEditors`が全パートを列挙するため新スペースの履歴に入り得る。(3) スペースを分ける前の`history.entries`は各スペースが自分の分を引き継げるよう残す（孤児として31KB程度）。(4) Ctrl+Shift+Tのreopenスタックとナビゲーションスタックはスペースを跨いだまま（どちらも非永続でセッション内のみ）
- 既知の制限: ブラウザページはウィンドウリロードを跨ぐと再ロードされる（WebContentsViewがウィンドウに紐づくため。URLはworking set経由で復元）。ブラウザのCookieパーティションは全リポジトリ共有

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

## モバイルアプリの配信手順（2026-08-06整備、アーカイブ前に必ず読む）

`app/mobile/ios/` は `app/.gitignore` で**まるごと無視されている**（Expo prebuild の成果物という扱いのため）。したがって **`app.json` の `version` を上げても、実際にアーカイブされるバイナリのバージョンは変わらない**。`npx expo prebuild` は禁止（手動追加の `NotifyExtension` と `ParaCodeWidgets` が消える）なので、`ios/` 側は手で合わせる。

アーカイブ前に上げる箇所（この5つが揃っていないと、拡張と本体の版が食い違って App Store Connect に弾かれる）:

1. `app/mobile/app.json` の `expo.version`
2. `app/mobile/src/changelog.ts` の `MOBILE_CHANGELOG` 先頭に同じ版の節を作る（`src/changelog.test.ts` が1と2の一致を検査する）
3. `app/mobile/ios/ParaCodeMobile.xcodeproj/project.pbxproj` の `MARKETING_VERSION`（6箇所）と `CURRENT_PROJECT_VERSION`（6箇所）
4. `app/mobile/ios/ParaCodeMobile/Info.plist` の `CFBundleShortVersionString` と `CFBundleVersion`（**値がハードコードされている**）
5. `app/mobile/ios/NotifyExtension/Info.plist` の同2つ（同じくハードコード）

`ios/ParaCodeWidgets/Info.plist` だけは `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` を参照しているので3を直せば追従する。**4と5だけ取り残しやすい**（2026-08-06 の 0.5.0 で実際に踏みかけた）。

アーカイブと検証:

```sh
cd app/mobile/ios
xcodebuild archive -workspace ParaCodeMobile.xcworkspace -scheme ParaCodeMobile \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /tmp/paracode-archive/ParaCodeMobile.xcarchive -allowProvisioningUpdates
```

生成後、本体と2つの拡張の版が揃っているか必ず確認する（揃っていないまま提出すると弾かれる）:

```sh
A=/tmp/paracode-archive/ParaCodeMobile.xcarchive/Products/Applications/ParaCodeMobile.app
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" -c "Print :CFBundleVersion" "$A/Info.plist"
for p in "$A/PlugIns"/*.appex; do
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" -c "Print :CFBundleVersion" "$p/Info.plist"
done
```

提出は Xcode の Organizer（Window → Organizer → Archives）から行う。

## モバイルアプリのiPad対応（2026-08-05）

`app/mobile` はiPhone専用（portrait固定・`supportsTablet: false`）だったが、iPadを2カラムで使えるようにした。設計の要点:

- **判定は幅だけ**: `src/sizeClass.ts` の `sizeClassFor(width, tablet)` が `compact` / `regular` を返す。しきい値700pt。iPadの全画面（短辺744pt〜）は必ず`regular`、Split Viewで狭くなると`compact`＝iPhoneと同じ1カラムへ自然に落ちる。純関数なので実機なしでテストできる（`src/sizeClass.test.ts`）
- **ナビゲーションツリーには手を入れていない**: `src/ipad/ipadShell.tsx` が `app/_layout.tsx` の `<Stack>` 全体を包み、左にサイドバー・右にスタックを並べるだけ。ディープリンク・通知タップ・戻る操作といった既存の動線がそのまま生きる
- **サイドバーの中身はiPhone版のドロワーそのもの**: `WsDrawerContent`（`src/components/wsDrawer.tsx`）を再利用し、`navigation` スロットに下部タブ相当のLiquid Glassセグメント（`src/ipad/ipadSidebar.tsx`）を差すだけ。ワークスペース一覧・メモ・PCステータスの実装を二重に持たない
- **タブは幅で実装を切り替える**: `regular` では `expo-router/js-tabs` の `Tabs` をタブバー非表示で使い、`compact` では従来どおり `NativeTabs`（iOS 26のLiquid Glassタブバー）。iPadOSではNativeTabsのタブバーの見せ方をOSが決めてしまい、こちらのサイドバーと二重になるため

**ハマったところ（同種の実装で必ず踏むので記録）**:

- **条件分岐でツリーの形を変えると、配下が丸ごと再マウントされる**。`IpadShell` / `WsDrawerLayout` の両方で当初やってしまった。`children`（＝ナビゲーションスタック全体）の階層が変わるとReactが別要素とみなし、ターミナルのWebView・ブラウザのミラー接続・遷移履歴・入力途中の文字が全部消える。**幅0での出し分け**（IpadShell）や **`drawerLockMode` での無効化**（WsDrawerLayout）にして、ツリーの形は常に同じに保つこと。発火するのは幅変化だけでなく、`ready` / `paired` の変化でも通る
- **スタック画面から `router.navigate('/terminal')` を呼ぶと `(tabs)` がもう1枚積まれる**。React NavigationのStackRouterは`pop`指定の無いNAVIGATEで既存routeを探しに行かない。`router.canDismiss()` が真なら `router.dismissTo()` を使う（`src/ipad/ipadSidebar.tsx` の `selectTab`）。**この不具合はiPhone版の `agentInfoSheet.tsx` にも同じ形で残っている**
- **「選択中のタブなら何もしない」は書いてはいけない**。エージェント詳細やブラウザを開いている間もホームタブを選択状態で見せているため、素朴に早期returnすると押しても戻れない死んだボタンになる
- **iPadのフローティングキーボードは画面下端に接していない**。`window.height - keyboard.screenY` をそのまま被覆量に使うとボトムシートが画面外へ飛ぶ。`src/keyboardCoverage.ts` に判定を切り出した。**ここで「幅が画面いっぱいでないものを除外する」判定を足してはいけない**——日本語の片手用キーボード（幅は狭いが下端に接していて実際に覆う）を取りこぼし、入力欄がキーボードに隠れる。接地しているかだけで判定する。あわせて、iOSの「クロスフェードトランジションを優先」が有効だと位置が実座標ではなく `screenY: 0` で報告される既知の挙動も特別扱いしている（RN本体の `KeyboardAvoidingView` も同じ分岐を持つ）
- **UIKitは提示後の `modalPresentationStyle` 変更を無視する**。ファイル/差分ビューアの `pageSheet` / `fullScreen` は開いた瞬間の値で凍結し、ヘッダーの上余白も同じ値から決めること。片方だけ幅に追従させると、開いたまま幅が変わったときにヘッダーがステータスバーへ潜る
- **`DrawerLockMode.LOCKED_CLOSED` はスワイプしか止めない**。RNGHの `openDrawer()` は lock mode を見ずにアニメーションを走らせるので、`useWsDrawer().open()` 側でも幅を見て塞ぐ必要がある（塞がないと中身が null の見えないパネルが開く）
- **`presentationStyle="fullScreen"` のModalはサイドバーごと画面を奪う**。ファイル/差分ビューアは`regular`では`pageSheet`にする
- `@expo/config-plugins` の `withOrientation` は `ios.infoPlist.UISupportedInterfaceOrientations` を明示すると上書きをスキップする。これを使ってiPhoneはportrait固定のまま、iPadだけ4方向を許可している（`app.json`。上の「コメントを書けないファイルへの変更一覧」も参照）

### `expo prebuild` は使えない（2026-08-05、iPad対応時に実地で判明）

**`app/mobile` では `npx expo prebuild` を実行してはいけない。** iPad対応で `app.json` に `ios.supportsTablet: true` を入れた際、それを反映しようと `--clean` **無し**で実行したところ、次が起きた:

- `- Clearing ios` → `✔ Cleared ios code` と表示され、**`--clean` を付けていないのに `ios/` が丸ごと作り直された**（SDK 57の挙動）
- Xcodeプロジェクト名が `ParaCodeMobile` → `ParaCode` に変わった（`expo.name` から導出されるため）
- **手動で追加した `NotifyExtension`（APNs用NSE）と `ParaCodeWidgets`（Live Activity）のターゲットが消えた**。これらはconfig pluginではなくXcode上で足したもので、prebuildは再現しない

`app/mobile/ios/` は `app/.gitignore` で無視されているため**gitで戻せない**。復旧は事前に取っておいたコピーからのrsyncで行った。

したがって**ネイティブ設定の変更は `ios/` へ直接当てる**。`app.json` の `ios.*` は「そういう意図である」ことを示すドキュメントとしてのみ機能し、成果物には自動で反映されない。実行するなら必ず `ios/`（Pods除く。1MB弱）を先に退避すること。

iPad対応で実際に手で当てた設定:

| 対象 | 変更 |
|---|---|
| `ios/ParaCodeMobile.xcodeproj/project.pbxproj` | `TARGETED_DEVICE_FAMILY = 1;` → `= "1,2";` を**6箇所**（本体・ParaCodeWidgets・NotifyExtension × Debug/Release）。拡張だけ1のままだと本体がiPad対応でも埋め込み検証で落ちる |
| `ios/ParaCodeMobile/Info.plist` | `UISupportedInterfaceOrientations~ipad` に4方向を追加（iPhone用の `UISupportedInterfaceOrientations` はportrait 2種のまま） |

**バージョンは全ターゲットで一致必須**（ずれるとApp Store Connectの検証で弾かれる）。今回0.3.0へ上げた際、本体だけ直すと NotifyExtension が 0.1.0 のまま残っていた。揃える箇所は `project.pbxproj` の `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` 各6箇所と、`ParaCodeMobile/Info.plist` ・ `NotifyExtension/Info.plist` の `CFBundleShortVersionString` / `CFBundleVersion`（`ParaCodeWidgets/Info.plist` は `$(MARKETING_VERSION)` 参照なので自動追従）。

**既知の制限（許容して出す）**: 幅700ptをまたぐリサイズ（Split Viewへの出入り）では、`(tabs)/_layout.tsx` が `NativeTabs` と `Tabs` のコンポーネント型そのものを入れ替えるため、タブ配下4画面が作り直される（ターミナルのWebViewの表示内容が消えて再同期がかかる）。選択中のタブとルート側スタック（`/agent`・`/browser` 等）は保たれる。iPhoneのiOS 26ネイティブタブバーを捨てないかぎり避けられないトレードオフなので、リサイズという明示操作に限って許容している。

**未対応（v2以降）**: ブラウザ/ターミナルを会話の横に並べるフローティングパネル（`app/mobile/mock/ipad.html` の案Bにあるドラッグ幅変更パネル）、Filesタブの2ペイン化、サイドバーの折りたたみ。現状は右カラム全体を覆うpush遷移。

## ビルド環境（macOS / Apple Silicon）

- Node: `.nvmrc`が指定する`24.17.0`を`mise`でプロジェクト固定（`mise.toml`）。システムのNode（v26.3.0）とは別
- 依存関係: `mise exec -- npm install`（約7分、1559パッケージ、致命的エラーなし）
- 開発起動: `mise exec -- bash scripts/code.sh`（初回はElectronダウンロード+コンパイルで時間がかかる。起動確認済み: 2026-07-01）

## 今後の方針候補（未確定、要議論）

- 優先実装ターゲットの選定（機能1〜3のうちfork版でしか解決できない部分から着手すべきか）
- ブランディング（`product.json`のnameShort/nameLong/アイコン等、名称は「Para Code」）
- ~~配布方式（Marketplace代替のOpen VSX方針、CI/署名/配布）~~ → 実装着手済み。詳細は「配布・自動アップデート基盤」セクション参照
