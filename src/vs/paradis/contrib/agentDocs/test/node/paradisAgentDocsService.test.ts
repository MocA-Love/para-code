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
import type { IParadisMcpOwningWindowRequest, IParadisMcpToolCallContext, ParadisMcpCallerKind, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisDocInspectItem, IParadisDocInspectResult, ParadisDocAdoptConfirmOutcome, paradisParseDocLedger } from '../../common/paradisAgentDocs.js';
import { IParadisDocLedgerStorage, ParadisAgentDocsLedger } from '../../node/paradisAgentDocsLedger.js';
import { ParadisAgentDocsService } from '../../node/paradisAgentDocsService.js';
import { ParadisAgentDocsToolProvider } from '../../node/paradisAgentDocsToolProvider.js';

class MemoryStorage implements IParadisDocLedgerStorage {
	constructor(public text: string | undefined = undefined) { }
	async read(): Promise<string | undefined> {
		return this.text;
	}
	async write(text: string): Promise<void> {
		this.text = text;
	}
}

function hook(token: string, event: string, extra: Partial<IParadisAgentHookEvent> = {}): IParadisAgentHookEvent {
	return { token, event, sessionId: undefined, transcriptPath: undefined, cwd: undefined, at: 1000, ...extra };
}

function write(token: string, session: string, filePath: string, toolName = 'Write', extra: Partial<IParadisAgentHookEvent> = {}): IParadisAgentHookEvent {
	return hook(token, 'PostToolUse', { sessionId: session, transcriptPath: `/home/u/.claude/projects/x/${session}.jsonl`, cwd: '/repo', toolName, payload: { tool_input: { file_path: filePath } }, toolUseId: `tu-${filePath}`, ...extra });
}

function start(token: string, session: string, cwd = '/repo', extra: Partial<IParadisAgentHookEvent> = {}): IParadisAgentHookEvent {
	return hook(token, 'SessionStart', { sessionId: session, transcriptPath: `/home/u/.claude/projects/x/${session}.jsonl`, cwd, ...extra });
}

interface IFakeWindow {
	folder?: { hostId: string; path: string };
	windowHostId?: string;
	paneKnown?: boolean;
	missing?: Set<string>;
	links?: Map<string, string>;
	answer?: ParadisDocAdoptConfirmOutcome;
	asked: unknown[];
	inspected: (readonly IParadisDocInspectItem[])[];
}

function context(window: IFakeWindow, caller: ParadisMcpCallerKind = 'pane'): IParadisMcpToolCallContext {
	return {
		classifyCaller: async () => caller,
		getPaneAgentStatus: () => undefined,
		getUnconfirmedRelease: () => undefined,
		hasAgentHookHistory: () => true,
		callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> => {
			if (request.method === 'inspect') {
				const items = request.args[1] as readonly IParadisDocInspectItem[];
				window.inspected.push(items);
				const windowHostId = window.windowHostId ?? '';
				const result: IParadisDocInspectResult = {
					paneKnown: window.paneKnown ?? true,
					windowHostId,
					...(window.folder ? { folder: window.folder } : {}),
					files: items.map(item => (item.hostId ?? windowHostId) !== windowHostId ? {} : window.missing?.has(item.path) ? { exists: false } : { exists: true, isFile: true, realPath: window.links?.get(item.path) ?? item.path }),
				};
				return { ok: true, value: result as T };
			}
			window.asked.push(request.args[1]);
			return { ok: true, value: (window.answer ?? 'approve') as T };
		},
	};
}

async function json(result: unknown): Promise<unknown> {
	const value = await result as { content: { text: string }[]; isError?: boolean };
	return value.isError ? { error: value.content[0].text } : JSON.parse(value.content[0].text);
}

suite('paradisAgentDocsService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let store: DisposableStore;
	let hooks: Emitter<IParadisAgentHookEvent>;
	let storage: MemoryStorage;
	let ledger: ParadisAgentDocsLedger;
	let service: ParadisAgentDocsService;
	let now: number;

	function create(text?: string): void {
		storage = new MemoryStorage(text);
		ledger = store.add(new ParadisAgentDocsLedger(storage, error => { throw error; }, () => now));
		service = store.add(new ParadisAgentDocsService(ledger, hooks.event));
	}

	setup(() => {
		store = disposables.add(new DisposableStore());
		hooks = store.add(new Emitter<IParadisAgentHookEvent>());
		now = 100;
		create();
	});

	async function settle(): Promise<void> {
		await ledger.ready;
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	function owners(): unknown {
		return ledger.all().map(entry => [entry.hostId, entry.path, entry.owner?.session, entry.owner?.via, entry.owner?.ended, entry.writes.length]);
	}

	test('the session that wrote a document last owns it; other tools, files and unverified hooks are ignored', async () => {
		hooks.fire(start('p1', 's1'));
		hooks.fire(start('p2', 's2'));
		hooks.fire(write('p1', 's1', '/repo/report.html'));
		hooks.fire(write('p1', 's1', '/repo/report.html', 'Edit'));
		hooks.fire(write('p2', 's2', '/repo/report.html', 'Edit'));
		hooks.fire(write('p1', 's1', '/repo/main.ts'));
		hooks.fire(write('p1', 's1', '/repo/notes.md', 'Bash'));
		hooks.fire(write('p1', 's1', '/repo/other.md', 'Write', { ownerUnverified: true }));
		hooks.fire(write('p1', 's1', 'relative.md'));
		hooks.fire(hook('p1', 'PreToolUse', { sessionId: 's1', toolName: 'Write', payload: { tool_input: { file_path: '/repo/pre.md' } } }));
		// Codex の書き込みは段 1 では載せない
		hooks.fire(write('p3', 'c1', '/repo/codex.md', 'Write', { transcriptPath: '/home/u/.codex/sessions/rollout-1.jsonl' }));
		hooks.fire(write('p4', 's4', '/srv/remote.md', 'Write', { remoteHostId: 'ssh-remote-box' }));
		await settle();
		assert.deepStrictEqual(owners(), [
			['', '/repo/report.html', 's2', 'write', undefined, 3],
			['ssh-remote-box', '/srv/remote.md', 's4', 'write', undefined, 1],
		]);
		assert.deepStrictEqual(ledger.get('', '/repo/report.html')?.previousOwners.map(entry => entry.session), ['s1']);
	});

	test('marks the owner ended on SessionEnd and on the exit of its terminal, and clears the mark when it comes back', async () => {
		hooks.fire(start('p1', 's1'));
		hooks.fire(start('p2', 's2'));
		hooks.fire(write('p1', 's1', '/repo/a.md'));
		hooks.fire(write('p2', 's2', '/repo/b.md'));
		now = 200;
		hooks.fire(hook('p1', 'SessionEnd', { sessionId: 's1' }));
		hooks.fire(hook('p2', 'TerminalExit'));
		await settle();
		const ended = owners();
		const livenessAfterEnd = service.livenessOf(ledger.get('', '/repo/a.md')!.owner!);
		hooks.fire(start('p5', 's1'));
		await settle();
		assert.deepStrictEqual({ ended, livenessAfterEnd, resumed: owners(), liveness: service.livenessOf(ledger.get('', '/repo/a.md')!.owner!) }, {
			ended: [['', '/repo/a.md', 's1', 'write', 200, 1], ['', '/repo/b.md', 's2', 'write', 200, 1]],
			livenessAfterEnd: 'ended',
			resumed: [['', '/repo/b.md', 's2', 'write', 200, 1], ['', '/repo/a.md', 's1', 'write', undefined, 1]],
			liveness: 'live',
		});
	});

	test('saves to the storage, keeps what was there before loading, and treats a restored owner as unknown', async () => {
		hooks.fire(start('p1', 's1'));
		hooks.fire(write('p1', 's1', '/repo/a.md'));
		await settle();
		await ledger.flush();
		const saved = storage.text;
		store.clear();
		hooks = store.add(new Emitter<IParadisAgentHookEvent>());
		create(saved);
		const restored = ledger.get('', '/repo/a.md');
		await settle();
		assert.deepStrictEqual({
			before: restored,
			after: owners(),
			liveness: service.livenessOf(ledger.get('', '/repo/a.md')!.owner!),
			file: paradisParseDocLedger(saved).length,
		}, { before: undefined, after: [['', '/repo/a.md', 's1', 'write', undefined, 1]], liveness: 'unknown', file: 1 });
	});

	test('preview_file registers an unowned html or md file to the session of the pane', async () => {
		hooks.fire(start('p1', 's1'));
		hooks.fire(start('p2', 's2'));
		hooks.fire(start('p3', 's3', '/srv', { remoteHostId: 'ssh-remote-box' }));
		hooks.fire(write('p2', 's2', '/repo/theirs.md'));
		await settle();
		const notes = [
			await service.onPreviewFileOpened({ token: 'p1', path: '/repo/old.html', deferred: false }),
			await service.onPreviewFileOpened({ token: 'p1', path: '/repo/old.html', deferred: false }),
			await service.onPreviewFileOpened({ token: 'p1', path: '/repo/theirs.md', deferred: true }),
			await service.onPreviewFileOpened({ token: 'p1', path: '/repo/image.png', deferred: false }),
			await service.onPreviewFileOpened({ token: 'unknown-pane', path: '/repo/x.md', deferred: false }),
			await service.onPreviewFileOpened({ token: 'p3', path: '/srv/r.md', remoteAuthority: 'ssh-remote+box', deferred: false }),
		];
		assert.deepStrictEqual({ notes, owners: owners() }, {
			notes: [
				'It is now a document of this session (list_docs shows it).',
				undefined,
				'Another session owns this document. Call adopt_doc if the user asked you to take it over.',
				undefined,
				undefined,
				'It is now a document of this session (list_docs shows it).',
			],
			owners: [
				['', '/repo/theirs.md', 's2', 'write', undefined, 1],
				['', '/repo/old.html', 's1', 'preview', undefined, 0],
				['ssh-remote-box', '/srv/r.md', 's3', 'preview', undefined, 0],
			],
		});
	});

	suite('tools', () => {

		test('refuse unverified callers and panes without a known session', async () => {
			const provider = new ParadisAgentDocsToolProvider(service);
			const window: IFakeWindow = { asked: [], inspected: [] };
			assert.deepStrictEqual([
				await provider.callTool('p1', 'list_tabs', {}, undefined, context(window)),
				await json(provider.callTool('p1', 'list_docs', {}, undefined, context(window, 'unverified'))),
				await json(provider.callTool('p1', 'list_docs', {}, undefined, context(window))),
				await json(provider.callTool('p1', 'adopt_doc', { paths: ['/repo/a.md'] }, undefined, context(window))),
			], [
				undefined,
				{ error: 'Para Code could not confirm that this request comes from a process inside a Para Code terminal pane (or from the SSH host of its window), so it refuses the request. Start this agent CLI from a terminal inside Para Code.' },
				{ error: 'list_docs was not run: Para Code does not know which agent session runs in this terminal yet (its hooks have not reported). Send one message in this terminal and retry.' },
				{ error: 'adopt_doc was not run: Para Code does not know which agent session runs in this terminal yet (its hooks have not reported). Send one message in this terminal and retry.' },
			]);
		});

		test('list_docs returns the documents of the session or of the space, newest first', async () => {
			hooks.fire(start('p1', 's1'));
			hooks.fire(start('p2', 's2', '/repo/wt'));
			now = 110;
			hooks.fire(write('p1', 's1', '/repo/a.md', 'Write', { at: Date.UTC(2026, 10, 18, 1) }));
			now = 120;
			hooks.fire(write('p1', 's1', '/tmp/scratch.html', 'Write', { at: Date.UTC(2026, 10, 18, 2) }));
			now = 130;
			hooks.fire(write('p2', 's2', '/elsewhere/b.html', 'Write', { at: Date.UTC(2026, 10, 18, 3) }));
			hooks.fire(write('p1', 's1', '/other/c.md', 'Write', { cwd: '/other', at: Date.UTC(2026, 10, 18, 4) }));
			await settle();
			const provider = new ParadisAgentDocsToolProvider(service);
			const window: IFakeWindow = { folder: { hostId: '', path: '/repo' }, missing: new Set(['/repo/a.md']), asked: [], inspected: [] };
			const session = await json(provider.callTool('p1', 'list_docs', {}, undefined, context(window)));
			const space = await json(provider.callTool('p2', 'list_docs', { scope: 'space' }, undefined, context(window)));
			const open = await json(provider.callTool('p1', 'list_docs', { only_open_comments: true }, undefined, context(window)));
			assert.deepStrictEqual({ session, space, open }, {
				session: {
					scope: 'session',
					docs: [
						{ path: '/other/c.md', kind: 'md', owner: 'this_session', registered_by: 'write', last_written: '2026-11-18T04:00:00.000Z', open_comments: 0, exists: true },
						{ path: '/tmp/scratch.html', kind: 'html', owner: 'this_session', registered_by: 'write', last_written: '2026-11-18T02:00:00.000Z', open_comments: 0, exists: true },
						{ path: '/repo/a.md', kind: 'md', owner: 'this_session', registered_by: 'write', last_written: '2026-11-18T01:00:00.000Z', open_comments: 0, exists: false },
					],
					truncated: false,
				},
				// 持ち主の会話がスペースのフォルダで始まった資料（/tmp・/elsewhere）も、そのスペースの資料
				space: {
					scope: 'space',
					docs: [
						{ path: '/other/c.md', kind: 'md', owner: 'other_session', registered_by: 'write', last_written: '2026-11-18T04:00:00.000Z', open_comments: 0, exists: true },
						{ path: '/elsewhere/b.html', kind: 'html', owner: 'this_session', registered_by: 'write', last_written: '2026-11-18T03:00:00.000Z', open_comments: 0, exists: true },
						{ path: '/tmp/scratch.html', kind: 'html', owner: 'other_session', registered_by: 'write', last_written: '2026-11-18T02:00:00.000Z', open_comments: 0, exists: true },
						{ path: '/repo/a.md', kind: 'md', owner: 'other_session', registered_by: 'write', last_written: '2026-11-18T01:00:00.000Z', open_comments: 0, exists: false },
					],
					truncated: false,
				},
				open: { scope: 'session', docs: [], truncated: false },
			});
		});

		test('adopt_doc registers, takes over from ended sessions, and asks once before taking over from a running one', async () => {
			hooks.fire(start('p1', 's1'));
			hooks.fire(start('p2', 's2'));
			hooks.fire(start('p3', 's3'));
			hooks.fire(write('p2', 's2', '/repo/live.md'));
			hooks.fire(write('p2', 's2', '/repo/live2.html'));
			hooks.fire(write('p3', 's3', '/repo/ended.md'));
			hooks.fire(write('p1', 's1', '/repo/mine.md'));
			hooks.fire(hook('p3', 'SessionEnd', { sessionId: 's3' }));
			await settle();
			const provider = new ParadisAgentDocsToolProvider(service);
			const window: IFakeWindow = {
				folder: { hostId: '', path: '/repo' },
				missing: new Set(['/repo/gone.md']),
				links: new Map([['/repo/link.md', '/etc/secret.md']]),
				answer: 'denied',
				asked: [],
				inspected: [],
			};
			const paths = ['/repo/new.md', '/repo/mine.md', '/repo/ended.md', '/repo/live.md', '/repo/live2.html', '/repo/gone.md', '/repo/x.txt', '/outside/a.md', '/repo/link.md', '/repo/.git/a.md'];
			const denied = await json(provider.callTool('p1', 'adopt_doc', { paths, reason: 'ユーザーに頼まれた' }, undefined, context(window)));
			window.answer = 'approve';
			const approved = await json(provider.callTool('p1', 'adopt_doc', { paths: ['/repo/live.md'] }, undefined, context(window)));
			assert.deepStrictEqual({ denied, approved, asked: window.asked, owners: ledger.all().map(entry => [entry.path, entry.owner?.session, entry.owner?.via]) }, {
				denied: {
					results: [
						{ path: '/repo/new.md', result: 'adopted', previous_owner: 'none', open_comments: 0 },
						{ path: '/repo/mine.md', result: 'already_yours', previous_owner: 'this_session', open_comments: 0 },
						{ path: '/repo/ended.md', result: 'adopted', previous_owner: 'ended_session', open_comments: 0 },
						{ path: '/repo/live.md', result: 'denied', previous_owner: 'other_session' },
						{ path: '/repo/live2.html', result: 'denied', previous_owner: 'other_session' },
						{ path: '/repo/gone.md', result: 'not_found' },
						{ path: '/repo/x.txt', result: 'unsupported_type' },
						{ path: '/outside/a.md', result: 'outside_space' },
						{ path: '/repo/link.md', result: 'outside_space' },
						{ path: '/repo/.git/a.md', result: 'unsupported_type' },
					],
				},
				approved: { results: [{ path: '/repo/live.md', result: 'adopted', previous_owner: 'other_session', open_comments: 0 }] },
				asked: [{ names: ['live.md', 'live2.html'], reason: 'ユーザーに頼まれた' }, { names: ['live.md'] }],
				owners: [
					['/repo/live2.html', 's2', 'write'],
					['/repo/mine.md', 's1', 'write'],
					['/repo/new.md', 's1', 'adopt'],
					['/repo/ended.md', 's1', 'adopt'],
					['/repo/live.md', 's1', 'adopt'],
				],
			});
		});

		test('adopt_doc keys the files by the host of the window (SSH)', async () => {
			hooks.fire(start('p1', 's1', '/srv', { remoteHostId: 'ssh-remote-box' }));
			await settle();
			const provider = new ParadisAgentDocsToolProvider(service);
			const window: IFakeWindow = { windowHostId: 'ssh-remote-box', folder: { hostId: 'ssh-remote-box', path: '/srv' }, asked: [], inspected: [] };
			const result = await json(provider.callTool('p1', 'adopt_doc', { paths: ['/srv/a.md'] }, undefined, context(window, 'tunnel')));
			assert.deepStrictEqual({ result, owners: owners() }, {
				result: { results: [{ path: '/srv/a.md', result: 'adopted', previous_owner: 'none', open_comments: 0 }] },
				owners: [['ssh-remote-box', '/srv/a.md', 's1', 'adopt', undefined, 0]],
			});
		});
	});
});
