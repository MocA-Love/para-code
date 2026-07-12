# Mobile HTML Script Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Para Code MobileのHTMLレンダーで、ワークスペース内HTMLのスクリプトを実行する。

**Architecture:** WebViewのJavaScript有効化ポリシーを副作用のないモジュールへ集約し、通常ファイルビューアとSCM差分ビューアが利用する。HTMLだけを追加で許可し、既存の他形式の条件は維持する。

**Tech Stack:** TypeScript、React Native、react-native-webview、Vitest。

## Global Constraints

- 対象は `.html`、`.htm`、`.xhtml` のレンダー表示だけとする。
- Raw表示とHTML以外の既存のJavaScript実行可否を変えない。
- WebViewからネイティブAPI・認証情報へ到達するブリッジは追加しない。

---

### Task 1: WebView JavaScript policy

**Files:**

- Create: `app/mobile/src/components/webViewScriptPolicy.ts`
- Test: `app/mobile/src/components/webViewScriptPolicy.test.ts`

**Interfaces:**

- Produces: `isFileViewerJavaScriptEnabled(kind, mode, focusLine)` と `isDiffViewerJavaScriptEnabled(kind)`。
- Consumes: ビューアが分類済みのファイル種別と表示モード。

- [ ] **Step 1: Write the failing test**

```ts
expect(isFileViewerJavaScriptEnabled('html', 'render')).toBe(true);
expect(isFileViewerJavaScriptEnabled('markdown', 'render')).toBe(false);
expect(isDiffViewerJavaScriptEnabled('html')).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir app/mobile vitest run src/components/webViewScriptPolicy.test.ts`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export function isFileViewerJavaScriptEnabled(kind: FileViewerKind, mode: FileViewerMode, focusLine?: number): boolean {
	return kind === 'html' || kind === 'spreadsheet' || kind === 'docx' || (mode === 'code' && focusLine !== undefined);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir app/mobile vitest run src/components/webViewScriptPolicy.test.ts`

Expected: PASS.

### Task 2: Apply policy to both HTML renderers

**Files:**

- Modify: `app/mobile/src/components/fileViewer.tsx`
- Modify: `app/mobile/src/components/diffView.tsx`

**Interfaces:**

- Consumes: policy functions from `webViewScriptPolicy.ts`.
- Produces: HTML WebViews whose scripts run in both normal and SCM-rendered views.

- [ ] **Step 1: Replace inline conditions with the policy functions**

```ts
const allowJs = isFileViewerJavaScriptEnabled(kind, mode, focusLine);
javaScriptEnabled={isDiffViewerJavaScriptEnabled(kind)}
```

- [ ] **Step 2: Update comments to state the paired-workspace HTML policy**

```ts
// ペアリング済みワークスペースのHTMLはPC版と同様にスクリプト実行を許可する。
```

- [ ] **Step 3: Run focused test and type check**

Run: `pnpm --dir app/mobile vitest run src/components/webViewScriptPolicy.test.ts && pnpm --dir app/mobile typecheck`

Expected: PASS with no TypeScript errors.

### Task 3: Review and commit

**Files:**

- Modify: the files from Tasks 1 and 2 only.

- [ ] **Step 1: Inspect the staged diff and rerun all mobile tests**

Run: `git diff --check && pnpm --dir app/mobile test && pnpm --dir app/mobile typecheck`

Expected: all commands succeed.

- [ ] **Step 2: Commit only this feature's files**

```bash
git add app/mobile/src/components/fileViewer.tsx app/mobile/src/components/diffView.tsx app/mobile/src/components/webViewScriptPolicy.ts app/mobile/src/components/webViewScriptPolicy.test.ts docs/superpowers/specs/2026-07-13-mobile-html-script-execution-design.md docs/superpowers/plans/2026-07-13-mobile-html-script-execution.md
git commit -m "feat(mobile): run scripts in HTML previews"
```
