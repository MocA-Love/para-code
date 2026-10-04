// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { codeSpaceGate, rendererTargetOf, type SpaceLinkInput } from './spaceLink.js';
import { SCM_NO_RESPONSE_MESSAGE, commitAction, groupScmEntries, listBodyState, orderedScmEntries, scmCounts, scmEntries, scmEntry, scmErrorText, shouldAutoRetryScmStatus, splitPath } from './scmModel.js';

describe('scmEntry', () => {
	it('未追跡・ステージ済み・変更に振り分ける', () => {
		expect(scmEntry({ x: '?', y: '?', path: 'a.ts' })).toMatchObject({ group: 'untracked', staged: false, kind: 'untracked' });
		expect(scmEntry({ x: 'M', y: ' ', path: 'a.ts' })).toMatchObject({ group: 'staged', staged: true, kind: 'modified' });
		expect(scmEntry({ x: 'A', y: ' ', path: 'a.ts' })).toMatchObject({ group: 'staged', staged: true, kind: 'added' });
		expect(scmEntry({ x: ' ', y: 'M', path: 'a.ts' })).toMatchObject({ group: 'changes', staged: false, kind: 'modified' });
		expect(scmEntry({ x: ' ', y: 'D', path: 'a.ts' })).toMatchObject({ group: 'changes', staged: false, kind: 'deleted' });
	});

	it('両側に変化があるものは「変更」に1回だけ出し、作業ツリー側の差分を見る', () => {
		expect(scmEntry({ x: 'M', y: 'M', path: 'a.ts' })).toMatchObject({ group: 'changes', staged: false });
	});

	it('競合はステージ済みに入れない', () => {
		expect(scmEntry({ x: 'U', y: 'U', path: 'a.ts' })).toMatchObject({ group: 'changes', kind: 'conflict' });
		expect(scmEntry({ x: 'A', y: 'A', path: 'a.ts' })).toMatchObject({ group: 'changes', kind: 'conflict' });
	});
});

describe('groupScmEntries / orderedScmEntries', () => {
	const entries = scmEntries({
		branch: 'main',
		files: [
			{ x: 'M', y: ' ', path: 'staged.ts' },
			{ x: '?', y: '?', path: 'new.ts' },
			{ x: ' ', y: 'M', path: 'changed.ts' },
		],
	});

	it('変更 → 未追跡 → ステージ済みの順に並べ、空の区分は出さない', () => {
		expect(groupScmEntries(entries).map(section => [section.title, section.entries.map(entry => entry.path)])).toEqual([
			['変更', ['changed.ts']],
			['未追跡のファイル', ['new.ts']],
			['ステージ済みの変更', ['staged.ts']],
		]);
		expect(groupScmEntries(entries.filter(entry => entry.group === 'staged')).map(section => section.group)).toEqual(['staged']);
	});

	it('画面と同じ順の一覧を返す', () => {
		expect(orderedScmEntries(entries).map(entry => entry.path)).toEqual(['changed.ts', 'new.ts', 'staged.ts']);
	});

	it('件数を数える（未追跡はステージされていない側）', () => {
		expect(scmCounts(entries)).toEqual({ unstaged: 2, staged: 1, total: 3 });
		expect(scmCounts([])).toEqual({ unstaged: 0, staged: 0, total: 0 });
	});

	it('一部だけステージしたファイル（MM）は、変更にもステージ済みにも数える', () => {
		const partial = scmEntries({ branch: 'main', files: [{ x: 'M', y: 'M', path: 'a.ts' }, { x: ' ', y: 'M', path: 'b.ts' }] });
		expect(partial.map(entry => entry.partiallyStaged)).toEqual([true, false]);
		expect(scmCounts(partial)).toEqual({ unstaged: 2, staged: 1, total: 2 });
	});
});

describe('splitPath', () => {
	it('ファイル名とフォルダに分ける', () => {
		expect(splitPath('src/auth/session.ts')).toEqual({ name: 'session.ts', dir: 'src/auth' });
		expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' });
	});
});

describe('commitAction', () => {
	const base = { live: true, total: 3, message: '直した', committing: false };

	it('変更とメッセージがあれば押せる', () => {
		expect(commitAction(base)).toEqual({ label: 'コミット', disabled: false, reason: undefined, showInput: true, busy: false });
	});

	it('押せない理由は 接続 → 変更の有無 → メッセージ の順で決める', () => {
		expect(commitAction({ ...base, live: false, message: '' }).reason).toBe('PC に接続すると使えます');
		expect(commitAction({ ...base, total: undefined }).reason).toBe('変更を読み込んでいます');
		expect(commitAction({ ...base, total: 0 }).reason).toBe('コミットする変更はありません');
		expect(commitAction({ ...base, message: '   ' }).reason).toBe('コミットメッセージを入れてください');
	});

	it('変更が無いときは入力欄を出さない（読み込み前は出しておく）', () => {
		expect(commitAction({ ...base, total: 0 }).showInput).toBe(false);
		expect(commitAction({ ...base, total: undefined }).showInput).toBe(true);
		expect(commitAction({ ...base, live: false, total: 0 }).showInput).toBe(false);
	});

	it('コミット中は押せず、文言が変わる', () => {
		expect(commitAction({ ...base, committing: true })).toMatchObject({ label: 'コミット中…', disabled: true, busy: true });
	});
});

describe('listBodyState', () => {
	it('読み込めた一覧は、接続が切れても失敗しても出し続ける', () => {
		expect(listBodyState({ data: [1], error: '失敗', unavailable: '切断' })).toEqual({ kind: 'ready' });
		expect(listBodyState({ data: [], error: undefined, unavailable: '切断' })).toEqual({ kind: 'empty' });
	});

	it('まだ読めていなければ 失敗 → 切断 → 読み込み中 の順', () => {
		expect(listBodyState({ data: undefined, error: '失敗', unavailable: '切断' })).toEqual({ kind: 'error', title: '読み込めませんでした', message: '失敗', retryLabel: '再読み込み' });
		expect(listBodyState({ data: undefined, error: undefined, unavailable: '切断' })).toEqual({ kind: 'offline', reason: '切断' });
		expect(listBodyState({ data: undefined, error: undefined, unavailable: undefined })).toEqual({ kind: 'loading' });
	});

	it('返事が無かった失敗は「接続先が応答していません」と再試行にする', () => {
		const titles = ['request timeout', '接続先が応答しません。しばらくしてから読み直してください。', SCM_NO_RESPONSE_MESSAGE].map(error => {
			const state = listBodyState({ data: undefined, error, unavailable: undefined });
			return state.kind === 'error' ? [state.title, state.retryLabel] : state.kind;
		});
		expect(titles).toEqual(Array(3).fill([SCM_NO_RESPONSE_MESSAGE, '再試行']));
	});
});

describe('scmErrorText / shouldAutoRetryScmStatus', () => {
	it('返事が無かった失敗をそろえ、ほかの失敗はそのまま出す。自分で取り直すのは返事が無かったときに 1 回だけ', () => {
		expect([
			scmErrorText(new Error('request timeout')),
			scmErrorText(new Error('接続先が応答しません。しばらくしてから読み直してください。')),
			scmErrorText(new Error('unknown workspace: w')),
			shouldAutoRetryScmStatus(0, 'request timeout'),
			shouldAutoRetryScmStatus(0, '接続先が応答しません。しばらくしてから読み直してください。'),
			shouldAutoRetryScmStatus(1, 'request timeout'),
			shouldAutoRetryScmStatus(0, 'unknown workspace: w'),
		]).toEqual([SCM_NO_RESPONSE_MESSAGE, SCM_NO_RESPONSE_MESSAGE, 'unknown workspace: w', true, true, false, false]);
	});
});

describe('rendererTargetOf', () => {
	const state: SpaceLinkInput = {
		connection: 'online',
		pcOnline: true,
		sessionProtocolReady: true,
		workspace: {
			protocolVersion: 4,
			desktopEpoch: 'e1',
			revision: 1,
			complete: true,
			renderers: [{ windowId: 7, rendererGeneration: 2, ready: true }],
			activeWs: undefined,
			workspaces: [{ id: '1:w1', sourceId: 'w1', windowId: 7, name: 'space' }],
			terminals: [],
		},
	};

	it('接続していてウィンドウが準備できていれば識別子を返す', () => {
		expect(rendererTargetOf(state, '1:w1')).toBe('e1:7:2');
	});

	it('要求を出せないときは undefined', () => {
		expect(rendererTargetOf(state, undefined)).toBeUndefined();
		expect(rendererTargetOf(state, '1:missing')).toBeUndefined();
		expect(rendererTargetOf({ ...state, pcOnline: false }, '1:w1')).toBeUndefined();
		expect(rendererTargetOf({ ...state, connection: 'connecting' }, '1:w1')).toBeUndefined();
		const workspace = state.workspace;
		if (workspace === undefined) {
			throw new Error('fixture');
		}
		expect(rendererTargetOf({ ...state, workspace: { ...workspace, renderers: [{ windowId: 7, rendererGeneration: 2, ready: false }] } }, '1:w1')).toBeUndefined();
	});
});

describe('codeSpaceGate', () => {
	it('台帳に無い PC は unknownPc', () => {
		expect(codeSpaceGate('unknown', 'ready', true)).toBe('unknownPc');
	});

	it('一度表示できた画面は、スペースが消えても ready のまま', () => {
		expect(codeSpaceGate('active', 'loading', true)).toBe('ready');
		expect(codeSpaceGate('inactive', 'missing', true)).toBe('ready');
	});

	it('切り替え中は loading、切り替え後はスペースの状態に従う', () => {
		expect(codeSpaceGate('inactive', 'ready', false)).toBe('loading');
		expect(codeSpaceGate('active', 'missing', false)).toBe('missing');
		expect(codeSpaceGate('active', 'ready', false)).toBe('ready');
	});
});
