# Background Work Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ParaCode-owned polling, listener retention, repeated Aivis requests, and unbounded Codex scan bookkeeping while preserving current UI and discovery behavior.

**Architecture:** Give each expensive background activity an explicit owner: the visible devices tab owns the device poll lease, each partial pane-list render owns only its own row listeners, one Aivis section owns a keyed single-flight result cache and render generation, and a small timestamp ledger owns Codex walk budgets. Test these ownership policies through deterministic helpers, then wire the real components to those helpers.

**Tech Stack:** TypeScript, VS Code lifecycle primitives, DOM helpers, Mocha node tests, shared-process IPC fakes.

**Spec:** `docs/superpowers/specs/2026-08-24-regression-resource-mobile-audit-design.md`

## Global Constraints

- Use TDD: observe every focused regression test fail before changing production code, then run it green.
- Keep all work on `para/audit-fixes-20260824`; never edit the user's main worktree.
- Add no dependency and preserve existing IPC payloads, UI text, polling interval, Codex scan interval, and Aivis API contract.
- Keep polling/listener/cache ownership deterministic and disposable; no new process-wide timer is allowed.
- Do not change unconfirmed audit candidates or upstream-owned code in this plan.
- Edit files only with `apply_patch`; prefix every shell command with `rtk`.

---

### Task 1: Scope mobile-device polling to the visible dialog tab

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialogResources.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisBindingDialogResources.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialog.ts`
- Modify: `src/vs/paradis/contrib/mobileCanvas/electron-browser/paradisMobileCanvasModel.ts`
- Create: `src/vs/paradis/contrib/mobileCanvas/test/electron-browser/paradisMobileCanvasModel.test.ts`

**Interfaces:**
- Consumes: `IParadisMobileCanvasModel.beginPolling(): IDisposable` and existing `DialogTab` values.
- Produces: `ParadisBindingDialogDevicePollLease.setDevicesVisible(visible: boolean): void`; unchanged mobile-canvas public IPC/interface.

- [ ] **Step 1: Write the failing test**

Add a deterministic `ParadisBindingDialogDevicePollLease` test with a fake `beginPolling()` that counts starts and disposals. Cover `panes -> devices -> mcp -> devices`, repeated `devices`, initial `devices`, and owner disposal. Assert that exactly one live lease exists only while the active tab is `devices`.

Add a deterministic `ParadisMobileCanvasSnapshotState` test. The first refresh must request initial loading publication; accepting the initial normalized snapshot closes first-load state. A later identical snapshot returns `changed=false`, while a changed device/attachment returns `changed=true` and becomes the current snapshot.

```ts
const owner = store.add(new ParadisBindingDialogDevicePollLease(() => {
	starts++;
	return toDisposable(() => stops++);
}));
owner.setDevicesVisible(false);
owner.setDevicesVisible(true);
owner.setDevicesVisible(true);
assert.deepStrictEqual({ starts, stops }, { starts: 1, stops: 0 });
owner.setDevicesVisible(false);
assert.deepStrictEqual({ starts, stops }, { starts: 1, stops: 1 });

const snapshots = new ParadisMobileCanvasSnapshotState();
assert.strictEqual(snapshots.beginRefresh(), true);
assert.strictEqual(snapshots.complete({ devices: [], attachments: [] }), false);
assert.strictEqual(snapshots.beginRefresh(), false);
assert.strictEqual(snapshots.complete({ devices: [], attachments: [] }), false);
const changed = { devices: [{ id: 'iphone', name: 'iPhone', platform: 'ios', state: 'booted', isRunning: true }], attachments: [] };
assert.strictEqual(snapshots.complete(changed), true);
assert.strictEqual(snapshots.snapshot, changed);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisBindingDialogResources.test.ts src/vs/paradis/contrib/mobileCanvas/test/electron-browser/paradisMobileCanvasModel.test.ts`

Expected: FAIL because the resource owner does not exist and the dialog starts polling unconditionally.

- [ ] **Step 3: Write minimal implementation**

Implement the owner with a `MutableDisposable<IDisposable>` and an idempotent `setDevicesVisible(boolean)`. In `ParadisBindingDialog`, replace the constructor-wide `beginPolling()` registration with the owner. Route every initial/tab-click assignment through one `_setActiveTab` method that updates the lease before rendering. A page-less dialog starts on `devices`; normal dialogs start on `panes`. Do not poll merely to update the devices badge while another tab is visible; retain the last snapshot.

In `ParadisMobileCanvasModel`, use `ParadisMobileCanvasSnapshotState` to compare normalized devices, attachments, and unavailable reason before replacing the snapshot or firing a data change. Surface `loading` transitions for the first empty load, but do not force two whole-dialog renders around every background poll once a snapshot exists. Keep `_inFlight` coalescing and attach/detach refresh semantics unchanged.

```ts
export class ParadisBindingDialogDevicePollLease extends Disposable {
	private readonly pollLease = this._register(new MutableDisposable<IDisposable>());
	constructor(private readonly beginPolling: () => IDisposable) { super(); }
	setDevicesVisible(visible: boolean): void {
		if (visible === (this.pollLease.value !== undefined)) { return; }
		this.pollLease.value = visible ? this.beginPolling() : undefined;
	}
}

export class ParadisMobileCanvasSnapshotState {
	private current: IParadisMobileCanvasSnapshot = EMPTY_SNAPSHOT;
	private loaded = false;
	get snapshot(): IParadisMobileCanvasSnapshot { return this.current; }
	beginRefresh(): boolean { return !this.loaded; }
	complete(next: IParadisMobileCanvasSnapshot): boolean {
		this.loaded = true;
		if (equals(this.current, next)) { return false; }
		this.current = next;
		return true;
	}
}

private readonly _snapshotState = new ParadisMobileCanvasSnapshotState();
get snapshot(): IParadisMobileCanvasSnapshot { return this._snapshotState.snapshot; }
```

Restructure `_refresh()` around an exact first-load flag:

```ts
private async _refresh(): Promise<void> {
	const publishLoading = this._snapshotState.beginRefresh();
	if (publishLoading) {
		this._loading = true;
		this._onDidChange.fire();
	}
	let next: IParadisMobileCanvasSnapshot;
	try {
		const snapshot = await this.sharedProcessService.getChannel(PARADIS_MOBILE_CANVAS_CHANNEL)
			.call<IParadisMobileCanvasSnapshot>('getSnapshot');
		next = normalizeSnapshot(snapshot);
	} catch (error) {
		this.logService.warn('[paradis-mobile-canvas] could not read the device snapshot', error);
		next = { devices: [], attachments: [], unavailableReason: toMessage(error) };
	}
	const changed = this._snapshotState.complete(next);
	this._loading = false;
	if (changed || publishLoading) { this._onDidChange.fire(); }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisBindingDialogResources.test.ts src/vs/paradis/contrib/mobileCanvas/test/electron-browser/paradisMobileCanvasModel.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialogResources.ts src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialog.ts src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisBindingDialogResources.test.ts src/vs/paradis/contrib/mobileCanvas/electron-browser/paradisMobileCanvasModel.ts src/vs/paradis/contrib/mobileCanvas/test/electron-browser/paradisMobileCanvasModel.test.ts
rtk git commit -m "fix: scope device polling to the active binding tab"
```

### Task 2: Dispose pane-row listeners on every partial list render

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialogResources.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisBindingDialogResources.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialog.ts`

**Interfaces:**
- Consumes: Task 1's `paradisBindingDialogResources.ts` lifecycle module.
- Produces: `ParadisBindingDialogPaneListResources.beginRender(): void` and `.add<T extends IDisposable>(value: T): T` for pane-row listeners only.

- [ ] **Step 1: Write the failing test**

Add a `ParadisBindingDialogPaneListResources` test. Register four disposable listener sentinels for a first list, begin a second partial render, and assert all four old sentinels were disposed exactly once while newly registered sentinels remain live. Repeat reset and owner disposal to prove no accumulation or double-disposal.

```ts
const resources = store.add(new ParadisBindingDialogPaneListResources());
const disposed = [0, 0, 0, 0, 0];
for (let index = 0; index < 4; index++) {
	resources.add(toDisposable(() => disposed[index]++));
}
resources.beginRender();
assert.deepStrictEqual(disposed, [1, 1, 1, 1, 0]);
resources.add(toDisposable(() => disposed[4]++));
resources.beginRender();
assert.deepStrictEqual(disposed, [1, 1, 1, 1, 1]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisBindingDialogResources.test.ts`

Expected: FAIL because search-driven `_renderPaneList()` clears DOM nodes but retains their listeners in `_renderDisposables`.

- [ ] **Step 3: Write minimal implementation**

Give the pane-list owner a dedicated `DisposableStore`, `beginRender()` that clears it, and `add()` for row listeners. Call `beginRender()` at the top of `_renderPaneList()`. Route switch listeners and the four hover/focus listeners created by `_wireRowHighlight` for pane rows into this owner; leave search input, nav, footer, and other whole-render listeners in `_renderDisposables`. Ensure a full dialog render and dialog disposal also dispose the pane-list owner.

```ts
export class ParadisBindingDialogPaneListResources extends Disposable {
	private readonly listeners = this._register(new DisposableStore());
	beginRender(): void { this.listeners.clear(); }
	add<T extends IDisposable>(value: T): T { return this.listeners.add(value); }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisBindingDialogResources.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialogResources.ts src/vs/paradis/contrib/agentBrowser/electron-browser/paradisBindingDialog.ts src/vs/paradis/contrib/agentBrowser/test/electron-browser/paradisBindingDialogResources.test.ts
rtk git commit -m "fix: release binding row listeners on filtered renders"
```

### Task 3: Cache Aivis usage requests per API key and date range

**Files:**
- Modify: `src/vs/paradis/contrib/notifications/electron-browser/paradisAivisApiCache.ts`
- Modify: `src/vs/paradis/contrib/notifications/test/electron-browser/paradisAivisApiCache.test.ts`
- Modify: `src/vs/paradis/contrib/notifications/electron-browser/paradisAivisUsageSection.ts`

**Interfaces:**
- Consumes: existing `IParadisAivisUsageResult`, `IParadisAivisMeResult`, and shared-process channel methods.
- Produces: `ParadisAivisUsageRequestCache.getOrCreate(apiKey, start, end, factory)` and `ParadisAivisRenderGeneration.begin()/isCurrent()`.

- [ ] **Step 1: Write the failing test**

Add a section-owned `ParadisAivisUsageRequestCache` test with deferred factories. Assert that two reads for the same API key/start/end return the same in-flight promise and call the factory once, resolved data is reused, different keys or ranges are independent, rejection removes the entry for retry, and `clear()` starts a fresh request. Add a generation guard test proving that only the latest render generation may apply a result.

```ts
const cache = new ParadisAivisUsageRequestCache();
let calls = 0;
const first = new DeferredPromise<IParadisAivisUsageBundle>();
const readA = cache.getOrCreate('key', '2026-08-01', '2026-08-07', () => { calls++; return first.p; });
const readB = cache.getOrCreate('key', '2026-08-01', '2026-08-07', () => { calls++; return first.p; });
assert.strictEqual(readA, readB);
assert.strictEqual(calls, 1);

const generations = new ParadisAivisRenderGeneration();
const oldRender = generations.begin();
const currentRender = generations.begin();
assert.strictEqual(generations.isCurrent(oldRender), false);
assert.strictEqual(generations.isCurrent(currentRender), true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/notifications/test/electron-browser/paradisAivisApiCache.test.ts`

Expected: FAIL because usage/me requests currently have no keyed cache or stale-render guard.

- [ ] **Step 3: Write minimal implementation**

Implement the request cache in `paradisAivisApiCache.ts`, keyed by API key plus exact start/end and storing the combined usage/me promise. Do not persist rejected promises. Have `ParadisAivisUsageSection` own one cache and a monotonically increasing render generation. Unrelated `aivis` setting changes and metric toggles reuse the current result; API-key or period changes select another key. Promise handlers must compare their captured generation with the current one before touching `bodyEl`, so a detached old subtree is never rendered. Disposal clears the section-owned cache; reopening the dialog creates a fresh section and fetches current external data.

```ts
export interface IParadisAivisUsageBundle {
	readonly usage: IParadisAivisUsageResult;
	readonly me: IParadisAivisMeResult | null;
}

export class ParadisAivisUsageRequestCache {
	private readonly entries = new Map<string, Promise<IParadisAivisUsageBundle>>();
	getOrCreate(apiKey: string, start: string, end: string, factory: () => Promise<IParadisAivisUsageBundle>): Promise<IParadisAivisUsageBundle> {
		const key = `${apiKey}\0${start}\0${end}`;
		const existing = this.entries.get(key);
		if (existing) { return existing; }
		const created = factory().catch(error => { this.entries.delete(key); throw error; });
		this.entries.set(key, created);
		return created;
	}
	clear(): void { this.entries.clear(); }
}

export class ParadisAivisRenderGeneration {
	private current = 0;
	begin(): number { return ++this.current; }
	isCurrent(value: number): boolean { return value === this.current; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/notifications/test/electron-browser/paradisAivisApiCache.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/notifications/electron-browser/paradisAivisApiCache.ts src/vs/paradis/contrib/notifications/electron-browser/paradisAivisUsageSection.ts src/vs/paradis/contrib/notifications/test/electron-browser/paradisAivisApiCache.test.ts
rtk git commit -m "perf: reuse Aivis usage requests within a settings dialog"
```

### Task 4: Bound Codex directory-walk timestamps

**Files:**
- Create: `src/vs/paradis/contrib/mobileRelay/common/paradisDirectoryWalkLedger.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/test/common/paradisDirectoryWalkLedger.test.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`

**Interfaces:**
- Consumes: `paradisCwdGroupKey(cwd)` and the existing five-minute walk interval.
- Produces: `ParadisDirectoryWalkLedger.mayRun(key: string): boolean`, `.mark(key: string): void`, and test-only `.size`.

- [ ] **Step 1: Write the failing test**

Test a clock-injected `ParadisDirectoryWalkLedger` with a five-minute TTL and 128-entry maximum. Verify a marked key is denied inside the interval, becomes eligible at expiry, stale entries are removed during lookup/mark, refreshing a key moves it to the newest position, and adding 129 live keys evicts only the oldest while keeping size at 128.

```ts
let now = 0;
const ledger = new ParadisDirectoryWalkLedger(5 * 60_000, 128, () => now);
ledger.mark('first');
assert.strictEqual(ledger.mayRun('first'), false);
now = 5 * 60_000;
assert.strictEqual(ledger.mayRun('first'), true);
for (let index = 0; index < 129; index++) { ledger.mark(`cwd-${index}`); }
assert.strictEqual(ledger.size, 128);
assert.strictEqual(ledger.mayRun('cwd-0'), true);
assert.strictEqual(ledger.mayRun('cwd-128'), false);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/mobileRelay/test/common/paradisDirectoryWalkLedger.test.ts`

Expected: FAIL because `lastCodexDirectoryWalkAt` is an unbounded `Map`.

- [ ] **Step 3: Write minimal implementation**

Implement the bounded timestamp ledger without timers. `mayRun(key)` prunes expired entries and preserves the existing five-minute decision; `mark(key)` prunes, refreshes insertion order, and evicts oldest entries to the configured maximum. Replace `lastCodexDirectoryWalkAt`, `mayWalkCodexSessions`, and the successful-walk callback with this ledger using `paradisCwdGroupKey(cwd)`. Keep budget consumption limited to actual Codex directory walks.

```ts
export class ParadisDirectoryWalkLedger {
	private readonly entries = new Map<string, number>();
	constructor(private readonly ttlMs: number, private readonly limit: number, private readonly now: () => number = Date.now) { }
	mayRun(key: string): boolean {
		const now = this.now();
		this.prune(now);
		const last = this.entries.get(key);
		return last === undefined || now - last >= this.ttlMs;
	}
	mark(key: string): void {
		const now = this.now();
		this.prune(now);
		this.entries.delete(key);
		this.entries.set(key, now);
		while (this.entries.size > this.limit) { this.entries.delete(this.entries.keys().next().value!); }
	}
	get size(): number { return this.entries.size; }
	private prune(now: number): void {
		for (const [key, at] of this.entries) { if (now - at >= this.ttlMs) { this.entries.delete(key); } }
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/mobileRelay/test/common/paradisDirectoryWalkLedger.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/mobileRelay/common/paradisDirectoryWalkLedger.ts src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts src/vs/paradis/contrib/mobileRelay/test/common/paradisDirectoryWalkLedger.test.ts
rtk git commit -m "fix: bound Codex directory walk bookkeeping"
```
