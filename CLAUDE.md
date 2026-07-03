# Para Code — 実装ルール（厳守）

このリポジトリは `microsoft/vscode` を fork した独自エディタ（Para Code）です。**今後も定期的にupstreamを取り込み続ける前提**なので、以下のルールは全ての実装作業で厳守してください。背景・経緯は `NOTES.md` を参照。

## 大前提

- 機能の野心（何を作るか）はフルフォーク相当に広げてよいが、**個々のパッチはコンフリクトを最小化する書き方に統一する**
- 「新規ファイルで完結させる」を常に最優先の選択肢として検討し、既存ファイルの変更は最小限・1箇所に抑える

## 新規機能の置き場所

- **新機能のcontributionは必ず `src/vs/sessions/contrib/<feature>/` 配下の新規ディレクトリに置く**。`src/vs/workbench/contrib/` 配下には新規ファイルを作らない（upstreamが将来同名ディレクトリを追加する可能性があるため）
- `src/vs/sessions/` はMicrosoft自身が用意した「エージェント的ワークフロー専用のworkbenchレイヤー」（`vs/workbench`の隣に位置し、workbenchをimportできるが逆はできない）。私たちの機能もこのレイヤーの思想に沿って追加する
- 新規ファイル・クラス名には接頭辞（`session`または`para`）を付け、upstreamの将来ファイルとパスが衝突しないようにする（例: `sessionBrowserView.ts`）

## contributionの登録方法

- 登録は `registerWorkbenchContribution2(ID, Class, WorkbenchPhase.AfterRestored)` 方式に統一する（`src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts` が実例）。この呼び出し1行で自己完結させる
- **重要（2026-07-01判明、実機で確認済みの落とし穴）**: `src/vs/sessions/sessions.common.main.ts` への集約importは、**`isSessionsWindow` フラグが有効な特別な「Agent Sessionsウィンドウ」専用のエントリ（`vs/sessions/electron-browser/sessions(-dev).html`）からしかロードされない**。通常のPara Codeウィンドウは別エントリ（`vs/workbench/workbench.desktop.main.js` 経由の `vs/workbench/workbench.common.main.ts`）を使うため、`sessions.common.main.ts` に登録したcontributionは通常ウィンドウでは**一切実行されない**（`registerAction2`や`registerWorkbenchContribution2`の呼び出し自体がされないので、コマンドパレットにも出てこない）。判定ロジック実体: `src/vs/platform/windows/electron-main/windowImpl.ts` の `if (configuration.isSessionsWindow) { ... 'sessions...html' } else { ... 'workbench...html' }`
  - **通常ウィンドウでも動く必要がある機能**（ターミナル2Dグリッド等、実際のユーザー作業ウィンドウで使うもの）は、`sessions.common.main.ts` に頼らず、既存のDI差し替えポイント（例: `terminalGroupService.ts`）から**副作用importとして直接読み込む**こと。既にその1ファイルは差し替え目的でPARA-PATCH済みなので、追加のimport1行で新規の触るファイルは増えない
  - `sessions.common.main.ts` への登録は、**Agent Sessionsウィンドウ専用の機能（既存の`browserView`等）にのみ**使う。通常ウィンドウ／Sessionsウィンドウ両方で有効にしたい機能は、両方から副作用importするか、通常ウィンドウ側の恒久ロードポイントに一本化する
- 集約ファイル(`sessions.common.main.ts`)は「importが並んでいるだけ」なので、upstream取り込み時にコンフリクトしても解消は機械的（自分の行を残して再適用するだけ）。ただし上記の通り**これは特定windowタイプのみに効くことを常に意識すること**

### 通常ウィンドウ向け新規機能の登録先（2026-07-01追加、ウィンドウ透明度機能の実装時に整備）

上記の「`sessions.common.main.ts`は通常ウィンドウで一切効かない」問題を恒久的に解決するため、通常ウィンドウ専用の集約importの入り口として `src/vs/paradis/` を新設した（`src/vs/sessions/` と同様、`src/vs/workbench/` と兄弟のfork専用トップレベル領域）。

- **既存の差し替え済みファイルにピギーバックできる場合を除き**、通常ウィンドウ向けの新規機能は `src/vs/paradis/paradis.common.contribution.ts`（web/desktop共通）または `src/vs/paradis/paradis.electron-browser.contribution.ts`（Electron専用API依存）への **import追記だけ**で登録する。`workbench.common.main.ts` / `workbench.desktop.main.ts` 側への追加の変更は今後発生しない（各ファイルへの1行importは初回整備時に済ませてある）
- **重要（层分け）**: `workbench.common.main.ts` は `workbench.desktop.main.ts`（Electronデスクトップ）と `workbench.web.main.ts`（Web）の**両方から共有**されている。したがって `paradis.common.contribution.ts` に登録した contribution は Web ビルドでも読み込まれ、DIコンテナがインスタンス化を試みる
  - `INativeHostService` など **`electron-browser` レイヤーでのみ登録されるサービス**（`registerSingleton(INativeHostService, ...)` は `services/host/electron-browser/nativeHostService.ts` にのみ存在）をDI注入するcontributionを誤って `paradis.common.contribution.ts` 経由で読み込むと、Webビルドでサービス解決に失敗し起動時エラーになる
  - Electron専用API（`BrowserWindow` 操作、`INativeHostService` 経由の処理等）に依存する機能は、必ず `src/vs/paradis/contrib/<feature>/electron-browser/` 配下の新規ファイルに実装し、`paradis.electron-browser.contribution.ts`（`workbench.desktop.main.ts` からのみ読み込まれ、Webビルドには一切含まれない）へ登録する
  - Web/Desktop両方で安全な機能（設定スキーマ登録など、`common`/`browser` レイヤーのAPIのみに依存するもの）は `src/vs/paradis/contrib/<feature>/browser/` 配下に置き、`paradis.common.contribution.ts` へ登録する
- 実例: ウィンドウ透明度設定は、設定スキーマ登録（`registerConfiguration`）を `contrib/windowTransparency/browser/paradisSettings.contribution.ts` → `paradis.common.contribution.ts` 経由で登録し、実際に `INativeHostService.setWindowOpacity()` を呼んで反映する部分は `contrib/windowTransparency/electron-browser/paradisWindowTransparency.contribution.ts` → `paradis.electron-browser.contribution.ts` 経由で登録する、という形で分離した
- `eslint.config.js` の `code-import-patterns` にも `src/vs/paradis/**` 用のlayer定義（`PARA-PATCH`コメント付き）を追加済み。新しい `contrib/<feature>/` を追加する場合、既存の `src/vs/paradis/contrib/*/~` ルールがそのまま流用できるはずだが、editor機能など新しい依存が必要な場合は同ファイルの該当箇所を拡張すること
- `sessions.common.main.ts` への登録は、引き続き **Agent Sessionsウィンドウ専用機能（既存の`browserView`等）にのみ**使う

## 既存ファイルへの変更が避けられない場合

- 変更は**1箇所・最小行数**に抑える。ロジック本体は新規ファイルに書き、既存ファイルには「差し替えポイント」だけを作る
  - 実例: ターミナル2Dグリッド化では、`terminalGroup.ts`（`SplitPaneContainer`が単一`orientation`の`SplitView`に密結合）を直接改造せず、`ITerminalGroup`インターフェース準拠の新クラスを新規ファイルに書き、`terminalGroupService.ts:163`の`this._instantiationService.createInstance(TerminalGroup, ...)`という1行だけを差し替える
- 既存の具象クラスを改造するのではなく、**既存インターフェースに準拠した新実装クラスを新規ファイルで書き、DIのファクトリ/registerSingleton点で丸ごと差し替える**ことを常に検討する
- やむを得ず既存ファイルを編集する箇所には、必ず一貫したマーカーコメント `// PARA-PATCH: <理由>` を付ける。これにより `grep -r "PARA-PATCH"` で全パッチ点を機械的に列挙できる
- 既存の関数・メソッドのシグネチャは変更しない。拡張が必要な場合はオプショナル引数の追加、または新規メソッドの追加で対応する（既存呼び出し側の差分＝コンフリクト面を増やさない）
- `src/vs/base/`（`grid.ts`等の汎用エンジン）は import して再利用するのみとし、改変しない。ここはupstreamの変更頻度が高くコンフリクトしやすい領域

## 独自実装であることを明示するマーカー規約（2026-07-02整備、厳守）

upstreamを定期的に取り込み続ける前提のため、「どこが独自実装か」を機械的に判別できることが常に重要。以下の2種類のマーカーを**必ず**使い分けること。

1. **`// PARA-PATCH: <理由>`** — 既存（upstream由来）ファイルの一部にfork独自の変更を加えた箇所に付ける（既存の規約、上記参照）。`grep -rn "PARA-PATCH"` で個々のパッチ点を列挙できる。
2. **`// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.`** — fork独自に新規作成した**ファイル全体**の冒頭（コピーライトヘッダー直後）に付ける。CSSファイルは `/* PARA-CODE: ... */` 形式にする。`grep -rl "PARA-CODE:"` でfork所有ファイルの一覧を丸ごと列挙できる。
   - 新規ディレクトリ（`src/vs/paradis/`、`src/vs/sessions/contrib/<feature>/`）配下のファイルはディレクトリ構成自体で「fork独自」と分かるとはいえ、ファイル単体を開いた人にも一目で分かるようにするため省略しない
   - `grep -rl "PARA-CODE:" src/` と `grep -rn "PARA-PATCH:" src/` の2つのgrepで、コード上のfork変更点を完全に洗い出せる状態を維持する

**コメントを書けないファイル（JSON/バイナリ等）の場合**: 上記2つのマーカーは埋め込めないため、代わりに `NOTES.md` の「コメントを書けないファイルへの変更一覧」セクションに1行追記すること（対象ファイル・変更内容・理由）。`git log --grep '^para:'` と合わせた二重の安全網として運用する。新しくこの種のファイルに変更を加える場合、実装完了時に必ずこの表への追記を忘れないこと。

## コミット運用

- 私たちの変更はコミットメッセージを **`para:` プレフィックス**で統一する（例: `para: add multi-repo workspace switching`）。`git log --grep '^para:'` で自分たちのパッチだけを一覧できるようにするため
- `git rerere` を有効化しておく（`git config rerere.enabled true`）。過去に解消したコンフリクトパターンをupstream取り込み時に自動再適用させるため
- `product.json`への変更（`extensionsGallery`追加など）は本家の`gulpfile.hygiene.js`のhygieneチェックに意図的に抵触する。この場合のみ理由を明記した上で`--no-verify`を使ってよい。詳細は`NOTES.md`の「hygieneチェックとproduct.jsonの既知の衝突」を参照。**それ以外の通常の実装コミットではhygieneチェックを飛ばさないこと**

## 更新履歴（アプリ内changelog）の運用（2026-07-03整備、厳守）

歯車メニュー（左下）→「更新履歴」で、forkが加えた変更の一覧をユーザーがアプリ内で確認できる（`paradis.showChangelog` コマンド、`src/vs/paradis/contrib/releaseNotes/`）。

- 実体は `src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md`（Markdownプレビューで表示される）。パッケージ版への同梱は `build/gulpfile.vscode.ts` の `vscodeResources` にPARA-PATCH済み
- **ユーザー向けの機能追加・改善・修正を実装したら、その作業の中で `## 未リリース` セクションに箇条書きを1行追記する**（コミットに含める）。内部整備のみ（ビルド修正・リファクタ等）は書かない
- **リリースタグ（`v1.x.y-paracode-N`）を打つ前に、`## 未リリース` を `## paracode-N（YYYY-MM-DD）` に改名して確定する**（新しいバージョンが上）
- 書き方: ユーザー視点で「何ができるようになったか / 何が直ったか」を日本語の箇条書きで書く。項目が多いリリースは `### 新機能` / `### 改善` / `### 修正` に分ける。ファイル名・クラス名など内部実装の用語は書かない

## 実装前に必ず確認すること

- 実装する機能が「新規ファイル＋集約ファイルへの1行import」だけで完結できないか、まず検討する（機能1のワークスペース管理、機能3のブラウザビューは実例としてこのパターンで完結している）
- 既存クラスを改造する以外に方法がなさそうに見える場合でも、DI/インターフェース境界での差し替えができないか一度立ち止まって検討する
- 判断がつかない場合は実装前にarchitectエージェント等で実際のソースを読んで裏付けを取ってから進める（推測で設計しない）

## 未検証・要確認事項

- ~~機能1で`isSessionsWindow`フラグがどの条件で有効になるか未検証~~ → **検証済み（2026-07-02）**: `isSessionsWindow` は「開くworkspaceのconfigPathが専用の`agentSessionsWorkspace`と一致するか」で自動決定され、trueだとHTMLエントリ自体が切り替わるため通常ウィンドウには転用不可。機能1は `relauncher.contribution.ts` への1行PARA-PATCH（`isParadisManagedWorkspaceWindow()`）で解決済み。詳細は `NOTES.md` の「機能1: ワークスペース即時切り替え」参照
