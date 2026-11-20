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
import type { IParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { IParadisDocViewRecord, ParadisAgentDocsViewCall } from '../../common/paradisAgentDocsView.js';
import { IParadisDocLedgerStorage, ParadisAgentDocsLedger } from '../../node/paradisAgentDocsLedger.js';
import { ParadisAgentDocsService } from '../../node/paradisAgentDocsService.js';
import { ParadisAgentDocsViewChannel } from '../../node/paradisAgentDocsViewChannel.js';
import { ParadisDocCommentsStore } from '../../node/paradisDocCommentsStore.js';

class MemoryStorage implements IParadisDocLedgerStorage {
	constructor(public text: string | undefined = undefined) { }
	async read(): Promise<string | undefined> {
		return this.text;
	}
	async write(text: string): Promise<void> {
		this.text = text;
	}
}

function hook(token: string, event: string, session: string | undefined, extra: Partial<IParadisAgentHookEvent> = {}): IParadisAgentHookEvent {
	return { token, event, sessionId: session, transcriptPath: session !== undefined ? `/home/u/.claude/projects/x/${session}.jsonl` : undefined, cwd: '/repo', at: 1000, ...extra };
}

suite('ParadisAgentDocsViewChannel', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(now = () => 500) {
		const disposables = store.add(new DisposableStore());
		const hooks = disposables.add(new Emitter<IParadisAgentHookEvent>());
		const storage = new MemoryStorage();
		const ledger = disposables.add(new ParadisAgentDocsLedger(storage, error => { throw error; }, now));
		const service = disposables.add(new ParadisAgentDocsService(ledger, hooks.event));
		const comments = disposables.add(new ParadisDocCommentsStore({ read: async () => undefined, write: async () => undefined }, error => { throw error; }, now));
		const channel = disposables.add(new ParadisAgentDocsViewChannel(service, comments));
		return { hooks, ledger, service, channel, storage, comments };
	}

	const call = <T>(channel: ParadisAgentDocsViewChannel, command: string, ...args: unknown[]) => channel.call<T>(undefined, command, args);

	test('a document the user opened is listed without an owner and never takes over an existing record', async () => {
		const { hooks, channel } = setup();
		hooks.fire(hook('pane-1', 'PostToolUse', 's1', { toolName: 'Write', payload: { tool_input: { file_path: '/repo/agent.html' } } }));
		await Promise.resolve();
		const results = [
			await call<boolean>(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/old.md'),
			await call<boolean>(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/old.md'),
			await call<boolean>(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/agent.html'),
			await call<boolean>(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/script.ts'),
			await call<boolean>(channel, ParadisAgentDocsViewCall.RegisterOpened, '', 'relative.md'),
			await call<boolean>(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/.git/x.md'),
			await call<boolean>(channel, ParadisAgentDocsViewCall.RegisterOpened, 'bad host!', '/repo/x.md'),
		];
		const list = (await call<IParadisDocViewRecord[]>(channel, ParadisAgentDocsViewCall.List)).map(record => ({ path: record.path, registeredBy: record.registeredBy, session: record.owner?.session, liveness: record.liveness }));
		assert.deepStrictEqual({ results, list }, {
			results: [true, false, false, false, false, false, false],
			list: [
				{ path: '/repo/agent.html', registeredBy: 'write', session: 's1', liveness: 'live' },
				{ path: '/repo/old.md', registeredBy: 'user_opened', session: undefined, liveness: undefined },
			],
		});
	});

	test('assigning a document to the session of a pane only fills an empty owner on the same machine', async () => {
		const { hooks, channel, ledger } = setup();
		hooks.fire(hook('pane-1', 'SessionStart', 's1'));
		hooks.fire(hook('pane-2', 'SessionStart', 's2', { remoteHostId: 'ssh-host' }));
		await call(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/old.md');
		const results = [
			await call(channel, ParadisAgentDocsViewCall.Assign, '', '/repo/old.md', 'pane-unknown'),
			await call(channel, ParadisAgentDocsViewCall.Assign, '', '/repo/old.md', 'pane-2'),
			await call(channel, ParadisAgentDocsViewCall.Assign, '', '/repo/missing.md', 'pane-1'),
			await call(channel, ParadisAgentDocsViewCall.Assign, '', '/repo/old.md', 'pane-1'),
			await call(channel, ParadisAgentDocsViewCall.Assign, '', '/repo/old.md', 'pane-1'),
		];
		const owner = ledger.get('', '/repo/old.md')?.owner;
		assert.deepStrictEqual({ results, owner, sessions: await call(channel, ParadisAgentDocsViewCall.PaneSessions, ['pane-1', 'pane-2', 'pane-unknown', 3]) }, {
			results: ['sessionUnknown', 'hostMismatch', 'unknown', 'assigned', 'owned'],
			owner: { agent: 'claude', session: 's1', cwd: '/repo', via: 'user', since: 500 },
			sessions: [
				{ token: 'pane-1', agent: 'claude', session: 's1', hostId: '' },
				{ token: 'pane-2', agent: 'claude', session: 's2', hostId: 'ssh-host' },
			],
		});
	});

	test('a changed file the window reports goes to the only working session; paths outside the watch and bad arguments are dropped', async () => {
		const { hooks, channel, ledger } = setup();
		hooks.fire(hook('pane-1', 'UserPromptSubmit', 's1'));
		await call(channel, ParadisAgentDocsViewCall.NoteChanged, '', '/repo/by-command.html', ['pane-1', 42, 'pane-unknown']);
		await call(channel, ParadisAgentDocsViewCall.NoteChanged, '', '/repo/node_modules/pkg/README.md', ['pane-1']);
		await call(channel, ParadisAgentDocsViewCall.NoteChanged, '', '/repo/script.ts', ['pane-1']);
		await call(channel, ParadisAgentDocsViewCall.NoteChanged, 'bad host!', '/repo/x.md', ['pane-1']);
		await call(channel, ParadisAgentDocsViewCall.NoteChanged, '', '/repo/no-tokens.md', 'pane-1');
		await ledger.ready;
		await Promise.resolve();
		assert.deepStrictEqual(ledger.all().map(record => [record.path, record.owner?.session, record.owner?.via, record.registeredBy]), [['/repo/by-command.html', 's1', 'watch', 'watch']]);
	});

	test('the missing mark is set once, cleared when the file is back or written again, and removing drops the row', async () => {
		let now = 100;
		const { hooks, channel, ledger } = setup(() => now);
		await call(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/a.md');
		await call(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/b.md');
		now = 200;
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/a.md', true);
		now = 300;
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/a.md', true);
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/b.md', true);
		const marked = [ledger.get('', '/repo/a.md')?.missingSince, ledger.get('', '/repo/b.md')?.missingSince];
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/a.md', false);
		hooks.fire(hook('pane-1', 'PostToolUse', 's1', { toolName: 'Edit', payload: { tool_input: { file_path: '/repo/b.md' } } }));
		await ledger.ready;
		await Promise.resolve();
		const cleared = [ledger.get('', '/repo/a.md')?.missingSince, ledger.get('', '/repo/b.md')?.missingSince];
		const removed = [await call(channel, ParadisAgentDocsViewCall.Remove, '', '/repo/a.md'), await call(channel, ParadisAgentDocsViewCall.Remove, '', '/repo/a.md')];
		assert.deepStrictEqual({ marked, cleared, removed, left: ledger.all().map(record => record.path) }, {
			marked: [200, 300],
			cleared: [undefined, undefined],
			removed: [true, false],
			left: ['/repo/b.md'],
		});
	});

	test('changes to the ledger and to the live sessions reach the window as one notice', async () => {
		const { hooks, channel } = setup();
		let notices = 0;
		const listener = channel.listen<void>(undefined, 'onDidChange')(() => notices++);
		hooks.fire(hook('pane-1', 'SessionStart', 's1'));
		await call(channel, ParadisAgentDocsViewCall.RegisterOpened, '', '/repo/a.md');
		await new Promise(resolve => setTimeout(resolve, 200));
		hooks.fire(hook('pane-1', 'TerminalExit', undefined));
		await new Promise(resolve => setTimeout(resolve, 200));
		listener.dispose();
		assert.strictEqual(notices, 2);
	});
});
