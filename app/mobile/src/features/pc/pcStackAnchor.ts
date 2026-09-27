// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC の器を積む Stack（`app/pc/_layout.tsx`）から、`withAnchor` の副作用で敷かれた「PC の無い器」を取り除く。
 *
 * `router.push(…, { withAnchor: true })` は遷移先の全階層に `initial: false` を付ける。PC の器の中では
 * これで根（`index`）が下に敷かれて狙いどおりだが、器を積む Stack には根の画面が無いので、先頭の画面
 * （`[pcId]`）が引数なしで1枚敷かれる。これが残ると、戻ったときに PC の決まらない画面が出る。
 */

interface StackRouteLike {
	readonly key: string;
}

interface StackStateLike<R extends StackRouteLike> {
	readonly index: number;
	readonly routes: readonly R[];
}

/**
 * `key` のルートを除いた Stack の状態。前面のルートは除かない（前面なら、あるいは見つからなければ undefined）。
 * 前面のルートは変えずに、`index` だけ詰める。
 */
export function stackWithoutRoute<R extends StackRouteLike, S extends StackStateLike<R>>(state: S, key: string): S | undefined {
	const position = state.routes.findIndex(route => route.key === key);
	if (position < 0 || position === state.index) {
		return undefined;
	}
	const routes = state.routes.filter(route => route.key !== key);
	return { ...state, routes, index: position < state.index ? state.index - 1 : state.index };
}
