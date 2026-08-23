# Office Viewer Platform Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Office KernelをDesktop local/remote、Web、Mobile、Git/index/LFS/untitledへ接続し、CSP、検索、印刷、アクセシビリティ、recoveryを共通化する。

**Architecture:** platform backendはSourceDescriptorとcapability handshakeを共有し、Desktop shared/remote worker、Browser Web Worker、Mobile host relayを選ぶ。v0/v1互換とruntime kill switchで旧経路へ戻せる。

**Tech Stack:** VS Code workbench/remote agent/Web Worker、React Native WebView、CSP、IConfigurationService、IStorageService、Git extension provider。

**Spec:** `docs/superpowers/specs/2026-08-24-office-viewer-complete-design.md` sections 10-12, 20-25, 29, 32, 34, 36.

## Global Constraints

- Git provider/untitledをshared processから直接参照しない。
- Web/Mobileでwildcard origin、外部navigation、external fetchを許可しない。
- old backendはwarning付きlegacy fallbackで、semantic completeを偽装しない。
- Mobile connectedとstandaloneをcapabilityで分ける。
- HTML/Markdown/PDF既存viewerのformat固有処理は不必要に移行しない。

---

## Per-Task Test Commands

Prefix desktop commands with `/Users/magu/.local/bin/mise exec node@24.18.0 --`.

| Task | Command | Expected RED |
|---|---|---|
| 1 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeCapabilities.test.ts` | missing capability/config |
| 2 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeGitSource.test.ts` then `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/node/paradisOfficeServerChannel.test.ts` | missing source/server adapters |
| 3 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeBrowser.test.ts` | missing browser worker/contribution |
| 4 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeSanitizer.test.ts` | missing sanitizer |
| 5 | `./scripts/test.sh --run src/vs/paradis/contrib/mobileRelay/test/electron-browser/paradisMobileWordDiffHtml.test.ts` then `cd app/mobile && /Users/magu/.local/bin/mise exec node@24.18.0 -- npm test -- src/components/officeCapability.test.ts` | missing v1 relay/handshake |
| 6 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeFindWidget.test.ts` | missing search/widget |
| 7 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisOfficePrint.test.ts` | missing print service |
| 8A | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeAccessibility.test.ts` | missing a11y contract |
| 8B | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeRecovery.test.ts` | missing recovery reducer |
| 8C | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeTelemetry.test.ts` | missing telemetry sanitizer |

After GREEN run `npm run transpile-client`; Tasks 1-4, 6-8 also run `npm run typecheck-client`. Browser/remote layering changes run `npm run valid-layers-check`.

### Task 1: Runtime Configuration and Capability Negotiation

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeCapabilities.ts`
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeConfiguration.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeCapabilities.test.ts`
- Modify: `src/vs/paradis/paradis.common.contribution.ts`

**Interfaces:**
- Produces: `ParadisOfficeCapabilitySet`, v0/v1 handshake, engine/subfeature settings

- [ ] **Step 1: Write failing compatibility table tests**

Encode all 10 spec section 36 combinations: v0/v0, v0/v1, v1/v0 local/remote, v1/v1, old/new mobile, Web worker/unavailable.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Register hidden runtime settings and precedence**

`engine=legacy` overrides semantic/virtualized/platform/searchPrint. Policy/CLI/profile setting changes apply on next open.

- [ ] **Step 4: Implement handshake and expected fallback outcome**

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(file-viewers): add Office capability negotiation`.

### Task 2: Desktop Remote and Git Source Backends

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeGitSource.ts`
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeRemoteClient.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/paradisOfficeRemoteBackend.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/paradisOfficeServerChannel.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeSourceBroker.ts`
- Modify: `src/vs/server/node/serverServices.ts`
- Test: `src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeGitSource.test.ts`
- Test: `src/vs/paradis/contrib/fileViewers/test/node/paradisOfficeServerChannel.test.ts`

**Interfaces:**
- Consumes: Git FS resource/ref metadata and Office SourceBroker

- [ ] **Step 1: Write failing source matrix tests**

Test HEAD→index, index→working, stage refresh, rename/delete, side missing, immutable commit, old/new remote, spool stale content hash, LFS pointer oid change, actual working bytes, no network fetch.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement Git/index descriptors and events**

Subscribe to repository status/index events; do not watch `.git` directly. Bind cursor/handle to repository root, HEAD, index checksum, path, content hash.

- [ ] **Step 4: Implement remote backend/fallback**

Register the v1 Office channel from `src/vs/server/node/serverServices.ts`, following `registerParadisCcusageForServer`. The workbench client selects `IRemoteAgentService.getConnection()?.getChannel(...)`; new server opens descriptor remotely, old server uses bounded broker spool and warning. No base64.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(file-viewers): add remote and Git Office sources`.

### Task 3: Browser Worker and Viewer Registration

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeWebWorker.ts`
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeBrowser.contribution.ts`
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeDiagnosticInput.ts`
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeDiagnosticEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/browser/paradisFileViewers.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetViewer.contribution.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxViewer.contribution.ts`
- Modify: `src/vs/paradis/paradis.common.contribution.ts`
- Modify: `src/vs/workbench/workbench.web.main.ts`
- Test: `src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeBrowser.test.ts`

**Interfaces:**
- Produces: Browser Excel/Word View/Diff capability or explicit diagnostic fallback

- [ ] **Step 1: Write failing browser registration/worker tests**

Cover xlsx/xlsm/xltx/xltm/docx/docm/dotx/dotm, unsupported diagnostic formats, worker unavailable, cancel/deadline, no eval/blob worker/external origin.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement browser contribution and Web Worker backend**

Bundle the common OPC/XML core and Spreadsheet/Word semantic parsers into the Web Worker; only archive/worker adapters are browser-specific. Register full semantic extensions `.xltx/.xltm/.docm/.dotx/.dotm`. Register `.xlsb/.ods/.xls/.doc/.rtf` to the new diagnostic editor, which reports detected format, unsupported reason, safe external-app action, and never displays binary garbage.

- [ ] **Step 4: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(file-viewers): enable Office viewers on web`.

### Task 4: CSP and Renderable Asset Sanitization

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeSanitizer.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeSanitizer.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxFileEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxDiffWebview.ts`

**Interfaces:**
- Produces: `sanitizeOfficeSvg(input): ParadisSanitizedSvg | ParadisOfficePlaceholder`
- Produces: `validateAndSubsetOfficeFont(input): ParadisRenderableFont | ParadisOfficePlaceholder`

- [ ] **Step 1: Write failing CSP tests**

Assert exact loopback origin, exact `webview.cspSource` fallback origin, no broad `https:`, wildcard, object/frame/worker. Test mount and remote resource paths separately.

- [ ] **Step 2: Write failing SVG/font allowlist tests**

Reject foreignObject/script/style/animation/filter/image/event attrs/external href/CSS URL/data URL/entities. Accept only spec element/property allowlist. Reject invalid font tables/SVG glyph/external refs; output only trusted WOFF2 within table/glyph/size budgets.

- [ ] **Step 3: Verify RED**

- [ ] **Step 4: Implement typed sanitizers and integrate renderable asset API**

Raw unsafe assets never cross to renderer. Unsupported inputs become fingerprinted placeholders.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(file-viewers): harden Office render assets`.

### Task 5: Mobile Capability, Word Diff Relay, and CSP

**Files:**
- Modify: `app/mobile/src/components/fileViewer.tsx`
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileWorkspaceProvider.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileWordDiffHtml.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/common/paradisMobileOfficeProtocol.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/test/electron-browser/paradisMobileWordDiffHtml.test.ts`
- Create: `app/mobile/src/components/officeCapability.ts`
- Test: `app/mobile/src/components/officeCapability.test.ts`

**Interfaces:**
- Produces: v1 mobile handshake, Host Excel/Word View/Diff relay, standalone explicit fallback

- [ ] **Step 1: Write failing mobile matrix tests**

Cover old/new PC/mobile combinations, connected/standalone, Excel View/Diff, Word View, new Word Diff relay, protocol warning, unavailable host action.

- [ ] **Step 2: Write failing CSP/navigation tests**

Assert exact CSP, no wildcard origin, http/https/file navigation denied, external link routed through native confirmation.

- [ ] **Step 3: Verify RED**

- [ ] **Step 4: Implement handshake, Word Diff relay, and safe WebView policy**

Keep existing Excel Diff relay. `paradisMobileWordDiffHtml.ts` requests paged semantic changes/render assets from the Office channel, serializes bounded HTML through `paradisMobileWorkspaceProvider.ts`, and uses the versioned message types in `paradisMobileOfficeProtocol.ts`. Generate PC/mobile Word assets from one render bundle; enforce existing wire/chunk budgets.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(mobile): add Office capability and Word diff relay`.

### Task 6: Shared Search and Find UI

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeFindWidget.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeSearch.ts`
- Test: `src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeFindWidget.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDiffEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxFileEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxDiffEditor.ts`

**Interfaces:**
- Consumes: `search(handle, query, cursor)`

- [ ] **Step 1: Write failing search contract/UI tests**

Test formatted/raw/formula/comment/link/alt/placeholder/Story/hidden search, NFC/case option, 10k cap, 200 paging, revision cursor invalidation, virtualization navigation, aria-live.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement semantic search and shared widget**

Do not search security secrets, macro binary, raw opaque XML. Reuse VS Code find keybindings and focus rules.

- [ ] **Step 4: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(file-viewers): add semantic Office search`.

### Task 7: Print Model and Export

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficePrint.ts`
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisOfficePrintService.ts`
- Test: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisOfficePrint.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDiffEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxFileEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxDiffEditor.ts`

**Interfaces:**
- Produces: script-free Print Model/HTML/PDF pipeline

- [ ] **Step 1: Write failing print tests**

Cover Excel area/setup/titles/header/footer, Word section/saved breaks, placeholder boxes, approximation warning, page range, Web browser print, Mobile host export, print failure error taxonomy.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement platform backends and actions**

Never print live viewer DOM. Keep unsupported/unsafe placeholders visible.

- [ ] **Step 4: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(file-viewers): add Office print and PDF export`.

### Task 8A: Office Accessibility Contracts

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeAccessibility.ts`
- Test: `src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeAccessibility.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDiffEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxFileEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxDiffEditor.ts`

**Interfaces:**
- Produces: grid/tab/change-list semantics and announcements

- [ ] **Step 1: Write failing keyboard/a11y tests**

Test grid arrows/Home/End/Page, tab/button labels, category not color-only, active descendant, logical counts, high contrast, reduced motion, screen-reader change announcements.

- [ ] Run the test; expect missing accessibility contract/roles.
- [ ] Implement keyboard/grid/tab/change-list/aria-live/high-contrast behavior.
- [ ] Run test/transpile, complete mandatory two-stage review, and commit `feat(file-viewers): add Office accessibility contracts`.

### Task 8B: Viewer Recovery State Machine

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeRecovery.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeRecovery.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDiffEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxFileEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxDiffEditor.ts`
- Modify: `app/mobile/src/components/fileViewer.tsx`

- [ ] Write failing recovery tests.

Test cancel restores previous input/view state, blank detection, remount once, isolated webview recreate once, final error/action, file disappearance/reappearance, rapid watch burst.

- [ ] Run the test; expect missing recovery reducer.
- [ ] Implement pure reducer plus platform effects, maximum two retries, and prior input/view restoration.
- [ ] Run tests/transpile, complete mandatory two-stage review, and commit `fix(file-viewers): unify Office recovery lifecycle`.

### Task 8C: Privacy-Safe Office Observability

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeTelemetry.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeTelemetry.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/node/paradisOfficeChannel.ts`

- [ ] Write failing tests that accept only format/scheme/backend/version/count buckets/timings/outcome and reject path, filename, content, cell text, connection secret.
- [ ] Run the test; expect missing sanitizer/event builder.
- [ ] Implement bounded event schema and redaction.
- [ ] Run tests/transpile, complete mandatory two-stage review, and commit `feat(file-viewers): add private Office observability`.
