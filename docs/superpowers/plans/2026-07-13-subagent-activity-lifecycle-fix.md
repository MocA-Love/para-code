# SubAgent Activity Lifecycle Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 親Agentのターン終了と子Agentの終了を分離し、モバイルの固定ヘッダーへ実際に実行中の子AgentとTaskだけを表示する。

**Architecture:** Relayのactivity trackerはClaudeの`SubagentStop`／`TaskCompleted`とCodexの`collabAgentToolCall.agentsStates`を子状態の正本とする。親ターン終了は親のライブ表示と未完了compactionだけを終了し、子状態は変更しない。モバイルは`running`だけを実行中として数え、`idle`は履歴画面の待機状態として保持する。

**Tech Stack:** TypeScript, VS Code Node services, Mocha, React Native/Expo, Vitest.

## Global Constraints

- 現行Claude Code 2.1.207と現行Codex CLI 0.144.1を対象にし、旧バージョン互換処理は追加しない。
- 親チャットのroot transcript正規化とCodex root thread除外は維持する。
- 完了履歴と待機履歴は削除せず、固定ヘッダーの実行中数だけから除外する。
- ユーザー所有の未コミット変更と未追跡ファイルをコミットしない。
- プッシュとリリースは行わない。

---

### Task 1: 親ターンと子ライフサイクルの分離

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisAgentActivity.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Test: `src/vs/paradis/contrib/mobileRelay/test/node/paradisAgentActivity.test.ts`

**Interfaces:**
- Consumes: Claude hook event名、Codex app-server item lifecycle、rolloutのturn timeline。
- Produces: `endTurn(at)`でcompactionだけを終了し、`endSession(reason, at)`でセッション終了時だけ子AgentとTaskを終了するtracker API。

- [ ] **Step 1: 親ターン完了後も実行中SubAgentとTaskが維持される失敗テストを書く**
- [ ] **Step 2: `npm run typecheck-client`後、対象Mochaを実行して既存`endTurn`がテストを失敗させることを確認する**
- [ ] **Step 3: tracker APIを親ターン終了とセッション終了へ分割し、Claude/Codexの呼び出し元を正しいAPIへ接続する**
- [ ] **Step 4: 型検査と対象Mochaを再実行し、個別終了イベント・stale処理・compaction終了も通ることを確認する**

### Task 2: ヘッダーの実行中判定統一

**Files:**
- Modify: `app/mobile/src/agentActivityTree.ts`
- Modify: `app/mobile/src/agentActivityTree.test.ts`
- Modify: `app/mobile/src/components/agentActivityCard.tsx`
- Modify: `app/mobile/app/agent.tsx`
- Modify: `app/mobile/app/agent-activity.tsx`

**Interfaces:**
- Consumes: `AgentActivityStatus`。
- Produces: `isRunningAgentActivity(status)`。固定ヘッダー、カード、一覧メトリクスが同じ判定を共有する。

- [ ] **Step 1: `running`だけが実行中で、`idle`と終端状態が実行中でない失敗テストを書く**
- [ ] **Step 2: mobile typecheck後に対象Vitestを実行し、関数未実装で失敗することを確認する**
- [ ] **Step 3: 純関数を実装し、3画面の重複判定を置き換える**
- [ ] **Step 4: mobile typecheckと全Vitestを実行する**

### Task 3: 一連対応の回帰レビューとコミット

**Files:**
- Review: commit `15746d36fb1`から現在までのSubAgent、Codex resume、親チャット、PC処理中連携の対象差分。
- Commit: この計画とTask 1、Task 2の対象ファイルだけ。

**Interfaces:**
- Consumes: 承認済み設計`docs/superpowers/specs/2026-07-13-subagent-hierarchy-and-codex-resume-design.md`と全検証結果。
- Produces: 根本原因を回帰テストで固定した単一コミット。

- [ ] **Step 1: `git diff`を仕様の検証パターンとセキュリティ・品質観点で自己レビューする**
- [ ] **Step 2: `npm run typecheck-client`、対象Nodeテスト、mobile全テスト、mobile typecheck、`npm run valid-layers-check`を実行する**
- [ ] **Step 3: 対象ファイルだけをstageし、staged diffを再確認する**
- [ ] **Step 4: `para: fix subagent activity lifecycle`としてコミットし、プッシュとリリースは行わない**
