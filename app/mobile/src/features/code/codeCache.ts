// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import type { ScmStatusResult } from '../../store.js';

/**
 * ソース管理と差分レビューが共有する、アプリを開いている間だけの記憶。
 *  - `status`: 最後に読んだ変更の一覧。差分レビューを開いた瞬間から一覧（前後の移動・ファイルの一覧）を
 *    出せるよう、ソース管理の画面が読んだものをそのまま使う（開いたあと自分でも読み直す）
 *  - `reviewed`: 差分レビューで「確認済み」にしたファイル。PC 側には確認の記録が無いので端末の中だけで持ち、
 *    一覧から消えたファイル（コミット・破棄された）は読み直すたびに外す
 *  - `pendingReveal`: ビューアのパンくずを押して1つ前のツリーへ戻るときに、ツリーで開いて目印を付けるフォルダ。
 *    戻った先のツリーが前面に来たときに1回だけ受け取る
 *
 * 保存はしない（アプリを閉じれば消える）。キーは PC とスペースの組（{@link codeCacheKey}）。
 */
interface CodeCacheStore {
	readonly status: Readonly<Record<string, ScmStatusResult>>;
	readonly reviewed: Readonly<Record<string, readonly string[]>>;
	readonly pendingReveal: Readonly<Record<string, string>>;
	setStatus(key: string, status: ScmStatusResult): void;
	setReviewed(key: string, path: string, reviewed: boolean): void;
	requestReveal(key: string, path: string): void;
	/** 受け取ったら消す（2回目は undefined）。 */
	takeReveal(key: string): string | undefined;
}

export function codeCacheKey(pcId: string | undefined, spaceId: string | undefined): string {
	return `${pcId ?? ''}\0${spaceId ?? ''}`;
}

const NO_PATHS: readonly string[] = [];

export const useCodeCache = create<CodeCacheStore>()((set, get) => ({
	status: {},
	reviewed: {},
	pendingReveal: {},
	setStatus(key, status) {
		set(state => {
			const paths = new Set(status.files.map(file => file.path));
			const previous = state.reviewed[key] ?? NO_PATHS;
			const kept = previous.filter(path => paths.has(path));
			return {
				status: { ...state.status, [key]: status },
				reviewed: kept.length === previous.length ? state.reviewed : { ...state.reviewed, [key]: kept },
			};
		});
	},
	setReviewed(key, path, reviewed) {
		set(state => {
			const previous = state.reviewed[key] ?? NO_PATHS;
			const has = previous.includes(path);
			if (has === reviewed) {
				return state;
			}
			return { reviewed: { ...state.reviewed, [key]: reviewed ? [...previous, path] : previous.filter(candidate => candidate !== path) } };
		});
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

/** 確認済みのパス（参照が変わらない限り同じ配列を返す）。 */
export function useReviewedPaths(key: string): readonly string[] {
	return useCodeCache(state => state.reviewed[key] ?? NO_PATHS);
}
