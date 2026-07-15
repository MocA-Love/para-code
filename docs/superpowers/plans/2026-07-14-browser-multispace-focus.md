# Browser Multispace and Focus Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute each task with a fresh implementer and read-only review checkpoint.

**Goal:** 複数スペース・複数ウィンドウのPara Browser MCPを正しいターミナル/BrowserViewへ固定し、MCP入力がユーザーのterminal・IME・workbench keybindingへ干渉しないようにする。

**Architecture:** 既存pane tokenを生存authorityとしてpark済みterminalまで列挙し、terminal/browser scopeをdiscriminated scopeとrevisionで同期する。bindはRenderer lease・authority manifest・Main view identityをprepare/commitで固定する。CDP `Input.*`はbinding generation/target単位の共有queueからElectron Mainのexact BrowserView debuggerへfocusなしで配送する。

**Tech Stack:** TypeScript、VS Code DI/IPC/Storage、Electron WebContentsView debugger、Node WebSocket proxy、Mocha

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-14-browser-multispace-focus-design.md`
- 現在の作業ツリーを使用し、worktreeを作成しない。
- TDDで各契約のREDを確認してからproduction codeを変更する。
- 各Task後に自己レビューと独立read-onlyレビューを行い、Critical/Importantを解消してから次へ進む。
- ユーザーの明示指示があるまでcommit/pushしない。
- `app/mobile/mock/serve.mts`、`.serena/`、`app/design/mobile-relay-v3-recovery-design.md`、`app/mobile/mock/slash-command-catalog.html`、`docs/superpowers/plans/2026-07-14-mobile-slash-command-catalog-mock.md`へ触れない。
- Node 24を使用する: `env PATH=/Users/magu/.local/share/mise/installs/node/24.17.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin ...`

---

### Task 1: live pane列挙とterminal scope authority

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/browser/paradisLivePaneInstances.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/browser/paradisLivePaneInstances.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/browser/paradisPaneTokenService.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceSwitch.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisTerminalScope.contribution.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisAgentBrowserBindingModel.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisAgentBrowser.contribution.ts`

**Contracts:**
- `ParadisBindingScope = { kind: 'managed'; stateKey: string } | { kind: 'unscoped' } | { kind: 'pending' }`をcommonに置く。
- `paradisCollectLivePaneInstances`はnormal/editor/background、parked panel、parked editorを合算し、instanceId/tokenを重複排除する。
- tokenの現行対応は`getInstanceForToken(token) === instanceId`だけを採用する。
- `listPaneTokens()`はforward mapではなくreverse mapの現行pairだけを返す。
- terminal scopeは`_instanceScopes`をgroup/active fallbackより先に参照し、stable scope revision/eventを公開する。

- [x] **Step 1:** 重複instance、同token旧新instance、parked panel/editor、PID未確定tokenの失敗テストを書く。
- [x] **Step 2:** focused testを実行し、旧forward-map/`terminalService.instances`限定でREDを確認する。
- [x] **Step 3:** pure collectorとreverse-map列挙を実装し、binding UIとRenderer manifestの列挙を置換する。
- [x] **Step 4:** terminal scopeのlive `_instanceScopes`優先、`pending`判定、revision/eventを実装する。
- [x] **Step 5:** focused tests、既存workspaceSwitch/agentBrowser tests、対象ESLintをGREENにする。
- [x] **Step 6:** detach/reattach遅延dispose、background scope固定、park/unpark非退役を自己レビュー・独立レビューする。

### Task 2: BrowserView scope serviceとreload-safe persistence

**Files:**
- Create: `src/vs/paradis/contrib/workspaceSwitch/common/paradisBrowserScopeState.ts`
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/common/paradisBrowserScopeState.test.ts`
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/electron-browser/paradisBrowserScope.contribution.test.ts`
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchService.test.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceSwitch.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspaceSwitchService.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisBrowserScope.contribution.ts`
- Modify: `src/vs/workbench/contrib/browserView/common/browserView.ts`
- Modify: `src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts`
- Modify: `src/vs/workbench/contrib/browserView/electron-browser/browserViewWorkbenchService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialog.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisAgentBrowser.contribution.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisAgentBrowserBindingModel.ts`

**Contracts:**
- `IBrowserViewWorkbenchService.whenInitialized`はMain既存view列挙の完了と成功可否を表すnon-rejecting `Promise<boolean>`で、desktopはcreate listenerをsnapshotより先に登録し、snapshot/accept callbackの失敗を`false`へ収束させ、webは`true`で即時resolveする。
- `IParadisBrowserScopeService`は`resolveScope`、`initializationBarrier`、revision、stable eventを公開する。
- scope本体はsingleton、AfterRestored contributionはstarterだけとし、storage Mapを二重生成しない。storageはhook/tagより前に同期loadして`valid | absent | corrupt`を区別し、`lifecycleService.willShutdown`も直接確認してshutdown中dispose、switch/reload、一時absentではmappingを削除しない。初期snapshotの復元不能viewはcontextual所属を確認できなければ`pending`にする。
- barrier前のscope retireはviewId tombstoneで遅延snapshotからの復活を防ぐ。snapshot失敗時はtombstoneとbarrier時点の初期unknown pendingを保持し、成功時も該当view破棄/absentの収束をIDごとに確認してから掃除する。初期化完了後の新規viewはsnapshot失敗後でも通常tagする。storage `absent`で初期pendingとなったviewは、後のscope switch/repository changeでcontextualになった時だけ再評価し、`corrupt`由来は隔離を維持する。switch中の既存scopeは`pending`を返す。managed windowでactive key未確定なら`pending`、管理外の通常workspaceだけ`unscoped`とする。同じURIでstateKeyだけ変わるswitchも再評価eventを発火し、pending/unscopedを再評価する。
- user closeとscope retireだけ削除する。ページ解決はexact既存binding→active→`getContextualBrowserViews()`の順とし、fallback前にinitialization barrierをawaitする。
- pane scope filterはbinding modelへ共通化し、dialogとQuickPickの両入口および最終bindで使う。既存binding行はscope不一致でもunbind管理用に表示し、bind eligibilityとは分ける。描画後に最終gateが拒否してもDialog/QuickPickでlocalizedな再試行案内を表示し、unhandled rejectionを残さない。

- [x] **Step 1:** storageのvalid/absent/corrupt、初期化前pending、inactive view復元、shutdown dispose、user close、scope retire-before-barrier/tombstone、snapshot失敗保持、absent pendingの後続contextual収束とcorrupt隔離のpure/contribution testと、load→hook→non-rejecting boolean barrier順を確認するnarrow electron-browser testを書く。
- [x] **Step 2:** focused testでREDを確認する。
- [x] **Step 3:** BrowserView initialization barrierとscope singleton/persistence/lifecycle/tombstoneを実装し、同一URI stateKey矯正時のswitch eventを修正する。
- [x] **Step 3a:** Browser scope contributionの旧「window reloadでページ再ロード」コメントをUnit 1後のMain保持/re-attach仕様へ更新する。
- [x] **Step 4:** contributionのdialog page resolverをasync化し、exact binding→active→contextual fallbackを実装する。binding modelへbind eligibility付き共通pane scope filterを追加し、dialogとQuickPickの両入口へ適用する。既存bindingのunbind行は残す。
- [x] **Step 5:** focused tests、browserView/workspaceSwitch regressions、対象ESLintをGREENにする。
- [x] **Step 6:** reload直後にactive scopeへ再tagしないこと、view disposeをscope reassignment eventにしないことを自己レビュー・独立レビューする。

### Task 3: Renderer authority manifestとmulti-window bind transaction

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/common/paradisBindingAuthority.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/node/paradisBindingAuthority.test.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisAgentBrowserAuthoritySyncService.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisAgentBrowserAuthoritySyncService.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/common/paradisAgentBrowser.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisAgentBrowser.contribution.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisAgentBrowserBindingModel.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserChannel.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-main/paradisCdpTargetService.ts`
- Modify: `src/vs/platform/browserView/electron-main/browserView.ts`

**Contracts:**
- authority manifestはrevision、complete、全live token owner/scope、BrowserView scopeを現行Renderer connection leaseへ固定し、専用singleton single-flight queueでserial sync/accepted revision ackする。barrier完了・shutdown外は毎回complete、reload shutdown中はfreezeする。scope switch前後、terminal接続、両barrier、scope、token、BrowserView集合の変化を直接triggerにし、`pending`を旧stable値で上書きしない。
- `_paneOwners`はPID台帳と分離し、cross-window token上書きを拒否する。
- cross-window/duplicate/invalid/上限超過manifestは型coercionなしでatomic rejectし、部分適用・保留・自動昇格しない。Renderer channelのtoken mutation/listはconnection+owner windowでscopeし、Main/window destroy内部cleanup APIと分離する。
- 新Renderer登録で旧authority eligibility/ticketを即時失効し、最初のaccepted manifestまではprepareを拒否する。legacy public `bind`を削除または常時拒否し、`syncPaneShells`は置換するか現行connectionのPID補完だけへ制限する。
- `prepareBind`はMain `{windowId,targetId,opaqueViewLease}` await前後でconnection object/authority/token mutation epoch/base bindingを再検証し、短寿命single-use ticketを返す。
- `commitBind`はawaitなしでconnection/revision/scope/epoch/base binding/ticketを再検証してからgenerationを採番・公開し、並行ticketを失効させる。ticketは注入可能なclock/ID factory、期限、総数上限を持ち、機会的に掃除する。
- visibility/screenshot/backgroundThrottlingもbindingのwindow/view/target/opaque leaseをMainで前後検証し、unbindのthrottling復元を含めviewId再利用後のinstanceへ作用させない。
- backgroundThrottling参照数もexact identity単位にし、commit後だけ無効化、最後のexact binding解除後だけ同じinstanceへ復元する。
- binding modelはtoken単位にbindを直列化し、`syncNow`とscope再確認を行い、stable scope変更だけgeneration付きunbindする。definite pre-commit失敗時だけ最新bindingを確認して共有状態を安全にrollbackし、commit応答喪失はoutcome unknownとして共有解除しない。

**Review checkpoints:**

- **3A Pure authority:** strict manifest parser、connection/owner state、complete/incomplete、prepare snapshot、bounded single-use ticket/epochをdependency-light common classへ分離し、focused testと独立レビューを通す。
- **3B Shared process + Main:** ctx-scoped channel/service、legacy遮断、prepare/commit integration、window destroy、exact BrowserView descriptor/opaque lease、副作用とthrottling参照数を実装し、focused/既存lifecycle回帰と独立レビューを通す。
- **3C Renderer:** singleton serial manifest sync、全trigger/barrier/shutdown freeze、binding modelのsyncNow/scope recheck/rollback/outcome unknownを実装し、Renderer focused回帰と独立レビューを通す。

- [ ] **Step 1:** legacy bind/manifest拒否、old Renderer遅延sync、new connection即時失効と初回manifest前prepare、PIDless owner、Window Bのtoken list/mutation拒否、owner奪取、atomic manifest reject、新revision後だけtransfer、terminal-exit通知喪失回収、await中reload/scope変更、並行ticket epoch、ticket reuse/expiry/cap、commit応答喪失rollback、同一viewId再生成時のMain副作用拒否、exact throttling参照数の失敗テストを書く。
- [ ] **Step 2:** focused testでREDを確認する。
- [ ] **Step 3:** authority state machine、strict atomic channel parser、Renderer singleton serial sync/ack service、全同期trigger、shutdown freeze、ctx-scoped token APIと内部cleanup APIを実装する。legacy `bind` commandは削除し、`syncPaneShells`をauthority迂回不能にする。
- [ ] **Step 4:** Main exact view descriptor/opaque instance lease、prepare/commit/abort、binding scope保存を実装し、visibility/screenshot/backgroundThrottlingをexact lease APIへ移行する。
- [ ] **Step 5:** Renderer側syncNow、scope照合、post-IPC recheck、stable reassignment reconcile、commit失敗時の安全な`setSharedWithAgent` rollbackを実装する。
- [ ] **Step 6:** focused testsと既存binding lifecycle 29件以上をGREENにする。
- [ ] **Step 7:** TOCTOU、cross-window、reload lease、complete/incompleteを自己レビュー・独立レビューする。

### Task 4: Electron Mainのfocusless automation input境界

**Files:**
- Create: `src/vs/platform/browserView/common/browserViewAutomationInput.ts`
- Create: `src/vs/platform/browserView/test/common/browserViewAutomationInput.test.ts`
- Modify: `src/vs/platform/browserView/common/browserView.ts`
- Modify: `src/vs/platform/browserView/electron-main/browserView.ts`
- Modify: `src/vs/platform/browserView/electron-browser/preload-browserView.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-main/paradisCdpTargetService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/common/paradisAgentBrowser.ts`

**Contracts:**
- allowlist: dispatchKeyEvent、insertText、imeSetComposition、dispatchMouseEvent、dispatchTouchEvent、dispatchDragEvent。
- Mainはexpected window/view/target/opaque leaseを送信前後で検証し、`sendCommandRaw`をrootへ直接送る。`focus()`は呼ばない。
- BrowserViewがuser-focusedなら全automation inputをretryable拒否する。
- automation key signatureはMain→preloadへのinactive登録ack、identity/focus再検証、activate ack、最終identity/focus再検証、Main同期commitを経てからだけ送信する。preloadはuser-focusedならactivate/consumeしない。focus時はElectron Mainのauthoritative eventでcommit済みを含む期待値を失効させ全preloadへcancelし、preloadはtrustedなwindow focusだけをlocal fail-safeとして受理してcancel到着前もdocument focus中のeventをconsumeしない。preload/before-input-eventの各経路ではactive/commit済みの完全一致sequenceを各1回だけ抑止し、command完了後250msは未到着routeだけを待つ。消費済みrouteの同一signature user keyは即時転送する。focus invalidationはTTLより優先し、送信直後raceのautomation漏れ防止より同一物理user keyの非抑止を選ぶ。該当preload eventは`preventDefault()`せず、通常shortcutは従来どおり処理する。各最大32件。
- send直前のopaque focus authorityを応答後にも照合し、send中のfocus→blurを含むfocus変更はoutcome-unknownにする。

- [ ] **Step 1:** allowlist、signature完全一致、不一致user shortcut、preload ack失敗、二経路消費、TTL/上限、focused rejection、identity changeの失敗テストを書く。
- [ ] **Step 2:** focused testでREDを確認する。
- [ ] **Step 3:** signature queueとBrowserView key-command suppressionを実装する。
- [ ] **Step 4:** Main exact input dispatch APIを実装し、旧`focusView`経路を削除する。
- [ ] **Step 5:** focused tests、BrowserView regressions、対象ESLintをGREENにする。
- [ ] **Step 6:** `launch`スキルで隔離Code OSSを起動し、可視/非表示BrowserViewのkeyboard/mouse/touch/IME、focused webContents不変、terminal入力不変を実測する。成立しなければfocus fallbackを追加せず設計へ戻る。
- [ ] **Step 7:** key suppressionと実ユーザー入力保護を自己レビュー・独立レビューする。

### Task 5: route共通Input queueとoutcome semantics

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/node/paradisCdpInputQueue.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpInputQueue.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisCdpGateway.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisCdpFilterProxy.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts`

**Contracts:**
- binding generation/expected target単位の共有queue、最大256件、params 1MiB、Main IPC 5秒。
- browser-level primary sessionとpage-level rootの`Input.*`だけをMain境界へ送り、未知root/childは拒否する。
- 同一connectionの後続non-Inputは先行Inputをbarrierし、両routeのInputは共有順序を持つ。
- commit前はretryable、commit後authority変更はoutcome-unknown。close/timeout/overflowはraw upstreamへfallbackしない。

- [ ] **Step 1:** cross-route順序、non-Input barrier、overflow、oversize、timeout late result、close、generation/lease変更、unknown child sessionの失敗テストを書く。
- [ ] **Step 2:** focused testsでREDを確認する。
- [ ] **Step 3:** shared queueとconnection barrierを実装する。
- [ ] **Step 4:** page/browser両proxy routeを同じdelegateへ統合し、focus callbackを削除する。
- [ ] **Step 5:** focused proxy/queue testsとAgent Browser Node globをGREENにする。
- [ ] **Step 6:** 二重実行、順序逆転、late settle、別binding誤配送を自己レビュー・独立レビューする。

### Task 6: 複数スペース統合・全体レビュー

**Files:**
- Modify: `.superpowers/sdd/progress.md`
- Modify: `docs/superpowers/plans/2026-07-14-browser-multispace-focus.md`
- Modify: 上記Taskでレビュー指摘が出た対象だけ

- [ ] **Step 1:** Node 24で`npm run transpile-client`を実行する。
- [ ] **Step 2:** workspaceSwitch、agentBrowser、BrowserViewのfocused globを実行する。
- [ ] **Step 3:** Node全体、対象ESLint、`git diff --check`、`npm run valid-layers-check`、`npm run compile`を実行する。既知のmobileRelay TS2339以外に今回由来のerrorがないことを切り分ける。
- [ ] **Step 4:** 2スペース×2ウィンドウ、park/unpark、background、detach/reattach、Renderer reload、inactive BrowserView復元、同時Inputを統合レビューする。
- [ ] **Step 5:** Critical/Importantが0になるまで修正と再検証を繰り返す。
- [ ] **Step 6:** Unit 2の変更点・検証結果・未実施事項をprogressへ記録する。commit/pushは行わない。
