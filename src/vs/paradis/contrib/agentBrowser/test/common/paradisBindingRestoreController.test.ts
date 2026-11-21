/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { parseLinkedText } from '../../../../../base/common/linkedText.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisBindingAuthority } from '../../common/paradisBindingAuthority.js';
import {
	IParadisBindingRestoreHost,
	ParadisBindingRestoreController,
	ParadisBindingRestoreOutcome,
	ParadisBindingRestoreReadiness,
	PARADIS_BINDING_RESTORE_NAME_MAX_LENGTH,
	paradisBindingRestoreDisplayName,
	paradisBindingRestoreFailureOutcome,
} from '../../common/paradisBindingRestoreController.js';
import { IParadisBindingRestoreEntry, paradisBindingRestoreKey, paradisSerializeBindingRestoreLedger } from '../../common/paradisBindingRestoreLedger.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://app.example';

/** A window with panes and pages. Every page is on {@link ORIGIN} unless a test moves it. */
class FakeHost implements IParadisBindingRestoreHost {
	stored: string | undefined;
	writes = 0;
	tokens = ['token-a', 'token-b'];
	pages = new Set(['page-1', 'page-2']);
	origins = new Map<string, string>();
	bound = new Map<string, string>();
	/** current のほかに共有しているページ（古い順）。共有は付け替えではなく追加。 */
	more = new Map<string, string[]>();
	readinessOf: (pageId: string) => ParadisBindingRestoreReadiness = () => 'ready';
	outcomeOf: (pageId: string, token: string) => ParadisBindingRestoreOutcome = () => 'restored';
	readonly restored: string[] = [];
	readonly reports: [number, number][] = [];
	/** Runs before each restore, to change the world while a share is being restored. */
	beforeRestore: () => void = () => { };

	constructor(ledger: Record<string, string>, withOrigins = true) {
		this.stored = paradisSerializeBindingRestoreLedger(new Map(Object.entries(ledger).map(([token, pageId]): [string, IParadisBindingRestoreEntry] => [
			paradisBindingRestoreKey(token),
			withOrigins ? { pageId, at: NOW - 1000, origins: { [pageId]: ORIGIN } } : { pageId, at: NOW - 1000 },
		])));
	}

	readStorage(): string | undefined { return this.stored; }
	writeStorage(value: string | undefined): void { this.stored = value; this.writes++; }
	listPaneTokens(): readonly string[] { return this.tokens; }
	boundPageForToken(token: string): string | undefined { return this.bound.get(token); }
	morePagesForToken(token: string): readonly string[] { return this.more.get(token) ?? []; }
	knownPageIds(): ReadonlySet<string> { return this.pages; }
	originOf(pageId: string): string | undefined { return this.origins.get(pageId) ?? ORIGIN; }
	readiness(pageId: string): ParadisBindingRestoreReadiness { return this.readinessOf(pageId); }
	async restore(pageId: string, token: string, origin: string): Promise<ParadisBindingRestoreOutcome> {
		this.beforeRestore();
		const outcome = origin !== this.originOf(pageId) ? 'moved' : this.outcomeOf(pageId, token);
		this.restored.push(`${token}->${pageId}:${outcome}`);
		if (outcome === 'restored') {
			const previous = this.bound.get(token);
			const more = (this.more.get(token) ?? []).filter(candidate => candidate !== pageId);
			this.more.set(token, previous !== undefined && previous !== pageId ? [...more, previous] : more);
			this.bound.set(token, pageId);
		}
		return outcome;
	}
	report(restored: number, moved: number): void { this.reports.push([restored, moved]); }
	log(): void { }

	/** The share goes away on its own (the pane fell out of the window's list, the shared process restarted). */
	drop(token: string): void {
		this.bound.delete(token);
		this.more.delete(token);
	}

	row(token: string): IParadisBindingRestoreEntry | undefined {
		return this.stored === undefined ? undefined : JSON.parse(this.stored)[paradisBindingRestoreKey(token)];
	}

	/** Tokens that still have a row in the stored ledger. */
	storedTokens(): string[] {
		return ['token-a', 'token-b', 'token-c'].filter(token => this.row(token) !== undefined);
	}
}

suite('ParadisBindingRestoreController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let now: number;
	function create(host: FakeHost, disposables: Pick<DisposableStore, 'add'> = store): ParadisBindingRestoreController {
		// Long delays: the tests drive evaluate() themselves and the scheduler never fires during a test.
		return disposables.add(new ParadisBindingRestoreController(host, { now: () => now, windowMs: 60_000, evaluateDelayMs: 60_000, retryDelayMs: 60_000 }));
	}

	setup(() => {
		now = NOW;
	});

	test('restores every pair without asking, reports how many, and keeps them in the ledger', async () => {
		const host = new FakeHost({ 'token-a': 'page-1', 'token-b': 'page-2' });
		const controller = create(host);
		await controller.evaluate();
		await controller.evaluate();
		assert.deepStrictEqual({
			restored: host.restored,
			reports: host.reports,
			stored: host.storedTokens(),
		}, {
			restored: ['token-a->page-1:restored', 'token-b->page-2:restored'],
			reports: [[2, 0]],
			stored: ['token-a', 'token-b'],
		});
	});

	// 1 つのペインへ複数のページを共有していたら、current を戻してから古いものを戻し、current を最後に共有し直す
	test('restores the current page first, then the other pages oldest first, and shares the current page again last', async () => {
		const host = new FakeHost({});
		host.pages = new Set(['page-1', 'page-2', 'page-3']);
		host.stored = paradisSerializeBindingRestoreLedger(new Map([[paradisBindingRestoreKey('token-a'), { pageId: 'page-3', at: NOW - 1000, more: ['page-1', 'page-2'], origins: { 'page-1': ORIGIN, 'page-2': ORIGIN, 'page-3': ORIGIN } }]]));
		const controller = create(host);
		await controller.evaluate();
		await controller.evaluate();
		assert.deepStrictEqual({
			restored: host.restored,
			reports: host.reports,
			current: host.bound.get('token-a'),
			stored: host.row('token-a')?.more,
		}, {
			restored: ['token-a->page-3:restored', 'token-a->page-1:restored', 'token-a->page-2:restored', 'token-a->page-3:restored'],
			reports: [[3, 0]],
			current: 'page-3',
			stored: ['page-1', 'page-2'],
		});
	});

	// current が戻らないとき（後でもう一度）は 2 枚目以降も戻さず、台帳も元のまま残す
	test('keeps the whole ledger row and restores nothing else when the current page has to wait', async () => {
		const host = new FakeHost({});
		host.pages = new Set(['page-1', 'page-3']);
		const row = { pageId: 'page-3', at: NOW - 1000, more: ['page-1'], origins: { 'page-1': ORIGIN, 'page-3': ORIGIN } };
		host.stored = paradisSerializeBindingRestoreLedger(new Map([[paradisBindingRestoreKey('token-a'), row]]));
		host.outcomeOf = pageId => pageId === 'page-3' ? 'retry' : 'restored';
		await create(host).evaluate();
		assert.deepStrictEqual({ restored: host.restored, reports: host.reports, stored: host.row('token-a') }, {
			restored: ['token-a->page-3:retry'],
			reports: [],
			stored: row,
		});
	});

	test('does not restore a page that moved to another site, restores the rest, and never restores a row without an origin', async () => {
		// Before the page is opened: page-1 is on another site now.
		const early = new FakeHost({ 'token-a': 'page-1', 'token-b': 'page-2' });
		early.origins.set('page-1', 'https://elsewhere.example');
		await create(early).evaluate();

		// After the page is opened (the load redirected it): the host compares again with the recorded origin.
		const late = new FakeHost({ 'token-a': 'page-1' });
		late.beforeRestore = () => late.origins.set('page-1', 'https://elsewhere.example');
		await create(late).evaluate();

		// A row written before origins were recorded cannot be verified.
		const legacy = new FakeHost({ 'token-a': 'page-1' }, false);
		await create(legacy).evaluate();

		assert.deepStrictEqual({
			early: [early.restored, early.reports, early.storedTokens()],
			late: [late.restored, late.reports, late.storedTokens()],
			legacy: [legacy.restored, legacy.reports, legacy.storedTokens()],
		}, {
			early: [['token-b->page-2:restored'], [[1, 1]], ['token-b']],
			late: [['token-a->page-1:moved'], [[0, 1]], []],
			legacy: [[], [], []],
		});
	});

	test('records the origin a page had while it was shared, and stops updating it once the share is gone', async () => {
		const host = new FakeHost({});
		host.bound.set('token-a', 'page-1');
		const controller = create(host);
		await controller.evaluate();
		const shared = host.row('token-a')?.origins;
		// The agent navigates the shared page: that is part of the share.
		host.origins.set('page-1', 'https://docs.example');
		await controller.evaluate();
		const navigated = host.row('token-a')?.origins;
		// The share drops and the window is over; the page then moves on its own.
		now += 120_000;
		host.drop('token-a');
		host.origins.set('page-1', 'https://elsewhere.example');
		await controller.evaluate();
		assert.deepStrictEqual({ shared, navigated, afterDrop: host.row('token-a')?.origins, restored: host.restored }, {
			shared: { 'page-1': ORIGIN },
			navigated: { 'page-1': 'https://docs.example' },
			afterDrop: { 'page-1': 'https://docs.example' },
			restored: [],
		});
	});

	test('keeps a share that dropped on its own and restores it, but forgets one the user removed', async () => {
		const host = new FakeHost({});
		host.bound.set('token-a', 'page-1');
		host.bound.set('token-b', 'page-2');
		const controller = create(host);
		await controller.evaluate();

		// token-a: the share vanished without anyone asking. token-b: the user unshares it.
		host.drop('token-a');
		const unbinding = controller.userUnbind('token-b', 'page-2');
		// The backend still lists the share while the unshare is in flight.
		await controller.evaluate();
		const inFlight = { stored: host.storedTokens(), restored: [...host.restored] };
		host.drop('token-b');
		unbinding.dispose();
		await controller.evaluate();
		assert.deepStrictEqual({ inFlight, restored: host.restored, reports: host.reports, stored: host.storedTokens(), bound: [...host.bound] }, {
			inFlight: { stored: ['token-a'], restored: ['token-a->page-1:restored'] },
			restored: ['token-a->page-1:restored'],
			reports: [[1, 0]],
			stored: ['token-a'],
			bound: [['token-a', 'page-1']],
		});
	});

	test('a page-wide unshare removes that page from every pane, and an unshare that fails leaves the share recorded', async () => {
		const host = new FakeHost({});
		host.pages = new Set(['page-1', 'page-2']);
		host.bound.set('token-a', 'page-1');
		host.more.set('token-a', ['page-2']);
		host.bound.set('token-b', 'page-1');
		const controller = create(host);
		await controller.evaluate();
		const unbinding = controller.userUnbind(undefined, 'page-1');
		const during = [host.row('token-a')?.pageId, host.row('token-b')?.pageId];
		// The unshare fails for token-b: it stays shared.
		host.bound.set('token-a', 'page-2');
		host.more.delete('token-a');
		unbinding.dispose();
		await controller.evaluate();
		assert.deepStrictEqual({ during, after: [host.row('token-a')?.pageId, host.row('token-b')?.pageId] }, {
			during: ['page-2', undefined],
			after: ['page-2', 'page-1'],
		});
	});

	test('forgets the row when the terminal really ended, but not when the pane is still there or only went away', async () => {
		const host = new FakeHost({ 'token-a': 'page-1', 'token-b': 'page-2', 'token-c': 'page-1' });
		host.tokens = ['token-b'];
		host.readinessOf = () => 'wait';
		const controller = create(host);
		// token-a ended; token-b was moved to another terminal instance (still listed); token-c is just not back yet.
		controller.paneEnded('token-a');
		controller.paneEnded('token-b');
		await controller.evaluate();
		assert.deepStrictEqual(host.storedTokens(), ['token-b', 'token-c']);
	});

	test('forgets pairs that can never be restored, and does not retry them', async () => {
		const never = new FakeHost({ 'token-a': 'page-1' });
		never.readinessOf = () => 'never';
		const neverController = create(never);
		await neverController.evaluate();
		await neverController.evaluate();

		const skipped = new FakeHost({ 'token-a': 'page-1', 'token-b': 'page-2' });
		skipped.outcomeOf = pageId => pageId === 'page-1' ? 'skipped' : 'restored';
		const skippedController = create(skipped);
		await skippedController.evaluate();
		await skippedController.evaluate();

		assert.deepStrictEqual({
			never: [never.restored, never.reports, never.storedTokens()],
			skipped: [skipped.restored, skipped.reports, skipped.storedTokens()],
		}, {
			never: [[], [], []],
			skipped: [['token-a->page-1:skipped', 'token-b->page-2:restored'], [[1, 0]], ['token-b']],
		});
	});

	// 自動の戻しも窓の一覧の検査（別の窓のペイン・スペースの違い）を通り、断られた組は消えて試し直さない
	test('a share the binding authority rejects as ownerConflict or scopeMismatch is dropped, not counted and not retried', async () => {
		const authority = new ParadisBindingAuthority<string, object, { readonly targetId: string }, { readonly generation: number }>({
			now: () => 0,
			createTicketId: () => 'unused',
			copyDescriptor: descriptor => ({ ...descriptor }),
		});
		const thisWindow = {};
		const otherWindow = {};
		authority.registerConnection('window:this', thisWindow);
		authority.registerConnection('window:other', otherWindow);
		// token-a belongs to another window; token-b and page-2 are in different spaces; token-c and page-3 match.
		authority.acceptManifest(otherWindow, { revision: 1, complete: true, panes: [{ token: 'token-a', scope: { kind: 'unscoped' } }], browserViews: [] });
		const panes = [
			{ token: 'token-b', scope: { kind: 'managed' as const, stateKey: 'space-1' } },
			{ token: 'token-c', scope: { kind: 'unscoped' as const } },
		];
		const browserViews = [
			{ viewId: 'page-2', scope: { kind: 'managed' as const, stateKey: 'space-2' } },
			{ viewId: 'page-3', scope: { kind: 'unscoped' as const } },
		];
		authority.acceptManifest(thisWindow, { revision: 1, complete: true, panes, browserViews });

		const host = new FakeHost({ 'token-a': 'page-1', 'token-b': 'page-2', 'token-c': 'page-3' });
		host.tokens = ['token-a', 'token-b', 'token-c'];
		host.pages = new Set(['page-1', 'page-2', 'page-3']);
		const rejections: string[] = [];
		host.outcomeOf = (pageId, token) => {
			try {
				if (token === 'token-a') {
					// The window syncs its list before binding; claiming another window's pane is refused there.
					authority.acceptManifest(thisWindow, { revision: 2, complete: true, panes: [...panes, { token, scope: { kind: 'unscoped' } }], browserViews });
				}
				authority.capturePrepareSnapshot(thisWindow, 1, token, pageId);
				return 'restored';
			} catch (error) {
				rejections.push(`${token}: ${(error as Error).message}`);
				// The rejection crosses IPC as a plain Error with the same message.
				throw new Error((error as Error).message);
			}
		};
		const controller = create(host);
		await controller.evaluate();
		await controller.evaluate();
		assert.deepStrictEqual({ rejections, restored: host.restored, reports: host.reports, stored: host.storedTokens() }, {
			rejections: ['token-a: Binding authority rejected: ownerConflict', 'token-b: Binding authority rejected: scopeMismatch'],
			restored: ['token-c->page-3:restored'],
			reports: [[1, 0]],
			stored: ['token-c'],
		});
	});

	test('retries only failures that come from state still settling', () => {
		assert.deepStrictEqual([
			'PARA_BROWSER_RETRYABLE: binding authority changed before preparation',
			'Binding authority rejected: manifestRequired',
			'Binding authority rejected: missingEntry',
			'Binding authority rejected: pendingScope',
			'Binding authority rejected: ownerConflict',
			'Binding authority rejected: scopeMismatch',
			'something else',
		].map(message => paradisBindingRestoreFailureOutcome(new Error(message))), ['retry', 'retry', 'retry', 'retry', 'skipped', 'skipped', 'failed']);
	});

	test('restores a pane once per window: a share that drops again right away, or a failure it cannot classify, waits for the next window', async () => {
		const flapping = new FakeHost({ 'token-a': 'page-1' });
		// The share is gone again as soon as it was restored.
		flapping.beforeRestore = () => queueMicrotask(() => flapping.drop('token-a'));
		const flappingController = create(flapping);
		await flappingController.evaluate();
		await flappingController.evaluate();
		await flappingController.evaluate();
		const once = { restored: [...flapping.restored], reports: [...flapping.reports], stored: flapping.storedTokens() };
		flappingController.restartWindow();
		await flappingController.evaluate();

		const failing = new FakeHost({ 'token-a': 'page-1' });
		failing.outcomeOf = () => { throw new Error('the shared process is not reachable'); };
		const failingController = create(failing);
		await failingController.evaluate();
		await failingController.evaluate();
		const failedOnce = { restored: [...failing.restored], stored: failing.storedTokens() };
		failing.outcomeOf = () => 'restored';
		failingController.restartWindow();
		await failingController.evaluate();

		assert.deepStrictEqual({ once, flapping: flapping.restored.length, failedOnce, failing: failing.restored }, {
			once: { restored: ['token-a->page-1:restored'], reports: [[1, 0]], stored: ['token-a'] },
			flapping: 2,
			failedOnce: { restored: [], stored: ['token-a'] },
			failing: ['token-a->page-1:restored'],
		});
	});

	test('waits for the terminal to be reconnected however long that takes, then retries only inside the window', async () => {
		const host = new FakeHost({ 'token-a': 'page-1' });
		host.tokens = [];
		const controller = create(host);
		await controller.evaluate();
		// Long after startup the terminal is reconnected: the window is counted from there.
		now += 3_600_000;
		host.tokens = ['token-a'];
		host.outcomeOf = () => 'retry';
		await controller.evaluate();
		const onReconnect = [...host.restored];
		// Still failing after the window: it stops trying but keeps the row.
		now += 120_000;
		host.outcomeOf = () => 'restored';
		await controller.evaluate();
		const expired = { restored: [...host.restored], stored: host.storedTokens() };
		// A space switch or a reconnect starts the window again.
		controller.restartWindow();
		await controller.evaluate();
		assert.deepStrictEqual({ onReconnect, expired, restored: host.restored }, {
			onReconnect: ['token-a->page-1:retry'],
			expired: { restored: ['token-a->page-1:retry'], stored: ['token-a'] },
			restored: ['token-a->page-1:retry', 'token-a->page-1:restored'],
		});
	});

	test('a share that drops after the window is over is kept and restored when the window starts again', async () => {
		const host = new FakeHost({});
		host.bound.set('token-a', 'page-1');
		const controller = create(host);
		await controller.evaluate();
		now += 120_000;
		host.drop('token-a');
		await controller.evaluate();
		const afterDrop = { restored: [...host.restored], stored: host.storedTokens() };
		controller.restartWindow();
		await controller.evaluate();
		assert.deepStrictEqual({ afterDrop, restored: host.restored }, {
			afterDrop: { restored: [], stored: ['token-a'] },
			restored: ['token-a->page-1:restored'],
		});
	});

	test('waits while the pane or the page has no settled space, and keeps the row', async () => {
		const host = new FakeHost({ 'token-a': 'page-1' });
		host.readinessOf = () => 'wait';
		const controller = create(host);
		await controller.evaluate();
		const whileWaiting = { restored: host.restored.length, stored: host.storedTokens() };
		host.readinessOf = () => 'ready';
		await controller.evaluate();
		assert.deepStrictEqual({ whileWaiting, restored: host.restored }, {
			whileWaiting: { restored: 0, stored: ['token-a'] },
			restored: ['token-a->page-1:restored'],
		});
	});

	test('writes the current state once when shutdown begins and nothing while the window tears down', async () => {
		const host = new FakeHost({});
		const controller = create(host);
		host.bound.set('token-a', 'page-1');
		controller.beginShutdown();
		const atShutdown = { stored: host.storedTokens(), writes: host.writes };
		// Panes and pages go away while the window closes; terminals are disposed.
		host.bound.clear();
		host.tokens = [];
		controller.paneEnded('token-a');
		await controller.evaluate();
		assert.deepStrictEqual({ atShutdown, duringTeardown: { stored: host.storedTokens(), writes: host.writes } }, {
			atShutdown: { stored: ['token-a'], writes: 1 },
			duringTeardown: { stored: ['token-a'], writes: 1 },
		});
	});

	test('re-checks each page before restoring it', async () => {
		const host = new FakeHost({});
		host.stored = paradisSerializeBindingRestoreLedger(new Map([[paradisBindingRestoreKey('token-a'), { pageId: 'page-2', at: NOW - 1000, more: ['page-1'], origins: { 'page-1': ORIGIN, 'page-2': ORIGIN } }]]));
		let settled = new Set(['page-1', 'page-2']);
		host.readinessOf = pageId => settled.has(pageId) ? 'ready' : 'wait';
		// page-1 loses its space while page-2 is being shared.
		host.beforeRestore = () => { settled = new Set(['page-2']); };
		await create(host).evaluate();
		assert.deepStrictEqual({ restored: host.restored, reports: host.reports }, {
			restored: ['token-a->page-2:restored'],
			reports: [[1, 0]],
		});
	});

	test('page and pane names cannot become links or commands in the prompt, and are kept short', () => {
		const hostile = paradisBindingRestoreDisplayName('[戻す](command:git.push)', 'fallback');
		const prompt = `再起動の前に共有していたページがあります。「${hostile}」→「${paradisBindingRestoreDisplayName('x\n[y](https://example.com)', 'fallback')}」`;
		const long = paradisBindingRestoreDisplayName('a'.repeat(500), 'fallback');
		assert.deepStrictEqual({
			hostile,
			links: parseLinkedText(prompt).nodes.filter(node => typeof node !== 'string').length,
			longLength: long.length,
			empty: paradisBindingRestoreDisplayName(' \u0000 ', 'fallback'),
			bidi: paradisBindingRestoreDisplayName('a\u202Eb\u200Fc\u2066d\u200Ee', 'fallback'),
		}, {
			hostile: '\uFF3B戻す\uFF3D\uFF08command:git.push\uFF09',
			links: 0,
			longLength: PARADIS_BINDING_RESTORE_NAME_MAX_LENGTH,
			empty: 'fallback',
			bidi: 'a b c d e',
		});
	});

	test('does not write storage again while nothing changes', async () => {
		const host = new FakeHost({});
		host.bound.set('token-a', 'page-1');
		const controller = create(host);
		await controller.evaluate();
		now += 5_000;
		await controller.evaluate();
		await controller.evaluate();
		assert.strictEqual(host.writes, 1);
	});
});
