# Office Viewer Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Office形式に共通するSourceBroker、bounded package inventory、worker隔離、outcome/completeness、versioned IPCを追加する。

**Architecture:** workbench SourceBrokerがprovider固有sourceをsealed spoolへ変換し、shared/remote backendのworkerがuntrusted packageを解析する。Kernelはformat adapterへ安全なPart graphとhandleを渡し、旧channelをcompatibility adapterとして維持する。

**Tech Stack:** TypeScript、IFileService、Git FS provider、VSBuffer、worker_threads、Web Worker、yauzl/JSZip、crypto SHA-256、Mocha。

**Spec:** `docs/superpowers/specs/2026-08-24-office-viewer-complete-design.md` sections 3, 4, 8, 9, 17, 19, 21, 24, 29-36.

## Global Constraints

- `SourceDescriptor`はserializable dataだけを持ち、stream/watchをIPCへ渡さない。
- Git/index/untitled/old remoteはworkbench SourceBroker経由に限定する。
- untrusted parse/diffをshared process event loopで実行しない。
- generic raw Part APIを作らず、renderable asset allowlistだけを公開する。
- `completeOpaque`は全bytes hash確定時だけ許す。
- `engine=legacy`で新open/render/diff/search/printをruntime rollbackできる。

---

## Per-Task Test Commands

All commands are prefixed with `/Users/magu/.local/bin/mise exec node@24.18.0 --`.

| Task | RED/GREEN command | Expected RED |
|---|---|---|
| 1 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeFixture.test.ts` | missing `buildOpcFixture` |
| 2 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeProtocol.test.ts` | missing protocol module/export |
| 3 | run SourceBroker and SpoolStore test files separately with `--run` | missing broker/store export |
| 4 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/node/paradisOfficePackageReader.test.ts` | missing archive/core implementation |
| 5 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/node/paradisOfficeWorkerHost.test.ts` | missing worker host/store |
| 6 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/node/paradisOfficeChannel.test.ts` | missing v1 channel |

After each GREEN run `npm run transpile-client`; Tasks 2, 4, and 6 also run `npm run typecheck-client` because they freeze shared interfaces/layers.

### Task 1: Audit Acceptance Matrix and Fixture Builder

**Files:**
- Create: `docs/office-viewer-acceptance-matrix.md`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeFixture.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeFixture.test.ts`

**Interfaces:**
- Produces: `buildOpcFixture(parts, relationships): Uint8Array`
- Produces: audit rows with `id | requirement | status | implementation | test | runtimeEvidence`

- [ ] **Step 1: Write the failing fixture test**

```ts
suite('ParadisOfficeFixture', () => {
	test('builds a deterministic OPC package independent of input ordering', async () => {
		const a = await buildOpcFixture({ parts: [['/a.xml', '<a/>'], ['/b.bin', new Uint8Array([1])]] });
		const b = await buildOpcFixture({ parts: [['/b.bin', new Uint8Array([1])], ['/a.xml', '<a/>']] });
		assert.deepStrictEqual(a, b);
	});
});
```

- [ ] **Step 2: Verify RED**

Run: `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeFixture.test.ts` through mise.  
Expected: FAIL because `buildOpcFixture` does not exist.

- [ ] **Step 3: Implement deterministic fixture builder**

Use JSZip with sorted canonical part names, fixed timestamp, explicit content types, and relationship helpers. Export only test utilities.

- [ ] **Step 4: Populate the acceptance matrix**

Copy every A/B/C/D row and every additional row from `docs/report-office-mock.html`. Required columns are `id | requirement | ownerTask | expectedBehavior | fixture | unitTest | runtimeGate | status | commit`. Mark existing fixes `verified-existing`, new work `pending`, and safe non-goals `pending-fallback`; do not mark anything complete without test/runtime evidence.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Run the single test and `git diff --check`. Commit: `test(office): add audit matrix and package fixtures`.

### Task 2: Common Source, Outcome, Coverage, and Error Types

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeProtocol.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeErrors.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeProtocol.test.ts`

**Interfaces:**
- Produces: `ParadisOfficeSourceDescriptor`
- Produces: `ParadisOfficeOutcome`, `ParadisOfficePartCoverage`, `ParadisOfficeCompletenessManifest`
- Produces: `ParadisOfficeInventory`, `ParadisOfficeBudgetProfile`, `ParadisOfficeChange`, `ParadisOfficeRenderableAsset`
- Produces: `aggregateOfficeOutcome(parts: readonly ParadisOfficePartStatus[]): ParadisOfficeOutcome`

- [ ] **Step 1: Write failing aggregation tests**

```ts
test('allows completeOpaque in a complete analysis but degrades unfinished opaque parts', () => {
	assert.strictEqual(aggregateOfficeOutcome([{ coverage: 'completeOpaque', required: false }]), 'complete');
	assert.strictEqual(aggregateOfficeOutcome([{ coverage: 'opaque', required: false }]), 'degraded');
	assert.strictEqual(aggregateOfficeOutcome([{ coverage: 'failed', required: true }]), 'blocked');
});
```

- [ ] **Step 2: Verify RED**

Run the new test. Expected: missing module/function.

- [ ] **Step 3: Implement exact enums and aggregation**

```ts
export type ParadisOfficeOutcome = 'complete' | 'degraded' | 'blocked' | 'sideMissing' | 'cancelled' | 'stale' | 'failed';
export type ParadisOfficePartCoverage = 'parsed' | 'partial' | 'opaque' | 'completeOpaque' | 'unsafe' | 'failed' | 'omittedByBudget';
export interface ParadisOfficePartStatus { readonly coverage: ParadisOfficePartCoverage; readonly required: boolean }

export interface ParadisOfficeSourceDescriptor {
	readonly kind: 'file' | 'remote' | 'gitCommit' | 'gitIndex' | 'workingTree' | 'untitled' | 'sideMissing';
	readonly uri?: string;
	readonly revisionHint?: string;
	readonly displayName: string;
	readonly side?: 'original' | 'modified';
}

export type ParadisOfficeChangeValue =
	| { readonly kind: 'none' }
	| { readonly kind: 'scalar'; readonly valueType: 'text' | 'number' | 'boolean' | 'null'; readonly value: string | boolean | null }
	| { readonly kind: 'list'; readonly items: readonly ParadisOfficeChangeValue[] }
	| { readonly kind: 'record'; readonly fields: readonly { readonly name: string; readonly value: ParadisOfficeChangeValue }[] }
	| { readonly kind: 'fingerprint'; readonly algorithm: 'sha256'; readonly value: string; readonly byteLength: number };

export interface ParadisOfficePlaceholder {
	readonly nodeId: string;
	readonly feature: string;
	readonly reason: 'unsupported' | 'unsafe' | 'notEvaluated' | 'budget' | 'noAnchor';
	readonly title: string;
	readonly detail?: string;
	readonly fingerprint?: string;
}

export type ParadisOfficeHandleRef =
	| { readonly kind: 'document'; readonly id: string }
	| { readonly kind: 'comparison'; readonly id: string };

export type ParadisOfficeRequest =
	| { readonly version: 1; readonly requestId: string; readonly operation: 'inspect'; readonly source: ParadisOfficeSourceDescriptor }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'open'; readonly source: ParadisOfficeSourceDescriptor }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'getViewport'; readonly handle: ParadisOfficeHandleRef; readonly locator: string; readonly range: readonly [number, number, number, number] }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'compare'; readonly original: ParadisOfficeSourceDescriptor; readonly modified: ParadisOfficeSourceDescriptor; readonly cursor?: string }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'search'; readonly handle: ParadisOfficeHandleRef; readonly query: string; readonly cursor?: string }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'getRenderableAsset'; readonly handle: ParadisOfficeHandleRef; readonly assetId: string; readonly offset: number; readonly length: number }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'getPrintModel'; readonly handle: ParadisOfficeHandleRef; readonly options: { readonly includePlaceholders: true; readonly pageRange?: readonly [number, number] } }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'exportPrint'; readonly handle: ParadisOfficeHandleRef; readonly format: 'pdf'; readonly pageRange?: readonly [number, number] }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'close' | 'cancel'; readonly handle?: ParadisOfficeHandleRef; readonly targetRequestId?: string };

export interface ParadisOfficeResponseMeta {
	readonly version: 1;
	readonly requestId: string;
	readonly outcome: ParadisOfficeOutcome;
	readonly warnings: readonly { readonly code: string; readonly message: string }[];
	readonly budgetUsage: Readonly<Record<string, number>>;
	readonly timings: Readonly<Record<string, number>>;
}

export interface ParadisOfficeDocumentResponseBase extends ParadisOfficeResponseMeta {
	readonly revision: { readonly kind: 'document'; readonly sourceRevision: string };
	readonly completeness: ParadisOfficeCompletenessManifest;
}

export interface ParadisOfficeComparisonResponseBase extends ParadisOfficeResponseMeta {
	readonly revision: {
		readonly kind: 'comparison';
		readonly originalRevision: string;
		readonly modifiedRevision: string;
		readonly comparisonRevision: string;
	};
	readonly completeness: ParadisOfficeCompletenessManifest;
}

export type ParadisOfficeHandleResponseBase = ParadisOfficeDocumentResponseBase | ParadisOfficeComparisonResponseBase;

export type ParadisOfficeResponse =
	| (ParadisOfficeDocumentResponseBase & { readonly ok: true; readonly operation: 'inspect'; readonly inventory: ParadisOfficeInventory })
	| (ParadisOfficeDocumentResponseBase & { readonly ok: true; readonly operation: 'open'; readonly handle: { readonly kind: 'document'; readonly id: string }; readonly capabilities: readonly string[] })
	| (ParadisOfficeHandleResponseBase & { readonly ok: true; readonly operation: 'getViewport'; readonly tile: ParadisOfficeRenderTile })
	| (ParadisOfficeComparisonResponseBase & { readonly ok: true; readonly operation: 'compare'; readonly handle: { readonly kind: 'comparison'; readonly id: string }; readonly changes: readonly ParadisOfficeChange[]; readonly nextCursor?: string; readonly terminal: boolean })
	| (ParadisOfficeHandleResponseBase & { readonly ok: true; readonly operation: 'search'; readonly results: readonly ParadisOfficeSearchResult[]; readonly nextCursor?: string })
	| (ParadisOfficeHandleResponseBase & { readonly ok: true; readonly operation: 'getRenderableAsset'; readonly assetId: string; readonly offset: number; readonly totalLength: number; readonly bytes: VSBuffer })
	| (ParadisOfficeHandleResponseBase & { readonly ok: true; readonly operation: 'getPrintModel'; readonly printModel: ParadisOfficePrintModel })
	| (ParadisOfficeHandleResponseBase & { readonly ok: true; readonly operation: 'exportPrint'; readonly assetId: string; readonly mime: 'application/pdf'; readonly byteLength: number })
	| (ParadisOfficeResponseMeta & { readonly ok: true; readonly operation: 'close' | 'cancel'; readonly acknowledged: true })
	| { readonly version: 1; readonly requestId: string; readonly operation: ParadisOfficeRequest['operation']; readonly ok: false; readonly revision?: ParadisOfficeDocumentResponseBase['revision'] | ParadisOfficeComparisonResponseBase['revision']; readonly outcome: Exclude<ParadisOfficeOutcome, 'complete'>; readonly completeness?: ParadisOfficeCompletenessManifest; readonly error: ParadisOfficeError };

export interface ParadisOfficeChange {
	readonly id: string;
	readonly category: 'content' | 'formatting' | 'structure' | 'annotation' | 'revision' | 'object' | 'security';
	readonly subject: { readonly kind: string; readonly locator: string };
	readonly before: ParadisOfficeChangeValue;
	readonly after: ParadisOfficeChangeValue;
	readonly certainty: 'exact' | 'normalized' | 'heuristic' | 'ambiguous' | 'opaque' | 'degraded';
	readonly sourceParts: readonly string[];
	readonly navigableAnchor?: string;
}
```

`ParadisOfficeRenderTile`はtyped cell/block/object/placeholderの配列、`ParadisOfficeSearchResult`はlocator/preview/location badge、`ParadisOfficePrintModel`はscript-free page/block/placeholder treeとして同じcommon moduleに定義する。`VSBuffer`以外は循環を持たないserializable dataに限定する。

document handleは通常表示、comparison handleは左右snapshot・alignment map・change indexを所有する。`getViewport/search/getPrintModel/exportPrint/getRenderableAsset`は両handle種別を受け、comparison handleでは左右またはDiff合成locatorを解決する。owner/nonce/quotaはhandle種別ごとではなく合算して適用する。

`ParadisOfficeChangeValue`は最大depth 8、list 256件、record 128 field、1 string 4,096文字、change全体64KiBに制限し、超過部分はfingerprint valueへ置き換える。cursorはsource revisionへbindし、1 response serialized payloadは2MiB以下、asset request lengthも2MiB以下に制限する。Task 6はこのunionを変更せずtransportだけを実装する。

Implement required/optional rules from spec section 31 and `canReportNoChanges(manifest, outcome, changeCount)`.

- [ ] **Step 4: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(office): add source outcome and coverage contracts`.

### Task 3: Workbench SourceBroker and Sealed Spool

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeSourceBroker.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeSourceBroker.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/paradisOfficeSpoolStore.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/browser/paradisOfficeSourceBroker.test.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/node/paradisOfficeSpoolStore.test.ts`

**Interfaces:**
- Consumes: `ParadisOfficeSourceDescriptor`
- Produces: `IOfficeSourceBroker.open(descriptor, token): Promise<ParadisOfficeBackendSource>`
- Produces: `OfficeSpoolStore.begin/append/seal/open/dispose`

- [ ] **Step 1: Write failing ownership/quota tests**

Test owner nonce rejection, 2 spool/client, 8 global, 2MiB chunk, platform byte budget, 2-minute unsealed expiry, crash/disconnect cleanup, and SHA-256 revision.

- [ ] **Step 2: Verify RED**

Run both source/spool test files; expect missing implementation.

- [ ] **Step 3: Implement broker routing**

Use direct backend descriptor only for local file and v1 remote. Route Git commit/index, untitled, old remote through bounded VSBuffer chunks. Seal only after content hash and before/after provider revision agree.

- [ ] **Step 4: Implement spool cleanup**

Use random owner-bound IDs, RunOnceScheduler expiry, idempotent dispose, and per-owner/global counters. Do not expose filesystem paths.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(office): add bounded source broker and spool`.

### Task 4: Bounded OPC Inventory and Canonicalization

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/office/paradisOfficeBudget.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/office/paradisOfficeArchive.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/office/paradisOfficePackageCore.ts`
- Create: `src/vs/paradis/contrib/fileViewers/common/office/paradisOfficeCanonicalXml.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/office/paradisOfficeNodeArchive.ts`
- Create: `src/vs/paradis/contrib/fileViewers/browser/office/paradisOfficeWebArchive.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/node/paradisOfficePackageReader.test.ts`

**Interfaces:**
- Produces: pure `inspectOfficePackage(archive: IParadisOfficeArchive, profile, token): Promise<ParadisOfficeInventory>`
- Produces: Node and Web implementations of `IParadisOfficeArchive`
- Produces: `canonicalizeOfficeXml(xml, relationshipResolver): CanonicalXmlResult`

- [ ] **Step 1: Write failing package security tests**

Cover entry/container ratio, expanded byte accounting, entries ±1, duplicate path, traversal, missing relationship, XML depth/node/attribute limits, canonical prefix/attribute order, and unknown subtree sensitivity.

- [ ] **Step 2: Verify RED**

Expected: missing package reader.

- [ ] **Step 3: Implement streaming inventory**

Count real decompressed bytes while reading. Abort current entry immediately on hard limit. Preserve remaining central-directory metadata only when safe. Compute raw SHA-256 for every fully read Part.

- [ ] **Step 4: Implement namespace-aware canonicalization**

Use QName URI/local name, sorted attributes, `xml:space`, relationship target replacement, MC Choice/Fallback branch hashes, and per-subtree SourceRef. Disable DTD/entity resolution. The common core may not import Node, Electron, DOM, or workbench services; Node/Web adapters provide streaming ZIP/XML primitives.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(office): add bounded package inventory`.

### Task 5: Worker Isolation and Handle Registry

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/node/office/paradisOfficeWorkerHost.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/office/paradisOfficeWorkerMain.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/office/paradisOfficeHandleStore.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/node/paradisOfficeWorkerHost.test.ts`

**Interfaces:**
- Produces: `OfficeWorkerHost.run(operation, source, budget, token)`
- Produces: owner-bound `OfficeHandleStore`

- [ ] **Step 1: Write failing lifecycle tests**

Test cooperative cancel, 250ms forced terminate, parse/diff deadline mapping, memory-limit mapping, exception mapping, client/global worker admission, queue timeout, handle idle/LRU/crash cleanup.

- [ ] **Step 2: Verify RED**

Expected: missing host/store.

- [ ] **Step 3: Implement worker host**

Use worker_threads resource limits from spec. Keep shared process as orchestrator only. Map cancel→cancelled, deadline/memory→blocked, abnormal exit→failed.

- [ ] **Step 4: Implement memory admission and handle quota**

Account worker reservation, cache, spool, and derived assets before start. Evict LRU cache first, queue 30s, then block. Close on editor/window/remote disconnect.

- [ ] **Step 5: Verify GREEN, complete mandatory two-stage review, and commit**

Commit: `feat(office): isolate package workers and handles`.

### Task 6: Versioned Office Document Channel

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/common/paradisOfficeChannel.ts`
- Create: `src/vs/paradis/contrib/fileViewers/node/paradisOfficeChannel.ts`
- Modify: `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts`
- Test: `src/vs/paradis/contrib/fileViewers/test/node/paradisOfficeChannel.test.ts`

**Interfaces:**
- Produces operations: `inspect/open/getViewport/compare/search/getRenderableAsset/getPrintModel/exportPrint/close/cancel`
- Maintains old `paradisSpreadsheet` channel

- [ ] **Step 1: Write failing protocol/version tests**

Test owner/request/revision validation, asset allowlist, unsafe denial, 2MiB range, v0/v1 negotiation, source restore without serialized handle.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement v1 channel and compatibility adapter**

Register the local channel directly in `sharedProcessMain.ts`, following the existing `registerParadisSpreadsheet` pattern. Reject path-based asset requests. Return the exact Task 2 response union without adding transport-specific fields. Remote server registration is Platform Task 2.

- [ ] **Step 4: Verify GREEN, run Kernel glob, complete mandatory two-stage review, and commit**

Commit: `feat(office): add versioned document protocol`.
