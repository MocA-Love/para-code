// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { agentHandoffResult, branchSyncOf, commitFailureView, commitHint, commitScope, parseCommitFailure, scmPrimaryAction, scmSyncSummary, type ScmPrimaryInput } from './scmSync.js';

describe('scmPrimaryAction', () => {
	const clean: ScmPrimaryInput = { live: true, total: 0, message: '', committing: false, sync: { upstream: 'origin/main', ahead: 0, behind: 0 }, syncing: undefined, branch: 'main' };

	it('変更があればコミット、無ければ 取り込み → プッシュ → 公開 の順に選ぶ', () => {
		expect([
			scmPrimaryAction({ ...clean, total: 2, message: 'x' }),
			scmPrimaryAction({ ...clean, sync: { upstream: 'origin/main', ahead: 0, behind: 3 } }),
			scmPrimaryAction({ ...clean, sync: { upstream: 'origin/main', ahead: 2, behind: 0 } }),
			scmPrimaryAction({ ...clean, sync: {} }),
			scmPrimaryAction(clean),
		].map(action => [action.kind, action.label, action.disabled])).toEqual([
			['commit', 'コミット', false],
			['pull', '取り込む（3）', false],
			['push', 'プッシュ（2）', false],
			['publish', 'ブランチを公開', false],
			['commit', 'コミット', true],
		]);
	});

	it('履歴が分かれているときは押せず、PC での解決を案内する（強制 push は出さない）', () => {
		const action = scmPrimaryAction({ ...clean, sync: { upstream: 'origin/main', ahead: 1, behind: 1 } });
		expect(action).toMatchObject({ disabled: true, reason: '手元とリモートの履歴が分かれています。PC で解決してください' });
		expect(action.label).not.toMatch(/force|強制/i);
	});

	it('同期を扱えない PC ではコミットだけ、同期の最中は押せない', () => {
		expect(scmPrimaryAction({ ...clean, sync: undefined })).toMatchObject({ kind: 'commit', disabled: true });
		expect(scmPrimaryAction({ ...clean, syncing: 'push' })).toMatchObject({ kind: 'push', label: 'プッシュ中…', disabled: true, busy: true });
		expect(scmPrimaryAction({ ...clean, sync: {}, branch: 'HEAD' }).kind).toBe('commit');
	});
});

describe('scmSyncSummary / branchSyncOf', () => {
	it('上流・先行・遅れを一行にし、出せる操作を並べる', () => {
		expect([
			scmSyncSummary({ upstream: 'origin/main', ahead: 2, behind: 0 }),
			scmSyncSummary({ upstream: 'origin/main', ahead: 1, behind: 4 }),
			scmSyncSummary({ upstream: 'origin/main', ahead: 0, behind: 0 }),
			scmSyncSummary({ upstream: 'origin/gone' }),
			scmSyncSummary({}),
			scmSyncSummary(undefined),
		]).toEqual([
			{ text: 'origin/main ↑2', diverged: false, actions: ['fetch', 'push'] },
			{ text: 'origin/main ↑1 ↓4', diverged: true, actions: ['fetch'] },
			{ text: 'origin/main と同じ', diverged: false, actions: ['fetch'] },
			{ text: 'origin/gone（リモートのブランチがありません）', diverged: false, actions: ['fetch'] },
			{ text: 'まだ公開していません', diverged: false, actions: ['fetch'] },
			undefined,
		]);
	});

	it('status の応答から任意項目だけを読む（古い PC は何も送らない）', () => {
		expect(branchSyncOf({ branch: 'main', files: [], upstream: 'origin/main', ahead: 1, behind: 0 })).toEqual({ upstream: 'origin/main', ahead: 1, behind: 0 });
		expect(branchSyncOf({ branch: 'main', files: [] })).toEqual({});
	});
});

describe('commitScope / commitHint', () => {
	const counts = { unstaged: 2, staged: 1, total: 3 };

	it('ファイルごとにステージできる PC で、ステージ済みがあればそれだけをコミットする', () => {
		expect([commitScope(counts, true), commitScope({ ...counts, staged: 0 }, true), commitScope(counts, false)]).toEqual(['staged', 'all', 'all']);
		expect(commitHint('staged', counts, true)).toBe('ステージ済みの 1 件だけをコミットします。');
		expect(commitHint('all', counts, false)).toContain('ステージの操作は PC で行います');
	});
});

describe('commit failure', () => {
	it('PC の失敗を読み、直してもらえるものにだけボタンを出す', () => {
		const failure = parseCommitFailure({ id: 'f1', kind: 'lint', summary: 'lint で失敗', output: 'a.ts:1 error', restored: true });
		expect(failure).toEqual({ id: 'f1', kind: 'lint', summary: 'lint で失敗', output: 'a.ts:1 error', restored: true });
		expect(commitFailureView(failure!)).toEqual({ title: 'lint で失敗', output: 'a.ts:1 error', fixable: true, note: 'ステージの状態はコミットの前に戻しました。' });
		expect(commitFailureView({ ...failure!, kind: 'identity', restored: false })).toMatchObject({ fixable: false, note: undefined });
		expect(parseCommitFailure({ id: 1 })).toBeUndefined();
		expect(parseCommitFailure({ id: 'x', kind: 'future', summary: 's', output: '' })?.kind).toBe('other');
	});

	it('エージェントへ頼んだ結果の一言（作業中なら新しいエージェントで頼む口を出す）', () => {
		expect([
			agentHandoffResult({ delivered: true, via: 'terminal', title: 'claude' }),
			agentHandoffResult({ delivered: true, via: 'launch' }),
			agentHandoffResult({ delivered: false, code: 'busy', message: '作業中です' }),
		]).toEqual([
			{ delivered: true, text: '「claude」に頼みました' },
			{ delivered: true, text: '新しいエージェントを起動して頼みました' },
			{ delivered: false, text: '作業中です', busy: true },
		]);
	});
});
