# Para Code - fork運用メモ

Paradis社内向けVS Codeフォーク。`microsoft/vscode`を`upstream`としてfork。

## 経緯（サマリ）

1. VS Code拡張機能（`paradis-dev-package`、`/Users/magu/github/paradis-dev-package`）として以下3機能を作ろうとした
   - 複数リポジトリのワークスペース即時切り替え（状態維持、非アクティブなものは非表示）
   - ターミナルの田の字型（縦横自由）分割
   - ブラウザタブ（CDP）⇔AIエージェントセッションの動的紐づけ
2. 拡張機能の範囲で実装を進めた結果:
   - 機能1は「本物のworkspaceFoldersを操作し、常にインデックス0に触れないダミーのアンカーフォルダを置く」方式で、**Extension Host再起動なしに安定動作することを実証済み**（`paradis-dev-package`の`src/workspaceSync.ts`参照）。これは拡張機能のままで解決できた
   - 機能2（ターミナル2Dグリッド）は`node-pty` + `xterm.js`の自作webviewターミナルで実現可能（`paradis-dev-package`の`src/terminalPanel.ts`）
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
- `origin`: `https://github.com/MocA-Love/para-code.git`（private）
- ブランチ運用は今後要検討（upstreamのタグを定期的に取り込む前提。マージ戦略は未確定）
- **`main`は履歴を1コミットに圧縮したもの**（`git checkout --orphan` + `git add -A`）。フルの履歴は`upstream`から`git log upstream/main`等で参照可能。理由は下記「pushトラブル」参照

## pushトラブルの記録（2026-07-01）

フル履歴（2,222,499オブジェクト、1.30 GiB）のまま`git push`すると、TCP接続が`CLOSED`または`CLOSE_WAIT`になって進捗ゼロのままハングする現象が複数回発生（`http.version HTTP/1.1`固定、`http.postBuffer`拡大、`http.lowSpeedLimit`設定を試しても解消せず）。原因はネットワーク経路側の問題と推測されるが特定はできていない。

対策として履歴を1コミットに圧縮（`git checkout --orphan squashed-base` → `git add -A`（`node_modules`/`.build`は`.gitignore`済みで除外される）→ `git commit --no-verify`（huskyのpre-commitフックが200万ファイル規模のインデックスに対して固まったためスキップ。通常の開発コミットではフックを飛ばさないこと）→ `git branch -m main`）してから再push。転送対象が19,683オブジェクト・LFS 272MB + 通常オブジェクト46MBまで減り、成功した。

**今後もし大きな変更を一括で加える場合、同様に転送量に注意すること。**

## hygieneチェックとproduct.jsonの既知の衝突

`gulpfile.hygiene.js`に「`product.json`に`extensionsGallery`キーを含めてはいけない」というMicrosoft本家向けのチェックがある（本家では公式Marketplace設定を別経路で注入するため、独自混入を防ぐルール）。私たちのforkはOpen VSX切り替えのために意図的に`extensionsGallery`を追加しているので、このチェックには**恒常的に引っかかる**。`product.json`を変更するコミットは`--no-verify`が必要になる。将来的には`gulpfile.hygiene.js`側にこのチェックの除外条件を追加するパッチを検討してもよい。

`mise.toml`のような新規追加ファイルも「Missing or bad copyright statement」でhygieneに引っかかる。Microsoftのコピーライトヘッダーを付けるのは適切ではないので、自分たちの新規ファイルに対するhygieneルールの扱いは今後整理が必要（`CLAUDE.md`のコンフリクト最小化ルール策定と合わせて検討）。

## コメントを書けないファイルへの変更一覧（2026-07-02整備）

`// PARA-PATCH:` / `// PARA-CODE:` マーカーはTS/JS/CSSのようなコメント構文を持つファイル専用。JSON（コメント非対応の厳密パース）やバイナリ資産にはマーカーを埋め込めないため、代わりにこの一覧を更新すること。upstream取り込み時、この一覧に載っているファイルはコンフリクトしやすい・または本来の意味が変わっていないか要確認。

| ファイル | 変更内容 | 理由 |
|---|---|---|
| `product.json` | `nameShort`/`nameLong`/`applicationName`/`dataFolderName`/`win32*`/`darwinBundleIdentifier`等ブランディング全般を「Para Code」向けに変更、`extensionsGallery`を追加（Open VSX）、`voiceWsUrl`を削除 | Phase 2ブランディング + Open VSX切り替え |
| `build/lib/i18n.resources.json` | `vs/sessions/contrib/terminalGrid` エントリを追加 | 新規contributionディレクトリの`localize()`利用に伴うi18nリソース登録 |
| `extensions/theme-defaults/themes/2026-dark.json` | primary accent色を`#3994BC`系→`#09AFD9`系（button/focusBorder/badge/選択背景等、約25箇所、アルファ値は維持）に置換 | ユーザー指定のブランドカラーへの統一 |
| `extensions/theme-defaults/themes/2026-light.json` | primary accent色を`#0069CC`系→`#0598BD`系（同上、白背景に対するコントラストを保つため若干暗めに調整）に置換 | 同上（ダーク/ライト両テーマでの一貫性） |
| `resources/darwin/code.icns` | アプリアイコンをユーザー指定画像に差し替え | ブランディング |
| `src/vs/paradis/contrib/watermark/browser/media/paradisWatermark.png` | 新規追加（fork所有バイナリ）。空エディタグループwatermarkのletterpress画像の差し替え先（`paradisWatermark.css`から参照） | ユーザー指定のwatermark画像への変更 |
| `src/vs/paradis/contrib/notifications/browser/media/sounds/*.mp3`（11ファイル: shamisen/arcade/ping/supersetquick/supersetdoowap/agentisdonewoman/codecompleteafrican/codecompleteafrobeat/codecompleteedm/comebacktothecode/shabalabadingdong） | 新規追加（fork所有バイナリ）。Superset (`apps/desktop/src/resources/sounds/`) のビルトイン着信音をそのまま移植。`FileAccess.asBrowserUri('vs/paradis/contrib/notifications/browser/media/sounds/<file>.mp3')` で参照（`paradisNotificationSoundPlayer.ts`） | 通知サウンド機能（Phase D）のビルトイン着信音アセット |

`git log --grep '^para:'`（コミットメッセージからの追跡）と合わせた二重の安全網として運用する。新しくJSON/バイナリファイルに変更を加えた場合は、必ずこの表に1行追記すること（`CLAUDE.md`の「既存ファイルへの変更が避けられない場合」ルール参照）。

## CDPゲートウェイとリモートデバッグ（agentBrowser、2026-07-02追加）

ブラウザページ⇔ターミナルペイン紐付け機能（`src/vs/paradis/contrib/agentBrowser/`）に、chrome-devtools-mcp / browser-use 等の既存ブラウザ自動化MCPをCDPで直結させる**CDPゲートウェイ**を追加した（Superset `apps/desktop` の cdp-gateway / cdp-filter-proxy 方式の移植）。

- **生のリモートデバッグポート（要注意）**: `src/main.ts` のPARA-PATCHで、Electron本体が常に `--remote-debugging-port=0`（動的割当）+ `--remote-debugging-address=127.0.0.1` で起動する。実ポートは `<userDataDir>/DevToolsActivePort` の1行目に書かれる。**この生ポートはフィルタ無しで全webContents（ワークベンチウィンドウ本体を含む）にアタッチできる**。Chromiumのremote-debuggingは127.0.0.1にのみバインドされる（`remote-debugging-address` でも明示済み）ため同一マシン内に限定されるが、リモートからのポートフォワード等でこのポートを外部公開してはならない。argv.json / CLI でユーザーが `remote-debugging-port` を明示した場合はそちらが優先される
- **ゲートウェイ**: shared processのagent-browser HTTPサーバー（固定既定ポート `47286`、専有時のみ動的フォールバック＋警告ログ。実ポートは常に `<userDataDir>/paradis-browser-mcp.json`）が `/json/*`・`/cdp/json/*`（GET）と `/devtools/{browser,page}/…`・`/cdp/devtools/…`（WebSocket upgrade）を提供し、上流＝生ポートへのプロキシ時に「呼び出し元ペインにバインドされたページのtargetId（とその子孫）以外は見えない・触れない」フィルタを適用する。`/cdp` プレフィックス無しも受けるのは、puppeteerが `--browserUrl` のパスを落として `/json/version` をルート直下に取りに来るため
- **呼び出し元ペインの識別（3段構え）**: (1) URLクエリ `?pane=<token>`、(2) loopbackピアPID（macOS: `lsof`、Linux: `ss`→`lsof`、Windows: `Get-NetTCPConnection`→`netstat -ano`）の祖先チェーンからenv `PARA_CODE_TERMINAL_PANE_ID` を読む（macOS: `ps eww`、Linux: `/proc/<pid>/environ`。Windowsは不可）、(3) workbenchから同期される「シェルPID⇔トークン」表と祖先チェーンの突合（Windowsの主経路）。実機検証はmacOSのみ、Linux/Windows経路は未検証
- ターミナルenvには `PARA_CODE_CDP_URL=http://127.0.0.1:47286/cdp` が注入される（chrome-devtools-mcpの `--browserUrl` にそのまま渡せる。再起動を跨いで同一文字列）。MCPツール `get_cdp_endpoint` で実URLを取得できる

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

## ビルド環境（macOS / Apple Silicon）

- Node: `.nvmrc`が指定する`24.17.0`を`mise`でプロジェクト固定（`mise.toml`）。システムのNode（v26.3.0）とは別
- 依存関係: `mise exec -- npm install`（約7分、1559パッケージ、致命的エラーなし）
- 開発起動: `mise exec -- bash scripts/code.sh`（初回はElectronダウンロード+コンパイルで時間がかかる。起動確認済み: 2026-07-01）

## 今後の方針候補（未確定、要議論）

- 優先実装ターゲットの選定（機能1〜3のうちfork版でしか解決できない部分から着手すべきか）
- ブランディング（`product.json`のnameShort/nameLong/アイコン等、名称は「Para Code」）
- 配布方式（Marketplace代替のOpen VSX方針、CI/署名/配布）
