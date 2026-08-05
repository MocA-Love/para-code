// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isAgentWaiting } from './store.js';

/**
 * ホーム一覧の並び替えと絞り込み。
 *
 * ユーザーによって見たい順序が違う（ステータスを優先したい／スペースでまとめたい）ため、
 * 並び順・第2キー・状態の絞り込みを選べるようにする。判定をここへ純関数として集約し、
 * 画面側は「選ばれた設定を渡して並んだ配列を受け取る」だけにする。
 *
 * **応答待ち（質問・応答待ち）はここでは扱わない。** あれは画面上部の「応答待ち」スタックが
 * 持つ別枠で、絞り込みで消えると回答できなくなるため、一覧に降りてくる前に除かれている。
 */

/** 並び替えのキー。 */
export type HomeSortKey = 'status' | 'space' | 'name' | 'added';

/**
 * 絞り込みに使う状態のまとまり。生の `agentStatus` は質問と応答待ちが別値だが、
 * ユーザーから見ればどちらも「応答待ち」の一種なので畳んでいる。
 */
export type HomeStatusBucket = 'waiting' | 'working' | 'review' | 'idle';

/** ホーム一覧の見え方の設定（端末に保存して次回も同じ並びにする）。 */
export interface HomeListPreferences {
	readonly sort: HomeSortKey;
	/** 第1キーが同じだったときの並び。第1キーと同じ値は選べない。 */
	readonly secondary: HomeSortKey;
	/** 空 = 絞り込みなし。1つ以上入っていればそのまとまりだけを出す。 */
	readonly filters: readonly HomeStatusBucket[];
	/** ピン留めを並び順に関係なく先頭へ出すか。 */
	readonly pinFirst: boolean;
}

export const DEFAULT_HOME_PREFERENCES: HomeListPreferences = {
	// 既定はこれまでの挙動（ステータス順・ピン留めが先頭）をそのまま再現する。
	// 第2キーだけは、同じステータスの中がPC側の配列順になっていて意味が読み取れなかったため、
	// スペース順にして「どのスペースのものか」で辿れるようにしている。
	sort: 'status',
	secondary: 'space',
	filters: [],
	pinFirst: true,
};

/** 並べ替えに必要なターミナルの形（実体は store.ts の workspace.terminals）。 */
export interface SortableTerminal {
	/** 受信時に一意性が検証されている唯一の値。最後のタイブレークに使う。 */
	readonly terminalKey: string;
	/** PC側のinstanceId。**レンダラーウィンドウごとの連番なので一意ではない**（別ウィンドウの1本目も1になる）。 */
	readonly id: number;
	readonly windowId: number;
	/** ワイヤ側で型検証されていないので undefined で届くことがある。 */
	readonly title?: string;
	readonly ws?: string;
	readonly agentStatus?: string;
}

/** 状態のまとまりを求める。 */
export function statusBucket(agentStatus: string | undefined): HomeStatusBucket {
	if (isAgentWaiting(agentStatus)) {
		return 'waiting';
	}
	return agentStatus === 'working' ? 'working' : agentStatus === undefined ? 'idle' : 'review';
}

/** ステータス順の重み。小さいほど上（応答待ち → 実行中 → レビュー → アイドル）。 */
export function statusOrder(agentStatus: string | undefined): number {
	const bucket = statusBucket(agentStatus);
	return bucket === 'waiting' ? 0 : bucket === 'working' ? 1 : bucket === 'review' ? 2 : 3;
}

/**
 * 絞り込みで出せるまとまり（チップの並び順もこれに従う）。
 *
 * **`waiting` を足してはいけない。** 応答待ちは一覧に降りてくる前に除かれて上部の
 * 「応答待ち」スタックへ回るので、足すと「常に0件で、選ぶと必ず空になるチップ」ができる。
 */
export const HOME_STATUS_BUCKETS: readonly HomeStatusBucket[] = ['working', 'review', 'idle'];

/** 第1キーとして選べるもの（シートの並び順もこれに従う）。 */
export const HOME_SORT_KEYS: readonly HomeSortKey[] = ['status', 'space', 'name', 'added'];

/**
 * 第2キーの候補。第1キーと同じものは「同じときの並び」になり得ないので外す。
 */
export function secondaryCandidates(sort: HomeSortKey): readonly HomeSortKey[] {
	return HOME_SORT_KEYS.filter(key => key !== sort);
}

/**
 * 第1キーを変えたときに第2キーを整合させる。同じ値になってしまう場合だけ、
 * 既定として意味のある組み合わせへ寄せる（ステータス優先ならスペース、それ以外はステータス）。
 */
export function reconcileSecondary(sort: HomeSortKey, secondary: HomeSortKey): HomeSortKey {
	if (sort !== secondary) {
		return secondary;
	}
	return sort === 'status' ? 'space' : 'status';
}

/** 絞り込みの切り替え。既に入っていれば外す。 */
export function toggleFilter(filters: readonly HomeStatusBucket[], bucket: HomeStatusBucket): HomeStatusBucket[] {
	return filters.includes(bucket) ? filters.filter(item => item !== bucket) : [...filters, bucket];
}

function compareBy(key: HomeSortKey, a: SortableTerminal, b: SortableTerminal, spaceIndexOf: (row: SortableTerminal) => number | undefined): number {
	if (key === 'status') {
		return statusOrder(a.agentStatus) - statusOrder(b.agentStatus);
	}
	if (key === 'space') {
		// スペースの解決は呼び出し側に任せる。ws未タグのターミナルをPC側アクティブスペース所属
		// として扱う規則がホーム全体で共通のため、ここで生の ws を引くと行に出ている
		// スペース名と並び順がずれる（PCのスペース切替中は ws が一時的に落ちる）。
		// それでも解決できないものだけ末尾へ回す。
		return (spaceIndexOf(a) ?? Number.MAX_SAFE_INTEGER) - (spaceIndexOf(b) ?? Number.MAX_SAFE_INTEGER);
	}
	if (key === 'name') {
		// 日本語のターミナル名が混ざるので localeCompare で辞書順にする。
		// title はワイヤ側で型検証されていないので、欠けていても落ちないように受ける。
		return (a.title ?? '').localeCompare(b.title ?? '', 'ja');
	}
	// 追加順。id はウィンドウごとの連番なので、まずウィンドウで揃えてから id を見る。
	return (a.windowId - b.windowId) || (a.id - b.id);
}

/** 最後の決着。terminalKey は受信時に一意性が検証されているので、ここで必ず順序が定まる。 */
function compareByKey(a: SortableTerminal, b: SortableTerminal): number {
	return a.terminalKey < b.terminalKey ? -1 : a.terminalKey > b.terminalKey ? 1 : 0;
}

/**
 * 絞り込んで並べる。
 *
 * `spaceIndexOf` はターミナルからスペースの表示順（ドロワーの並び）を引く関数。マップではなく
 * 関数で受けるのは、ws未タグのターミナルをPC側アクティブスペース所属として扱う規則が
 * 画面側にあり、そこを通してもらう必要があるため。
 *
 * 最後は必ず terminalKey で決着を付ける。id はウィンドウごとの連番で一意ではなく、
 * `workspace.terminals` の配列順もPCからのstate再送のたびに変わるため、そこへ委ねると
 * 同着の行が10Hzで入れ替わって踊る。
 */
export function arrangeHomeRows<T extends SortableTerminal>(
	rows: readonly T[],
	preferences: HomeListPreferences,
	options: { readonly spaceIndexOf: (row: T) => number | undefined; readonly isPinned: (row: T) => boolean },
): T[] {
	const filters = preferences.filters;
	const filtered = filters.length === 0
		? [...rows]
		: rows.filter(row => filters.includes(statusBucket(row.agentStatus)));
	const spaceIndexOf = options.spaceIndexOf as (row: SortableTerminal) => number | undefined;
	return filtered.sort((a, b) => {
		if (preferences.pinFirst) {
			const pinDiff = (options.isPinned(b) ? 1 : 0) - (options.isPinned(a) ? 1 : 0);
			if (pinDiff !== 0) {
				return pinDiff;
			}
		}
		return compareBy(preferences.sort, a, b, spaceIndexOf)
			|| compareBy(preferences.secondary, a, b, spaceIndexOf)
			|| compareByKey(a, b);
	});
}

/** 絞り込みチップに出す件数（絞り込みの影響を受けない、まとまりごとの総数）。 */
export function bucketCounts(rows: readonly SortableTerminal[]): Record<HomeStatusBucket, number> {
	const counts: Record<HomeStatusBucket, number> = { waiting: 0, working: 0, review: 0, idle: 0 };
	for (const row of rows) {
		counts[statusBucket(row.agentStatus)]++;
	}
	return counts;
}

/** 保存された値の読み戻し。壊れていた項目だけ既定へ落とす（全部捨てない）。 */
export function parseHomePreferences(raw: unknown): HomeListPreferences {
	if (typeof raw !== 'object' || raw === null) {
		return DEFAULT_HOME_PREFERENCES;
	}
	const value = raw as Record<string, unknown>;
	const sort = HOME_SORT_KEYS.includes(value['sort'] as HomeSortKey) ? value['sort'] as HomeSortKey : DEFAULT_HOME_PREFERENCES.sort;
	const rawSecondary = HOME_SORT_KEYS.includes(value['secondary'] as HomeSortKey) ? value['secondary'] as HomeSortKey : DEFAULT_HOME_PREFERENCES.secondary;
	const filters = Array.isArray(value['filters'])
		? value['filters'].filter((item): item is HomeStatusBucket => HOME_STATUS_BUCKETS.includes(item as HomeStatusBucket))
		: DEFAULT_HOME_PREFERENCES.filters;
	return {
		sort,
		secondary: reconcileSecondary(sort, rawSecondary),
		filters,
		pinFirst: typeof value['pinFirst'] === 'boolean' ? value['pinFirst'] : DEFAULT_HOME_PREFERENCES.pinFirst,
	};
}
