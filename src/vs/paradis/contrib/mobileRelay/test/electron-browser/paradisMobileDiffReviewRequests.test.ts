/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { InMemoryStorageService, IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { paradisMobileDiffIdentity, paradisParseMobilePorcelainStatus, paradisWithMobileLineCounts } from '../../common/paradisMobileDiffReview.js';
import { PARADIS_MOBILE_REVIEW_STORAGE_KEY } from '../../common/paradisMobileReviewStore.js';
import { paradisReviewNotesTargetVerdict } from '../../electron-browser/paradisMobileDiffReviewRequests.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

interface IReply {
	readonly id: string;
	readonly error?: string;
	readonly marks?: Record<string, { readonly identity: string; readonly reviewedAt: number }>;
	readonly notes?: readonly { readonly id: string; readonly path: string; readonly line: number; readonly body: string; readonly sentAt?: number }[];
	readonly [key: string]: unknown;
}

/** git の代わり。status と numstat は与えた値を返し、`add` はその後の status を差し替える。 */
class FakeGit {
	readonly calls: string[] = [];
	constructor(public status: string, public unstaged = '', public staged = '', private readonly afterAdd?: { status: string; unstaged: string; staged: string }) { }

	run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
		this.calls.push(args.join(' '));
		if (args[0] === 'add' && this.afterAdd !== undefined) {
			({ status: this.status, unstaged: this.unstaged, staged: this.staged } = this.afterAdd);
			return { code: 0, stdout: '', stderr: '' };
		}
		const stdout = args[0] === 'status' ? this.status : args.includes('--cached') ? this.staged : args[0] === 'diff' ? this.unstaged : '';
		return { code: 0, stdout, stderr: '' };
	}
}

suite('ParadisMobileDiffReviewRequests', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHost(services: Map<unknown, unknown>, sent: IReply[], git: FakeGit, files: Record<string, string> = {}): IParadisMobileRequestHost {
		services.set(IFileService, {
			stat: async (uri: URI) => {
				const text = files[uri.path.slice('/repo/'.length)];
				if (text === undefined) {
					throw new Error('missing');
				}
				return { isDirectory: false, size: text.length };
			},
			readFile: async (uri: URI) => ({ value: VSBuffer.fromString(files[uri.path.slice('/repo/'.length)] ?? '') }),
		});
		return {
			// 使わないサービス（送り先を確かめる端末まわり）は空で埋める
			invokeFunction: fn => fn({ get: id => services.get(id) ?? {} } as ServicesAccessor),
			resolveRoot: ws => ws === 'repo' ? URI.file('/repo') : undefined,
			runGit: async (_root, args) => git.run(args),
			resolvePath: async (_ws, relativePath) => URI.file(`/repo/${relativePath}`),
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, _mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
		};
	}

	function createServices(): Map<unknown, unknown> {
		return new Map<unknown, unknown>([[IStorageService, store.add(new InMemoryStorageService())]]);
	}

	const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
	const dispatch = (host: IParadisMobileRequestHost, body: Record<string, unknown>) => paradisDispatchMobileRequest('scm', { ws: 'repo', ...body }, 'phone', host);

	test('marks files one at a time, keeps them in the workspace storage and drops committed ones on read', async () => {
		const services = createServices();
		const sent: IReply[] = [];
		const host = createHost(services, sent, new FakeGit(' M a.ts\n M b.ts\n'));
		dispatch(host, { t: 'reviewSet', id: '1', marks: [{ path: 'a.ts', identity: '00aa' }, { path: 'gone.ts', identity: '00bb' }] });
		dispatch(host, { t: 'reviewSet', id: '2', marks: [{ path: 'b.ts', identity: '00cc' }] });
		dispatch(host, { t: 'reviewGet', id: '3' });
		await flush();

		const storage = services.get(IStorageService) as IStorageService;
		assert.deepStrictEqual({
			afterPhone: Object.keys(sent[0].marks!),
			afterIpad: Object.keys(sent[1].marks!),
			read: Object.keys(sent[2].marks!),
			stored: Object.keys(JSON.parse(storage.get(PARADIS_MOBILE_REVIEW_STORAGE_KEY, StorageScope.WORKSPACE)!).repo.marks),
		}, {
			afterPhone: ['a.ts', 'gone.ts'],
			afterIpad: ['a.ts', 'gone.ts', 'b.ts'],
			read: ['a.ts', 'b.ts'],
			stored: ['a.ts', 'b.ts'],
		});
	});

	test('removes a mark with a null identity and rejects malformed requests and unknown spaces', async () => {
		const sent: IReply[] = [];
		const host = createHost(createServices(), sent, new FakeGit(' M a.ts\n'));
		dispatch(host, { t: 'reviewSet', id: '1', marks: [{ path: 'a.ts', identity: '00aa' }] });
		dispatch(host, { t: 'reviewSet', id: '2', marks: [{ path: 'a.ts', identity: null }] });
		dispatch(host, { t: 'reviewSet', id: '3', marks: [{ path: '/etc/passwd', identity: '00aa' }] });
		dispatch(host, { t: 'reviewSet', id: '4', marks: [{ path: 'a.ts', identity: 'NOT HEX' }] });
		dispatch(host, { t: 'reviewGet', id: '5', ws: 'elsewhere' });
		await flush();

		assert.deepStrictEqual(sent.slice(1), [
			{ t: 'review', ws: 'repo', marks: {}, notes: [], id: '2' },
			{ error: 'invalid marks', id: '3' },
			{ error: 'invalid marks', id: '4' },
			{ error: 'unknown workspace: elsewhere', id: '5' },
		]);
	});

	test('adds, edits and deletes notes, and clears sent and stale ones', async () => {
		const services = createServices();
		const sent: IReply[] = [];
		const files = { 'a.ts': 'one\ntwo\nthree' };
		const host = createHost(services, sent, new FakeGit(' M a.ts\n'), files);
		dispatch(host, { t: 'reviewNoteAdd', id: '1', path: 'a.ts', line: 2, lineText: 'two', body: ' rename this ' });
		dispatch(host, { t: 'reviewNoteAdd', id: '2', path: 'a.ts', line: 3, lineText: 'three', body: 'and this' });
		dispatch(host, { t: 'reviewNoteAdd', id: '3', path: 'a.ts', line: 0, lineText: 'x', body: 'bad line' });
		const [first, second] = sent[1].notes!;
		dispatch(host, { t: 'reviewNoteEdit', id: '4', noteId: first.id, body: 'renamed' });
		dispatch(host, { t: 'reviewNoteEdit', id: '5', noteId: first.id, body: '   ' });
		await flush();
		const edited = sent[3].notes![0].body;
		const emptyEdit = sent[4].error;

		// 2 件目の行（three）が直されて無くなった。1 件目は行が 1 つ下へ動いただけなので残る
		files['a.ts'] = 'zero\none\ntwo\nTHREE';
		dispatch(host, { t: 'reviewNotesClear', id: '6' });
		await flush();
		const clear = sent.at(-1)!;

		dispatch(host, { t: 'reviewNoteDelete', id: '7', ids: [first.id] });
		await flush();

		assert.deepStrictEqual({
			added: sent[1].notes!.map(note => ({ path: note.path, line: note.line, body: note.body })),
			badLine: sent[2].error,
			edited,
			emptyEdit,
			cleared: { removed: clear.removed, left: clear.notes!.map(note => note.id) },
			deleted: sent.at(-1)!.notes,
		}, {
			added: [{ path: 'a.ts', line: 2, body: 'rename this' }, { path: 'a.ts', line: 3, body: 'and this' }],
			badLine: 'invalid note',
			edited: 'renamed',
			emptyEdit: 'invalid note',
			cleared: { removed: 1, left: [first.id] },
			deleted: [],
		});
		assert.notStrictEqual(second.id, first.id);
	});

	test('sends the stored notes to a newly launched agent and keeps them as sent', async () => {
		const services = createServices();
		const launched: { prompt?: string; agentId: string; stateKey: string }[] = [];
		services.set(IInstantiationService, { invokeFunction: async (_fn: unknown, request: { prompt?: string; agentId: string; stateKey: string }) => { launched.push(request); } });
		const sent: IReply[] = [];
		const host = createHost(services, sent, new FakeGit(' M a.ts\n'), { 'a.ts': 'x\nconst a = 1;\n' });
		dispatch(host, { t: 'reviewNoteAdd', id: '1', path: 'a.ts', line: 1, lineText: 'const a = 1;', body: 'use let' });
		const noteId = sent[0].notes![0].id;
		dispatch(host, { t: 'reviewNotesSend', id: '2', ids: [noteId], target: { agent: 'claude' } });
		dispatch(host, { t: 'reviewNotesSend', id: '3', ids: [noteId], target: { agent: 'claude', terminalKey: 't' } });
		await flush();

		const reply = (id: string) => sent.find(candidate => candidate.id === id)!;
		assert.deepStrictEqual({
			launched: launched.map(request => ({ agentId: request.agentId, stateKey: request.stateKey, prompt: request.prompt })),
			sent: reply('2').sent,
			sentAt: typeof reply('2').notes![0].sentAt,
			both: reply('3').error,
		}, {
			launched: [{
				agentId: 'claude',
				stateKey: 'repo',
				prompt: '差分レビューのメモです。それぞれの場所を確かめて、メモに沿って直してください。\n\n1. a.ts:2\n   対象の行: const a = 1;\n   メモ: use let',
			}],
			sent: [noteId],
			sentAt: 'number',
			both: 'invalid request',
		});
	});

	test('stages only reviewed files whose content is unchanged, and moves their marks to the staged identity', async () => {
		const status = ' M a.ts\n M b.ts\nUU c.ts\n';
		const git = new FakeGit(status, '1\t0\ta.ts\0' + '2\t0\tb.ts\0', '', { status: 'M  a.ts\n M b.ts\nUU c.ts\n', unstaged: '2\t0\tb.ts\0', staged: '1\t0\ta.ts\0' });
		const identities = new Map(paradisWithMobileLineCounts(paradisParseMobilePorcelainStatus(status), '1\t0\ta.ts\0' + '2\t0\tb.ts\0', '').map(file => [file.path, paradisMobileDiffIdentity(file)]));
		const sent: IReply[] = [];
		const host = createHost(createServices(), sent, git);
		dispatch(host, { t: 'reviewSet', id: '1', marks: [{ path: 'a.ts', identity: identities.get('a.ts') }] });
		const entries = [
			{ path: 'a.ts', identity: identities.get('a.ts') },
			{ path: 'b.ts', identity: '00ff' },
			{ path: 'c.ts', identity: identities.get('c.ts') },
			{ path: 'gone.ts', identity: '00aa' },
		];
		dispatch(host, { t: 'reviewStage', id: '2', entries });
		await flush();

		const staged = paradisMobileDiffIdentity({ x: 'M', y: ' ', path: 'a.ts', stagedAdded: 1, stagedRemoved: 0 });
		assert.deepStrictEqual({
			add: git.calls.filter(call => call.startsWith('add')),
			staged: sent[1].staged,
			skipped: sent[1].skipped,
			mark: sent[1].marks!['a.ts'].identity === staged,
		}, {
			add: ['add -- a.ts'],
			staged: ['a.ts'],
			skipped: [{ path: 'b.ts', reason: 'changed' }, { path: 'c.ts', reason: 'conflict' }, { path: 'gone.ts', reason: 'gone' }],
			mark: true,
		});
	});

	test('sends to an existing terminal only while the agent is in the foreground and waiting', () => {
		const ready = { isAgent: true, status: undefined, hasCommandDetection: true, executingCommand: 'claude', screenShowsPrompt: false } as const;
		assert.deepStrictEqual([
			paradisReviewNotesTargetVerdict(ready),
			paradisReviewNotesTargetVerdict({ ...ready, status: 'review' }),
			paradisReviewNotesTargetVerdict({ ...ready, status: 'working' }),
			paradisReviewNotesTargetVerdict({ ...ready, screenShowsPrompt: true }),
			paradisReviewNotesTargetVerdict({ ...ready, executingCommand: undefined }),
			paradisReviewNotesTargetVerdict({ ...ready, hasCommandDetection: false }),
			paradisReviewNotesTargetVerdict({ ...ready, isAgent: false }),
		], ['ready', 'ready', 'busy', 'busy', 'not-running', 'unknown-foreground', 'not-agent']);
	});
});
