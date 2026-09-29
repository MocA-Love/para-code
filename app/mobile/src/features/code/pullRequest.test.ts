// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { canFixChecks, checkSummaryText, mergeConfirmMessage, orderedChecks, parsePrMergeReply, parsePrView, prMergeButton, prMergeToastText, prUnavailableText, type PrDetail } from './pullRequest.js';

const HEAD = 'f'.repeat(40);

function pr(overrides: Partial<PrDetail> = {}): PrDetail {
	return { number: 4, title: 'Add sync', url: 'https://github.com/o/r/pull/4', state: 'open', repo: 'o/r', headRefName: 'feat', headSha: HEAD, baseRefName: 'main', checks: [], ...overrides };
}

describe('parsePrView', () => {
	it('PC の PR を読み、形の違うチェックは飛ばす', () => {
		expect(parsePrView({ pr: { ...pr(), checks: [{ name: 'build', bucket: 'fail', url: 'https://github.com/x' }, { name: 'bad', bucket: 'weird' }, { bucket: 'pass' }] } })).toEqual({
			kind: 'pr',
			pr: { ...pr(), checks: [{ name: 'build', bucket: 'fail', url: 'https://github.com/x' }] },
		});
	});

	it('切る前の全件の数と「全件か分からない」を読み、それでマージを止める', () => {
		const view = parsePrView({ pr: { ...pr(), checks: [{ name: 'a', bucket: 'pass' }], checkCounts: { pass: 150, fail: 1, pending: 0, skipping: 0, cancel: 0 }, checksIncomplete: true } });
		expect(view.kind === 'pr' ? [view.pr.checkCounts?.fail, view.pr.checksIncomplete, prMergeButton(view.pr).reason, checkSummaryText(view.pr.checks, view.pr.checkCounts)] : undefined)
			.toEqual([1, true, '失敗した CI のチェックがあります。PC でマージしてください。', '失敗 1・成功 150']);
		expect(prMergeButton(pr({ checks: [{ name: 'a', bucket: 'pass' }], checksIncomplete: true })).reason).toContain('すべてを確かめられません');
	});

	it('出せない理由を読み、知らない理由と壊れた PR は「取得できなかった」にする', () => {
		expect(parsePrView({ unavailable: 'no-auth' })).toEqual({ kind: 'unavailable', reason: 'no-auth', message: undefined });
		expect(parsePrView({ unavailable: 'future', message: 'x' })).toEqual({ kind: 'unavailable', reason: 'error', message: 'x' });
		expect(parsePrView({ pr: { number: 1, url: 'javascript:alert(1)' } }).kind).toBe('unavailable');
		expect(prUnavailableText('no-auth', undefined).body).toContain('gh auth login');
	});
});

describe('checks', () => {
	const checks = [
		{ name: 'lint', bucket: 'pass' as const },
		{ name: 'e2e', bucket: 'pending' as const },
		{ name: 'unit', bucket: 'fail' as const },
		{ name: 'docs', bucket: 'skipping' as const },
	];

	it('失敗を先に並べ、数を一行にする', () => {
		expect(orderedChecks(checks).map(check => check.name)).toEqual(['unit', 'e2e', 'lint', 'docs']);
		expect(checkSummaryText(checks)).toBe('失敗 1・実行中 1・成功 1・スキップ 1');
		expect(checkSummaryText([])).toBeUndefined();
	});

	it('失敗したチェックがある開いた PR だけ「直してもらう」を出す', () => {
		expect([canFixChecks(pr({ checks })), canFixChecks(pr({ checks: [checks[0]!] })), canFixChecks(pr({ checks, state: 'merged' }))]).toEqual([true, false, false]);
	});
});

describe('prMergeButton', () => {
	it('CI が失敗・実行中なら押せず「PC でマージしてください」を出し、閉じた PR には出さない', () => {
		expect(prMergeButton(pr({ checks: [{ name: 'a', bucket: 'pass' }] }))).toEqual({ visible: true, reason: undefined });
		expect(prMergeButton(pr({ checks: [{ name: 'a', bucket: 'fail' }] })).reason).toContain('PC でマージしてください');
		expect(prMergeButton(pr({ checks: [{ name: 'a', bucket: 'pending' }] })).reason).toContain('実行中');
		expect(prMergeButton(pr({ state: 'merged' })).visible).toBe(false);
	});

	it('マージキューに入れた PR は、同じ head のまま開いている間だけ押せず、キューに入れたことを出す', () => {
		const passing = pr({ checks: [{ name: 'a', bucket: 'pass' }] });
		expect([
			prMergeButton(passing, { number: passing.number, headSha: passing.headSha }),
			prMergeButton({ ...passing, headSha: 'a'.repeat(40) }, { number: passing.number, headSha: passing.headSha }),
			prMergeButton({ ...passing, state: 'merged' }, { number: passing.number, headSha: passing.headSha }),
		]).toEqual([
			{ visible: true, reason: 'マージキューに入れました。GitHub がマージするとマージ済みに変わります。' },
			{ visible: true, reason: undefined },
			{ visible: false, reason: undefined },
		]);
	});

	it('マージの応答を読み、キューに入れたときは「マージキューに入れました」と出す（queued を返さない古い PC はマージした扱い）', () => {
		expect([
			prMergeToastText(4, parsePrMergeReply({ queued: true })),
			prMergeToastText(4, parsePrMergeReply({})),
			prMergeToastText(4, parsePrMergeReply(undefined)),
		]).toEqual(['#4 をマージキューに入れました', '#4 をマージしました', '#4 をマージしました']);
	});

	it('確かめのシートに題名・ブランチ・チェック・固定するコミットを並べる', () => {
		expect(mergeConfirmMessage(pr({ checks: [{ name: 'a', bucket: 'pass' }] })).split('\n')).toEqual([
			'#4 Add sync',
			'feat → main',
			'成功 1',
			'コミット fffffff をリポジトリの既定の方法でマージします。この操作は取り消せません。',
		]);
	});
});
