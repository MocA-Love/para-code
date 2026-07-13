# SubAgent Hierarchy and Codex Resume Implementation Plan

> **For Codex:** Execute this plan task by task with test-first checkpoints. Do not release; include only task-owned files in the commit.

**Goal:** モバイルのSubAgentを階層チャットとして表示し、Codexの新規起動・resume・TUI内resumeを取りこぼさず安全に認識する。

**Architecture:** Relay側でCLIモード、root thread、親子関係を正規化し、モバイルには循環のない`parentId`/`depth`を含む完全状態を送る。詳細画面は共有Markdown rendererを使うチャット表示とし、探索は新規セッションと再開セッションで鮮度条件を分離する。

**Tech Stack:** TypeScript, VS Code workbench services, Node SQLite, React Native/Expo, Mocha, Vitest.

---

### Task 1: CLI起動モードとroot thread探索

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/common/paradisAgentCliCommand.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/common/paradisMobileRelay.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileRelay.contribution.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Test: `src/vs/paradis/contrib/mobileRelay/test/node/paradisAgentCliCommand.test.ts`
- Test: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileAgentChat.test.ts`

1. CLI分類が`agent`と`mode`を返す失敗テストを追加する。
2. state DBのSubAgent sourceをroot候補から除外し、resumeではcreatedAtを要求しない失敗テストを追加する。
3. 最小実装でテストを通す。
4. capability追加時の`executingCommand`再評価と、CLI実行中の再探索を実装する。
5. 対象Mochaテストを実行する。

### Task 2: Agent親子モデル

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisAgentActivity.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `app/mobile/src/store.ts`
- Test: `src/vs/paradis/contrib/mobileRelay/test/node/paradisAgentActivity.test.ts`
- Test: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileAgentChat.test.ts`
- Test: `app/mobile/src/store.test.ts`

1. Claude/Codexの親ID・depth正規化と循環防止の失敗テストを追加する。
2. Codex session metadata/source parserの失敗テストを追加する。
3. Trackerとrelay型へ`parentId`/`depth`を追加する。
4. モバイル境界でフィールドを上限付きに検証する。
5. 対象テストを実行する。

### Task 3: 階層一覧とチャット詳細

**Files:**
- Modify: `app/mobile/app/agent-activity.tsx`
- Modify: `app/mobile/app/agent-activity-detail.tsx`
- Modify/Create: `app/mobile/src/components/agentMessageBubble.tsx`
- Modify: `app/mobile/app/agent.tsx`
- Test: relevant mobile component/store tests

1. 階層整列、descendant集計、パンくず計算を純関数として失敗テストから追加する。
2. 親画面のMarkdown/tool表示を共有コンポーネントへ抽出する。
3. 詳細を親右・子左のチャット表示へ変更する。
4. 直接の子Agent遷移カードとパンくずを追加する。
5. 一覧の実行中数・履歴数を分離し、階層表示へ変更する。
6. mobileテストとtypecheckを実行する。

### Task 4: 回帰検証とセルフレビュー

**Files:** task-owned files only

1. root対象Mocha、mobile test/typecheck、client typecheck/compile/layer checkを実行する。
2. diffを仕様表と照合して自己レビューする。
3. 不具合があれば失敗テストを追加して修正し、再検証する。
4. task-owned filesだけをコミットし、現在のbranchをpushする。
5. リリースは行わない。
