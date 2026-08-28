# Spreadsheet Viewer and Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Excel表示とDiffをraw OOXMLを正本とするsemantic workbook、決定的書式、構造Diff、virtualized renderへ移行する。

**Architecture:** Package Readerがworkbook/sheet/style/object Partを解析し、ExcelJSはrender projectionに限定する。Node workerが全体semantic Diffを完了し、rendererはhandleからviewportとchange pageを取得する。

**Tech Stack:** TypeScript、ExcelJS、namespace-aware XML parser、Worker、SVG、VS Code DOM/Scrollable、Mocha。

**Spec:** `docs/superpowers/specs/2026-08-24-office-viewer-complete-design.md` sections 5, 7, 18-25, 33-35.

## Global Constraints

- raw OOXMLがsemantic authoritative、ExcelJSとの不一致はdiagnostic。
- 数式を再計算しない。stored formulaとcached resultを分離する。
- hidden/veryHidden/printArea外もsemantic Diff対象。
- CFの未確定依存は`notEvaluated`であり、rule Diffは失わない。
- macro/external/OLE等はmetadata/hash/placeholderのみ。
- full Diffはviewportと独立してterminal manifestまで実行する。

---

## Per-Task Test Commands

Prefix every command with `/Users/magu/.local/bin/mise exec node@24.18.0 --`.

| Task | Test file passed to `./scripts/test.sh --run` | Expected RED |
|---|---|---|
| 1 | `src/vs/paradis/contrib/fileViewers/test/node/paradisSpreadsheetSemanticParser.test.ts` | missing semantic parser |
| 2 | `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetNumberFormat.test.ts` | missing formatter |
| 3A | `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetConditionalFormatting.test.ts` | missing CF parser |
| 3B | `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetAnnotations.test.ts` | missing annotation parser |
| 4A | `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetTables.test.ts` | missing table/print parser |
| 4B | `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetObjects.test.ts` | missing object/security parser |
| 4C | `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisSpreadsheetObjectRenderer.test.ts` | missing renderer |
| 5 | `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetSemanticDiff.test.ts` | missing semantic Diff |
| 6 | `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisSpreadsheetViewport.test.ts` | missing viewport |
| 7 | `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisSpreadsheetInspector.test.ts` | missing v1 UI |

After GREEN run `npm run transpile-client`; Tasks 1, 5, 6, 7 also run `npm run typecheck-client`.

### Task 1: Spreadsheet Semantic Types and Workbook Parser

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetSemantic.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetSemanticParser.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetNodeAdapter.ts`
- Create: `src/vs/paradis/contrib/fileViewers/browser/spreadsheet/paradisSpreadsheetWebAdapter.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/node/paradisSpreadsheetSemanticParser.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/common/paradisSpreadsheet.ts`

**Interfaces:**
- Produces: `ParadisSpreadsheetSnapshot`, `ParadisSemanticSheet`, `ParadisSemanticCell`
- Consumes: `ParadisOfficeInventory`

- [ ] **Step 1: Write failing cell identity tests**

```ts
test('keeps formula, cached result, raw type, and cache absence separate', async () => {
	const snapshot = await parseSpreadsheetSemantic(formulaFixture());
	assert.deepStrictEqual(snapshot.sheets[0].cells.get('B2'), {
		storedType: 'formula', rawValue: undefined,
		formula: { text: 'SUM(B3:B6)', kind: 'normal' },
		cachedResult: { present: true, type: 'number', rawValue: '100' },
		styleRef: 1
	});
});
```

Also test number `1`, string `"1"`, empty string, blank, formula result `1`, no-cache formula, shared/array formula, error, date1904.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement workbook/sheet/cell semantic parse**

Parse workbook order/state, calcPr, names, sheet views, row/column props, merges, sparse cells, raw `<f>/<v>/<is>`, styles references and completeness counters. Preserve hidden rows instead of dropping them. The common parser consumes `IParadisOfficeArchive`/XML token streams and imports no Node/DOM/workbench module; Node and Web adapters supply archive/worker/runtime services.

- [ ] **Step 4: Reconcile ExcelJS as projection only**

Keep existing runtime for legacy render, but add diagnostics when projection differs from raw semantic value. Do not overwrite semantic fields.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(spreadsheet): add semantic workbook model`.

### Task 2: Number Format Engine

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetNumberFormat.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetNumberFormat.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetSemanticParser.ts`

**Interfaces:**
- Produces: `formatSpreadsheetValue(value, format, context): ParadisFormattedCellValue`

- [ ] **Step 1: Write failing format corpus tests**

Cover built-in 0-49, custom positive/negative/zero/text sections, conditions/colors, percent, accounting, fraction, scientific, escaped/quoted text, date/time, 1900/1904, serial 60, application/workbook locale fallback.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement parser and formatter**

Tokenize without locale-dependent `Date`. Keep Excel serial timezone-free. Return `{ text, status: 'exact' | 'approximated', unsupportedTokens }`; never silently use General for unsupported tokens.

- [ ] **Step 4: Integrate formatted display into render projection, not semantic identity**

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(spreadsheet): render deterministic number formats`.

### Task 3A: Conditional Formatting Semantics

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetConditionalFormatting.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetConditionalFormatting.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetSemantic.ts`

**Interfaces:** Produces typed CF rules and `exact | notEvaluated` outcomes.

- [ ] Write failing tests for priority/stopIfTrue, cellIs, relative/absolute refs, expression subset, top10/average/duplicate/text/time, colorScale/dataBar/iconSet, and cached-value source rules.
- [ ] Run `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetConditionalFormatting.test.ts`; expect missing parser/evaluator.
- [ ] Implement rule parse/evaluation without recalculation; unresolved cache/error/cycle/external becomes`notEvaluated`.
- [ ] Run the same test plus transpile, complete mandatory two-stage review, and commit `feat(spreadsheet): add conditional format semantics`.

### Task 3B: Validation, Comments, and Hyperlinks

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetAnnotations.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetAnnotations.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetSemantic.ts`

**Interfaces:** Produces validation, legacy/threaded comment, person, hyperlink records.

- [ ] Write failing tests for x14 validation, note, threaded reply/resolve, hyperlink target/location/tooltip, unsafe/external scheme.
- [ ] Run the single test; expect missing annotation parser.
- [ ] Implement semantic parse, redacted UI values, normalized target hash, and zero external fetch.
- [ ] Run test/transpile, complete mandatory two-stage review, and commit `feat(spreadsheet): add annotations and links`.

### Task 4A: Tables, Filters, and Print Semantics

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetTables.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetTables.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/common/paradisSpreadsheetPageLayout.ts`

- [ ] Write failing tests for table range/columns/totals/style, AutoFilter/sort, print areas/titles/header/footer/options.
- [ ] Run the test; expect missing parser.
- [ ] Implement typed semantic nodes and completeness accounting.
- [ ] Run test/transpile, complete mandatory two-stage review, and commit `feat(spreadsheet): model tables filters and print`.

### Task 4B: Pivot, Drawings, Charts, and Security Semantics

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetObjectParser.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetObjects.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetObjects.test.ts`

**Interfaces:** Produces pivot/cache, image/drawing/chart, protection/VBA/OLE/ActiveX/external semantic nodes.

- [ ] Write failing tests for duplicate names, image content/placement/style, chart series/cache, pivot source/cache, protection and unsafe Parts.
- [ ] Run the test; expect missing parser.
- [ ] Implement duplicate-safe identities, typed chart/pivot nodes, hashes, and unsafe metadata only.
- [ ] Run test/transpile, complete mandatory two-stage review, and commit `feat(spreadsheet): model objects and security`.

### Task 4C: Spreadsheet Object Render Primitives

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/spreadsheet/paradisSpreadsheetObjectRenderer.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisSpreadsheetObjectRenderer.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDrawings.ts`

- [ ] Write failing tests for supported chart SVG, image/drawing primitives, unsupported anchored placeholder, and raw XML/SVG denial.
- [ ] Run the test; expect missing renderer.
- [ ] Implement renderer over typed safe nodes and Platform sanitizer contract.
- [ ] Run test/transpile, complete mandatory two-stage review, and commit `feat(spreadsheet): render safe workbook objects`.

### Task 5: Semantic Spreadsheet Diff and Alignment

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetSemanticDiff.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/spreadsheet/paradisSpreadsheetGridAlign.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisSpreadsheetSemanticDiff.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDiff.ts`

**Interfaces:**
- Produces: paged `ParadisOfficeChange` records and logical row/column alignment maps

- [ ] **Step 1: Write failing Diff invariant tests**

Cover formula-same-result, type-only, numFmt-only, CF-only, row/column insertion/move, duplicate rows/columns, 2,000 boundary, hidden row, sheet rename/order/state, row/column size, merge, names, annotations, objects, opaque Part.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement sheet matcher and grid aligner**

Use part identity→name→content fingerprint. Use patience unique anchors then bounded Myers/LCS for rows and columns. Ambiguous ties become added/removed with certainty, never silent index fallback.

- [ ] **Step 4: Implement category/change paging and terminal completeness**

Content/format/structure/annotation/object/security categories, source Part refs, navigable anchors, certainty. Float tolerance is a diagnostic only; exact raw values remain changes.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(spreadsheet): add semantic grid diff`.

### Task 6: Virtualized Grid, Freeze Panes, and Logical Scroll Sync

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/spreadsheet/paradisSpreadsheetViewport.ts`
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/spreadsheet/paradisSpreadsheetGridRenderer.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisSpreadsheetViewport.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDiffEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/media/paradisSpreadsheet.css`

**Interfaces:**
- Consumes: `getViewport(handle, sheet, range)` and alignment map
- Produces: corner/top/left/body panes with <=10,000 live cells

- [ ] **Step 1: Write failing viewport/freeze tests**

Test 100k cells, 16,384 columns, hidden/group, frozen row/column, resize/fonts-ready remeasure, logical anchor scroll, keyboard grid semantics, stale tile rejection.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement two-dimensional virtualization**

Use overscan tiles, measured row/column prefix sums, generation/revision fence, reusable cell nodes, delayed media decode.

- [ ] **Step 4: Implement freeze and Diff alignment**

Render four synchronized areas. Sync Diff by logical aligned row/column anchor, not pixel scrollTop.

- [ ] **Step 5: Verify DOM/performance gates and commit**

Commit: `perf(spreadsheet): virtualize grid and freeze panes`.

### Task 7: Spreadsheet Inspector, Search, Print, and Legacy Adapter

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/spreadsheet/paradisSpreadsheetChangeInspector.ts`
- Create: `src/vs/paradis/contrib/fileViewers/electron-browser/spreadsheet/paradisSpreadsheetDiagnostics.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisSpreadsheetInspector.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDiffEditor.ts`

**Interfaces:**
- Consumes: semantic search/compare/print model APIs
- Preserves: legacy editor/input/serializer/channel fallback

- [ ] **Step 1: Write failing UI contract tests**

Test diagnostics ribbon, category counts, No Changes gate, placeholder navigation, hidden-sheet search result, print warning, zoom/filter persistence, cancel input restoration, aria labels/live announcements/high contrast tokens.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement v1 UI behind runtime settings**

Keep legacy path selectable with`engine=legacy`. Restore SourceDescriptor/view state, never handle IDs.

- [ ] **Step 4: Verify tests and typecheck, complete mandatory two-stage review, and commit**

Commit: `feat(spreadsheet): integrate semantic viewer and inspector`.
