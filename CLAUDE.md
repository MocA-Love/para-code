# Para Code — 実装ルール（厳守）

このリポジトリは `microsoft/vscode` を fork した社内向けエディタ（Para Code）です。**今後も定期的にupstreamを取り込み続ける前提**なので、以下のルールは全ての実装作業で厳守してください。背景・経緯は `NOTES.md` を参照。

## 大前提

- 機能の野心（何を作るか）はフルフォーク相当に広げてよいが、**個々のパッチはコンフリクトを最小化する書き方に統一する**
- 「新規ファイルで完結させる」を常に最優先の選択肢として検討し、既存ファイルの変更は最小限・1箇所に抑える

## 新規機能の置き場所

- **新機能のcontributionは必ず `src/vs/sessions/contrib/<feature>/` 配下の新規ディレクトリに置く**。`src/vs/workbench/contrib/` 配下には新規ファイルを作らない（upstreamが将来同名ディレクトリを追加する可能性があるため）
- `src/vs/sessions/` はMicrosoft自身が用意した「エージェント的ワークフロー専用のworkbenchレイヤー」（`vs/workbench`の隣に位置し、workbenchをimportできるが逆はできない）。私たちの機能もこのレイヤーの思想に沿って追加する
- 新規ファイル・クラス名には接頭辞（`session`または`para`）を付け、upstreamの将来ファイルとパスが衝突しないようにする（例: `sessionBrowserView.ts`）

## contributionの登録方法

- 登録は `registerWorkbenchContribution2(ID, Class, WorkbenchPhase.AfterRestored)` 方式に統一する（`src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts` が実例）。この呼び出し1行で自己完結させる
- 集約importの追記先は **fork所有の `src/vs/sessions/sessions.common.main.ts`**（「sessions contributions」region、447〜494行付近）に限定する。**upstream所有の `src/vs/workbench/workbench.common.main.ts` は触らない**
- この集約ファイルは「importが並んでいるだけ」なので、upstream取り込み時にコンフリクトしても解消は機械的（自分の行を残して再適用するだけ）

## 既存ファイルへの変更が避けられない場合

- 変更は**1箇所・最小行数**に抑える。ロジック本体は新規ファイルに書き、既存ファイルには「差し替えポイント」だけを作る
  - 実例: ターミナル2Dグリッド化では、`terminalGroup.ts`（`SplitPaneContainer`が単一`orientation`の`SplitView`に密結合）を直接改造せず、`ITerminalGroup`インターフェース準拠の新クラスを新規ファイルに書き、`terminalGroupService.ts:163`の`this._instantiationService.createInstance(TerminalGroup, ...)`という1行だけを差し替える
- 既存の具象クラスを改造するのではなく、**既存インターフェースに準拠した新実装クラスを新規ファイルで書き、DIのファクトリ/registerSingleton点で丸ごと差し替える**ことを常に検討する
- やむを得ず既存ファイルを編集する箇所には、必ず一貫したマーカーコメント `// PARA-PATCH: <理由>` を付ける。これにより `grep -r "PARA-PATCH"` で全パッチ点を機械的に列挙できる
- 既存の関数・メソッドのシグネチャは変更しない。拡張が必要な場合はオプショナル引数の追加、または新規メソッドの追加で対応する（既存呼び出し側の差分＝コンフリクト面を増やさない）
- `src/vs/base/`（`grid.ts`等の汎用エンジン）は import して再利用するのみとし、改変しない。ここはupstreamの変更頻度が高くコンフリクトしやすい領域

## コミット運用

- 私たちの変更はコミットメッセージを **`para:` プレフィックス**で統一する（例: `para: add multi-repo workspace switching`）。`git log --grep '^para:'` で自分たちのパッチだけを一覧できるようにするため
- `git rerere` を有効化しておく（`git config rerere.enabled true`）。過去に解消したコンフリクトパターンをupstream取り込み時に自動再適用させるため
- `product.json`への変更（`extensionsGallery`追加など）は本家の`gulpfile.hygiene.js`のhygieneチェックに意図的に抵触する。この場合のみ理由を明記した上で`--no-verify`を使ってよい。詳細は`NOTES.md`の「hygieneチェックとproduct.jsonの既知の衝突」を参照。**それ以外の通常の実装コミットではhygieneチェックを飛ばさないこと**

## 実装前に必ず確認すること

- 実装する機能が「新規ファイル＋集約ファイルへの1行import」だけで完結できないか、まず検討する（機能1のワークスペース管理、機能3のブラウザビューは実例としてこのパターンで完結している）
- 既存クラスを改造する以外に方法がなさそうに見える場合でも、DI/インターフェース境界での差し替えができないか一度立ち止まって検討する
- 判断がつかない場合は実装前にarchitectエージェント等で実際のソースを読んで裏付けを取ってから進める（推測で設計しない）

## 未検証・要確認事項

- 機能1（ワークスペース切り替え）で`IWorkspaceEditingService.updateFolders(0, 1, ...)`を呼ぶ際、`isSessionsWindow`フラグ（Extension Host再起動をスキップする特権）が実際にどの条件で有効になるか未検証。通常のworkbenchウィンドウで動くのか、実際に「Sessions Window」モード（`WindowEnablement.Sessions`）を有効にしたウィンドウでしか機能しないのか、機能1のネイティブ実装に着手する際に実機で確認すること
