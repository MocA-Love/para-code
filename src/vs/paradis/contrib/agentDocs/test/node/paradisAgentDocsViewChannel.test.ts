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

	function setup(now = () => 500, stored?: string) {
		const disposables = store.add(new DisposableStore());
		const hooks = disposables.add(new Emitter<IParadisAgentHookEvent>());
		const storage = new MemoryStorage(stored);
		const sidecars = new Map<string, string>();
		const ledger = disposables.add(new ParadisAgentDocsLedger(storage, error => { throw error; }, now));
		const service = disposables.add(new ParadisAgentDocsService(ledger, hooks.event));
		const comments = disposables.add(new ParadisDocCommentsStore({ read: async name => sidecars.get(name), write: async (name, text) => { sidecars.set(name, text); } }, error => { throw error; }, now));
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

	test('the days until a missing document is dropped count from when this version first recorded it missing, not from an older record', async () => {
		let now = 9_000;
		// 数え始めを書かない版が残した記録（見つからなくなった時刻だけがある）
		const legacy = JSON.stringify({ docs: [{ hostId: '', path: '/repo/legacy.md', kind: 'md', previousOwners: [], writes: [], registeredBy: 'user_opened', firstSeen: 5, missingSince: 10 }] });
		const { channel, ledger } = setup(() => now, legacy);
		await ledger.ready;
		const counts = () => {
			const record = ledger.get('', '/repo/legacy.md');
			return [record?.missingSince, record?.missingCountedFrom];
		};
		const loaded = counts();
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/legacy.md', true);
		const counted = counts();
		now = 9_500;
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/legacy.md', true);
		const countedOnce = counts();
		const viewed = (await call<IParadisDocViewRecord[]>(channel, ParadisAgentDocsViewCall.List)).map(record => [record.missingSince, record.missingCountedFrom]);
		// 見つかれば両方外れ、また見つからなくなれば両方がその時刻になる
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/legacy.md', false);
		const found = counts();
		now = 9_900;
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/legacy.md', true);
		assert.deepStrictEqual({ loaded, counted, countedOnce, viewed, found, missingAgain: counts() }, {
			loaded: [10, undefined],
			counted: [10, 9_000],
			countedOnce: [10, 9_000],
			viewed: [[10, 9_000]],
			found: [undefined, undefined],
			missingAgain: [9_900, 9_900],
		});
	});

	test('a missing document moves to the place the window verified, with its owner, writes and comments; anything else is refused', async () => {
		let now = 100;
		const { hooks, channel, ledger, storage, comments } = setup(() => now);
		const hash = 'ab'.repeat(32);
		const fingerprint = { size: 9, mtime: 50, hash, at: 150 };
		hooks.fire(hook('pane-1', 'PostToolUse', 's1', { toolName: 'Write', toolUseId: 'tool-1', payload: { tool_input: { file_path: '/repo/plan.md' } } }));
		hooks.fire(hook('pane-1', 'PostToolUse', 's1', { toolName: 'Write', toolUseId: 'tool-2', payload: { tool_input: { file_path: '/repo/other.md' } } }));
		hooks.fire(hook('pane-1', 'PostToolUse', 's1', { toolName: 'Write', toolUseId: 'tool-3', payload: { tool_input: { file_path: '/repo/bare.md' } } }));
		await ledger.ready;
		await Promise.resolve();
		await comments.add('', '/repo/plan.md', { anchor: { quote: 'A' }, text: 'look here' });
		await call(channel, ParadisAgentDocsViewCall.SetFingerprints, '', [
			{ path: '/repo/plan.md', fingerprint },
			{ path: '/repo/other.md', fingerprint: { ...fingerprint, hash: 'cd'.repeat(32) } },
			{ path: '/repo/unknown.md', fingerprint },
			{ path: '/repo/bare.md', fingerprint: { ...fingerprint, hash: 'nope' } },
		]);
		// 見張りが、移ってきたファイルを先に載せていた
		await call(channel, ParadisAgentDocsViewCall.NoteChanged, '', '/repo/mock/plan.md', ['pane-1']);
		await Promise.resolve();
		now = 200;
		await call(channel, ParadisAgentDocsViewCall.SetMissing, '', '/repo/plan.md', true);
		now = 300;
		const results = {
			wrongHash: await call<boolean>(channel, ParadisAgentDocsViewCall.Relocate, '', '/repo/plan.md', '/repo/mock/plan.md', 'cd'.repeat(32)),
			otherKind: await call<boolean>(channel, ParadisAgentDocsViewCall.Relocate, '', '/repo/plan.md', '/repo/mock/plan.html', hash),
			ownedPlace: await call<boolean>(channel, ParadisAgentDocsViewCall.Relocate, '', '/repo/plan.md', '/repo/other.md', hash),
			dependencyFolder: await call<boolean>(channel, ParadisAgentDocsViewCall.Relocate, '', '/repo/plan.md', '/repo/node_modules/x/plan.md', hash),
			noFingerprint: await call<boolean>(channel, ParadisAgentDocsViewCall.Relocate, '', '/repo/bare.md', '/repo/mock/bare.md', hash),
			moved: await call<boolean>(channel, ParadisAgentDocsViewCall.Relocate, '', '/repo/plan.md', '/repo/mock/plan.md', hash),
			again: await call<boolean>(channel, ParadisAgentDocsViewCall.Relocate, '', '/repo/plan.md', '/repo/mock/plan.md', hash),
		};
		await comments.get('', '/repo/plan.md');
		// 移す前の書き込みを会話の記録から読み直しても、元の場所には載せ直さない
		const replayed = ledger.recordTranscriptWrite('', '/repo/plan.md', { agent: 'claude', session: 's1' }, { at: 250, tool: 'Write', toolUseId: 'tool-1' }, false);
		await ledger.flush();
		const moved = ledger.get('', '/repo/mock/plan.md');
		assert.deepStrictEqual({
			results,
			replayed,
			paths: ledger.all().map(record => record.path),
			moved: { owner: moved?.owner?.session, via: moved?.owner?.via, writes: moved?.writes.map(write => write.toolUseId), missingSince: moved?.missingSince, fingerprint: moved?.fingerprint, registeredBy: moved?.registeredBy },
			comments: [comments.peek('', '/repo/plan.md')?.threads.length, comments.peek('', '/repo/mock/plan.md')?.threads.map(thread => thread.messages[0].text)],
			saved: (JSON.parse(storage.text!) as { removed: { path: string }[] }).removed.map(removal => removal.path),
		}, {
			results: { wrongHash: false, otherKind: false, ownedPlace: false, dependencyFolder: false, noFingerprint: false, moved: true, again: false },
			replayed: false,
			paths: ['/repo/other.md', '/repo/bare.md', '/repo/mock/plan.md'],
			moved: { owner: 's1', via: 'write', writes: ['tool-1'], missingSince: undefined, fingerprint, registeredBy: 'write' },
			comments: [undefined, ['look here']],
			saved: ['/repo/plan.md'],
		});
	});

	test('missing documents are removed in one call', async () => {
		const { channel, ledger } = setup();
		for (const path of ['/repo/a.md', '/repo/b.md', '/repo/c.md']) {
			await call(channel, ParadisAgentDocsViewCall.RegisterOpened, '', path);
		}
		const removed = await call<number>(channel, ParadisAgentDocsViewCall.RemoveMany, '', ['/repo/a.md', '/repo/c.md', '/repo/unknown.md', 'relative.md', 7]);
		assert.deepStrictEqual({ removed, left: ledger.all().map(record => record.path) }, { removed: 2, left: ['/repo/b.md'] });
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
