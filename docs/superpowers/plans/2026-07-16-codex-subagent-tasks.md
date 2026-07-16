# Codex SubAgent Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CodexのSubAgent委譲をClaude Codeと同じActivity Taskとしてモバイルへ表示し、完了履歴も保持する。

**Architecture:** Relayの`ParadisAgentActivityTracker`で旧・新Codex collaboration itemを子Thread単位へ正規化する。spawnだけがTaskを作り、後続collaborationと`subAgentActivity`は同じTaskを更新する。Taskの`agentId`へ子Thread IDを保持し、モバイルのSubAgent詳細は表示名ではなくIDで確実に関連付ける。

**Tech Stack:** TypeScript, VS Code Node services, Mocha, React Native/Expo, Vitest.

## Global Constraints

- Task IDは`codex:<childThreadId>`とする。
- PlanとGoalはTaskへ変換しない。
- 親Turn終了だけではTaskを終了しない。
- ユーザー所有の未追跡ファイルを変更・コミットしない。
- テストコマンドはユーザーの明示指示がないため実行しない。
- プッシュは行わない。

---

### Task 1: Codex委譲Taskの回帰仕様を固定する

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/test/node/paradisAgentActivity.test.ts`

**Interfaces:**
- Consumes: `ParadisAgentActivityTracker.applyCodex(method, params, at)`。
- Produces: 旧形式・現行ドキュメント形式、spawn完了、後続状態更新、担当名更新を固定する回帰ケース。

- [ ] **Step 1: 既存Codex collaborationテストへTask期待値を追加する**
- [ ] **Step 2: 状態なしのspawn完了がTaskを完了扱いしないケースを追加する**
- [ ] **Step 3: 現行`collabToolCall`形式と後続waitによる状態更新ケースを追加する**
- [ ] **Step 4: `subAgentActivity`で担当名と再開状態を更新するケースを追加する**
- [ ] **Step 5: プロジェクト指示に従いテスト実行は省略し、実装前差分で期待値を確認する**

### Task 2: RelayでCodex collaborationをTaskへ正規化する

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisAgentActivity.ts`

**Interfaces:**
- Consumes: 旧`collabAgentToolCall`と現行ドキュメントの`collabToolCall` item。
- Produces: 子Thread ID、prompt、明示Agent状態を共通化し、`IParadisAgentActivityTask`へ収束させる内部処理。

- [ ] **Step 1: Task ID、label、assignee、Agent状態抽出の小さな純関数を追加する**
- [ ] **Step 2: 旧・新collaboration形式から対象子Threadを列挙する**
- [ ] **Step 3: spawn時だけTaskを作り、明示状態またはitem失敗から初期状態を決める**
- [ ] **Step 4: 後続collaborationの明示状態を既存Taskへ反映する**
- [ ] **Step 5: `subAgentActivity`の状態とagentPathを既存Taskへ反映する**
- [ ] **Step 6: 遅延イベント抑止、履歴上限、セッション終了、staleの既存処理を維持する**

### Task 3: SubAgent詳細へTaskを関連付ける

**Files:**
- Modify: `app/mobile/src/store.ts`
- Modify: `app/mobile/src/agentActivityTree.ts`
- Modify: `app/mobile/src/agentActivityTree.test.ts`
- Modify: `app/mobile/app/agent-activity-detail.tsx`

**Interfaces:**
- Consumes: Relay Taskの任意`agentId`と従来の`assignee`。
- Produces: `agentActivityTasksForAgent(tasks, agent)`でIDを優先しつつ旧データも表示できる関連付け。

- [ ] **Step 1: ID関連付けと旧assignee互換の回帰ケースを追加する**
- [ ] **Step 2: モバイルTask型と受信境界へ上限500文字の`agentId`を追加する**
- [ ] **Step 3: 関連Task選択を純関数化し、SubAgent詳細画面から利用する**
- [ ] **Step 4: プロジェクト指示に従いテスト実行は省略し、差分を静的確認する**

### Task 4: 自己レビューとコミット

**Files:**
- Review: `docs/superpowers/specs/2026-07-16-codex-subagent-tasks-design.md`
- Review: `docs/superpowers/plans/2026-07-16-codex-subagent-tasks.md`
- Review: `src/vs/paradis/contrib/mobileRelay/node/paradisAgentActivity.ts`
- Review: `src/vs/paradis/contrib/mobileRelay/test/node/paradisAgentActivity.test.ts`
- Review: `app/mobile/src/store.ts`
- Review: `app/mobile/src/agentActivityTree.ts`
- Review: `app/mobile/src/agentActivityTree.test.ts`
- Review: `app/mobile/app/agent-activity-detail.tsx`

**Interfaces:**
- Consumes: 承認済み設計とTask 1・2・3の差分。
- Produces: 今回の対象ファイルだけを含むレビュー済みコミット。

- [ ] **Step 1: 仕様の各要件を差分へ対応付ける**
- [ ] **Step 2: `git diff --check`と対象ファイルの静的差分確認を行う**
- [ ] **Step 3: CRITICAL／HIGHのセキュリティ・品質問題がないことを確認する**
- [ ] **Step 4: 対象8ファイルだけをstageし、staged diffを再確認する**
- [ ] **Step 5: 単一コミットを作成し、プッシュしない**
