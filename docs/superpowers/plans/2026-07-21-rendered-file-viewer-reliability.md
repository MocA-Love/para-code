# Rendered File Viewer Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Markdown and HTML Rendered views serialize refreshes, confirm inner-frame loading, recreate failed webviews automatically, and expose a final Reload action.

**Architecture:** A small render coordinator coalesces requests while guaranteeing single-flight execution. The core webview exposes inner-frame load completion, while `ParadisRenderedFileEditor` owns bounded presentation retries and a workbench-side loading/error layer.

**Tech Stack:** TypeScript, VS Code workbench/webview APIs, Mocha TDD browser tests, CSS.

## Global Constraints

- Do not create a git worktree.
- Preserve the existing Rendered/Raw behavior for Markdown and HTML.
- Keep Markdown document scripts disabled.
- Retry webview presentation at most three times before showing an error.
- Do not modify or commit unrelated untracked files.

---

### Task 1: Serialized Render Coordinator

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisRenderCoordinator.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/browser/paradisRenderCoordinator.test.ts`

**Interfaces:**
- Produces: `ParadisRenderCoordinator.request(): Promise<void>` and `dispose(): void`.
- Consumes: an async runner supplied to the constructor.

- [ ] **Step 1: Write failing tests**

Cover non-overlapping execution, coalescing multiple requests into one follow-up execution, propagating runner failure to request callers, and rejecting pending callers after disposal.

- [ ] **Step 2: Run the focused browser test and confirm failure**

Run: `npm run test-browser-no-install -- --grep "ParadisRenderCoordinator"`

Expected: failure because `paradisRenderCoordinator.js` does not exist.

- [ ] **Step 3: Implement the coordinator**

Implement a disposable class that stores one pending batch of deferred callers and drains batches in a loop:

```ts
export class ParadisRenderCoordinator extends Disposable {
	constructor(private readonly _runner: () => Promise<void>) { super(); }
	request(): Promise<void> { /* enqueue caller and start drain */ }
	private async _drain(): Promise<void> { /* run one batch at a time */ }
}
```

- [ ] **Step 4: Re-run the focused test**

Expected: all coordinator tests pass.

### Task 2: Webview Load Completion Signal

**Files:**
- Modify: `src/vs/workbench/contrib/webview/browser/pre/index.html`
- Modify: `src/vs/workbench/contrib/webview/browser/webview.ts`
- Modify: `src/vs/workbench/contrib/webview/browser/webviewElement.ts`
- Modify: `src/vs/workbench/contrib/webview/browser/overlayWebview.ts`

**Interfaces:**
- Produces: `IWebview.onDidLoad: Event<void>`.
- Consumes: the existing typed `did-load` webview message.

- [ ] **Step 1: Add a compile-failing use of `onDidLoad` in the viewer implementation**

Subscribe to `webview.onDidLoad` before changing the interface.

- [ ] **Step 2: Run `npm run typecheck-client` and confirm the missing-property error**

Expected: TypeScript reports that `onDidLoad` does not exist on `IOverlayWebview`.

- [ ] **Step 3: Wire the load signal through each webview layer**

Emit `did-load` after the pending iframe becomes the visible active frame, expose an emitter on `WebviewElement`, and forward it from `OverlayWebview`.

- [ ] **Step 4: Re-run type checking**

Expected: no TypeScript errors.

### Task 3: Reliable Presentation and Recovery

**Files:**
- Modify: `src/vs/paradis/contrib/fileViewers/browser/paradisRenderedFileEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/browser/media/paradisFileViewer.css`
- Modify: `src/vs/paradis/contrib/fileViewers/test/browser/paradisRenderCoordinator.test.ts`

**Interfaces:**
- Consumes: `ParadisRenderCoordinator` and `IWebview.onDidLoad`.
- Produces: serialized rendering, three-attempt webview recovery, and Reload error UI.

- [ ] **Step 1: Add failing recovery tests to the coordinator test module**

Test a small exported retry helper with success on a later attempt and exhaustion after three failures.

- [ ] **Step 2: Run the focused tests and confirm the expected failures**

- [ ] **Step 3: Implement presentation recovery**

Replace render generations with the coordinator, retain webview context while hidden, await `onDidLoad` with a timeout, recreate the overlay after failure, and preserve the generated HTML across presentation retries.

- [ ] **Step 4: Implement loading and error UI**

Add a workbench DOM status layer with a localized message and Reload button. The button recreates the webview and requests a fresh render.

- [ ] **Step 5: Run focused tests and type checking**

Expected: tests pass and type checking exits successfully.

### Task 4: Review, Verification, and Publication

**Files:**
- Review all files reported by `git diff --name-only HEAD`.

- [ ] **Step 1: Run focused and related tests**

Run the coordinator tests and existing Markdown front matter tests.

- [ ] **Step 2: Run `npm run typecheck-client`**

- [ ] **Step 3: Review the complete diff**

Check error handling, disposal, stale event isolation, localization, accessibility, XSS exposure, and unrelated changes.

- [ ] **Step 4: Commit only task files**

Use one intentional commit after all verification succeeds.

- [ ] **Step 5: Push the feature branch**

Push `fix/rendered-file-viewer-reliability` to `origin` without force.
