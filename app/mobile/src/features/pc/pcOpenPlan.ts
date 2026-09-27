// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { firstParam, type RouteHref } from '../../routes.js';

/**
 * PC の外から PC の中の画面を開くとき（通知のタップ・通知の一覧・起動中に届いたリンクの中継）に、
 * 器の Stack（`app/pc/_layout.tsx`）をどう動かすかを決める純関数。
 *
 * 規則（どの入口でも同じ）:
 *  1. 器の Stack には、同じ PC の器を1枚しか置かない
 *  2. 開きたい PC の器が器の Stack にあれば、その上に積んだ器を閉じてその器へ戻り、その中で開く
 *     - 行き先が器の根（`/pc/<id>`＝PC の画面）なら、積まずに器の中を根まで戻す（根を2枚にしない）
 *     - いまその器に出ている画面が開きたい画面と同じなら、開き直さない。`latest`（会話を最新まで送る印）が
 *       付いていれば、その画面の引数として渡す（セッションの画面がタブを切り替えるときと同じ渡し方）
 *     - 2列では、器の中（詳細の列）を根まで戻してから開く（左の列の行を押したときと同じく、積み増さず入れ替える）
 *  3. 無ければ器の Stack の上に新しい器を積んで開く
 *  4. 器の Stack が前面に無い（ホーム・設定などの上から開く）ときは、今までどおりルートに新しい器の Stack を積む
 *
 * 戻る操作は「開いた画面 → その器で下にあった画面 → その器の下の器」の順になる。器を並べ替える
 * （`dangerouslySingular`）と、並べ替えた後でネイティブの画面と JS の状態が食い違ったので、閉じる（pop）だけで
 * 前面へ戻す。
 *
 * 呼び出しの位置は2通り:
 *  - `focus`: いま前面の画面から開く（OS の通知のタップ）。ルートの前面が器の Stack なら、その中で規則を当てる
 *  - `overlay`: ルートの Stack の一番上にいる自分（通知の一覧・中継の画面）を閉じて開く。すぐ下が器の Stack
 *    なら、自分を閉じてからその中で規則を当てる。そうでなければ自分を行き先に置き換える
 */

/** ナビゲーションの状態のうち、ここで読むところ。 */
export interface NavRouteLike {
	readonly key: string;
	readonly name: string;
	readonly params?: object;
	readonly state?: NavStateLike;
}

export interface NavStateLike {
	readonly key: string;
	readonly index: number;
	readonly routes: readonly NavRouteLike[];
}

/** 開きたい PC の中の画面。 */
export interface PcTarget {
	readonly pcId: string;
	/** `/pc/<pcId>/…` の形のパス（各区切りは符号化しない生の値。クエリは含まない）。 */
	readonly path: string;
	/** セッションのタブ（`tab` のクエリ）。 */
	readonly tab: string | undefined;
	/** 会話を最新まで送る一度限りの印（`latest` のクエリ）。 */
	readonly latest: string | undefined;
}

export type PcOpenPlan =
	/** 器の Stack を使わない。`focus` なら push、`overlay` なら自分を置き換える（どちらも `withAnchor`）。 */
	| { readonly kind: 'new-stack' }
	| {
		readonly kind: 'in-stack';
		/** ルートの Stack から自分（通知の一覧・中継の画面）を閉じる。 */
		readonly closeOverlay: { readonly rootKey: string } | undefined;
		/** 器の Stack から閉じる器の数（開きたい PC の器の上に積んだもの）。 */
		readonly popPcs: { readonly stackKey: string; readonly count: number } | undefined;
		/** 器の中の Stack を根まで戻す（行き先が根のとき・2列で入れ替えるとき）。 */
		readonly popInner: { readonly stackKey: string } | undefined;
		/** もう出ている画面へ引数（`latest`）だけ渡す。 */
		readonly setParams: { readonly stackKey: string; readonly routeKey: string; readonly params: Readonly<Record<string, string>> } | undefined;
		/** 器の中で開く（false なら開き直さない）。 */
		readonly push: boolean;
	};

/** 行き先（`routes.*` の形か、`/pc/…?…` の文字列）を読む。PC の中の画面でなければ undefined。 */
export function pcTargetOf(href: RouteHref): PcTarget | undefined {
	if (typeof href === 'string') {
		const queryAt = href.indexOf('?');
		const pathname = queryAt >= 0 ? href.slice(0, queryAt) : href;
		const segments = pathname.split('/').slice(1);
		const decoded: string[] = [];
		for (const segment of segments) {
			const value = safeDecode(segment);
			if (value === undefined) {
				return undefined;
			}
			decoded.push(value);
		}
		if (decoded[0] !== 'pc' || decoded[1] === undefined || decoded[1] === '') {
			return undefined;
		}
		const query = queryAt >= 0 ? href.slice(queryAt + 1) : '';
		return { pcId: decoded[1], path: `/${decoded.join('/')}`.replace(/\/+$/, ''), tab: readQuery(query, 'tab'), latest: readQuery(query, 'latest') };
	}
	if (!href.pathname.startsWith('/pc/[pcId]')) {
		return undefined;
	}
	const pcId = href.params.pcId;
	if (pcId === undefined) {
		return undefined;
	}
	const path = fillPath(href.pathname.slice(1).split('/'), href.params);
	return path === undefined ? undefined : { pcId, path, tab: href.params.tab, latest: href.params.latest };
}

/**
 * どう開くか。`container` はナビゲーションのコンテナの状態（Expo Router の `__root` に包まれていてよい）。
 * `twoColumn` は iPad の2列で使っているか。
 */
export function planPcOpen(container: NavStateLike, target: PcTarget, from: 'focus' | 'overlay', twoColumn = false): PcOpenPlan {
	const root = rootStackOf(container);
	const stackIndex = from === 'focus' ? root.index : root.index - 1;
	const stackRoute = root.routes[stackIndex];
	const stack = stackRoute?.name === 'pc' ? stackRoute.state : undefined;
	if (stack === undefined || stack.routes.length === 0) {
		return { kind: 'new-stack' };
	}
	const closeOverlay = from === 'overlay' ? { rootKey: root.key } : undefined;
	const top = stack.index;
	let found = -1;
	for (let i = top; i >= 0; i--) {
		if (pcIdOf(stack.routes[i]) === target.pcId) {
			found = i;
			break;
		}
	}
	if (found < 0) {
		return { kind: 'in-stack', closeOverlay, popPcs: undefined, popInner: undefined, setParams: undefined, push: true };
	}
	const popPcs = found < top ? { stackKey: stack.key, count: top - found } : undefined;
	const pcRoute = stack.routes[found];
	const inner = pcRoute?.state;
	const stacked = inner !== undefined && inner.routes.length > 1 ? { stackKey: inner.key } : undefined;
	if (target.path === `/pc/${target.pcId}`) {
		// PC の画面（器の根）。根をもう1枚積むと、詳細の列の様子が上の根に取られて壊れる。
		return { kind: 'in-stack', closeOverlay, popPcs, popInner: stacked, setParams: undefined, push: false };
	}
	const shown = shownTarget(pcRoute);
	if (shown !== undefined && shown.path === target.path && (target.tab === undefined || target.tab === shown.tab)) {
		const shownRoute = inner?.routes[inner.index];
		const setParams = target.latest !== undefined && target.latest !== shown.latest && inner !== undefined && shownRoute !== undefined
			? { stackKey: inner.key, routeKey: shownRoute.key, params: { latest: target.latest } }
			: undefined;
		return { kind: 'in-stack', closeOverlay, popPcs, popInner: undefined, setParams, push: false };
	}
	return { kind: 'in-stack', closeOverlay, popPcs, popInner: twoColumn ? stacked : undefined, setParams: undefined, push: true };
}

/** アプリのルートの Stack（`app/_layout.tsx`）。コンテナの状態は Expo Router の `__root` 1枚に包まれている。 */
function rootStackOf(state: NavStateLike): NavStateLike {
	let current = state;
	while (current.routes.length === 1 && current.routes[0]?.name === '__root' && current.routes[0].state !== undefined) {
		current = current.routes[0].state;
	}
	return current;
}

/** 器（`[pcId]`）にいま出ている画面。器の中がまだ組み立てられていなければ undefined。 */
function shownTarget(pcRoute: NavRouteLike | undefined): PcTarget | undefined {
	const pcId = pcIdOf(pcRoute);
	const inner = pcRoute?.state;
	const route = inner?.routes[inner.index];
	if (pcId === undefined || route === undefined) {
		return undefined;
	}
	const params = stringParams(route.params);
	const path = fillPath(['pc', '[pcId]', ...route.name.split('/').filter(segment => segment !== 'index')], { ...params, pcId });
	return path === undefined ? undefined : { pcId, path, tab: params.tab, latest: params.latest };
}

function pcIdOf(route: NavRouteLike | undefined): string | undefined {
	const pcId = (route?.params as { pcId?: unknown } | undefined)?.pcId;
	return typeof pcId === 'string' ? pcId : undefined;
}

function stringParams(params: object | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(params ?? {})) {
		const first = firstParam(typeof value === 'string' || Array.isArray(value) ? value as string | string[] : undefined);
		if (first !== undefined) {
			result[name] = first;
		}
	}
	return result;
}

function fillPath(segments: readonly string[], params: Readonly<Record<string, string>>): string | undefined {
	const filled: string[] = [];
	for (const segment of segments) {
		const name = /^\[(?<name>[^\]]+)\]$/.exec(segment)?.groups?.name;
		const value = name !== undefined ? params[name] : segment;
		if (value === undefined) {
			return undefined;
		}
		filled.push(value);
	}
	return `/${filled.join('/')}`;
}

function readQuery(query: string, name: string): string | undefined {
	for (const pair of query.split('&')) {
		const at = pair.indexOf('=');
		if (at > 0 && safeDecode(pair.slice(0, at)) === name) {
			return safeDecode(pair.slice(at + 1).replace(/\+/g, ' '));
		}
	}
	return undefined;
}

function safeDecode(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}
