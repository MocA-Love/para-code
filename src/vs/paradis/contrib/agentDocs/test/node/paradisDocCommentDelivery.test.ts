/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import type { IParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { IParadisPaneAgentStatusSource } from '../../../agentBrowser/node/paradisPaneAgentStatusSource.js';
import { IParadisDocCommentThread } from '../../common/paradisDocComments.js';
import { ParadisAgentDocsLedger } from '../../node/paradisAgentDocsLedger.js';
import { ParadisAgentDocsService } from '../../node/paradisAgentDocsService.js';
import { ParadisDocCommentDelivery } from '../../node/paradisDocCommentDelivery.js';
import { IParadisDocCommentsStorage, ParadisDocCommentsStore } from '../../node/paradisDocCommentsStore.js';

class MemoryCommentsStorage implements IParadisDocCommentsStorage {
	readonly files = new Map<string, string>();
	async read(name: string): Promise<string | undefined> {
		return this.files.get(name);
	}
	async write(name: string, text: string): Promise<void> {
		this.files.set(name, text);
	}
	async list(): Promise<readonly string[]> {
		return [...this.files.keys()];
	}
}

function hook(token: string, event: string, session: string, extra: Partial<IParadisAgentHookEvent> = {}): IParadisAgentHookEvent {
	return { token, event, sessionId: session, transcriptPath: `/home/u/.claude/projects/x/${session}.jsonl`, cwd: '/repo', at: 1000, ...extra };
}

function write(token: string, session: string, filePath: string): IParadisAgentHookEvent {
	return hook(token, 'PostToolUse', session, { toolName: 'Write', payload: { tool_input: { file_path: filePath } } });
}

suite('ParadisDocCommentDelivery', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const store = disposables.add(new DisposableStore());
		let now = 1_000;
		const hooks = store.add(new Emitter<IParadisAgentHookEvent>());
		const turnEnded = store.add(new Emitter<{ token: string; at: number; cause?: 'turn' | 'cli-exit' }>());
		const ledger = store.add(new ParadisAgentDocsLedger({ read: async () => undefined, write: async () => undefined }, error => { throw error; }, () => now));
		const docs = store.add(new ParadisAgentDocsService(ledger, hooks.event));
		let id = 0;
		const comments = store.add(new ParadisDocCommentsStore(new MemoryCommentsStorage(), error => { throw error; }, () => now, () => `c-00000000000${++id}`));
		const statuses = new Map<string, ParadisAgentStatus>();
		const drafts = new Map<string, string | undefined>();
		const noHooks = new Set<string>();
		const source: IParadisPaneAgentStatusSource = {
			getPaneAgentStatus: token => statuses.has(token) ? { status: statuses.get(token)!, changedAt: 0 } : undefined,
			getUnconfirmedRelease: () => undefined,
			hasAgentHookHistory: token => !noHooks.has(token),
		};
		const delivery = store.add(new ParadisDocCommentDelivery(docs, comments, () => source, token => drafts.has(token) ? drafts.get(token) : '', hooks.event, turnEnded.event, () => now));
		const wanted: (readonly string[])[] = [];
		store.add(delivery.onDidWant(tokens => wanted.push(tokens)));
		const state = async (path: string) => (await comments.get('', path)).threads.map((thread: IParadisDocCommentThread) => [thread.id, thread.state, thread.delivery?.blockedBy ?? (thread.delivery?.typedAt !== undefined ? `typed:${thread.delivery.entered === true}` : undefined)]);
		const settle = async () => {
			await ledger.ready;
			await new Promise(resolve => setTimeout(resolve, 0));
		};
		return { hooks, turnEnded, comments, delivery, statuses, drafts, noHooks, wanted, state, settle, advance: (ms: number) => { now += ms; } };
	}

	test('waits while the owner asks for a permission, types once and presses Enter when it is idle, and marks it delivered on the submitted prompt', async () => {
		const t = setup();
		t.hooks.fire(write('p1', 's1', '/repo/a.md'));
		await t.settle();
		const first = await t.comments.add('', '/repo/a.md', { anchor: { quote: 'A' }, text: '根拠は?' });
		t.statuses.set('p1', 'permission');
		await t.delivery.evaluate();
		const whilePermission = { state: await t.state('/repo/a.md'), wanted: t.wanted.length, claim: await t.delivery.claim('p1') };
		t.statuses.delete('p1');
		await t.delivery.evaluate();
		const claim = await t.delivery.claim('p1');
		const again = await t.delivery.claim('p1');
		t.drafts.set('p1', claim?.text);
		const mayEnter = t.delivery.confirmEnter(claim!.attempt);
		await t.delivery.finish(claim!.attempt, 'entered');
		const second = await t.comments.add('', '/repo/a.md', { anchor: { quote: 'B' }, text: '別件' });
		await t.delivery.evaluate();
		const whileSending = await t.state('/repo/a.md');
		t.hooks.fire(hook('p1', 'UserPromptSubmit', 's1', { payload: { prompt: claim!.text } }));
		await t.settle();
		await t.settle();
		assert.deepStrictEqual({
			whilePermission,
			wanted: t.wanted,
			claim: { text: claim?.text.includes(first!.id) && claim.text.includes('根拠は?'), enter: claim?.enter },
			again,
			mayEnter,
			whileSending,
			delivered: await t.state('/repo/a.md'),
		}, {
			whilePermission: { state: [[first!.id, 'queued', 'permission']], wanted: 0, claim: undefined },
			wanted: [['p1']],
			claim: { text: true, enter: true },
			again: undefined,
			mayEnter: true,
			whileSending: [[first!.id, 'queued', 'typed:true'], [second!.id, 'queued', 'sending']],
			delivered: [[first!.id, 'delivered', 'typed:true'], [second!.id, 'queued', 'sending']],
		});
	});

	test('does not deliver to a pane without hooks or without an owner, and waits for the end of a turn when the draft is unknown', async () => {
		const t = setup();
		t.hooks.fire(write('p1', 's1', '/repo/a.md'));
		t.hooks.fire(write('p2', 's2', '/repo/b.md'));
		t.hooks.fire(write('p3', 's3', '/repo/c.md'));
		await t.settle();
		t.noHooks.add('p2');
		t.drafts.set('p3', undefined);
		const a = await t.comments.add('', '/repo/a.md', { anchor: { quote: 'A' }, text: 'x' });
		const b = await t.comments.add('', '/repo/b.md', { anchor: { quote: 'B' }, text: 'y' });
		const c = await t.comments.add('', '/repo/c.md', { anchor: { quote: 'C' }, text: 'z' });
		const d = await t.comments.add('', '/repo/none.md', { anchor: { quote: 'D' }, text: 'w' });
		t.drafts.set('p1', 'まだ書いている');
		await t.delivery.evaluate();
		const before = [...await t.state('/repo/a.md'), ...await t.state('/repo/b.md'), ...await t.state('/repo/c.md'), ...await t.state('/repo/none.md')];
		t.hooks.fire(hook('p3', 'Stop', 's3'));
		await t.settle();
		await t.delivery.evaluate();
		const claim = await t.delivery.claim('p3');
		assert.deepStrictEqual({ before, wanted: t.wanted.flat(), claimed: claim?.text.includes(c!.id) }, {
			before: [[a!.id, 'queued', 'draft'], [b!.id, 'undeliverable', 'noHooks'], [c!.id, 'queued', 'draftUnknown'], [d!.id, 'undeliverable', 'noOwner']],
			wanted: ['p3'],
			claimed: true,
		});
	});

	test('does not deliver after the CLI exited (the shell is in front) until a hook comes again', async () => {
		const t = setup();
		t.hooks.fire(write('p1', 's1', '/repo/a.md'));
		await t.settle();
		const a = await t.comments.add('', '/repo/a.md', { anchor: { quote: 'A' }, text: 'x' });
		t.turnEnded.fire({ token: 'p1', at: 1_000, cause: 'cli-exit' });
		await t.delivery.evaluate();
		const exited = { state: await t.state('/repo/a.md'), claim: await t.delivery.claim('p1') };
		t.hooks.fire(hook('p1', 'SessionStart', 's1'));
		await t.settle();
		await t.delivery.evaluate();
		assert.deepStrictEqual({ exited, back: await t.state('/repo/a.md'), wanted: t.wanted.flat() }, {
			exited: { state: [[a!.id, 'undeliverable', 'unknown']], claim: undefined },
			back: [[a!.id, 'queued', undefined]],
			wanted: ['p1'],
		});
	});
});
