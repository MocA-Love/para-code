// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { viewerKindOf } from './fileViewerModel.js';
import type { ScmEntry } from './scmModel.js';

/**
 * 差分の画面の見方（「表示・差分・Raw」）の決まり。React に依存しない純関数で、`reviewViewModes.test.ts` で固定している。
 *
 *  - 表示（render）: 変更後の中身をファイルビューアと同じ部品で描く（削除したファイルは変更前）
 *  - 差分（diff）: 変更前と変更後を比べる。画像は並べ、Excel は PC の `xlsxDiff`、Word は PC の Word 差分
 *  - Raw（raw）: 文字の差分。テキストは `git diff`、Excel・Word は書式を外した中身（セルの値・段落）の比較
 *
 * 種類ごとの見方と既定（ユーザーの決定 Q6-1・Q6-2）:
 *  - Markdown・HTML: 表示（既定）・Raw
 *  - 画像: 表示（既定）・差分
 *  - Excel・Word: 表示・差分（既定）・Raw
 *  - その他のテキスト: Raw だけ（切り替えは出さない）
 */
export type ReviewViewMode = 'render' | 'diff' | 'raw';

export const REVIEW_VIEW_LABELS: Readonly<Record<ReviewViewMode, string>> = { render: '表示', diff: '差分', raw: 'Raw' };

/** 見方を決める種類。 */
export type ReviewContentKind = 'markdown' | 'html' | 'image' | 'spreadsheet' | 'docx' | 'text';

export function reviewContentKindOf(path: string): ReviewContentKind {
	const kind = viewerKindOf(path);
	return kind === 'markdown' || kind === 'html' || kind === 'image' || kind === 'spreadsheet' || kind === 'docx' ? kind : 'text';
}

/** PC が持っている機能（無い PC では、その機能に頼る見方を出さない）。 */
export interface ReviewViewCaps {
	/** `scm.file-at.v1`: HEAD・インデックス・作業ツリーの中身を受け取れる。 */
	readonly fileAt: boolean;
	/** `scm.word-diff.v1`: Word の差分。 */
	readonly wordDiff: boolean;
}

/** 中身をどこから読むか。`missing` はその側にファイルが無い（新規・削除）。 */
export type ReviewSide = 'head' | 'index' | 'worktree' | 'missing';

export interface ReviewSides {
	/** 変更前（ステージ済みなら HEAD、そうでなければインデックス）。 */
	readonly before: ReviewSide;
	/** 変更後（ステージ済みならインデックス、そうでなければ作業ツリー）。 */
	readonly after: ReviewSide;
}

/**
 * 変更前と変更後の側。PC のソース管理の差分と同じ組み合わせ（ステージ済みは HEAD ⇔ インデックス、
 * 作業ツリーの変更はインデックス ⇔ 作業ツリー）。名前を変えたファイルは変更前のパスが分からないので、変更前は無しにする。
 */
export function reviewSidesOf(entry: Pick<ScmEntry, 'staged' | 'kind'> | undefined): ReviewSides {
	const staged = entry?.staged === true;
	const kind = entry?.kind;
	const noBefore = kind === 'added' || kind === 'untracked' || kind === 'renamed' || kind === 'copied';
	return {
		before: noBefore ? 'missing' : staged ? 'head' : 'index',
		after: kind === 'deleted' ? 'missing' : staged ? 'index' : 'worktree',
	};
}

/** 「表示」で描く側（変更後。削除したファイルは変更前）。 */
export function reviewRenderSide(sides: ReviewSides): ReviewSide {
	return sides.after !== 'missing' ? sides.after : sides.before;
}

export interface ReviewViewPlan {
	/** 切り替えに並べる見方（1 つ以下なら切り替えを出さない）。 */
	readonly modes: readonly ReviewViewMode[];
	/** 開いたとき（ファイルを移ったとき）の見方。 */
	readonly initial: ReviewViewMode;
}

/**
 * その種類・その PC で使える見方と既定。
 *  - 作業ツリー以外の側（ステージ済み・削除）を読むには `fileAt` が要る。古い PC では作業ツリーの中身で描けるときだけ「表示」を出す
 *  - Excel の表示は PC が描く（`fsXlsx`）ので作業ツリーのファイルだけ。差分（`xlsxDiff`）は xlsx・xlsm で、HEAD と作業ツリーの比較なので、
 *    変更後が作業ツリーの行（ステージしていない変更）だけに出す
 */
export function reviewViewPlan(kind: ReviewContentKind, sides: ReviewSides, caps: ReviewViewCaps, path = ''): ReviewViewPlan {
	const renderSide = reviewRenderSide(sides);
	const canRead = (side: ReviewSide) => side === 'worktree' || (side !== 'missing' && caps.fileAt);
	const both = sides.before !== 'missing' && sides.after !== 'missing';
	switch (kind) {
		case 'markdown':
		case 'html':
			return plan(canRead(renderSide) ? ['render', 'raw'] : ['raw'], 'render');
		case 'image': {
			const modes: ReviewViewMode[] = [];
			if (canRead(renderSide)) {
				modes.push('render');
			}
			if (both && caps.fileAt) {
				modes.push('diff');
			}
			// どちらも出せないとき（古い PC の削除・ステージ済みの画像）は git の 1 行だけでも見せる
			return plan(modes.length > 0 ? modes : ['raw'], 'render');
		}
		case 'spreadsheet': {
			const modes: ReviewViewMode[] = [];
			if (renderSide === 'worktree') {
				modes.push('render');
			}
			// PC の `xlsxDiff` は HEAD と作業ツリーを比べる。ステージ済みの行（インデックスが変更後）では比べる側が食い違うので出さない
			if (/\.(?:xlsx|xlsm)$/i.test(path) && sides.after === 'worktree') {
				modes.push('diff');
			}
			if (caps.fileAt) {
				modes.push('raw');
			}
			return plan(modes, 'diff', ['diff', 'raw', 'render']);
		}
		case 'docx': {
			const modes: ReviewViewMode[] = [];
			if (canRead(renderSide)) {
				modes.push('render');
			}
			if (caps.wordDiff) {
				modes.push('diff');
			}
			if (caps.fileAt) {
				modes.push('raw');
			}
			return plan(modes, 'diff', ['diff', 'raw', 'render']);
		}
		case 'text':
			return plan(['raw'], 'raw');
	}
}

function plan(modes: readonly ReviewViewMode[], preferred: ReviewViewMode, fallbacks: readonly ReviewViewMode[] = []): ReviewViewPlan {
	const initial = [preferred, ...fallbacks].find(mode => modes.includes(mode)) ?? modes[0] ?? 'raw';
	return { modes: modes.length > 0 ? modes : ['raw'], initial };
}

/** 選んだ見方がこのファイルで使えなければ既定へ戻す。 */
export function effectiveReviewMode(planned: ReviewViewPlan, chosen: ReviewViewMode | undefined): ReviewViewMode {
	return chosen !== undefined && planned.modes.includes(chosen) ? chosen : planned.initial;
}
