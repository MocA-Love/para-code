# Mobile Relay v3 Seamless Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renderer・PC・モバイルの再起動や一時切断が重なっても誤配送や二重実行を起こさず、モバイルでは最後の画面を保ったまま安全な操作だけを継続できるようにする。

**Architecture:** Electron MainをRenderer leaseの唯一の権威とし、Shared ProcessはMainとregistryの両方で配送先を検証する。モバイルはsession-level v3 negotiationとpair/epoch scoped durable outboxを使い、UIはキャッシュを表示し続けながらライブ通信が必要な操作だけを即時拒否する。

**Tech Stack:** TypeScript、Electron/VS Code IPC、React Native/Expo、Vitest、VS Code Node tests

## Global Constraints

- PC・モバイル間の必須プロトコルは `3`。
- 旧プロトコルからのAgent・Browser・Notifyを含む全操作を遮断する。
- terminal mutation (`input/create/rename/close/ackStatus`) は送信前に永続化し、同じoperation IDだけを再送する。
- `outcome-unknown` とdesktop epoch変更後の操作は自動再送しない。
- 一時切断中もキャッシュ済み画面を表示する。
- ライブ応答が必要なFS・SCM・Agent・Browser操作はオフライン中にキューせず、即時エラーにする。
- ユーザー指示によりテストコードは先に追加するが、テスト・型検査・lintは実行しない。
- ユーザー指示がないためコミット・プッシュは行わない。

---

### Task 1: Main Renderer lease authority

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/common/paradisMobileWindowLease.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-main/paradisMobileWindowLeaseChannel.ts`
- Test: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileRendererLeaseAuthority.test.ts`

**Interfaces:**
- Produces: connection-bound claim capability and pre-claim workbench manifest tracking.

- [ ] Add regression tests for reversed same-window claims, unclaimed workbench windows, stale disconnects, and real window destruction.
- [ ] Bind each claim to the IPC connection that received its generation instead of resolving by `window:<id>` alone.
- [ ] Register real workbench windows before claim so reload gaps cannot produce an empty `complete:true` manifest.
- [ ] Keep special/non-workbench connections out of the manifest.
- [ ] Review manifest and window revision monotonicity without running tests.

### Task 2: v3 session boundary and lease-safe routing

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileRelay.contribution.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileTerminalRegistry.ts`
- Test: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileTerminalRegistry.test.ts`

**Interfaces:**
- Consumes: current Main lease validation and terminal registry ownership.
- Produces: session-level protocol authorization and exact-owner inbound/outbound routing.

- [ ] Add regression tests/helpers for v2 session rejection, stale inbound owner rejection, partial manifest deletion, and lease-scoped terminal hints.
- [ ] Require a valid v3 State handshake before accepting every non-State mobile frame, including Agent, Browser and Notify.
- [ ] Validate the resolved renderer lease immediately before Terminal/SCM/FS inbound delivery; finalize undeliverable terminal mutations as `stale-renderer`.
- [ ] Route terminal hints through `(windowId, windowSession, rendererGeneration, terminalId)`.
- [ ] Delay pane synchronization until terminal state registered the same Renderer generation.
- [ ] Preserve only windows explicitly listed as pending when merging partial state; remove windows absent from the manifest.
- [ ] Audit outbound authorization as a linearization point and reject results whose registry owner changed around Main validation.

### Task 3: Pair- and epoch-safe mobile outbox

**Files:**
- Modify: `app/mobile/src/store.ts`
- Modify: `app/mobile/src/appState.ts`
- Modify: `app/mobile/src/platform.ts`
- Test: `app/mobile/src/store.test.ts`

**Interfaces:**
- Produces: `TerminalOperationOutboxStore.loadCandidates()`, `clear()`, pair scope validation, epoch reconciliation, and explicit unknown discard.

- [ ] Add tests for `.next` recovery, corrupted candidate fallback, pair mismatch rejection, awaited unpair clear, epoch-change quarantine, and explicit unknown discard.
- [ ] Persist an encrypted outbox envelope bound to the current pairing scope.
- [ ] Load candidate files newest-first and accept the first decryptable, scope-matching envelope.
- [ ] Make controller reset asynchronous and await durable clearing before deleting credentials.
- [ ] Request State before replay; replay only after a matching desktop epoch is established.
- [ ] Move mismatched-epoch operations to `outcome-unknown` without sending.
- [ ] Expose an explicit API that discards acknowledged unknown operations and frees the operation cap.

### Task 4: Cached-screen seamless resume and operation policy

**Files:**
- Modify: `app/mobile/src/components/connectionGate.tsx`
- Create: `app/mobile/src/components/connectionStatusBanner.tsx`
- Modify: `app/mobile/src/appState.ts`
- Modify: `app/mobile/src/store.ts`
- Modify: `app/mobile/app/(tabs)/terminal.tsx`
- Modify: relevant FS/SCM/Agent/Browser screens only where central guards do not already surface an error.
- Test: `app/mobile/src/store.test.ts`

**Interfaces:**
- Produces: non-blocking reconnect status, cached-content gate, `requireLiveConnection()` request guard, and global unknown-operation acknowledgement.

- [ ] Add store-level tests that terminal mutation stays accepted offline while FS/SCM/Agent/Browser requests fail immediately and are not queued.
- [ ] Render cached children while paired and a cached workspace exists, even when relay or PC is reconnecting.
- [ ] Show a compact non-blocking reconnect/offline banner; keep protocol mismatch and no-cache startup blocking.
- [ ] Centralize live-request availability in the controller so every non-durable operation follows the same policy.
- [ ] Keep terminal mutation enqueue available offline and preserve order through the durable outbox.
- [ ] Add explicit UI action for acknowledging and discarding `outcome-unknown` records.

### Task 5: Whole-change review and static verification

**Files:**
- Review every path returned by `git diff --name-only HEAD`.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: no unresolved CRITICAL/HIGH review finding in the inspected diff, or an explicit blocker report.

- [ ] Run `git diff --check` and inspect its exit status.
- [ ] Review security, authority boundaries, stale generation races, idempotency, storage recovery, error handling, and accessibility.
- [ ] Dispatch independent final reviewers for desktop protocol, mobile persistence, and end-to-end behavior; do not let them edit or run tests.
- [ ] Fix every substantiated CRITICAL/HIGH issue and repeat the static review.
- [ ] Report changed behavior, failure handling, and unexecuted verification in a Japanese table.
