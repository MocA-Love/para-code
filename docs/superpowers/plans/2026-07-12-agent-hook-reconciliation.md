# Agent Hook Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude CodeまたはCodexの設定が外部から再保存されても、ユーザー定義hookを保持したままPara Code管理hookの不足だけを自動復旧する。

**Architecture:** 既存の安全なJSONマージ処理を再利用するreconcilerを追加し、設定ディレクトリの変更通知をデバウンスして再実行する。通知欠落に備えた低頻度監査も行い、shared processの破棄時にはwatcherとtimerを確実に解放する。

**Tech Stack:** TypeScript、Node.js `fs.watch`、VS Code Disposable/RunOnceScheduler、Mocha

## Global Constraints

- 設定ファイル全体をテンプレートで上書きしない。
- ディスク上の最新JSONを毎回読み、Para Code管理hookだけを追加・更新する。
- ユーザーおよび他ツールのhook、matcher、未知フィールドを保持する。
- 不正JSONと新しい未知のPara Code hookスキーマには書き込まない。
- watcherイベントを取りこぼしても定期監査で復旧する。
- 自己書き込みは同値判定により再書き込みしない。

---

### Task 1: Reconcilerの動作をテストで固定する

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHooksSetup.ts`

**Interfaces:**
- Consumes: `paradisMergeAgentHooksJson(existingRaw, managedEvents, hookCommand)`
- Produces: `ParadisAgentHooksReconciler`、`IParadisAgentHooksReconcilerOptions`

- [ ] **Step 1: 外部上書き後の再整合、デバウンス、定期監査、破棄を表す失敗テストを追加する**

テストでは一時homeを使い、ユーザーhookだけの設定へ外部上書きした後に`reconcile()`を呼び、ユーザーhookを残したままPara Code hookが戻ることを検証する。注入したwatcher/timerで変更通知の集約、監査呼び出し、dispose後の停止も検証する。

- [ ] **Step 2: 対象テストを実行し、reconciler未実装により失敗することを確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

Expected: `ParadisAgentHooksReconciler`がexportされていないためFAIL。

- [ ] **Step 3: 最小限のreconcilerを実装する**

`paradisAgentHooksSetup.ts`に、初回整合、親ディレクトリwatch、500msデバウンス、60秒監査、直列化された再整合、disposeを実装する。watch対象は`settings.json`と`hooks.json`だけに絞り、watch失敗時も監査は維持する。

- [ ] **Step 4: 対象テストを再実行して成功を確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

Expected: 全テストPASS。

### Task 2: Shared processのライフサイクルへ統合する

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

**Interfaces:**
- Consumes: `ParadisAgentHooksReconciler`
- Produces: shared processに登録されたreconciler disposable

- [ ] **Step 1: 起動と破棄の契約を検証する失敗テストを追加する**

reconcilerの`start()`が初回整合を開始し、`dispose()`がwatcher・デバウンス・監査timerを全て破棄することを検証する。

- [ ] **Step 2: 対象テストを実行して期待した失敗を確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

Expected: ライフサイクル契約未実装によりFAIL。

- [ ] **Step 3: serviceの一回限りsetupをreconciler登録へ置き換える**

`ParadisAgentBrowserService`のconstructorでreconcilerを`this._register(...)`し、既存のshell env resolverを渡して開始する。初回処理の失敗はログに残してshared process起動を妨げない。

- [ ] **Step 4: 対象テストを再実行して成功を確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

Expected: 全テストPASS。

### Task 3: 回帰検証・自己レビュー・コミット

**Files:**
- Review: 本計画で変更した全ファイル

**Interfaces:**
- Consumes: Tasks 1–2の実装
- Produces: 検証済みコミット

- [ ] **Step 1: 対象テストと型・lint検証を実行する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts`

Run: リポジトリで対象ファイルに適用される既存の型検査・eslintコマンド。

Expected: exit code 0。

- [ ] **Step 2: 差分を自己レビューする**

`git diff --check`、`git diff --name-only HEAD`、`git diff HEAD`を確認し、ユーザーhook保持、競合時の最新読込、無限ループ防止、エラー処理、disposable解放、機密情報混入を点検する。CRITICAL/HIGHがあれば修正して再検証する。

- [ ] **Step 3: 変更だけをコミットする**

Run: `git add docs/superpowers/plans/2026-07-12-agent-hook-reconciliation.md src/vs/paradis/contrib/agentBrowser/node/paradisAgentHooksSetup.ts src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentHooksSetup.test.ts && git commit -m "fix: keep managed agent hooks reconciled"`

Expected: commit成功。pushは行わない。
