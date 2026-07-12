# Claude Hook Version Probe Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Codeのバージョン取得を15秒タイムアウトと最大3回の再試行で自己回復させ、成功後に対応する追加hooksを登録する。

**Architecture:** `paradisAgentHooksSetup.ts` 内で、実行ファイル解決とプロセス実行を1回分のプローブ関数へ集約する。`ParadisAgentHooksReconciler` は成功結果だけをキャッシュし、失敗回数を保持して既存の60秒監査ごとに最大3回まで再試行する。

**Tech Stack:** TypeScript、Node.js `child_process.execFile`、VS Code `findExecutable`、既存のshared processログサービス

## Global Constraints

- バージョン取得タイムアウトは15秒とする。
- 最大試行回数は初回を含め3回とする。
- バージョン不明時は基本hooksだけを登録する。
- 成功したバージョンだけをプロセス存続中キャッシュする。
- 既存ユーザーhooks、イベント一覧、最低対応バージョン、Codex hooksの挙動は変更しない。
- 認証情報や環境変数全体をログへ出力しない。
- ユーザー指示により、テストコード追加・テスト実行・コミットは行わない。

---

### Task 1: 診断可能なClaudeバージョンプローブ

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHooksSetup.ts`

**Interfaces:**
- Consumes: `shellEnvResolver: () => Promise<NodeJS.ProcessEnv>`、`findExecutable(command, cwd, paths, env)`
- Produces: 1回の取得結果を表す内部discriminated unionと、15秒制限で実行する内部プローブ関数

- [ ] **Step 1: 共通実行ファイル解決を導入する**

`../../../../base/node/processes.js` から `findExecutable` をimportする。解決済み環境を渡して `claude` の絶対パスを取得し、未検出を明示的な失敗結果にする。

- [ ] **Step 2: プローブ結果を型で区別する**

成功時はバージョン出力、失敗時は `shell-env`、`not-found`、`spawn`、`timeout`、`exit`、`unparseable` の段階と安全な診断情報を返す内部型を追加する。

- [ ] **Step 3: タイムアウトを15秒へ変更する**

絶対パスへ `execFile(executable, ['--version'], ...)` を実行し、`timeout: 15_000` とする。終了コード0でも既存のバージョン解析が受理できない出力は `unparseable` として扱う。

- [ ] **Step 4: 安全なwarningログを追加する**

呼び出し側が試行番号と失敗段階を出力できるようにする。環境変数全体は出力せず、実行ファイルパス、エラーコード、終了コード、signal、短く制限したstderrだけを保持する。

### Task 2: 最大3回の再試行と成功キャッシュ

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHooksSetup.ts`

**Interfaces:**
- Consumes: Task 1の1回分プローブ関数
- Produces: `ParadisAgentHooksReconciler` の成功キャッシュ、失敗回数、打ち切り状態

- [ ] **Step 1: 失敗結果を永続キャッシュするPromiseを除去する**

現在の `claudeVersionPromise` を、成功済みバージョンと試行中Promiseを分けた状態へ置き換える。同時reconcileが同じプローブを重複実行しないよう、進行中Promiseだけは共有する。

- [ ] **Step 2: 最大3回の状態遷移を実装する**

初回reconcileで1回目を実行し、失敗後は既存の60秒監査で2回目、3回目を実行する。3回目の失敗後はプロセス存続中の再試行を止める。成功時は失敗回数に関係なくバージョンを保存する。

- [ ] **Step 3: hooks整合処理を維持する**

未取得・失敗・打ち切り中は `PARADIS_CLAUDE_HOOK_EVENTS` のみをマージする。成功した監査回では既存のバージョン境界関数を通じて追加イベントを含め、冪等マージする。

- [ ] **Step 4: 状態ログを完成させる**

各失敗で `attempt N/3` と段階をwarning出力し、3回目には再試行打ち切りを明記する。成功時は既存infoログへ取得バージョンと有効イベントを出す。初回失敗時の `unknown` を成功済み情報のように一度だけ固定しない。

### Task 3: 静的確認と引き渡し

**Files:**
- Review: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHooksSetup.ts`
- Review: `docs/superpowers/specs/2026-07-13-claude-hook-version-probe-recovery-design.md`

**Interfaces:**
- Consumes: Tasks 1–2の変更
- Produces: ユーザーが実行するテスト観点と変更ファイル一覧

- [ ] **Step 1: 差分を目視確認する**

認証情報のログ出力、未確認hookのfail-open、Codex側の変更、既存ユーザーhookのマージ変更が含まれていないことを確認する。

- [ ] **Step 2: ユーザー向けテスト観点を整理する**

ユーザーが、初回失敗後の監査再試行、3回打ち切り、成功後の追加hook登録、成功後の再プローブ抑止を確認できるよう、対象ログと設定ファイルを引き渡しに記載する。
