# Port List Resource and Responsive Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the newly added port-list panel operable at 390/375/320px, eliminate closed-panel polling and N-times full scans during Kill All, and make displayed route/remote process ownership match the actual kill targets.

**Architecture:** Move viewport geometry and polling ownership into deterministic helpers used by the panel/widget. Replace renderer-side per-entry Kill All calls with one IPC batch whose shared execution helper collects a fresh snapshot once, validates every request, deduplicates process signals, and returns an exact failed-entry count. Use the remote service's `null` contract as the single route predicate, and keep remote socket identity and all owning PIDs through parsing and entry construction.

**Tech Stack:** TypeScript, VS Code DOM/lifecycle primitives, IPC channels, Node process signals, Mocha node tests, CSS media queries.

**Spec:** `docs/superpowers/specs/2026-08-24-regression-resource-mobile-audit-design.md`

## Global Constraints

- Use TDD and observe each focused regression suite fail before changing production code.
- Preserve single-entry kill confirmation/error behavior, remote fail-closed routing, search/filter semantics, and the 15-second open-panel refresh interval.
- Closed panels own no timer and perform no initial/visibility-change collection; opening always requests one fresh snapshot immediately.
- Panel width must stay within 8px margins at viewport widths 440, 390, 375, and 320px; the per-row kill button must remain visible.
- Batch kill must collect once, never signal PID 0/negative/self (and remote parent), signal each validated PID at most once, and retain one final UI refresh.
- `IRemoteAgentService.getConnection() === null` is local; panel wording, fail-closed comparison, and channel selection must agree.
- Remote collection retains different socket inodes on the same endpoint and every PID sharing one inode.
- Add no dependency; all new fork files use `PARA-CODE` and upstream titlebar edits retain `PARA-PATCH` markers.
- Edit files only with `apply_patch`; prefix every shell command with `rtk`.

---

### Task 1: Make panel geometry and compact rows responsive

**Files:**
- Create: `src/vs/paradis/contrib/portList/common/paradisPortListLayout.ts`
- Create: `src/vs/paradis/contrib/portList/test/common/paradisPortListLayout.test.ts`
- Modify: `src/vs/paradis/contrib/portList/electron-browser/paradisPortListPanel.ts`
- Modify: `src/vs/paradis/contrib/portList/electron-browser/media/paradisPortList.css`

**Interfaces:**
- Consumes: anchor `DOMRect.right` and `window.innerWidth`.
- Produces: `paradisPortListPanelGeometry(viewportWidth: number, anchorRight: number): { readonly width: number; readonly left: number }` with `maxWidth=440` and `margin=8`.

- [ ] **Step 1: Write the failing test**

Create `paradisPortListLayout.test.ts` with exact geometry cases for wide and compact viewports. Assert both `left >= 8` and `left + width <= viewportWidth - 8` for every usable viewport.

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { paradisPortListPanelGeometry } from '../../common/paradisPortListLayout.js';

suite('Paradis port list layout', () => {
	test('keeps the panel within eight-pixel viewport margins', () => {
		assert.deepStrictEqual(paradisPortListPanelGeometry(800, 760), { width: 440, left: 320 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(390, 370), { width: 374, left: 8 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(375, 360), { width: 359, left: 8 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(320, 300), { width: 304, left: 8 });
		for (const viewportWidth of [440, 390, 375, 320]) {
			const geometry = paradisPortListPanelGeometry(viewportWidth, viewportWidth - 20);
			assert.ok(geometry.left >= 8);
			assert.ok(geometry.left + geometry.width <= viewportWidth - 8);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/common/paradisPortListLayout.test.ts`

Expected: FAIL because the geometry helper does not exist and the panel always sets 440px.

- [ ] **Step 3: Write minimal implementation**

Implement the pure helper and call it on construction and every resize instead of setting a fixed constructor width.

```ts
const PARADIS_PORT_LIST_PANEL_MAX_WIDTH = 440;
const PARADIS_PORT_LIST_PANEL_MARGIN = 8;

export function paradisPortListPanelGeometry(viewportWidth: number, anchorRight: number): { readonly width: number; readonly left: number } {
	const available = Math.max(0, viewportWidth - PARADIS_PORT_LIST_PANEL_MARGIN * 2);
	const width = Math.min(PARADIS_PORT_LIST_PANEL_MAX_WIDTH, available);
	const maximumLeft = Math.max(PARADIS_PORT_LIST_PANEL_MARGIN, viewportWidth - width - PARADIS_PORT_LIST_PANEL_MARGIN);
	const left = Math.max(PARADIS_PORT_LIST_PANEL_MARGIN, Math.min(anchorRight - width, maximumLeft));
	return { width, left };
}
```

In `reposition()`, set both `element.style.width` and `left` from this result. Add `@media (max-width: 455px)` rules that reduce row horizontal padding/gap, port/PID fixed widths, and risk-badge maximum width with ellipsis; keep `.ppl-proc { min-width: 0 }` and `.ppl-kill-btn { flex: none }` so the kill button cannot be squeezed out.

```css
@media (max-width: 455px) {
	.paradis-port-list-panel .ppl-row { gap: 6px; padding-inline: 10px; }
	.paradis-port-list-panel .ppl-port { width: 46px; }
	.paradis-port-list-panel .ppl-pid { width: 48px; }
	.paradis-port-list-panel .ppl-risk-badge { max-width: 64px; overflow: hidden; text-overflow: ellipsis; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/common/paradisPortListLayout.test.ts`

Expected: PASS for 800/440/390/375/320px.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/portList/common/paradisPortListLayout.ts src/vs/paradis/contrib/portList/electron-browser/paradisPortListPanel.ts src/vs/paradis/contrib/portList/electron-browser/media/paradisPortList.css src/vs/paradis/contrib/portList/test/common/paradisPortListLayout.test.ts
rtk git commit -m "fix: keep the port list panel within narrow viewports"
```

### Task 2: Stop port collection while the panel is closed

**Files:**
- Create: `src/vs/paradis/contrib/portList/electron-browser/paradisPortListPolling.ts`
- Create: `src/vs/paradis/contrib/portList/test/electron-browser/paradisPortListPolling.test.ts`
- Modify: `src/vs/paradis/contrib/portList/electron-browser/paradisPortListWidget.ts`

**Interfaces:**
- Consumes: an `IntervalTimer`-compatible `{ cancel(): void; cancelAndSet(runner, interval): void }` and `poll(): void`.
- Produces: `ParadisPortListPolling.setPanelOpen(open: boolean): void`; open uses exactly `15_000`, closed owns no deadline.

- [ ] **Step 1: Write the failing test**

Create `paradisPortListPolling.test.ts` with a complete fake timer that records schedules/cancellations. Cover initial closed state, open, repeated open, close, reopen, and disposal.

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPortListPollTimer, ParadisPortListPolling } from '../../electron-browser/paradisPortListPolling.js';

class TestPollTimer implements IParadisPortListPollTimer {
	readonly intervals: number[] = [];
	private runner: (() => void) | undefined;
	get hasDeadline(): boolean { return this.runner !== undefined; }
	cancel(): void { this.runner = undefined; }
	cancelAndSet(runner: () => void, interval: number): void {
		this.runner = runner;
		this.intervals.push(interval);
	}
	fire(): void { this.runner?.(); }
}

suite('ParadisPortListPolling', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('owns a 15 second timer only while the panel is open', () => {
		const timer = new TestPollTimer();
		let polls = 0;
		const polling = store.add(new ParadisPortListPolling(timer, () => polls++));

		assert.deepStrictEqual(timer.intervals, []);
		assert.strictEqual(timer.hasDeadline, false);
		polling.setPanelOpen(true);
		polling.setPanelOpen(true);
		assert.deepStrictEqual(timer.intervals, [15_000]);
		timer.fire();
		assert.strictEqual(polls, 1);
		polling.setPanelOpen(false);
		assert.strictEqual(timer.hasDeadline, false);
		polling.setPanelOpen(true);
		assert.deepStrictEqual(timer.intervals, [15_000, 15_000]);
		polling.dispose();
		assert.strictEqual(timer.hasDeadline, false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/electron-browser/paradisPortListPolling.test.ts`

Expected: FAIL because the owner does not exist and the widget schedules a 60-second closed-panel timer plus an immediate poll.

- [ ] **Step 3: Write minimal implementation**

Implement an idempotent owner that cancels before every state transition and schedules only when open.

```ts
export interface IParadisPortListPollTimer {
	cancel(): void;
	cancelAndSet(runner: () => void, interval: number): void;
}

export class ParadisPortListPolling extends Disposable {
	private open = false;
	constructor(private readonly timer: IParadisPortListPollTimer, private readonly poll: () => void) { super(); }
	setPanelOpen(open: boolean): void {
		if (open === this.open) { return; }
		this.open = open;
		this.timer.cancel();
		if (open) { this.timer.cancelAndSet(this.poll, 15_000); }
	}
	override dispose(): void { this.timer.cancel(); super.dispose(); }
}
```

In the widget, remove `IDLE_POLL_INTERVAL_MS`, the closed-panel `visibilitychange` listener, constructor `reschedulePolling()`, and constructor `poll(false)`. Register the new owner around the existing `IntervalTimer`; set open before the explicit `poll(true)` in `togglePanel`, and set closed in `closePanel`. Retain `latestSnapshot` only as a stale-while-refresh initial view.

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/electron-browser/paradisPortListPolling.test.ts`

Expected: PASS and the fake timer has no closed/disposed deadline.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/portList/electron-browser/paradisPortListPolling.ts src/vs/paradis/contrib/portList/electron-browser/paradisPortListWidget.ts src/vs/paradis/contrib/portList/test/electron-browser/paradisPortListPolling.test.ts
rtk git commit -m "perf: stop port scans while the panel is closed"
```

### Task 3: Batch Kill All through one fresh collection

**Files:**
- Create: `src/vs/paradis/contrib/portList/common/paradisPortKillBatch.ts`
- Modify: `src/vs/paradis/contrib/portList/common/paradisPortList.ts`
- Modify: `src/vs/paradis/contrib/portList/electron-browser/paradisPortListClient.ts`
- Modify: `src/vs/paradis/contrib/portList/electron-browser/paradisPortListWidget.ts`
- Modify: `src/vs/paradis/contrib/portList/node/paradisPortListChannel.ts`
- Modify: `src/vs/paradis/contrib/portList/node/paradisPortListChannelServer.ts`
- Create: `src/vs/paradis/contrib/portList/test/common/paradisPortKillBatch.test.ts`
- Modify: `src/vs/paradis/contrib/portList/test/node/paradisPortListChannel.test.ts`
- Modify: `src/vs/paradis/contrib/portList/test/node/paradisPortListChannelServer.test.ts`

**Interfaces:**
- Consumes: untrusted `readonly unknown[]`, one `collect(): Promise<readonly IParadisPortEntry[]>`, protected PID set, and injected `kill(pid): void`.
- Produces: `IParadisPortKillBatchResult { readonly failed: number }`, `executeParadisPortKillBatch(...)`, IPC command `killAll`, and `ParadisPortListClient.killAll(requests, expectedViaRemote)`.
- Preserves: `ParadisPortListService` and `ParadisPortListServerService` production defaults while allowing their existing collect/signal functions to be injected in node tests.

- [ ] **Step 1: Write the failing test**

Create `paradisPortKillBatch.test.ts` exactly as follows to test one collection, validation, deduplication, and exact failure counting. Two requested ports owned by the same PID result in one signal; if that signal throws, both requested entries count as failed. Invalid, stale, and protected entries fail without a signal.

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IParadisPortEntry } from '../../common/paradisPortList.js';
import { executeParadisPortKillBatch } from '../../common/paradisPortKillBatch.js';

suite('Paradis port kill batch', () => {
	const entries: IParadisPortEntry[] = [
		{ port: 3000, proto: 'TCP', pid: 10, processName: 'node', address: '127.0.0.1', risky: false },
		{ port: 3001, proto: 'TCP', pid: 10, processName: 'node', address: '127.0.0.1', risky: false },
		{ port: 4000, proto: 'TCP', pid: 20, processName: 'python', address: '127.0.0.1', risky: false },
	];

	test('collects once, rejects stale/protected requests, and signals a PID once', async () => {
		let collections = 0;
		const signalled: number[] = [];
		const result = await executeParadisPortKillBatch(
			[entries[0], entries[1], entries[2], { port: 9999, pid: 30, processName: 'stale' }],
			async () => { collections++; return entries; },
			new Set([20]),
			pid => { signalled.push(pid); },
		);
		assert.strictEqual(collections, 1);
		assert.deepStrictEqual(signalled, [10]);
		assert.deepStrictEqual(result, { failed: 2 });
	});

	test('counts every request in a PID group when its single signal fails', async () => {
		const attempts: number[] = [];
		const result = await executeParadisPortKillBatch(
			[entries[0], entries[1]],
			async () => entries,
			new Set(),
			pid => { attempts.push(pid); throw new Error('signal failed'); },
		);
		assert.deepStrictEqual(attempts, [10]);
		assert.deepStrictEqual(result, { failed: 2 });
	});

	test('treats malformed IPC values as failures without signalling them', async () => {
		const signalled: number[] = [];
		const result = await executeParadisPortKillBatch(
			[undefined, { pid: -1, port: 3000, processName: 'node' }, { pid: 10, port: 0, processName: 'node' }],
			async () => entries,
			new Set(),
			pid => { signalled.push(pid); },
		);
		assert.deepStrictEqual(signalled, []);
		assert.deepStrictEqual(result, { failed: 3 });
	});
});
```

Extend the local and remote node test files with injected collect/signal functions. Each service test calls `killAll` with one normal request plus entries using `process.pid` (and `process.ppid` remotely), then asserts one collection, one signal for the normal PID, and the exact protected failure count. Also add a captured-channel test through each existing registration function and call command `killAll` once, proving the IPC array is forwarded rather than falling through to `Method not found`.

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/common/paradisPortKillBatch.test.ts src/vs/paradis/contrib/portList/test/node/paradisPortListChannel.test.ts src/vs/paradis/contrib/portList/test/node/paradisPortListChannelServer.test.ts`

Expected: FAIL because no batch result/helper/IPC command exists and the widget loops over `client.kill()`.

- [ ] **Step 3: Write minimal implementation**

Implement the execution helper with one `await collect()`, structural request validation, fresh snapshot matching on PID/port/processName, protected-PID rejection, grouping by PID, one signal per group, and failed-entry aggregation.

```ts
export interface IParadisPortKillBatchResult { readonly failed: number }

export async function executeParadisPortKillBatch(
	requests: readonly unknown[],
	collect: () => Promise<readonly IParadisPortEntry[]>,
	protectedPids: ReadonlySet<number>,
	kill: (pid: number) => void,
): Promise<IParadisPortKillBatchResult> {
	const entries = await collect();
	const byPid = new Map<number, IParadisPortKillRequest[]>();
	let failed = 0;
	for (const value of requests) {
		if (!isParadisPortKillRequest(value)) { failed++; continue; }
		const request = value;
		const valid = entries.some(entry => entry.pid === request.pid && entry.port === request.port && entry.processName === request.processName)
			&& !protectedPids.has(request.pid);
		if (!valid) { failed++; continue; }
		const group = byPid.get(request.pid) ?? [];
		group.push(request);
		byPid.set(request.pid, group);
	}
	for (const [pid, group] of byPid) {
		try { kill(pid); } catch { failed += group.length; }
	}
	return { failed };
}
```

Implement `isParadisPortKillRequest(value: unknown)` beside the helper with object, safe-positive integer, and string checks. Expose `killAll` from both server channels; a non-array IPC payload becomes an empty request list. Use the existing collection functions and protected PID rules, and invalidate the service cache after the batch attempt. The client must apply the same remote-connection fail-closed comparison as single kill. Replace the widget's per-entry loop with one batch call, preserve confirmation text, turn a rejected batch into `entries.length` failures, perform one final forced poll, and show the existing partial-failure notification using `result.failed`.

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/common/paradisPortKillBatch.test.ts src/vs/paradis/contrib/portList/test/node/paradisPortListChannel.test.ts src/vs/paradis/contrib/portList/test/node/paradisPortListChannelServer.test.ts`

Expected: PASS; every test observes exactly one collection and at most one signal per PID.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/portList/common/paradisPortKillBatch.ts src/vs/paradis/contrib/portList/common/paradisPortList.ts src/vs/paradis/contrib/portList/electron-browser/paradisPortListClient.ts src/vs/paradis/contrib/portList/electron-browser/paradisPortListWidget.ts src/vs/paradis/contrib/portList/node/paradisPortListChannel.ts src/vs/paradis/contrib/portList/node/paradisPortListChannelServer.ts src/vs/paradis/contrib/portList/test/common/paradisPortKillBatch.test.ts src/vs/paradis/contrib/portList/test/node/paradisPortListChannel.test.ts src/vs/paradis/contrib/portList/test/node/paradisPortListChannelServer.test.ts
rtk git commit -m "perf: batch port-list kill validation"
```

---

### Task 4: Make local/remote route identity use the service's null contract

**Files:**
- Create: `src/vs/paradis/contrib/portList/test/electron-browser/paradisPortListClient.test.ts`
- Modify: `src/vs/paradis/contrib/portList/electron-browser/paradisPortListClient.ts`

**Interfaces:**
- Consumes: `IRemoteAgentService.getConnection(): IRemoteAgentConnection | null`.
- Preserves: local shared-process channel and remote REH channel selection.
- Produces: `connectedToRemote`, `kill`, and Task 3's `killAll` all interpret only a non-null connection as remote.

- [ ] **Step 1: Write the failing route-contract test**

Create `paradisPortListClient.test.ts`. The local half must prove `null` renders as local, uses the shared channel, accepts `expectedViaRemote=false`, and rejects `true`. The remote half proves the inverse for both single and batch kill.

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPortKillRequest, IParadisPortListSnapshot } from '../../common/paradisPortList.js';
import { ParadisPortListClient } from '../../electron-browser/paradisPortListClient.js';

interface IRecordedCall { readonly command: string; readonly arg: unknown }

function recordingChannel(calls: IRecordedCall[]): IChannel {
	return {
		listen: () => Event.None,
		call: async <T>(command: string, arg?: unknown): Promise<T> => {
			calls.push({ command, arg });
			if (command === 'getSnapshot') {
				return { entries: [], collectedAt: 1 } as IParadisPortListSnapshot as T;
			}
			if (command === 'killAll') {
				return { failed: 0 } as T;
			}
			return undefined as T;
		},
	};
}

suite('ParadisPortListClient route identity', () => {
	const request: IParadisPortKillRequest = { port: 3000, pid: 10, processName: 'node' };

	test('uses null as local and a connection object as remote for every operation', async () => {
		const sharedCalls: IRecordedCall[] = [];
		const remoteCalls: IRecordedCall[] = [];
		const sharedChannel = recordingChannel(sharedCalls);
		const remoteChannel = recordingChannel(remoteCalls);
		let connection: IRemoteAgentConnection | null = null;
		const sharedProcessService = { getChannel: () => sharedChannel } as unknown as ISharedProcessService;
		const remoteAgentService = { getConnection: () => connection } as unknown as IRemoteAgentService;
		const client = new ParadisPortListClient(sharedProcessService, remoteAgentService);

		assert.strictEqual(client.connectedToRemote, false);
		await client.getSnapshot();
		await client.kill(request, false);
		await client.killAll([request], false);
		await assert.rejects(client.kill(request, true), /remote connection state changed/);
		assert.deepStrictEqual(sharedCalls.map(call => call.command), ['getSnapshot', 'kill', 'killAll']);

		connection = { getChannel: () => remoteChannel } as unknown as IRemoteAgentConnection;
		assert.strictEqual(client.connectedToRemote, true);
		await client.getSnapshot();
		await client.kill(request, true);
		await client.killAll([request], true);
		await assert.rejects(client.killAll([request], false), /remote connection state changed/);
		assert.deepStrictEqual(remoteCalls.map(call => call.command), ['getSnapshot', 'kill', 'killAll']);
	});
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/electron-browser/paradisPortListClient.test.ts`

Expected: FAIL in the local assertions because `null !== undefined` is true, so local is labelled remote and `kill(request, false)` aborts.

- [ ] **Step 3: Use one null-aware predicate in all client routes**

Change both current comparisons from `remoteConnection !== undefined` to `remoteConnection !== null`. Keep channel selection on the same `remoteConnection` object. Task 3's `killAll` must mirror the corrected single-kill implementation exactly.

```ts
	get connectedToRemote(): boolean {
		return this.remoteAgentService.getConnection() !== null;
	}

	private channelForExpectedRoute(expectedViaRemote: boolean): IChannel {
		const remoteConnection = this.remoteAgentService.getConnection();
		if ((remoteConnection !== null) !== expectedViaRemote) {
			throw new Error('Port kill aborted: the remote connection state changed');
		}
		return remoteConnection
			? remoteConnection.getChannel(PARADIS_PORT_LIST_CHANNEL)
			: this.sharedProcessService.getChannel(PARADIS_PORT_LIST_CHANNEL);
	}
```

Have both `kill` and `killAll` call `channelForExpectedRoute`; do not change snapshot routing or UI text.

- [ ] **Step 4: Run the route test GREEN**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/electron-browser/paradisPortListClient.test.ts`

Expected: PASS; local calls only the shared channel, remote calls only the remote channel, and both mismatched expected routes reject before IPC.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/portList/electron-browser/paradisPortListClient.ts src/vs/paradis/contrib/portList/test/electron-browser/paradisPortListClient.test.ts
rtk git commit -m "fix: align port-list route labels and kill targets"
```

---

### Task 5: Preserve every remote socket inode and owning PID

**Files:**
- Modify: `src/vs/paradis/contrib/portList/node/paradisPortListChannelServer.ts`
- Modify: `src/vs/paradis/contrib/portList/test/node/paradisPortListChannelServer.test.ts`

**Interfaces:**
- Produces: `loadSocketOwners(stdout: string): Map<number, Set<number>>`.
- Produces: `resolveRemotePortEntries(listening, owners, names): IParadisPortEntry[]`.
- Changes: `loadListeningConnections` deduplicates only identical socket inodes, not equal `ip:port` values.
- Preserves: `/proc` read strategy, process-name lookup, risk classification, caching, and Linux-only REH support.

- [ ] **Step 1: Add failing parser and join tests**

Extend the existing remote node test imports with `loadSocketOwners` and `resolveRemotePortEntries`, then add these tests.

```ts
test('retains distinct socket inodes listening on the same endpoint', () => {
	const first = '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0';
	const second = '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0000000000000000 100 0 0 10 0';
	assert.deepStrictEqual(loadListeningConnections([HEADER, first, second].join('\n')), [
		{ socket: 12345, ip: '127.0.0.1', port: 8080 },
		{ socket: 67890, ip: '127.0.0.1', port: 8080 },
	]);
});

test('retains every PID that owns the same socket inode', () => {
	const owners = loadSocketOwners([
		'lrwx------ 1 user user 64 Aug 24 00:00 /proc/111/fd/3 -> socket:[12345]',
		'lrwx------ 1 user user 64 Aug 24 00:00 /proc/222/fd/4 -> socket:[12345]',
	].join('\n'));
	assert.deepStrictEqual([...owners].map(([socket, pids]) => [socket, [...pids]]), [
		[12345, [111, 222]],
	]);
	assert.deepStrictEqual(resolveRemotePortEntries(
		[{ socket: 12345, ip: '0.0.0.0', port: 8080 }],
		owners,
		new Map([[111, 'worker-a'], [222, 'worker-b']]),
	), [
		{ port: 8080, proto: 'TCP', pid: 111, processName: 'worker-a', address: '0.0.0.0', risky: true },
		{ port: 8080, proto: 'TCP', pid: 222, processName: 'worker-b', address: '0.0.0.0', risky: true },
	]);
});
```

- [ ] **Step 2: Run the remote node suite and observe RED**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/node/paradisPortListChannelServer.test.ts`

Expected: FAIL because equal endpoints collapse to one inode and the new owner/join helpers do not exist.

- [ ] **Step 3: Keep socket and owner identity through collection**

Change the `loadListeningConnections` map key from `${entry.ip}:${entry.port}` to `entry.socket`. Extract the current symlink parser into `loadSocketOwners`, adding every matched PID to a `Set` for its inode.

```ts
export function loadSocketOwners(stdout: string): Map<number, Set<number>> {
	const owners = new Map<number, Set<number>>();
	for (const line of stdout.split('\n')) {
		const match = /\/proc\/(\d+)\/fd\/\d+ -> socket:\[(\d+)\]/.exec(line);
		if (!match) { continue; }
		const pid = parseInt(match[1], 10);
		const socket = parseInt(match[2], 10);
		const pids = owners.get(socket) ?? new Set<number>();
		pids.add(pid);
		owners.set(socket, pids);
	}
	return owners;
}
```

Have `readSocketOwners` return `loadSocketOwners(stdout)`. Implement `resolveRemotePortEntries` as the nested product of each listening connection and all PIDs in `owners.get(connection.socket)`, applying the existing process-name fallback and `paradisIsRiskyPortAddress`. In `collectEntries`, resolve names for the distinct PIDs referenced by listening sockets, then return this helper's entries.

- [ ] **Step 4: Run the remote suite GREEN**

Run: `rtk npm run transpile-client`

Run: `rtk npm run test-node -- --run src/vs/paradis/contrib/portList/test/node/paradisPortListChannelServer.test.ts`

Expected: PASS; equal endpoint/different inode and one inode/two owners are both retained, alongside all existing parser cases.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/portList/node/paradisPortListChannelServer.ts src/vs/paradis/contrib/portList/test/node/paradisPortListChannelServer.test.ts
rtk git commit -m "fix: retain all remote port owners"
```
