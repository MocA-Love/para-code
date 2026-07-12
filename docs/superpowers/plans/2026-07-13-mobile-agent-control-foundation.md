# ParaCode Mobile Agent Control Foundation Implementation Plan

> **For agentic workers:** Implement task-by-task and request a read-only code review after every task.

**Goal:** ParaCode MobileのClaude Code / Codex操作をセッション検証付きAgent Actionへ移行し、同じAgentを複数モバイルから購読可能にする。

**Architecture:** PC側`ParadisMobileAgentChat`をAgent状態と操作の権威とし、モバイルはrequest ID付きactionを送る。既存termチャネルはターミナル画面専用として維持する。SubAgentツリーとWeb Activityは後続計画へ分離する。

**Tech Stack:** TypeScript、React Native / Expo、VS Code terminal API、E2E暗号化済みParaCode relay protocol。

## Global Constraints

- 既存の未コミット変更へ触れない。
- 実装単位ごとにレビュー後コミットする。プッシュ、マイグレーションは行わない。
- プロジェクト指示に従い、テストコマンドは実行しない。各Task後は差分の静的レビューを行う。
- 旧モバイルと旧PCの互換経路を残す。
- termチャネルの一般ターミナル操作は変更しない。

---

### Task 1: 複数モバイル購読

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`

**Interfaces:**
- Consumes: `mobileId`, `paneToken`,既存`sendTo()`。
- Produces: `Map<string, Set<string>>`による購読、全購読者向けsnapshot/delta/live/activity/info配信。

- [x] `subscribers`を`Map<string, Set<string>>`へ変更する。
- [x] attach時に既存集合を維持してmobile IDを追加する。
- [x] detachと`dropSubscriber()`で対象mobile IDだけを削除する。
- [x] 集合が空になった時だけtailer停止判定を行う。
- [x] snapshot、delta、live、activity、infoの送信箇所を全購読者配信へ変更する。
- [x] model catalog、settings update、action resultは要求元だけへ返す構造を維持する。
- [x] `git diff --check`相当の内容を目視確認し、read-only reviewerへ差分レビューを依頼する。

### Task 2: 通常メッセージAgent Action

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `app/mobile/src/store.ts`
- Modify: `app/mobile/src/appState.ts`
- Modify: `app/mobile/src/hooks/useAgentActions.ts`
- Modify: `app/mobile/src/components/agentComposer.tsx`
- Modify: `app/mobile/app/agent.tsx`

**Interfaces:**
- Produces: `action/sendMessage`、`action-result`、capability、送信中状態。

- [x] agent outbound snapshot/deltaへ`capabilities: { agentActions: true }`を追加する。
- [x] action requestに`id/token/requestId/epoch/text`を要求する。
- [x] PC側で購読者、pane token、epoch、現在セッションを再検証する。
- [x] owner window限定IPCと`ITerminalInstance.sendText(text, true, true)`を使って送信し、最終結果を要求元へ返す。
- [x] モバイルストアにpending actionと30秒timeoutを追加する。
- [x] Agentコンポーザーはaction結果の`accepted`後にだけ、同じdraft revisionの下書きを消す。
- [x] capabilityが無い旧PCでは既存`sendTextInput()`へフォールバックする。
- [x] read-only reviewerへ差分レビューを依頼し、Important以上を解消する。

### Task 3: 質問・承認Interaction Action

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHookBus.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `app/mobile/src/store.ts`
- Modify: `app/mobile/src/hooks/useAgentActions.ts`
- Modify: `app/mobile/src/components/questionCard.tsx`
- Modify: `app/mobile/src/components/approvalCard.tsx`
- Modify: `app/mobile/app/agent.tsx`

**Interfaces:**
- Produces: `AgentInteraction`、`answerQuestion`、`answerApproval`、要求単位の取消可能なキー列。

- [x] pending question IDとapproval IDをPC側の状態として保持する。
- [x] snapshot/deltaへ`interaction`を追加する。
- [x] interaction ID不一致の要求を`stale-interaction`で拒否する。
- [x] TUIキー列をPC側で直列化し、各待機後にsession/interaction/owner/terminalを再検証する。
- [x] ターミナル終了、セッションepoch変更、disposeで残りのキー列をキャンセルする。
- [x] モバイルの質問・承認カードを送信中に無効化し、失敗時だけ復帰する。
- [x] 単一multiSelectも決定時までローカル保持する。
- [x] interaction単位の排他claimで複数モバイルからの二重回答を防止する。
- [x] read-only reviewerへ差分レビューを依頼し、Important以上を解消する。

### Task 4: Claudeモデル・Effort操作の統合

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisAgentModelSwitchGuard.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileWorkspaceProvider.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `app/mobile/src/components/modelPill.tsx`
- Modify: `app/mobile/src/hooks/useAgentActions.ts`

**Interfaces:**
- Consumes: Task 2のrequest/result、Task 3のinteraction mode。
- Produces: prompt状態に限定されたClaude model command。

- [x] Claudeモデルコマンドをtermチャネルからagent actionへ移す。
- [x] prompt以外の状態では要求を拒否する。
- [x] 既存確認ダイアログguardをrequest IDとsession epochへ紐づける。
- [x] guardの成功、タイムアウト、セッション変更をaction resultへ反映する。
- [x] Claude設定専用capabilityで旧・中間PCとのfallbackを維持する。
- [x] Codexの既存app-server設定変更経路は維持する。
- [x] read-only reviewerへ差分レビューを依頼し、Important以上を解消する。

### Task 5: 基盤全体レビュー

**Files:**
- Review: 上記全変更ファイル
- Update: `docs/superpowers/specs/2026-07-13-mobile-agent-control-foundation-design.md`（実装上の確定差分がある場合のみ）

- [ ] 設計要件と実装の対応を自己レビューする。
- [ ] 旧PC/旧モバイル、切断、二重送信、セッション切替、複数端末の経路をコード上で追跡する。
- [ ] read-only reviewerへ全体レビューを依頼する。
- [ ] Critical/Importantを解消し、未実行のテスト項目をユーザーへ引き渡す。
