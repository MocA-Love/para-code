// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisMobileReviewState, type ParadisMobileReviewState } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDiffReview.js';
import type { DiffRow } from '../../components/diffParser.js';
import { classifyMobileFileKind } from '../../components/officeCapability.js';
import type { ReviewMarks } from './codeCache.js';
import type { ScmEntry } from './scmModel.js';

/**
 * 差分レビュー（Orca の MobileDiffReview*）の判定。React に依存しない純関数で、
 * `diffReview.test.ts` で固定している。差分の行への分解は既存の `parseUnifiedDiff` を使う。
 */

/** 上の絞り込み（Orca の All / Unreviewed / Reviewed）。 */
export type ReviewFilter = 'all' | 'todo' | 'done';

export const REVIEW_FILTERS: readonly { readonly key: ReviewFilter; readonly label: string }[] = [
	{ key: 'all', label: 'すべて' },
	{ key: 'todo', label: '未確認' },
	{ key: 'done', label: '確認済み' },
];

/**
 * そのファイルの確認の状態。確認した後に中身が変わった（識別が違う）ものは `changed` で、
 * 「確認済み」には数えない（もう一度見てほしいので「未確認」の絞り込みに入る）。
 */
export function reviewStateOf(entry: ScmEntry, marks: ReviewMarks): ParadisMobileReviewState {
	return paradisMobileReviewState(entry.identity, marks[entry.path]);
}

export function isReviewed(entry: ScmEntry, marks: ReviewMarks): boolean {
	return reviewStateOf(entry, marks) === 'reviewed';
}

/** 絞り込んだ一覧（前後の移動・ファイルの一覧の対象）。 */
export function reviewQueue(entries: readonly ScmEntry[], marks: ReviewMarks, filter: ReviewFilter): ScmEntry[] {
	if (filter === 'all') {
		return [...entries];
	}
	return entries.filter(entry => isReviewed(entry, marks) === (filter === 'done'));
}

/**
 * 前後のファイル。端まで行ったら反対の端へ回る（モックと同じ）。絞り込んだ一覧が空なら
 * 全体から選ぶ。いまのファイルが一覧に無ければ、進むときは先頭・戻るときは末尾から。
 */
export function stepReview(entries: readonly ScmEntry[], queue: readonly ScmEntry[], currentPath: string | undefined, delta: 1 | -1): string | undefined {
	const list = queue.length > 0 ? queue : entries;
	if (list.length === 0) {
		return undefined;
	}
	const at = list.findIndex(entry => entry.path === currentPath);
	if (at < 0) {
		return (delta > 0 ? list[0] : list[list.length - 1])?.path;
	}
	return list[(at + delta + list.length) % list.length]?.path;
}

/** 確認済みにした後に進む先（いまのファイルより後ろの未確認 → 先頭からの未確認）。無ければ undefined。 */
export function nextUnreviewed(entries: readonly ScmEntry[], marks: ReviewMarks, currentPath: string): string | undefined {
	const at = entries.findIndex(entry => entry.path === currentPath);
	const ordered = at < 0 ? entries : [...entries.slice(at + 1), ...entries.slice(0, at)];
	return ordered.find(entry => entry.path !== currentPath && !isReviewed(entry, marks))?.path;
}

/** 確認済みの件数（いまの一覧に残っていて、確認した後に変わっていないものだけ数える）。 */
export function reviewedCount(entries: readonly ScmEntry[], marks: ReviewMarks): number {
	return entries.filter(entry => isReviewed(entry, marks)).length;
}

export function diffStats(rows: readonly DiffRow[]): { readonly add: number; readonly del: number } {
	let add = 0;
	let del = 0;
	for (const row of rows) {
		if (row.kind === 'add') {
			add++;
		} else if (row.kind === 'del') {
			del++;
		}
	}
	return { add, del };
}

/** 行の左に出す番号（新しい側を優先し、削除行は古い側）。見出し行は出さない。 */
export function diffLineNumber(row: DiffRow): number | undefined {
	return row.kind === 'hunk' ? undefined : row.newNo ?? row.oldNo;
}

/** 行の頭の記号。 */
export function diffSign(row: DiffRow): string {
	return row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : '';
}

/**
 * 差分の取り方。表計算は PC 側がセルの色分けで作る差分（HTML）を見せる。それ以外の Office 形式は
 * 差分を作れない。残りは `git diff` のテキスト。
 */
export type DiffSource = 'text' | 'spreadsheet' | 'officeUnavailable';

export function diffSourceOf(path: string): DiffSource {
	const name = path.split('/').pop() ?? path;
	const office = classifyMobileFileKind(name);
	if (office === 'spreadsheet' && /\.(?:xlsx|xlsm)$/i.test(name)) {
		return 'spreadsheet';
	}
	return office !== undefined ? 'officeUnavailable' : 'text';
}

/** 実ファイルを開けるか（削除されたファイルは作業ツリーに無い）。 */
export function canOpenWorkingFile(entry: ScmEntry | undefined): boolean {
	return entry === undefined || entry.kind !== 'deleted';
}
