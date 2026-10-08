/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { parseLinkedText } from '../../../../../base/common/linkedText.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisBindingRestoreDescription,
	IParadisBindingRestoreHost,
	ParadisBindingRestoreAnswer,
	ParadisBindingRestoreController,
	ParadisBindingRestoreOutcome,
	ParadisBindingRestoreReadiness,
	PARADIS_BINDING_RESTORE_NAME_MAX_LENGTH,
	paradisBindingRestoreDisplayName,
} from '../../common/paradisBindingRestoreController.js';
import { paradisBindingRestoreKey, paradisSerializeBindingRestoreLedger } from '../../common/paradisBindingRestoreLedger.js';

const NOW = 1_800_000_000_000;

/** A window with panes and pages, and a user who answers the restore prompt. */
class FakeHost implements IParadisBindingRestoreHost {
	stored: string | undefined;
	writes = 0;
	tokens = ['token-a', 'token-b'];
	pages = new Set(['page-1', 'page-2']);
	bound = new Map<string, string>();
	/** current のほかに共有しているページ（古い順）。共有は付け替えではなく追加。 */
	more = new Map<string, string[]>();
	readinessOf: (pageId: string) => ParadisBindingRestoreReadiness = () => 'ready';
	answer: ParadisBindingRestoreAnswer = 'restore';
	outcomeOf: (pageId: string) => ParadisBindingRestoreOutcome = () => 'restored';
	readonly asked: (readonly IParadisBindingRestoreDescription[])[] = [];
	readonly restored: string[] = [];

	constructor(ledger: Record<string, string>) {
		this.stored = paradisSerializeBindingRestoreLedger(new Map(Object.entries(ledger).map(([token, pageId]) => [paradisBindingRestoreKey(token), { pageId, at: NOW - 1000 }])));
	}

	readStorage(): string | undefined { return this.stored; }
	writeStorage(value: string | undefined): void { this.stored = value; this.writes++; }
	listPaneTokens(): readonly string[] { return this.tokens; }
	boundPageForToken(token: string): string | undefined { return this.bound.get(token); }
	morePagesForToken(token: string): readonly string[] { return this.more.get(token) ?? []; }
	knownPageIds(): ReadonlySet<string> { return this.pages; }
	readiness(pageId: string): ParadisBindingRestoreReadiness { return this.readinessOf(pageId); }
	describe(pageId: string, token: string): IParadisBindingRestoreDescription { return { page: pageId, pane: token }; }
	/** When set, the prompt stays open until the test answers it (or the controller cancels it). */
	pendingAnswer: { resolve(answer: ParadisBindingRestoreAnswer): void } | undefined;
	holdPrompt = false;
	promptCancelled = false;
	/** Runs before each restore, to change the world while the share confirmation is open. */
	beforeRestore: () => void = () => { };
	async confirm(items: readonly IParadisBindingRestoreDescription[], token: CancellationToken): Promise<ParadisBindingRestoreAnswer> {
		this.asked.push(items);
		if (!this.holdPrompt) {
			return this.answer;
		}
		return new Promise(resolve => {
			const listener = token.onCancellationRequested(() => {
				listener.dispose();
				this.promptCancelled = true;
				resolve('later');
			});
			this.pendingAnswer = {
				resolve: answer => {
					listener.dispose();
					resolve(answer);
				},
			};
		});
	}
	async restore(pageId: string, token: string): Promise<ParadisBindingRestoreOutcome> {
		this.beforeRestore();
		const outcome = this.outcomeOf(pageId);
		this.restored.push(`${token}->${pageId}:${outcome}`);
		if (outcome === 'restored') {
			const previous = this.bound.get(token);
			if (previous !== undefined && previous !== pageId) {
				this.more.set(token, [...(this.more.get(token) ?? []), previous]);
			}
			this.bound.set(token, pageId);
		}
		return outcome;
	}
	log(): void { }

	/** Tokens that still have a row in the stored ledger. */
	storedTokens(): string[] {
		const keys = this.stored === undefined ? [] : Object.keys(JSON.parse(this.stored));
		return ['token-a', 'token-b', 'token-c'].filter(token => keys.includes(paradisBindingRestoreKey(token)));
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

	test('asks once for every ready pair, then restores the approved ones and keeps them in the ledger', async () => {
		const host = new FakeHost({ 'token-a': 'page-1', 'token-b': 'page-2' });
		const controller = create(host);
		await controller.evaluate();
		await controller.evaluate();
		assert.deepStrictEqual({
			asked: host.asked,
			restored: host.restored,
			stored: host.storedTokens(),
			undecided: controller.undecidedCount,
		}, {
			asked: [[{ page: 'page-1', pane: 'token-a' }, { page: 'page-2', pane: 'token-b' }]],
			restored: ['token-a->page-1:restored', 'token-b->page-2:restored'],
			stored: ['token-a', 'token-b'],
			undecided: 0,
		});
	});

	// 1 つのペインへ複数のページを共有していたら、全部を 1 回の確認で尋ね、古いものから戻して current を最後に戻す
	test('restores every page a pane shared, the older ones first so that its current page is shared last', async () => {
		const host = new FakeHost({});
		host.pages = new Set(['page-1', 'page-2', 'page-3']);
		host.stored = paradisSerializeBindingRestoreLedger(new Map([[paradisBindingRestoreKey('token-a'), { pageId: 'page-3', at: NOW - 1000, more: ['page-1', 'page-2'] }]]));
		const controller = create(host);
		await controller.evaluate();
		await controller.evaluate();
		assert.deepStrictEqual({
			asked: host.asked,
			restored: host.restored,
			current: host.bound.get('token-a'),
			stored: JSON.parse(host.stored ?? '{}')[paradisBindingRestoreKey('token-a')]?.more,
		}, {
			asked: [[{ page: 'page-1', pane: 'token-a' }, { page: 'page-2', pane: 'token-a' }, { page: 'page-3', pane: 'token-a' }]],
			restored: ['token-a->page-1:restored', 'token-a->page-2:restored', 'token-a->page-3:restored'],
			current: 'page-3',
			stored: ['page-1', 'page-2'],
		});
	});

	test('forgets pairs the user refuses in the prompt or in the share confirmation, and ones that can never be restored', async () => {
		const refused = new FakeHost({ 'token-a': 'page-1' });
		refused.answer = 'discard';
		await create(refused).evaluate();

		const declined = new FakeHost({ 'token-a': 'page-1', 'token-b': 'page-2' });
		declined.outcomeOf = pageId => pageId === 'page-1' ? 'declined' : 'restored';
		declined.readinessOf = () => 'ready';
		await create(declined).evaluate();

		const never = new FakeHost({ 'token-a': 'page-1' });
		never.readinessOf = () => 'never';
		await create(never).evaluate();

		assert.deepStrictEqual({
			refused: [refused.restored, refused.storedTokens()],
			declined: [declined.restored, declined.storedTokens()],
			never: [never.asked.length, never.storedTokens()],
		}, {
			refused: [[], []],
			declined: [['token-a->page-1:declined', 'token-b->page-2:restored'], ['token-b']],
			never: [0, []],
		});
	});

	test('does not ask about pages of a space the user is not looking at, and keeps them for later', async () => {
		const host = new FakeHost({ 'token-a': 'page-1' });
		host.readinessOf = () => 'wait';
		const controller = create(host);
		await controller.evaluate();
		const whileHidden = { asked: host.asked.length, stored: host.storedTokens() };
		host.readinessOf = () => 'ready';
		await controller.evaluate();
		assert.deepStrictEqual({ whileHidden, restored: host.restored }, {
			whileHidden: { asked: 0, stored: ['token-a'] },
			restored: ['token-a->page-1:restored'],
		});
	});

	test('after the window expires it stops trying without forgetting, and a space switch or reconnect starts it again', async () => {
		const host = new FakeHost({ 'token-a': 'page-1' });
		host.tokens = [];
		const controller = create(host);
		await controller.evaluate();
		now += 120_000;
		host.tokens = ['token-a', 'token-b'];
		await controller.evaluate();
		const expired = { asked: host.asked.length, stored: host.storedTokens() };
		controller.restartWindow();
		await controller.evaluate();
		assert.deepStrictEqual({ expired, restored: host.restored }, {
			expired: { asked: 0, stored: ['token-a'] },
			restored: ['token-a->page-1:restored'],
		});
	});

	test('closing the prompt only postpones, and a retry does not ask again', async () => {
		const host = new FakeHost({ 'token-a': 'page-1' });
		host.answer = 'later';
		const controller = create(host);
		await controller.evaluate();
		await controller.evaluate();
		const postponed = { asked: host.asked.length, restored: host.restored.length, stored: host.storedTokens() };

		host.answer = 'restore';
		host.outcomeOf = () => 'retry';
		controller.restartWindow();
		await controller.evaluate();
		host.outcomeOf = () => 'restored';
		await controller.evaluate();
		assert.deepStrictEqual({ postponed, asked: host.asked.length, restored: host.restored }, {
			postponed: { asked: 1, restored: 0, stored: ['token-a'] },
			asked: 2,
			restored: ['token-a->page-1:retry', 'token-a->page-1:restored'],
		});
	});

	test('writes the current state once when shutdown begins and nothing while the window tears down, until the shutdown is vetoed', async () => {
		const host = new FakeHost({});
		const controller = create(host);
		host.bound.set('token-a', 'page-1');
		controller.beginShutdown();
		const atShutdown = host.storedTokens();
		// Panes and pages go away while the window closes.
		host.bound.clear();
		host.tokens = [];
		await controller.evaluate();
		const duringTeardown = host.storedTokens();
		controller.cancelShutdown();
		await controller.evaluate();
		assert.deepStrictEqual({ atShutdown, duringTeardown, afterVeto: host.storedTokens() }, {
			atShutdown: ['token-a'],
			duringTeardown: ['token-a'],
			afterVeto: [],
		});
	});

	test('closes an unanswered prompt when the space switches, and asks again for what is visible afterwards', async () => {
		const host = new FakeHost({ 'token-a': 'page-1' });
		host.holdPrompt = true;
		const controller = create(host);
		const first = controller.evaluate();
		await Promise.resolve();
		controller.spaceSwitched();
		await first;
		const afterSwitch = { cancelled: host.promptCancelled, restored: host.restored.length, stored: host.storedTokens() };
		host.holdPrompt = false;
		await controller.evaluate();
		assert.deepStrictEqual({ afterSwitch, asked: host.asked.length, restored: host.restored }, {
			afterSwitch: { cancelled: true, restored: 0, stored: ['token-a'] },
			asked: 2,
			restored: ['token-a->page-1:restored'],
		});
	});

	test('re-checks each pair before restoring it and postpones one whose space went out of view', async () => {
		const host = new FakeHost({ 'token-a': 'page-1', 'token-b': 'page-2' });
		let visible = new Set(['page-1', 'page-2']);
		host.readinessOf = pageId => visible.has(pageId) ? 'ready' : 'wait';
		// The user switches away from page-2's space while page-1 is being shared.
		host.beforeRestore = () => { visible = new Set(['page-1']); };
		const controller = create(host);
		await controller.evaluate();
		const firstRound = [...host.restored];
		visible = new Set(['page-1', 'page-2']);
		host.beforeRestore = () => { };
		await controller.evaluate();
		assert.deepStrictEqual({ firstRound, asked: host.asked.length, restored: host.restored }, {
			firstRound: ['token-a->page-1:restored'],
			asked: 1,
			restored: ['token-a->page-1:restored', 'token-b->page-2:restored'],
		});
	});

	test('keeps the ledger up to date while a prompt is left open', async () => {
		const host = new FakeHost({ 'token-a': 'page-1' });
		host.holdPrompt = true;
		const controller = create(host);
		const pending = controller.evaluate();
		await Promise.resolve();
		// While the prompt waits, the user shares another pane by hand and later closes the first one.
		host.bound.set('token-b', 'page-2');
		await controller.evaluate();
		const whileOpen = host.storedTokens();
		host.pendingAnswer?.resolve('discard');
		await pending;
		assert.deepStrictEqual({ whileOpen, after: host.storedTokens(), asked: host.asked.length }, {
			whileOpen: ['token-a', 'token-b'],
			after: ['token-b'],
			asked: 1,
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
