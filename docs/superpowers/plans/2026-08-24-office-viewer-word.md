# Word Viewer and Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Word表示とDiffを全Story/構造/Packageを保持するsemantic modelへ移行し、docx-preview描画と安全なplaceholderを統合する。

**Architecture:** Safe OPC AnalyzerがWord semantic treeを生成し、Story/tree/package Diffを計算する。docx-previewはRender Adapterへ隔離し、semantic node IDからDOM anchorへ注釈する。

**Tech Stack:** TypeScript、WordprocessingML/DrawingML、docx-preview、JSZip、MathML/SVG、Worker、Mocha。

**Spec:** `docs/superpowers/specs/2026-08-24-office-viewer-complete-design.md` sections 6, 7, 18, 20, 23, 29-35.

## Global Constraints

- body/header/footer/notes/comments/textboxを別Storyにする。
- table/container境界を越えてparagraphをmatchしない。
- move pair成立後もcontent/format/object/whitespaceを比較する。
- image identityはbinary hash、placement、presentationを分離する。
- Word自動改ページ、field再計算、macro/OLE実行はしない。
- semantic Diffはdocx-preview AST/DOMへ依存しない。

---

## Per-Task Test Commands

Prefix every command with `/Users/magu/.local/bin/mise exec node@24.18.0 --`.

| Task | Test file passed to `./scripts/test.sh --run` | Expected RED |
|---|---|---|
| 1 | `src/vs/paradis/contrib/fileViewers/test/node/paradisWordSemanticParser.test.ts` | missing Story parser |
| 2 | `src/vs/paradis/contrib/fileViewers/test/node/paradisWordStyles.test.ts` | missing style/table/list resolver |
| 3A | `src/vs/paradis/contrib/fileViewers/test/node/paradisWordObjects.test.ts` | missing image/math/field parser |
| 3B | `src/vs/paradis/contrib/fileViewers/test/common/paradisWordSecurity.test.ts` | missing security parser |
| 4 | `src/vs/paradis/contrib/fileViewers/test/common/paradisWordSemanticDiff.test.ts` | missing Story/package Diff |
| 5A | `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisDocxRenderAdapter.test.ts` | missing 0.3.7 adapter |
| 5B | `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisDocxPreview040Adapter.test.ts` | missing 0.4.0 adapter |
| 6 | `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisWordObjectRenderer.test.ts` | missing object renderer |
| 7 | `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisWordInspector.test.ts` | missing v1 UI |

After GREEN run `npm run transpile-client`; Tasks 1, 4, 5B, 7 also run `npm run typecheck-client`. Task 5B additionally verifies deterministic bundle SHA-256 twice from a clean temp directory.

### Task 1: Word Semantic Tree and Story Addresses

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordSemantic.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordSemanticParser.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/word/paradisWordNodeAdapter.ts`
- Create: `src/vs/paradis/contrib/fileViewers/browser/word/paradisWordWebAdapter.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/node/paradisWordSemanticParser.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/common/paradisDocx.ts`

**Interfaces:**
- Produces: `ParadisWordDocument`, `ParadisWordStory`, `ParadisWordNode`, `ParadisWordSourceRef`

- [ ] **Step 1: Write failing Story tests**

```ts
test('separates body header footer footnote comment and textbox stories', async () => {
	const doc = await parseWordSemantic(storyFixture());
	assert.deepStrictEqual(doc.stories.map(s => s.address.kind), [
		'body', 'header', 'footer', 'footnote', 'comment', 'textbox'
	]);
});
```

Test shared header references separately from Story content, first/even/default, endnotes, altChunk, content controls, unknown blocks.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement package-backed Story/tree parser**

Build Section/Paragraph/Table/Row/Cell/ContentControl/Drawing/AltChunk/UnknownBlock trees. Inline nodes include text, tab, typed break, symbol, hyperlink, bookmark, field, OMML, revision, image, note/comment refs. The common parser consumes archive/XML token contracts only; Node and Web adapters provide worker/archive/media implementations.

- [ ] **Step 4: Assign SourceRef and RenderAnchorKey**

Use part URI, semantic path, kind, ordinal, fingerprint; do not use rId alone.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(word): add semantic story model`.

### Task 2: Styles, Theme, Tables, and Numbering

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordStyles.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordTables.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordNumbering.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/node/paradisWordStyles.test.ts`

**Interfaces:**
- Produces: direct/effective properties with provenance; table grid; numbering definition fingerprint

- [ ] **Step 1: Write failing effective-style tests**

Cover docDefaults, basedOn/link/next, paragraph/character/table/numbering style, theme color/font, East Asia/CS, embedded font metadata, explicit-default vs inherited-default.

- [ ] **Step 2: Write failing table/list tests**

Cover gridSpan/vMerge/hMerge, width/height, border/shading, RTL, repeat header, cantSplit, nested tables, abstract numbering, start/restart/override, numFmt/lvlText/picture bullet.

- [ ] **Step 3: Verify RED**

- [ ] **Step 4: Implement resolvers and fingerprints**

Aggregate style definition change once and attach affected node IDs. Do not count every affected paragraph as an independent definition change.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(word): model effective styles tables and lists`.

### Task 3A: Images, OMML, Fields, Sections, and Revisions

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordObjects.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordFields.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/node/paradisWordObjects.test.ts`

**Interfaces:**
- Produces: image content/placement/presentation identities; canonical math; field; section; revision nodes

- [ ] **Step 1: Write failing identity tests**

Cover same path/different image bytes, resize only, crop/rotation/effect/alt text, external image, OMML in-place change, fldSimple/complex field instruction/result/dirty/lock, sectPr, ins/del/move/property revisions.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement canonical parsers**

OMML keeps canonical XML fingerprint and safe projection. Field never recalculates.

- [ ] **Step 4: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(word): model images fields sections and revisions`.

### Task 3B: Word Security and Embedded Objects

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordSecurity.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisWordSecurity.test.ts`

**Interfaces:** Produces macro/OLE/ActiveX/signature/external/embedded package unsafe nodes.

- [ ] Write failing tests for VBA, signature, OLE preview, ActiveX, DDE, external image/relationship, recursive embedded package, and asset raw-access denial.
- [ ] Run the test; expect missing security parser.
- [ ] Implement content-type/relationship detection, hashes, redacted metadata, preview references, and zero execution/fetch.
- [ ] Run test/transpile, complete mandatory two-stage review, and commit `feat(word): model embedded document security`.

### Task 4: Story and Package Diff

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordSemanticDiff.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/word/paradisWordTreeAlign.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisWordSemanticDiff.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/common/paradisDocxDiff.ts`

**Interfaces:**
- Produces: paged change records, Story/tree alignment, terminal completeness

- [ ] **Step 1: Write failing matching tests**

Cover duplicate paragraph, edited move, table boundary, same-depth different table, shared header change/reference switch, footnote text, style/theme, image binary, OMML, field instruction, section, comments/revisions, grapheme clusters.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement hierarchical alignment**

Story→Section→Table/container→Paragraph→Inline. Use unique anchors, patience, bounded Myers, exact tie-break order. Ambiguous ties become added/removed. Enforce candidate budgets and degraded outcomes.

- [ ] **Step 4: Implement package Diff and No Changes gate**

Compare style/theme/numbering/relationships/metadata/security/unknown Part. Stream pages but wait for terminal completeness before 0-count result.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(word): add story and package semantic diff`.

### Task 5A: Reproducible docx-preview 0.3.7 Adapter

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/word/paradisDocxRenderAdapter.ts`
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/word/paradisDocxRenderAnchor.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisDocxRenderAdapter.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/README.md`
- Modify: `build/next/index.ts`
- Modify: `build/gulpfile.vscode.ts`

**Interfaces:**
- Produces: `IDocxRenderAdapter.render(bytes, semantic, options): RenderResult`
- Produces: node-ID-to-DOM-anchor map and render outcomes

- [ ] **Step 1: Write failing adapter contract tests**

Test one-to-one, many-to-one, collision, omitted node→ancestor marker, no anchor→Inspector, Symbol replacement, wide table, cancellation, stale revision.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Isolate 0.3.7 adapter and patch queue**

Move manual patch knowledge from minified assumptions into reproducible source patch/build script. Keep vendored license and deterministic bundle hash.

- [ ] **Step 4: Generate one PC/mobile 0.3.7 bundle and verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(word): make docx preview bundle reproducible`.

### Task 5B: docx-preview 0.4.0 Adapter

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/word/paradisDocxPreview040Adapter.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisDocxPreview040Adapter.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/README.md`

- [ ] Pin upstream source/archive SHA-256, license, patch order, deterministic build command, and output hashes in README/build metadata.
- [ ] Write failing golden tests comparing numbering/table/VML/image/page/DOM anchors/mobile output against accepted 0.3.7 behavior.
- [ ] Run the test; expect missing adapter/bundle.
- [ ] Implement 0.4.0 adapter with`h()` node IDs and only the still-required patch queue.
- [ ] Run adapter/golden tests, complete mandatory two-stage review, and commit `feat(word): add docx preview 0.4 adapter`.

### Task 6: DrawingML, Chart, SmartArt, and Safe Placeholder Renderer

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/word/paradisWordObjectRenderer.ts`
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/word/paradisWordPlaceholder.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisWordObjectRenderer.test.ts`

**Interfaces:**
- Consumes: typed safe object nodes/assets only
- Produces: SVG primitives or placeholders

- [ ] **Step 1: Write failing renderer tests**

Cover DrawingML textbox/shape/WordArt, supported preset geometry, chart cached series, SmartArt flow/hierarchy, unsupported geometry/type, OLE preview, external image, unsafe SVG denial.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement capability-based rendering**

No raw XML/unsafe binary reaches DOM. Every node gets rendered/approximated/placeholder/blockedByPolicy/noAnchor.

- [ ] **Step 4: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(word): render safe document objects and placeholders`.

### Task 7: Word Viewer/Diff Inspector, Search, Print, and State

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/word/paradisWordChangeInspector.ts`
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/word/paradisWordDiagnostics.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxFileEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxDiffEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxDiffWebview.ts`
- Test: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisWordInspector.test.ts`

**Interfaces:**
- Consumes: Story/package change pages, anchors, search/print APIs

- [ ] **Step 1: Write failing UI tests**

Test Story category/counts, visible-but-unmarked legacy scenario, header/footnote/math/image/style changes, Final/Original/Markup, diagnostics/placeholder navigation, search non-body Story, print approximation, zoom/filter persistence, cancel restoration, blank retry, a11y.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement v1 normal/Diff UI behind flag**

Reuse existing toolbar colors/nav/generation/CSP. `No changes` uses Kernel completeness. Keep legacy adapter kill switch.

- [ ] **Step 4: Verify GREEN and typecheck, complete mandatory two-stage review, and commit**

Commit: `feat(word): integrate semantic viewer diff and inspector`.
