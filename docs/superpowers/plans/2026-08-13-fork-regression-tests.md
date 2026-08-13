# Para Code Fork Regression Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `acdd702de2cb` 以降に追加された Para Code 固有機能と前回から残る高リスク境界へ、製品ロジックを直接検証する回帰テストを追加して実行する。

**Architecture:** 外部境界だけを fake にし、直接テストできないロジックは純粋関数または小さな状態機械へ抽出する。第1弾は新規の重大領域、第2弾は前回残存領域と部分カバー領域を扱い、同じ製品ファイルを触るタスクだけ直列化する。

**Tech Stack:** TypeScript、Mocha、Sinon、Vitest、Electron test runner、pnpm、Node.js

## Global Constraints

- 製品挙動を変更しない。発見した製品不具合は、期待仕様が明確な場合のみ別の failing regression test として記録する。
- 製品コード変更はテスト容易性のための最小限の純粋関数抽出または依存注入に限定する。
- private method の型キャスト呼び出し、製品ロジックのテスト内複製、ソース文字列だけの検査を追加しない。
- test-first で進め、characterization test は一時 mutation で検出能力を確認して必ず復元する。
- 既存の未追跡 HTML と無関係な変更には触れない。
- ファイル編集は `apply_patch` を使う。
- コミット、push、PR 作成は行わない。
- subagent は担当ファイル以外を編集しない。型検査やformatterによる担当外ファイルの書き換えを行わない。

---

## Phase 1: 新規高リスク領域

### Task 1: Session Resume のNode契約

**Files:**
- Create: `src/vs/paradis/contrib/sessionResume/test/node/paradisSessionResumeChannel.test.ts`
- Modify only if required for injection: `src/vs/paradis/contrib/sessionResume/node/paradisSessionResumeChannel.ts`

**Interfaces:**
- Exercise: `ParadisSessionResumeService.list`, `preview`, `search`
- Preserve: `PARADIS_RESUME_SESSION_ID_PATTERN` and existing IPC response types

- [ ] Claude と Codex の最小 transcript fixture を一時ディレクトリに作り、`list` が workspace、agent、mtime、catalog IDを返す failing testを書く。
- [ ] `preview` が catalog外IDを拒否し、許可root外とsymlink越境を読まず、メッセージ数・文字数・bytes上限を反映する failing testを書く。
- [ ] `search` が新しいrevisionだけを返し、古い並行検索結果を公開しない failing testを書く。
- [ ] `npm run transpile-client` 後、`npm run test-node -- --grep "ParadisSessionResume"` でREDを確認する。
- [ ] 必要な場合だけ filesystem/home dependency をconstructorへ注入し、既定値は現行実装にする。
- [ ] 同コマンドでGREENを確認する。

### Task 2: Remote SSH renderer結線

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisRemoteAgentHooks.contribution.test.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisRemoteAgentTunnel.contribution.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisRemoteAgentHooks.contribution.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisRemoteAgentTunnel.contribution.ts`

**Interfaces:**
- Produce injectable controllers that keep the contribution constructors' existing defaults.
- Preserve retry delays and gateway polling interval exactly as production currently uses them.

- [ ] hook導入が失敗後に既存の4段階で再試行し、成功後は停止する failing testを書く。
- [ ] gateway portが変化した場合だけ再導入し、dispose後はpoll/retryしない failing testを書く。
- [ ] tunnel contributionがSSH authorityだけをensureし、dispose時に同じauthorityをcloseする failing testを書く。
- [ ] Electron対象テストでREDを確認する。
- [ ] channel、delay、interval、endpoint readerを最小限注入可能にする。
- [ ] Electron対象テストでGREENを確認する。

### Task 3: Relay APNs契約

**Files:**
- Modify: `app/relay/test/push.test.ts`
- Test: `app/relay/src/deviceDO.ts`

**Interfaces:**
- Preserve: PC owns the push decision; Relay does not infer reachability from an online socket.

- [ ] 現在の「onlineなら送らない」テストを単独実行し、実装との矛盾によるREDを記録する。
- [ ] テストを「online socketが残っていても登録tokenへ1回送る」期待へ修正し、URL、payload、tokenを確認する。
- [ ] `cd app && pnpm --filter @para/relay typecheck` を実行する。
- [ ] `cd app && pnpm --filter @para/relay exec vitest run test/push.test.ts` でGREENを確認する。

### Task 4: Process-gone診断

**Files:**
- Create: `src/vs/paradis/contrib/sentry/common/paradisProcessGone.ts`
- Create: `src/vs/paradis/contrib/sentry/test/common/paradisProcessGone.test.ts`
- Modify: `src/vs/paradis/contrib/sentry/electron-main/paradisProcessGoneDiagnostics.ts`

**Interfaces:**
- Produce: `createParadisChildProcessGoneDiagnostic(details, durationMs)`
- Produce: `createParadisRenderProcessGoneDiagnostic(details, durationMs)`
- Return `undefined` for `clean-exit`; otherwise return operation, error message and safe extras consumed by the existing reporter.

- [ ] missing helperをimportするテストを書き、typecheck/target testのREDを確認する。
- [ ] child process名の優先順位が `name`、`serviceName`、`type` であることをliteral payloadで確認する。
- [ ] renderer payloadにURL、title、WebContents情報が存在しないことを確認する。
- [ ] 純粋helperを実装し、既存registrationをそのhelper経由にする。
- [ ] `npm run transpile-client` と対象Node testでGREENを確認する。

### Task 5: Webview Service Worker starting監視

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/test/electron-main/paradisWebviewServiceWorkerWatch.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-main/paradisWebviewServiceWorkerWatch.ts`

**Interfaces:**
- Keep existing registration entry point.
- Inject event source, reporter, clock/timer factory only through production-shaped dependencies.

- [ ] `starting` が20秒未満なら報告せず、猶予到達時に1件報告する failing testを書く。
- [ ] `running`、registration削除、対象外sourceでtimerを解除する failing testを書く。
- [ ] 監視対象を20件以下に保ち、dispose後にtimer/listenerが動かない failing testを書く。
- [ ] Electron main対象テストでREDを確認する。
- [ ] 最小DIを追加し、既存app配線の既定動作を維持する。
- [ ] Electron main対象テストでGREENを確認する。

### Task 6: Heap snapshot lifecycle

**Files:**
- Create: `src/vs/paradis/contrib/heapSnapshot/test/electron-main/paradisHeapSnapshotMain.test.ts`
- Modify: `src/vs/paradis/contrib/heapSnapshot/electron-main/paradisHeapSnapshotMain.ts`

**Interfaces:**
- Inject platform, directory, uptime, heap statistics, writer, stat and unlink dependencies.
- Existing `paradisRegisterHeapSnapshot` and result shape remain unchanged.

- [ ] first writeが未完了中のsecond writeを拒否する failing testを書く。
- [ ] LinuxはuserData、それ以外はtmpdirを選び、filenameへuptimeを含める failing testを書く。
- [ ] writer失敗時にpartial pathをunlinkし、stat失敗時は`bytes: -1`、次回実行ではlockが解放済みになる failing testを書く。
- [ ] channel登録が既存channel IDを使うことを確認する。
- [ ] Electron main対象テストでRED後、DIを実装してGREENを確認する。

### Task 7: Windows updater overwrite loop guard

**Files:**
- Create: `src/vs/platform/update/test/common/paradisWin32UpdateGuard.test.ts`
- Create: `src/vs/platform/update/common/paradisWin32UpdateGuard.ts`
- Modify: `src/vs/platform/update/electron-main/updateService.win32.ts`

**Interfaces:**
- Produce: `shouldStopParadisOverwriteLoop(stateType, pendingVersion, offeredVersion): boolean`
- Return true only for `StateType.Overwriting` and equal non-empty versions.

- [ ] missing helperを使うtable-driven testを書き、REDを確認する。
- [ ] Overwriting+sameだけtrue、different versionと他stateはfalseをliteral表で確認する。
- [ ] helperを実装し、既存branchをhelperへ置換する。
- [ ] `npm run transpile-client` と対象Node testでGREENを確認する。

### Task 8: Relay障害報告

**Files:**
- Create: `src/vs/paradis/contrib/mobileRelay/common/paradisRelayDisconnectReport.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/test/common/paradisRelayDisconnectReport.test.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts`

**Interfaces:**
- Extract a small state machine retaining operation, message, extras, arm attempt and timer lifecycle.
- Reporter fires after the current production grace period and minimum failed-attempt count.

- [ ] 閾値未満では報告せず、到達時に最初の理由と差分attemptで1件だけ報告する failing testを書く。
- [ ] recovery、disable、disposeでpending timerを取消す failing testを書く。
- [ ] fake clockでREDを確認し、状態機械を実装してserviceから利用する。
- [ ] `npm run transpile-client` と対象Node testでGREENを確認する。

### Task 9: Mobile音声通知

**Files:**
- Create: `src/vs/paradis/contrib/mobileRelay/common/paradisVoiceSubscriptions.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/test/common/paradisVoiceSubscriptions.test.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts`
- Create: `app/mobile/src/voiceLifecycle.test.ts`
- Create: `app/mobile/src/voiceLifecycle.ts`
- Modify: `app/mobile/src/appState.ts`

**Interfaces:**
- Produce a subscription state machine with `start`, `stop`, `drop`, `recipients`, `beginSend`, `endSend`.
- Produce a mobile generation guard that invalidates reconnect callbacks after stop.

- [ ] same SID更新、different SID停止拒否、TTL期限切れ、offline除外、送信中drop、送信失敗後解放の failing testsを書く。
- [ ] mobile側でstop後の古いgeneration callbackとtimerが状態をliveへ戻さない failing testを書く。
- [ ] 両runnerでREDを確認する。
- [ ] 最小状態機械へ既存logicを移し、wire formatとtimeout値を変更しない。
- [ ] VS Code Node test、`@para/mobile` typecheck、対象VitestでGREENを確認する。

---

## Phase 2: 残存・部分カバー領域

### Task 10: Terminal Grid境界

**Files:**
- Modify: `src/vs/sessions/contrib/terminalGrid/test/browser/sessionTerminalGridGroup.test.ts`
- Modify only if a defect is detected: `src/vs/sessions/contrib/terminalGrid/browser/sessionTerminalGridGroup.ts`

- [ ] 上下左右dropと中央・境界非drop、水平・垂直splitのorder/relative sizeを追加する。
- [ ] resize、最後のcell、dispose済みinstance、重複dropを追加する。
- [ ] characterization testは一時mutationでREDを確認し、復元後にbrowser対象testを通す。

### Task 11: PDF/DOCX拒否入力

**Files:**
- Create tests under: `src/vs/paradis/contrib/fileViewers/test/electron-browser/`
- Test production: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisPdfFileEditor.ts`
- Test production: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxFileEditor.ts`

- [ ] 空、破損、上限直前、上限超過fixtureを最小byte列で作る。
- [ ] 不正入力をrenderせず安全なfallback/errorへ送るobservable behaviorを検証する。
- [ ] 対象Electron browser testをRED/GREENで実行する。

### Task 12: Relay securityとWebRTC fallback

**Files:**
- Modify tests under: `app/protocol/test/`, `app/relay/test/`, `app/mobile/src/`
- Modify tests under: `src/vs/paradis/contrib/mobileRelay/test/`
- Modify production only for discovered defects in matching app/mobileRelay files.

- [ ] file read/uploadの`..`、absolute、symlink越境を拒否する契約テストを追加する。
- [ ] WebRTC offer/answer/ICE SID一致、timeout、stop、JPEG fallback復帰を追加する。
- [ ] Relay auth failure、重複・順序逆転frame、reconnect keepaliveを追加する。
- [ ] `pnpm -r typecheck/test`とPC側対象Mochaを実行する。

### Task 13: Workspace Switch cancel/dispose

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchService.test.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchIntegration.test.ts`

- [ ] 競合switch、途中cancel、target削除、dispose後callback、失敗時rollbackを追加する。
- [ ] terminal/editor ownershipが元scopeへ戻ることをobservable stateで確認する。
- [ ] browser対象testをmutation付きで検証する。

### Task 14: Bookmark storage復旧

**Files:**
- Create: `src/vs/paradis/contrib/browserBookmarks/test/electron-browser/paradisBookmarksService.test.ts`
- Modify only for injection/defect: `src/vs/paradis/contrib/browserBookmarks/electron-browser/paradisBookmarksService.ts`

- [ ] 壊れたJSON、旧schema、重複ID/URL、root欠損から安全に復旧するtestを書く。
- [ ] 復旧後のinsert/move/removeと再保存結果を確認する。
- [ ] Electron browser対象testをRED/GREENで実行する。

### Task 15: ccusage warm cache

**Files:**
- Create: `src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts`
- Modify: `src/vs/paradis/contrib/ccusage/node/paradisCcusageChannel.ts`

- [ ] TTL、single-flight、manual bypass、fresh warm skip、idle停止をfake clockで追加する。
- [ ] 3連続失敗停止、dispose、offline fallback短TTL、child timeout/output上限を追加する。
- [ ] 必要なexec/clock dependencyだけ注入し、Node対象testをRED/GREENで実行する。

### Task 16: Spreadsheet DOM性能

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisSpreadsheetStickyStrips.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.ts`

- [ ] layout readがDOM writeより先に完了し、列・行を各1回のfragment appendで追加するtestを書く。
- [ ] 空表と実測offset/size反映を確認する。
- [ ] DOM dependencyを小さなhelperへ抽出し、対象testをRED/GREENで実行する。

### Task 17: Parcel watcher long-path patch

**Files:**
- Create: `build/lib/test/paradisParcelWatcherPatch.test.ts`
- Modify: `build/npm/paradisParcelWatcherPatch.ts`

- [ ] 対象版へのpatch、非対象版skip、2回適用の冪等性、long-path変換をtemporary fixtureで検証する。
- [ ] malformed inputでは元ファイルを半端に書き換えないことを確認する。
- [ ] `cd build && npm run typecheck` と対象build testを実行する。

### Task 18: Browser automation preload

**Files:**
- Modify: `src/vs/platform/browserView/common/browserViewAutomationInput.ts`
- Modify: `src/vs/platform/browserView/electron-browser/preload-browserView.ts`
- Modify: `src/vs/platform/browserView/test/common/browserViewAutomationInput.test.ts`

- [ ] active expectationのfirst matchはconsume+ack、second matchはconsumeのみを返す純粋decision testを書く。
- [ ] native focus、unmatched signature、inactive、complete TTLを追加する。
- [ ] preloadを同じdecision helperへ接続し、Node対象testをRED/GREENで実行する。

### Task 19: Remote transcript mirror renderer配線

**Files:**
- Create: `src/vs/paradis/contrib/mobileRelay/test/electron-browser/paradisRemoteTranscriptMirror.contribution.test.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisRemoteTranscriptMirror.contribution.ts`

- [ ] chunk offset、短read再実行、reset、owner unavailable、stop/release、disposeを追加する。
- [ ] file serviceとchannelを最小注入し、store core testとは重複しない。
- [ ] Electron browser対象testをRED/GREENで実行する。

### Task 20: Default extensionsとrelease契約

**Files:**
- Create: `src/vs/paradis/contrib/defaultExtensions/test/electron-browser/paradisDefaultExtensions.test.ts`
- Modify only for extraction: `src/vs/paradis/contrib/defaultExtensions/electron-browser/paradisDefaultExtensions.contribution.ts`
- Create or modify closest release contract test under: `build/lib/test/`

- [ ] bundled VSIX列挙、欠損、重複、既導入、version更新、破損storageを追加する。
- [ ] update feed platform名とrelease artifact名、Open VSX checksum参照を実際のmanifest readerで検証する。
- [ ] Electron/browser対象testとbuild対象testを実行する。

### Task 21: Sentry秘匿化の残り

**Files:**
- Modify tests under: `src/vs/paradis/contrib/sentry/test/common/`
- Modify only for defects: `src/vs/paradis/contrib/sentry/common/`

- [ ] path、query、token、環境変数、process metadataを含むevent fixtureを通し、safe allow-list以外が除去されることを追加する。
- [ ] cancellationとforeign crashが引き続きdropされることを追加する。
- [ ] Node対象testをmutation付きで実行する。

## Final Verification

- [ ] `git diff --check` を実行する。
- [ ] `npm run transpile-client` または変更範囲に必要なtypecheckを実行する。
- [ ] 追加したVS Code Node/Electron/browser対象テストをrunner別に再実行する。
- [ ] `cd app && pnpm -r typecheck && pnpm -r test` を実行する。
- [ ] build変更があれば `cd build && npm run typecheck` と対象testを実行する。
- [ ] `git status --short` と `git diff --name-only` で担当外変更がないことを確認する。
- [ ] コミット・pushを作成していないことを確認する。
