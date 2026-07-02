<!-- allow-any-unicode-comment-file (Para Code) -->
# Para Code — 仕様・ロードマップ（SPEC）

このドキュメントは Para Code の「何を作っているか / どこまで出来ているか / 次に何をやるか」を、
別の LLM やエージェントが単独で読んで着手できるようにまとめたものです。

- **実装ルール（厳守）**: `CLAUDE.md` — コンフリクト最小化のパッチ規約。着手前に必ず読む。
- **経緯・落とし穴の記録**: `NOTES.md` — なぜこうなっているかの背景。
- この SPEC は「意図と現状」、`CLAUDE.md` は「守るべき書き方」、`NOTES.md` は「過去の教訓」。役割が違う。

---

## 1. プロジェクトの目的

`microsoft/vscode` を fork した **社内向けエディタ「Para Code」**。目的は、拡張機能APIの境界に縛られず、
AIエージェント（Claude Code CLI / Codex CLI 等）と密結合した開発体験をネイティブに作り込むこと。

- 配布は社内限定（VSIX拡張ではなく fork 版エディタ本体を配る）。macOS / Apple Silicon が第一ターゲット、Win/Linux も視野。
- Marketplace の代わりに **Open VSX**（`product.json` で切替済み）。
- **今後も定期的に upstream を取り込み続ける**前提。だから個々のパッチはコンフリクトを最小化する書き方に統一する（`CLAUDE.md`）。

### 設計思想（要約 / 詳細は CLAUDE.md）
- 機能の野心はフルフォーク相当に広げてよいが、**既存ファイルへの変更は最小限**（1箇所・数行の「差し替えポイント」だけ）。
- ロジック本体は**新規ファイル**に置く。新規機能は原則 `src/vs/paradis/` か `src/vs/sessions/contrib/<feature>/` に隔離。
- 既存ファイルを触る箇所は `// PARA-PATCH:` マーカー、fork独自の新規ファイルは冒頭に `// PARA-CODE:` マーカー。
  `grep -rn "PARA-PATCH" src/` と `grep -rl "PARA-CODE:" src/` で全変更点を機械的に列挙できる状態を保つ。
- 通常ウィンドウ向けの新規 contribution は `src/vs/paradis/paradis.common.contribution.ts`（web/desktop共通）または
  `paradis.electron-browser.contribution.ts`（Electron専用）への import 追記で登録する。
  **`src/vs/sessions/sessions.common.main.ts` は Agent Sessions ウィンドウ専用で通常ウィンドウでは実行されない**（NOTES.md 参照）。

### 現状の規模感（upstream からの乖離）
- `src/` の既存ファイルへの改変は **22ファイル / 実質 +235行程度**（VS Code本体 約224万行の ~0.01%）。
- 機能本体は **新規18ファイル / ~4,000行** に隔離。
- fork独自コミットは `git log --grep '^para:'` で一覧できる。`main` は upstream を1コミットに squash したベース（`21e6e7d858c`）＋ para: コミット群。

---

## 2. 実装ステータス一覧

| # | 機能 | 状態 | 主なコミット / 置き場所 |
|---|---|---|---|
| ブランディング | Para Code 名称 + Open VSX | ✅ 完了 | `product.json`（`6021a3560c1`） |
| 機能2 | ターミナル2Dグリッド分割（田の字） | ✅ 完了 | `src/vs/sessions/contrib/terminalGrid/`（`0d9a6819ef2`） |
| 付随 | セカンダリActivity Bar + SCMデフォルト右配置 | ✅ 完了 | `1efa08f2caa` |
| 付随 | Paradis設定セクション + ウィンドウ透明度 | ✅ 完了（ブラー保留） | `src/vs/paradis/contrib/windowTransparency/`（`6a206d7ad47`） |
| 付随 | アプリアイコン差し替え | ✅ 完了 | `336e7abd85f` |
| 付随 | Primary color `#09AFD9` 系へ統一 | ✅ 完了 | `688ec7e9e95` |
| 機能3 | ブラウザページ⇔ターミナルペインのエージェント紐付け | ✅ 完了 | `src/vs/paradis/contrib/agentBrowser/`（`022c48a5607` 他） |
| 付随 | 内蔵ブラウザ右クリックに Copy Element | ✅ 完了 | `2ae4a04cf06` |
| 付随 | 通知トーストで内蔵ブラウザを一時停止しない | ✅ 完了 | `d9e174be396` |
| **機能1** | **複数リポジトリのワークスペース即時切り替え** | ✅ **完了（Phase 0〜4、実機検証済み）** | `src/vs/paradis/contrib/workspaceSwitch/`、下記 §4 |

---

## 3. 実装済み機能の詳細と残課題

### 機能2: ターミナル2Dグリッド分割
- 実体: `SessionTerminalGridGroup`（`ITerminalGroup` を実装、base `Grid` で真の2Dレイアウト）。upstream の単一軸 `TerminalGroup` を
  `terminalGroupService.ts` の DI ファクトリ1点差し替えで置換。
- 使い方: コマンドパレット `Split Terminal Up/Down/Left/Right`、キーバインド `Ctrl+K` → `Alt+↑/↓/←/→`、
  ターミナルタブのドラッグ&ドロップ（4方向、capture フェーズでupstreamのDnDを横取り）。
- 既知の制約:
  - `resizePanes`（1D比率の永続復元）と `moveInstance`（フラット配列 index）は2Dに完全対応せず、レイアウト復元は1列に劣化しうる（機能上は許容）。
  - セルの高さは CSS で `width/height:100%` 明示が必須（過去バグ: 未指定でターミナルが1px高に潰れた）。

### 機能3: ブラウザ⇔エージェント紐付け（`src/vs/paradis/contrib/agentBrowser/`）
社内ブラウザのページを、ターミナルペインで動く外部エージェントCLI（Claude Code / Codex）から読み書きさせる。

- **トークン注入**: 全ターミナル生成のチョークポイント `terminalInstanceService.createInstance` で、
  PTY起動前に `PARA_CODE_TERMINAL_PANE_ID`（一意トークン） / `PARA_CODE_MCP_PORT_FILE` / `PARA_CODE_CDP_URL` を env 注入。
  永続ターミナル再接続時は `{persistentProcessId → token}` を `IStorageService` で復元。
- **MCPサーバー（read系）**: shared process 常駐の自前 JSON-RPC over HTTP（固定ポート `47286`、専有時のみ動的。実ポートは
  `<userDataDir>/paradis-browser-mcp.json`）。ツール: `get_shared_page` / `read_page` / `get_cdp_endpoint`。
  依存ゼロの stdio シム `paradisBrowserMcpShim.js` が CLI からの stdio MCP を HTTP に橋渡し（毎起動でポートファイル解決）。
- **CDPゲートウェイ（操作系）**: chrome-devtools-mcp / browser-use を CDP 直結させる。Electron 本体を常時
  loopback限定 `--remote-debugging-port=0` で起動し、ゲートウェイが `/json/*`・`/devtools/*` を per-pane フィルタ
  （バインド済みページの targetId 以外は `Target.attachToTarget`/`getTargets` から除外、`createTarget`/`Browser.close` 拒否）。
  呼び出し元ペイン識別は3段構え: ①URLクエリ `?pane=` ②接続元PIDのenv読取（macOS `ps eww` / Linux `/proc/environ`）
  ③祖先PIDチェーン⇔workbench同期のシェルPID表の突合（Windows主経路）。
- **UI（Phase C）**: `paradisBindingDialog.ts`（自前モーダル、`--vscode-*` トークン、mock準拠）。ブラウザツールバーボタン、
  コマンド `Paradis: Open Agent Browser Binding`、ターミナルグリッドセルのインジケータ、ステータスバー項目から開く。
  バインドはトークンさえあれば常に可能（エージェント検出やMCP接続状態でブロックしない）。
- セットアップは `Paradis: Copy MCP Setup Command`（Claude Code / Codex / browser-use を選んでスニペットをコピー）。
  Claude Code は `${PARA_CODE_CDP_URL:-...}` を接続時展開、Codex は `env_vars` で転送。
- 既知の制約:
  - **1ペイン = 共有1ページ**。`Target.createTarget`（MCPからの新規タブ生成）は非対応。
  - **Linux/Windows のピア解決経路は未検証**（実機確認は macOS のみ）。
  - シムは `out/` の1ファイル実行前提で、**製品パッケージング未対応**（dev起動では動作）。
  - ウィンドウリロードでバインディングは消える（トークンは復元されるので再共有で同トークン、CLI再設定は不要）。

### 付随機能のメモ
- **ウィンドウ透明度**: `paradis.window.transparency.enabled/opacity`。`BrowserWindow.setOpacity()` を使うフラット透過。
  「背景だけぼかす」ブラー/vibrancy は**保留**（Warp調査の結論: 真のクロスプラットフォーム連続ブラーはOS別実装が必要でリスク大）。
  将来やるなら macOS は公式 vibrancy か非公開 `CGSSetWindowBackgroundBlurRadius` 系、Windows は Acrylic、Linux はコンポジタ依存。
- **セカンダリActivity Bar**: `ActivitybarPart` を part id パラメータ化し、grid上に独立Part `AUXILIARY_ACTIVITYBAR_PART` として追加。
  `layout.ts` 等コア6ファイルに PARA-PATCH。SCM は `scm.contribution.ts` でデフォルト `AuxiliaryBar` に。

---

## 4. 機能1 — 複数リポジトリのワークスペース即時切り替え（✅ 実装済み、2026-07-02）

サイドバー（FleetView 風）で複数リポジトリを列挙し、クリック / キーバインドで瞬時に作業スペースを切り替える。
非アクティブなリポジトリのエディタ/ターミナル/ブラウザは**破棄せず隠して**隔離し、切り替えで戻ると完全復元される
（Superset 方式）。実装: `src/vs/paradis/contrib/workspaceSwitch/`。詳細な落とし穴の記録は `NOTES.md` の同名セクション。

**アーキテクチャ**: 単一ウィンドウ・単一の固定 `.code-workspace`（`~/.para-code/para.code-workspace`、workspace id は
configPath のみ依存で folders 非依存 → WORKSPACE スコープ storage を共有）のまま、`IWorkspaceEditingService.updateFolders`
で folders を丸ごと入れ替える。Extension Host 再起動は `relauncher.contribution.ts` への1行 PARA-PATCH で抑止
（`isSessionsWindow` は Sessions ウィンドウ専用で転用不可、と実機確定済み）。

- **使い方**: `Paradis: Initialize Multi-Repo Workspace` → サイドバーの Workspaces ビュー（+ボタン / `Paradis: Add Repository...`）で
  リポジトリ登録 → クリックまたは `ctrl+cmd+1..9` / `ctrl+cmd+[` `]`（mac、win/linux は `ctrl+alt+…`）で切り替え。
- **エディタ**: upstream 純正 `saveWorkingSet`/`applyWorkingSet` でリポジトリごとに退避/復元（分割レイアウト・タブ順含む、
  リロード跨ぎ永続）。dirty エディタは閉じずに持ち越し（upstream 仕様、データ保護）。
- **ターミナル**: グループ単位の非破壊 park/unpark（`terminalGroupService.ts` PARA-PATCH）。PTY・スクロールバック生存、
  タブリスト/パネルからは消える。park 中もレイアウト永続化に参加（`terminalService.ts` PARA-PATCH）しリロード後に再 park。
- **ブラウザ**: 切り替え中の dispose を veto（upstream 純正フック）して WebContentsView を生存させ、復帰時は同一 id へ
  再接続 = **リロードなし**（`window.__marker` 一致で実証）。手動クローズは通常どおり破棄。機能3のバインディングは
  token/pageId 不変のため自動追従。
- **Git/SCM**: フォルダ入れ替えに自動追従（エディタ入れ替えを updateFolders より先に行うことで旧リポの SCM 残留を防止）。
  コミットメッセージ入力途中テキストも退避/復元。リポジトリ登録時に workspace trust へ自動追加。
- **既知の制限**: ブラウザページはウィンドウリロード跨ぎでは再ロード（URL は復元）。Cookie は全リポジトリ共有。
  切り替え連打は Sequencer で直列化。パネル開閉状態はセッション内のみ保持（リロードで初期化）。

---

## 5. 未整理のバックログ / 将来検討

- 機能3: `Target.createTarget` 対応（複数ページ共有）、Linux/Windows ピア解決の実機検証、製品パッケージングでのシム同梱、
  MCP接続実績の永続化。
- 機能1: ブラウザ Cookie のリポジトリ別分離（WebContentsView 生成時のセッション決定への介入が必要）、
  パネル開閉状態のリロード跨ぎ永続化、リポジトリごとのアクティブターミナルグループ復元、
  Workspaces ビューの並べ替え / git ブランチ表示などの充実。
- ウィンドウブラー/vibrancy の本実装（保留中）。
- upstream 追従の運用（取り込み頻度・ブランチ戦略・`git rerere` 運用・CI）。現状 `main` は squash ベース。
- hygiene チェックとの恒常的な衝突（`product.json` の `extensionsGallery`、日本語コメントの unicode ルール）の整理（NOTES.md）。
- CI / 署名 / 配布パイプライン（社内配布）。

---

## 6. 他のLLM / エージェントが着手するときのガイド

1. **必読順**: この `SPEC.md` → `CLAUDE.md`（パッチ規約は厳守）→ 該当機能まわりの `NOTES.md`。
2. **ビルド環境**: Node は `.nvmrc` の `24.17.0` を `mise` でプロジェクト固定。依存は `mise exec -- npm install`。
3. **型チェック/lint/ビルド**:
   - `mise exec -- npm run typecheck-client`（0エラー必須）
   - `mise exec -- npx eslint <変更ファイル>`（0エラー0警告）
   - `mise exec -- npm run compile`（フルビルド。数分。`compile-client` の完了まで待つ）
4. **実機起動**: `pkill -f "Para Code.app/Contents/MacOS/Para Code"` で終了 →
   `VSCODE_SKIP_PRELAUNCH=1 mise exec -- bash scripts/code.sh`。
   - `preLaunch.ts` は `out/` が既存だとコンパイルをスキップするので、ソース変更後は先に `npm run compile` すること（過去バグ）。
   - shared process（機能3のMCP/CDP）は起動から20〜30秒遅延で立ち上がる。
5. **視覚検証**: 本アプリは常時 loopback remote-debugging が有効（実ポートは `<userDataDir>/DevToolsActivePort` の1行目）。
   CDP経由で workbench ページに接続し `Page.captureScreenshot` でスクショを撮って確認できる（scratchpad の `cdp-inspect.mjs` 参照）。
6. **コミット**: `para:` プレフィックス。既存ファイルを触ったら `PARA-PATCH`、新規ファイルは `PARA-CODE` マーカー。
   JSON/バイナリ等コメント不可のファイルは `NOTES.md` の変更一覧表に追記。**明示指示があるまで push しない**。

---

## 7. （記入待ち）オーナーのビジョン・優先度

> ここはオーナー（人間）が自由に追記する欄。上の §1〜§6 は現状の事実ベース。
> 「次に何を優先したいか」「機能1のUI/挙動のこだわり」「その他ほしい機能」などを書き足してください。
