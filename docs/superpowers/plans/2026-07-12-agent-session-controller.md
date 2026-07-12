# Agent Session Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent Teams通信を正しく分類し、Claude Code / Codexのペイン状態をterminal・hook・transcriptの全経路から確実に収束させる。

**Architecture:** shared processのpane token単位状態を正本とし、terminal終了を冪等retireへ統合する。表示用transcript購読とは独立したstatus監視を常時有効にし、正規化済み状態だけをWorkspaceとモバイルへ配信する。

**Tech Stack:** TypeScript、VS Code workbench/shared process IPC、React Native、Mocha/Vitest

## Global Constraints

- main上の既存未コミット変更を保持し、今回のhunkだけをコミットする。
- provider固有イベントの解釈はPC側へ閉じ込める。
- terminal reloadと真のexit/disposeを区別する。
- 時間だけで長時間処理を終了扱いしない。

---

### Task 1: Agent Teamsメッセージの正規化

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileAgentChat.test.ts`
- Modify: `app/mobile/src/store.ts`
- Modify: `app/mobile/app/agent.tsx`

- [ ] teammate report、summary、idle通知、通常userの失敗テストを追加する。
- [ ] `peer_message`パーサーを実装し、idle通知を除外し、userText signalを立てない。
- [ ] モバイルへ送信元付き中立カードを追加する。
- [ ] PC parserテストとmobile typecheckを実行する。

### Task 2: terminal終了の冪等retire

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisAgentStatus.contribution.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHookBus.ts`
- Test: `src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentBrowserStatus.test.ts`

- [ ] onExit/onDisposedの順序とretire全削除を表す失敗テストを追加する。
- [ ] terminal監視登録時にtokenを保存し、両イベントから先着一度だけ終了通知する。
- [ ] shared processのretireでstatus、agent実績、activity、binding、shell、CDP cacheを一括削除する。
- [ ] Browser共有中でもterminal終了を優先する。
- [ ] 対象テストを実行する。

### Task 3: status用turn終了監視の独立

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`
- Test: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileAgentChat.test.ts`

- [ ] モバイル未接続のCodex task_complete/error/turn_aborted失敗テストを追加する。
- [ ] statusに必要な軽量tailをagent session中は購読有無と無関係に維持する。
- [ ] ClaudeのStopなし中断も同じturn-ended経路へ統合する。
- [ ] tailer破棄が通常workingを残さないよう収束させる。
- [ ] 対象テストを実行する。

### Task 4: poll障害とstale収束

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisAgentStatus.contribution.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/common/paradisAgentStatusStale.ts`
- Test: `src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentBrowserStatus.test.ts`

- [ ] poll一時失敗、連続失敗、再接続snapshotのテストを追加する。
- [ ] 一時失敗は保持し、連続失敗時は古いrenderer状態をclearする。
- [ ] background taskとfallbackの時間基準を統一する。
- [ ] PTY/transcript根拠なしの孤児状態だけを安全弁で収束させる。
- [ ] 対象テストを実行する。

### Task 5: 検証・レビュー・コミット

- [ ] 変更対象のMocha/Vitest、mobile typecheck、compile-client、対象ESLintを実行する。
- [ ] `git diff --check`と差分レビューで既存ユーザー変更の混入がないことを確認する。
- [ ] security/品質レビューでCritical/Highがないことを確認する。
- [ ] 今回のファイル/hunkだけをstageしてコミットする。pushは行わない。
