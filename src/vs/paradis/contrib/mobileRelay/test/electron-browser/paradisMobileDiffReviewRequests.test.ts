/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { InMemoryStorageService, IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { paradisMobileDiffIdentity, paradisParseMobilePorcelainStatus, paradisWithMobileLineCounts } from '../../common/paradisMobileDiffReview.js';
import { PARADIS_MOBILE_REVIEW_STORAGE_KEY } from '../../common/paradisMobileReviewStore.js';
import { PARADIS_MOBILE_HOST_NO_RESPONSE_MESSAGE, PARADIS_MOBILE_STATUS_DEADLINE_MS } from '../../common/paradisMobileHostDeadline.js';
import { paradisReviewNotesTargetVerdict } from '../../electron-browser/paradisMobileAgentPromptDelivery.js';
// 差分レビューの処理を登録表へ載せる（副作用 import）
import '../../electron-browser/paradisMobileDiffReviewRequests.js';
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
	/** 失敗させるサブコマンド（まだコミットの無いリポジトリの `restore --staged` など）。 */
	readonly failing = new Set<string>();
	/** `add` の直前に呼ぶ（確かめてから足すまでの間の書き換えを再現する）。 */
	beforeAdd: (() => void) | undefined;
	/** `add` の後は接続先が返さない（どの git も終わらない）。 */
	hangAfterAdd = false;
	added = false;
	constructor(public status: string, public unstaged = '', public staged = '', private readonly afterAdd?: { status: string; unstaged: string; staged: string }) { }

	run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
		this.calls.push(args.join(' '));
		if (this.failing.has(args[0])) {
			return { code: 128, stdout: '', stderr: 'fatal: could not resolve HEAD' };
		}
		if (args[0] === 'add') {
			this.beforeAdd?.();
			this.added = true;
		}
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
			realpath: async (uri: URI) => uri,
			stat: async (uri: URI) => {
				const text = files[uri.path.slice('/repo/'.length)];
				if (text === undefined) {
					throw new Error('missing');
				}
				return { isDirectory: false, size: text.length, mtime: 1 };
			},
			readFile: async (uri: URI) => ({ value: VSBuffer.fromString(files[uri.path.slice('/repo/'.length)] ?? '') }),
		});
		return {
			// 使わないサービス（送り先を確かめる端末まわり）は空で埋める
			invokeFunction: fn => fn({ get: id => services.get(id) ?? {} } as ServicesAccessor),
			resolveRoot: ws => ws === 'repo' ? URI.file('/repo') : undefined,
			runGit: (_root, args) => git.hangAfterAdd && git.added ? new Promise<never>(() => { }) : Promise.resolve(git.run(args)),
			resolvePath: async (_ws, relativePath) => URI.file(`/repo/${relativePath}`),
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, _mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
		};
	}

	function createServices(): Map<unknown, unknown> {
		return new Map<unknown, unknown>([[IStorageService, store.add(new InMemoryStorageService())]]);
	}

	/** 処理の await（ファイルを読む・起動を待つ）が一巡するまで待つ（送信中の印が次のテストへ残らないように）。 */
	const flush = async () => {
		for (let turn = 0; turn < 5; turn++) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
	};
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
			{ t: 'review', ws: 'repo', revision: 2, marks: {}, notes: [], id: '2' },
			{ error: 'invalid marks', id: '3' },
			{ error: 'invalid marks', id: '4' },
			{ error: 'unknown workspace: elsewhere', id: '5' },
		]);
	});

	test('adds, edits and deletes notes, and clears sent and stale ones', async () => {
		const services = createServices();
		const sent: IReply[] = [];
		const files = { 'a.ts': 'one\ntwo\nthree', 'done.ts': 'kept' };
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

		// コミット済み（変更の一覧に無い）のファイルのメモは、行が残っていても片付ける
		dispatch(host, { t: 'reviewNoteAdd', id: '5b', path: 'done.ts', line: 1, lineText: 'kept', body: 'committed' });
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
			cleared: { removed: 2, left: [first.id] },
			deleted: [],
		});
		assert.notStrictEqual(second.id, first.id);
	});

	test('アプリが振った noteId なら、送り直しても 1 件のまま。同じ id で中身が違えば断る', async () => {
		const sent: IReply[] = [];
		const host = createHost(createServices(), sent, new FakeGit(' M a.ts\n'), { 'a.ts': 'one\ntwo' });
		const noteId = '0f8fad5b-d9cb-469f-a165-70867728950e';
		dispatch(host, { t: 'reviewNoteAdd', id: '1', path: 'a.ts', line: 2, lineText: 'two', body: 'rename', noteId });
		dispatch(host, { t: 'reviewNoteAdd', id: '2', path: 'a.ts', line: 2, lineText: 'two', body: 'rename', noteId });
		dispatch(host, { t: 'reviewNoteAdd', id: '3', path: 'a.ts', line: 2, lineText: 'two', body: 'other', noteId });
		dispatch(host, { t: 'reviewNoteAdd', id: '4', path: 'a.ts', line: 2, lineText: 'two', body: 'bad id', noteId: '../x' });
		await flush();

		assert.deepStrictEqual(sent.map(reply => ({ id: reply.id, notes: reply.notes?.map(note => note.id), revision: reply.revision, error: reply.error, code: reply.code })), [
			{ id: '1', notes: [noteId], revision: 1, error: undefined, code: undefined },
			{ id: '2', notes: [noteId], revision: 1, error: undefined, code: undefined },
			{ id: '3', notes: undefined, revision: undefined, error: '同じ id の別のメモが既にあります。メモの一覧を読み直してください。', code: 'note-id-conflict' },
			{ id: '4', notes: undefined, revision: undefined, error: 'invalid note', code: undefined },
		]);
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
		const status = ' M a.ts\n M b.ts\nUU c.ts\n M e.ts\n?? dir/\n';
		const git = new FakeGit(status, '1\t0\ta.ts\0' + '2\t0\tb.ts\0' + '1\t1\te.ts\0', '', { status: 'M  a.ts\n M b.ts\nUU c.ts\n M e.ts\n?? dir/\n', unstaged: '2\t0\tb.ts\0' + '1\t1\te.ts\0', staged: '1\t0\ta.ts\0' });
		const identities = new Map(paradisWithMobileLineCounts(paradisParseMobilePorcelainStatus(status), '1\t0\ta.ts\0' + '2\t0\tb.ts\0' + '1\t1\te.ts\0', '').map(file => [file.path, paradisMobileDiffIdentity(file)]));
		const sent: IReply[] = [];
		const host = createHost(createServices(), sent, git);
		// e.ts は確認済みにしていない（スマホが送ってきても足さない）
		dispatch(host, { t: 'reviewSet', id: '1', marks: ['a.ts', 'c.ts', 'dir/'].map(path => ({ path, identity: identities.get(path) })) });
		const entries = ['a.ts', 'b.ts', 'c.ts', 'e.ts', 'dir/', 'gone.ts'].map(path => ({ path, identity: path === 'b.ts' ? '00ff' : identities.get(path) ?? '00aa' }));
		dispatch(host, { t: 'reviewStage', id: '2', entries });
		await flush();

		const staged = paradisMobileDiffIdentity({ x: 'M', y: ' ', path: 'a.ts', stagedAdded: 1, stagedRemoved: 0 });
		assert.deepStrictEqual({
			add: git.calls.filter(call => call.startsWith('add')),
			staged: sent[1].staged,
			skipped: sent[1].skipped,
			mark: sent[1].marks!['a.ts'].identity === staged,
		}, {
			add: ['add -- :(literal)a.ts'],
			staged: ['a.ts'],
			skipped: [
				{ path: 'b.ts', reason: 'changed' },
				{ path: 'c.ts', reason: 'conflict' },
				{ path: 'e.ts', reason: 'not-reviewed' },
				{ path: 'dir/', reason: 'unsupported' },
				{ path: 'gone.ts', reason: 'gone' },
			],
			mark: true,
		});
	});

	test('stages a reviewed new file and keeps it reviewed by re-checking its size and time after git add', async () => {
		const status = '?? n.ts\n?? big.ts\n';
		const git = new FakeGit(status, '', '', { status: 'A  n.ts\n?? big.ts\n', unstaged: '', staged: '2\t0\tn.ts\0' });
		const files = { 'n.ts': 'a\nb' };
		const sent: IReply[] = [];
		const host = createHost(createServices(), sent, git, files);
		// big.ts は大きさを調べられなかった（上限より後ろ・読めない）新しいファイルの代わり
		const reviewed = paradisMobileDiffIdentity({ x: '?', y: '?', path: 'n.ts', size: files['n.ts'].length, mtime: 1 });
		const noSize = paradisMobileDiffIdentity({ x: '?', y: '?', path: 'big.ts' });
		dispatch(host, { t: 'reviewSet', id: '1', marks: [{ path: 'n.ts', identity: reviewed }, { path: 'big.ts', identity: noSize }] });
		dispatch(host, { t: 'reviewStage', id: '2', entries: [{ path: 'n.ts', identity: reviewed }, { path: 'big.ts', identity: noSize }] });
		await flush();

		const reply = sent.find(candidate => candidate.id === '2')!;
		assert.deepStrictEqual({
			add: git.calls.filter(call => call.startsWith('add')),
			skipped: reply.skipped,
			remapped: reply.marks!['n.ts'].identity === paradisMobileDiffIdentity({ x: 'A', y: ' ', path: 'n.ts', stagedAdded: 2, stagedRemoved: 0 }),
			revisions: [sent[0].revision, reply.revision],
		}, {
			add: ['add -- :(literal)n.ts'],
			skipped: [{ path: 'big.ts', reason: 'unsupported' }],
			remapped: true,
			revisions: [1, 2],
		});
	});

	test('puts back a reviewed file whose content was rewritten between the check and git add, and keeps its mark', async () => {
		const status = ' M a.ts\n';
		// 確かめたときは 1 行足しただけ。足したときには 3 行足されていた
		const git = new FakeGit(status, '1\t0\ta.ts\0', '', { status: 'M  a.ts\n', unstaged: '', staged: '3\t0\ta.ts\0' });
		const reviewed = paradisMobileDiffIdentity(paradisWithMobileLineCounts(paradisParseMobilePorcelainStatus(status), '1\t0\ta.ts\0', '')[0]);
		const sent: IReply[] = [];
		const host = createHost(createServices(), sent, git);
		dispatch(host, { t: 'reviewSet', id: '1', marks: [{ path: 'a.ts', identity: reviewed }] });
		dispatch(host, { t: 'reviewStage', id: '2', entries: [{ path: 'a.ts', identity: reviewed }] });
		await flush();

		const reply = sent.find(candidate => candidate.id === '2')!;
		assert.deepStrictEqual({
			git: git.calls.filter(call => call.startsWith('add') || call.startsWith('restore')),
			staged: reply.staged,
			skipped: reply.skipped,
			mark: reply.marks!['a.ts'].identity === reviewed,
		}, {
			git: ['add -- :(literal)a.ts', 'restore --staged -- :(literal)a.ts'],
			staged: [],
			skipped: [{ path: 'a.ts', reason: 'changed' }],
			mark: true,
		});
	});

	test('tells that it staged but could not verify when the host stops answering after git add, and keeps the mark', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const status = ' M a.ts\n';
		const git = new FakeGit(status, '1\t0\ta.ts\0', '', { status: 'M  a.ts\n', unstaged: '', staged: '1\t0\ta.ts\0' });
		git.hangAfterAdd = true;
		const reviewed = paradisMobileDiffIdentity(paradisWithMobileLineCounts(paradisParseMobilePorcelainStatus(status), '1\t0\ta.ts\0', '')[0]);
		const services = createServices();
		const sent: IReply[] = [];
		const host = createHost(services, sent, git);
		dispatch(host, { t: 'reviewSet', id: '1', marks: [{ path: 'a.ts', identity: reviewed }] });
		dispatch(host, { t: 'reviewStage', id: '2', entries: [{ path: 'a.ts', identity: reviewed }] });
		await timeout(PARADIS_MOBILE_STATUS_DEADLINE_MS + 1);

		const reply = sent.find(candidate => candidate.id === '2');
		const stored = JSON.parse((services.get(IStorageService) as IStorageService).get(PARADIS_MOBILE_REVIEW_STORAGE_KEY, StorageScope.WORKSPACE)!).repo.marks['a.ts'].identity;
		assert.deepStrictEqual({ git: git.calls.filter(call => call.startsWith('add') || call.startsWith('restore')), code: reply?.code, staged: reply?.staged, markKept: stored === reviewed }, {
			git: ['add -- :(literal)a.ts'],
			code: 'staged-unverified',
			staged: undefined,
			markKept: true,
		});
	}));

	test('fails as "the host does not respond" before staging anything when the first read does not answer', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const git = new FakeGit(' M a.ts\n');
		git.hangAfterAdd = true;
		git.added = true;
		const sent: IReply[] = [];
		const host = createHost(createServices(), sent, git);
		dispatch(host, { t: 'reviewStage', id: '2', entries: [{ path: 'a.ts', identity: '00aa' }] });
		await timeout(PARADIS_MOBILE_STATUS_DEADLINE_MS + 1);

		assert.deepStrictEqual({ reply: sent.find(candidate => candidate.id === '2'), add: git.calls.filter(call => call.startsWith('add')) }, {
			reply: { error: PARADIS_MOBILE_HOST_NO_RESPONSE_MESSAGE, id: '2' },
			add: [],
		});
	}));

	test('does not report a rewritten new file as staged when it cannot be put back (no commit yet)', async () => {
		const status = '?? n.ts\n';
		const git = new FakeGit(status, '', '', { status: 'A  n.ts\n', unstaged: '', staged: '3\t0\tn.ts\0' });
		git.failing.add('restore');
		// 確かめたときは 3 文字。足したときには書き換えられて 5 文字になっていた
		const files: Record<string, string> = { 'n.ts': 'a\nb' };
		const sent: IReply[] = [];
		const host = createHost(createServices(), sent, git, files);
		const reviewed = paradisMobileDiffIdentity({ x: '?', y: '?', path: 'n.ts', size: 3, mtime: 1 });
		dispatch(host, { t: 'reviewSet', id: '1', marks: [{ path: 'n.ts', identity: reviewed }] });
		git.beforeAdd = () => {
			files['n.ts'] = 'a\nb\nc';
		};
		dispatch(host, { t: 'reviewStage', id: '2', entries: [{ path: 'n.ts', identity: reviewed }] });
		await flush();

		const reply = sent.find(candidate => candidate.id === '2')!;
		assert.deepStrictEqual({ git: git.calls.filter(call => call.startsWith('add') || call.startsWith('restore')), code: reply.code, staged: reply.staged }, {
			git: ['add -- :(literal)n.ts', 'restore --staged -- :(literal)n.ts'],
			code: 'restore-failed',
			staged: undefined,
		});
	});

	test('sends to an existing terminal only while the agent is in the foreground and waiting', () => {
		const ready = { isAgent: true, status: undefined, parked: false, canPasteMultiline: true, screenShowsPrompt: false } as const;
		assert.deepStrictEqual([
			paradisReviewNotesTargetVerdict(ready),
			paradisReviewNotesTargetVerdict({ ...ready, status: 'review' }),
			paradisReviewNotesTargetVerdict({ ...ready, status: 'working' }),
			paradisReviewNotesTargetVerdict({ ...ready, screenShowsPrompt: true }),
			// エージェントを抜けた後のシェル・ssh・python など（前面が claude / codex と確かめられない）
			paradisReviewNotesTargetVerdict({ ...ready, canPasteMultiline: false }),
			paradisReviewNotesTargetVerdict({ ...ready, parked: true }),
			paradisReviewNotesTargetVerdict({ ...ready, isAgent: false }),
		], ['ready', 'ready', 'busy', 'busy', 'not-running', 'parked', 'not-agent']);
	});

	test('strips terminal control characters from the request, refuses a second send in flight, and does not mark notes edited meanwhile as sent', async () => {
		const services = createServices();
		const sent: IReply[] = [];
		const hostRef: { current?: IParadisMobileRequestHost } = {};
		const launched: string[] = [];
		services.set(IInstantiationService, {
			invokeFunction: async (_fn: unknown, request: { prompt: string }) => {
				launched.push(request.prompt);
				// 起動を待つ間に、別の端末がメモを書き直す
				dispatch(hostRef.current!, { t: 'reviewNoteEdit', id: 'edit', noteId: sent[1].notes![0].id, body: 'edited while sending' });
			},
		});
		const host = hostRef.current = createHost(services, sent, new FakeGit(' M a.ts\n'), { 'a.ts': 'x\n' });
		dispatch(host, { t: 'reviewNoteAdd', id: '1', path: 'a.ts', line: 1, lineText: 'x\u001b[201~rm -rf ~\u001b[200~', body: 'first\u0003' });
		dispatch(host, { t: 'reviewNoteAdd', id: '2', path: 'a.ts', line: 1, lineText: 'x', body: 'second' });
		const ids = sent[1].notes!.map(note => note.id);
		dispatch(host, { t: 'reviewNotesSend', id: 'send', ids, target: { agent: 'claude' } });
		dispatch(host, { t: 'reviewNotesSend', id: 'again', ids, target: { agent: 'claude' } });
		await flush();

		const reply = (id: string) => sent.find(candidate => candidate.id === id)!;
		assert.deepStrictEqual({
			controlCharacters: launched.some(prompt => /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(prompt)),
			again: reply('again').code,
			sentAt: reply('send').notes!.map(note => note.sentAt !== undefined),
		}, { controlCharacters: false, again: 'sending', sentAt: [false, true] });
	});
});
