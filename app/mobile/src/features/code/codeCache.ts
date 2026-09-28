// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import type { IParadisMobileReviewMark, IParadisMobileReviewNote } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDiffReview.js';
import type { ScmStatusResult } from '../../store.js';

/** 確認済みの印（パスごと）。`identity` が今の変更と違えば「確認後に変更あり」。 */
export type ReviewMarks = Readonly<Record<string, IParadisMobileReviewMark>>;

/**
 * ソース管理と差分レビューが共有する、アプリを開いている間だけの記憶。
 *  - `status`: 最後に読んだ変更の一覧。差分レビューを開いた瞬間から一覧（前後の移動・ファイルの一覧）を
 *    出せるよう、ソース管理の画面が読んだものをそのまま使う（開いたあと自分でも読み直す）
 *  - `reviewed`: 差分レビューで「確認済み」にしたファイルと、確認したときの中身の識別（Orca W2-14）。
 *    PC が `review.store.v1` を持てば PC の保存の写し（`useReviewMarks.ts` が読み書きする）、持たなければ
 *    端末の中だけの記録。一覧から消えたファイル（コミット・破棄された）は読み直すたびに外す
 *  - `pendingReveal`: ビューアのパンくずを押して1つ前のツリーへ戻るときに、ツリーで開いて目印を付けるフォルダ。
 *    戻った先のツリーが前面に来たときに1回だけ受け取る
 *
 * 端末には保存しない（アプリを閉じれば消える。PC に保存できる PC なら開き直したときに PC から読む）。
 * キーは PC とスペースの組（{@link codeCacheKey}）。
 */
interface CodeCacheStore {
	readonly status: Readonly<Record<string, ScmStatusResult>>;
	readonly reviewed: Readonly<Record<string, ReviewMarks>>;
	/** 差分の行へのメモ（PC の保存の写し。`review.notes.v1` の PC だけ。Orca W2-28）。 */
	readonly reviewNotes: Readonly<Record<string, readonly IParadisMobileReviewNote[]>>;
	readonly pendingReveal: Readonly<Record<string, string>>;
	setStatus(key: string, status: ScmStatusResult): void;
	/** 1件の印を付ける（`undefined` で外す）。 */
	setReviewMark(key: string, path: string, mark: IParadisMobileReviewMark | undefined): void;
	/** 印をまとめて置き換える（PC から読んだとき）。 */
	replaceReviewMarks(key: string, marks: ReviewMarks): void;
	replaceReviewNotes(key: string, notes: readonly IParadisMobileReviewNote[]): void;
	requestReveal(key: string, path: string): void;
	/** 受け取ったら消す（2回目は undefined）。 */
	takeReveal(key: string): string | undefined;
}

export function codeCacheKey(pcId: string | undefined, spaceId: string | undefined): string {
	return `${pcId ?? ''}\0${spaceId ?? ''}`;
}

const NO_MARKS: ReviewMarks = {};
const NO_NOTES: readonly IParadisMobileReviewNote[] = [];

export const useCodeCache = create<CodeCacheStore>()((set, get) => ({
	status: {},
	reviewed: {},
	reviewNotes: {},
	pendingReveal: {},
	setStatus(key, status) {
		set(state => {
			const paths = new Set(status.files.map(file => file.path));
			const previous = state.reviewed[key] ?? NO_MARKS;
			const kept = Object.fromEntries(Object.entries(previous).filter(([path]) => paths.has(path)));
			return {
				status: { ...state.status, [key]: status },
				reviewed: Object.keys(kept).length === Object.keys(previous).length ? state.reviewed : { ...state.reviewed, [key]: kept },
			};
		});
	},
	setReviewMark(key, path, mark) {
		set(state => {
			const previous = state.reviewed[key] ?? NO_MARKS;
			const current = previous[path];
			if (current === mark || (current !== undefined && mark !== undefined && current.identity === mark.identity && current.reviewedAt === mark.reviewedAt)) {
				return state;
			}
			const { [path]: _removed, ...rest } = previous;
			return { reviewed: { ...state.reviewed, [key]: mark !== undefined ? { ...rest, [path]: mark } : rest } };
		});
	},
	replaceReviewMarks(key, marks) {
		set(state => ({ reviewed: { ...state.reviewed, [key]: marks } }));
	},
	replaceReviewNotes(key, notes) {
		set(state => ({ reviewNotes: { ...state.reviewNotes, [key]: notes } }));
	},
	requestReveal(key, path) {
		set(state => ({ pendingReveal: { ...state.pendingReveal, [key]: path } }));
	},
	takeReveal(key) {
		const pending = get().pendingReveal;
		if (!Object.prototype.hasOwnProperty.call(pending, key)) {
			return undefined;
		}
		const { [key]: path, ...rest } = pending;
		set({ pendingReveal: rest });
		return path;
	},
}));

/** 確認済みの印（参照が変わらない限り同じものを返す）。 */
export function useReviewMarks(key: string): ReviewMarks {
	return useCodeCache(state => state.reviewed[key] ?? NO_MARKS);
}

/** 差分の行へのメモ（参照が変わらない限り同じ配列を返す）。 */
export function useReviewNotes(key: string): readonly IParadisMobileReviewNote[] {
	return useCodeCache(state => state.reviewNotes[key] ?? NO_NOTES);
}
