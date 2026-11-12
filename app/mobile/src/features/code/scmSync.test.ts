// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { agentHandoffResult, branchSyncOf, commitFailureView, commitLandedAfter, commitHint, confirmCommitLanded, commitScope, parseCommitFailure, scmPrimaryAction, scmPushConfirm, scmSyncSummary, type ScmPrimaryInput } from './scmSync.js';

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
		expect(commitHint('staged', counts, true)).toBe('ステージ済みの 1 件の、ステージした分だけをコミットします（一部だけステージしたファイルの残りは入れません）。');
		// 一部だけステージしたファイル（MM）しか無くても、ステージ済みだけのコミットにする（git add -A で残りまで入れない）
		expect(commitScope({ unstaged: 1, staged: 1, total: 1 }, true)).toBe('staged');
		expect(commitHint('all', counts, false)).toContain('ステージの操作は PC で行います');
	});
});

describe('scmPushConfirm', () => {
	it('プッシュと公開の確かめに、ブランチ・件数・送り先を出す', () => {
		expect([
			scmPushConfirm({ upstream: 'origin/feat', ahead: 2, behind: 0 }, 'feat'),
			scmPushConfirm({}, 'feat'),
			scmPushConfirm({ upstream: 'origin/feat' }, undefined),
		]).toEqual([
			{ title: 'プッシュしますか？', message: '「feat」のコミット 2 件を origin/feat へプッシュします。強制プッシュはしません。', confirmLabel: 'プッシュ' },
			{ title: 'ブランチを公開しますか？', message: '「feat」をリモートに公開し、上流に設定します。', confirmLabel: '公開' },
			{ title: 'プッシュしますか？', message: 'このブランチを origin/feat へプッシュします。強制プッシュはしません。', confirmLabel: 'プッシュ' },
		]);
	});
});

describe('commit failure', () => {
	it('PC の失敗を読み、直してもらえるものにだけボタンを出す', () => {
		const failure = parseCommitFailure({ id: 'f1', kind: 'lint', summary: 'lint で失敗', output: 'a.ts:1 error', restored: true });
		expect(failure).toEqual({ id: 'f1', kind: 'lint', summary: 'lint で失敗', output: 'a.ts:1 error', restored: true });
		expect(commitFailureView(failure!)).toEqual({ title: 'lint で失敗', output: 'a.ts:1 error', fixable: true, note: 'ステージの状態はコミットの前に戻しました。' });
		expect(commitFailureView({ ...failure!, kind: 'identity', restored: false })).toMatchObject({ fixable: false, note: undefined });
		expect(commitFailureView(parseCommitFailure({ id: 'f2', kind: 'hook', summary: 's', output: '', restored: false, restoreFailed: true })!).note).toBe('ステージを戻せませんでした。PC で確かめてください。');
		// フックの間に PC でステージが変わったので戻さなかった（古いアプリは restoreFailed だけを読む）
		expect(commitFailureView(parseCommitFailure({ id: 'f3', kind: 'hook', summary: 's', output: '', restored: false, restoreFailed: true, indexChanged: true })!).note)
			.toBe('コミットの途中で PC のステージが変わったため、ステージは戻していません。PC で確かめてください。');
		expect(parseCommitFailure({ id: 1 })).toBeUndefined();
		expect(parseCommitFailure({ id: 'x', kind: 'future', summary: 's', output: '' })?.kind).toBe('other');
	});

	it('結果が分からなかったコミットは、前の先頭より上に同じ件名があるときだけできたとみなす', () => {
		const log = [
			{ hash: 'c3', subject: 'fix: typo in readme' },
			{ hash: 'c2', subject: 'other work on PC' },
			{ hash: 'c1', subject: 'fix: typo in readme' },
		];
		expect([
			commitLandedAfter(log, 'c2', 'fix: typo in readme'),
			// 本文付きのメッセージは最初の段落（件名）で比べる
			commitLandedAfter(log, 'c2', '  fix: typo in readme\n\nlonger body\n'),
			// 前の先頭のまま（何も増えていない）
			commitLandedAfter(log, 'c3', 'fix: typo in readme'),
			// 同じ件名は前の先頭より下にしかない（前のコミットと取り違えない）
			commitLandedAfter(log, 'c2', 'other work on PC'),
			// 前の先頭が分からない・一覧に見つからない
			commitLandedAfter(log, undefined, 'fix: typo in readme'),
			commitLandedAfter(log, 'gone', 'fix: typo in readme'),
		]).toEqual([true, true, false, false, false, false]);
	});

	it('結果が分からないコミットは、つながり直すまで待ち、期限まで間隔を空けて読み直す', async () => {
		const before = [{ hash: 'c1', subject: 'base' }];
		const landed = [{ hash: 'c2', subject: 'fix: typo' }, ...before];
		// 時計と一覧を進める偽物。`live` は呼ばれるたびの接続の状態、`logs` は読むたびの一覧（null は読めない）
		const run = async (live: readonly boolean[], logs: readonly (readonly { hash: string; subject: string }[] | null)[], deadline: number, cancelAt?: number) => {
			let now = 0;
			let reads = 0;
			const events: string[] = [];
			const result = await confirmCommitLanded('c1', 'fix: typo', deadline, {
				waitUntilLive: async () => {
					const ok = live[Math.min(events.filter(event => event.startsWith('wait')).length, live.length - 1)] ?? false;
					events.push(`wait@${now}:${ok}`);
					return ok;
				},
				readLog: async () => {
					const log = logs[Math.min(reads++, logs.length - 1)] ?? null;
					events.push(`read@${now}`);
					if (log === null) {
						throw new Error('unreachable');
					}
					return log;
				},
				sleep: async ms => { now += ms; },
				now: () => now,
				cancelled: () => cancelAt !== undefined && reads >= cancelAt,
			});
			return { result, events };
		};
		expect([
			// つながり直した後、PC がまだコミット中で 2 回目に見つかる
			await run([true], [before, landed], 300_000),
			// 読めなかった 1 回目の後に読み直す
			await run([true], [null, landed], 300_000),
			// 期限までにつながり直さない
			await run([false], [landed], 300_000),
			// 期限を過ぎていても 1 回は読み、次は読まない
			await run([true], [before, landed], 0),
			// 次のコミットが始まったら、読めた結果を捨てる
			await run([true], [landed], 300_000, 1),
		]).toEqual([
			{ result: true, events: ['wait@0:true', 'read@0', 'wait@5000:true', 'read@5000'] },
			{ result: true, events: ['wait@0:true', 'read@0', 'wait@5000:true', 'read@5000'] },
			{ result: false, events: ['wait@0:false'] },
			{ result: false, events: ['wait@0:true', 'read@0'] },
			{ result: false, events: ['wait@0:true', 'read@0'] },
		]);
		// 見つからなければ間隔を空けて期限まで読み直す（5・10・20・30 秒、以降 30 秒ごと）
		const never = await run([true], [before], 100_000);
		expect([never.result, never.events.filter(event => event.startsWith('read'))]).toEqual([false, ['read@0', 'read@5000', 'read@15000', 'read@35000', 'read@65000', 'read@95000']]);
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
