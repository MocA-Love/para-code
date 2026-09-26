// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isAgentWaiting } from './store.js';

/**
 * ホーム一覧の並び替えと、ステータス順のときの見出し区切り。
 *
 * ユーザーによって見たい順序が違う（ステータスを優先したい／スペースでまとめたい）ため、
 * 並び順・第2キーを選べるようにする。判定をここへ純関数として集約し、
 * 画面側は「選ばれた設定を渡して並んだ配列を受け取る」だけにする。
 *
 * 以前あった状態の絞り込み（チップ）は、ステータス順の一覧を状態の見出しで区切るように
 * したことで役目を終えたので外した（{@link groupRowsByStatus}）。
 *
 * **要対応（質問・許可待ち）はここでは扱わない。** あれは画面上部の要対応スタックが
 * 持つ別枠で、その場で回答できるカードとして出すため、一覧に降りてくる前に除かれている。
 */

/** 並び替えのキー。 */
export type HomeSortKey = 'status' | 'space' | 'name' | 'added';

/**
 * 状態のまとまり。生の `agentStatus` は質問と許可待ちが別値だが、
 * ユーザーから見ればどちらも「要対応」の一種なので畳んでいる。
 */
export type HomeStatusBucket = 'waiting' | 'working' | 'review' | 'idle';

/** ホーム一覧の見え方の設定（端末に保存して次回も同じ並びにする）。 */
export interface HomeListPreferences {
	readonly sort: HomeSortKey;
	/** 第1キーが同じだったときの並び。第1キーと同じ値は選べない。 */
	readonly secondary: HomeSortKey;
	/** ピン留めを並び順に関係なく先頭へ出すか。 */
	readonly pinFirst: boolean;
}

export const DEFAULT_HOME_PREFERENCES: HomeListPreferences = {
	// 既定はこれまでの挙動（ステータス順・ピン留めが先頭）をそのまま再現する。
	// 第2キーだけは、同じステータスの中がPC側の配列順になっていて意味が読み取れなかったため、
	// スペース順にして「どのスペースのものか」で辿れるようにしている。
	sort: 'status',
	secondary: 'space',
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

/** ステータス順の重み。小さいほど上（要対応 → 実行中 → 未確認 → 待機）。 */
export function statusOrder(agentStatus: string | undefined): number {
	const bucket = statusBucket(agentStatus);
	return bucket === 'waiting' ? 0 : bucket === 'working' ? 1 : bucket === 'review' ? 2 : 3;
}

/**
 * ステータス順のときに一覧を区切る見出しの並び（要対応はスタックが別に持つので含まない）。
 *
 * **`waiting` を足してはいけない。** 要対応は一覧に降りてくる前に除かれて上部の
 * 要対応スタックへ回るので、足すと常に空の段ができる。
 */
export const HOME_STATUS_SECTIONS: readonly Exclude<HomeStatusBucket, 'waiting'>[] = ['working', 'review', 'idle'];

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
 * 並べる。
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
	const spaceIndexOf = options.spaceIndexOf as (row: SortableTerminal) => number | undefined;
	return [...rows].sort((a, b) => {
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

/** ステータス順の一覧の1段（見出し1つとその下の行）。 */
export interface HomeStatusSection<T> {
	readonly key: Exclude<HomeStatusBucket, 'waiting'>;
	readonly rows: readonly T[];
}

/**
 * 並べ終えた行を状態ごとの段に分ける。段の順は {@link HOME_STATUS_SECTIONS}、段の中は
 * 渡された順（{@link arrangeHomeRows} の結果＝ピン留め・第2キーが効いた順）をそのまま保つ。
 * 行の無い段は返さない（空の見出しを並べない）。要対応の行が紛れていても段には入れない
 * （スタックが持つもので、二重に出さない）。
 */
export function groupRowsByStatus<T extends SortableTerminal>(rows: readonly T[]): HomeStatusSection<T>[] {
	const buckets = new Map<HomeStatusBucket, T[]>();
	for (const row of rows) {
		const bucket = statusBucket(row.agentStatus);
		const list = buckets.get(bucket);
		if (list === undefined) {
			buckets.set(bucket, [row]);
		} else {
			list.push(row);
		}
	}
	return HOME_STATUS_SECTIONS
		.map(key => ({ key, rows: buckets.get(key) ?? [] }))
		.filter(section => section.rows.length > 0);
}

/**
 * 保存された値の読み戻し。壊れていた項目だけ既定へ落とす（全部捨てない）。
 *
 * **以前保存していた `filters`（状態の絞り込み）は読まずに捨てる。** 絞り込みの画面部品は
 * もう無いので、読み戻すと「外す手段の無い絞り込み」で行が消えたままになる。
 */
export function parseHomePreferences(raw: unknown): HomeListPreferences {
	if (typeof raw !== 'object' || raw === null) {
		return DEFAULT_HOME_PREFERENCES;
	}
	const value = raw as Record<string, unknown>;
	const sort = HOME_SORT_KEYS.includes(value['sort'] as HomeSortKey) ? value['sort'] as HomeSortKey : DEFAULT_HOME_PREFERENCES.sort;
	const rawSecondary = HOME_SORT_KEYS.includes(value['secondary'] as HomeSortKey) ? value['secondary'] as HomeSortKey : DEFAULT_HOME_PREFERENCES.secondary;
	return {
		sort,
		secondary: reconcileSecondary(sort, rawSecondary),
		pinFirst: typeof value['pinFirst'] === 'boolean' ? value['pinFirst'] : DEFAULT_HOME_PREFERENCES.pinFirst,
	};
}

/** 畳める段（ステータス順の「待機」）の見え方。 */
export interface CollapsibleSectionView<T> {
	/** 段を開いているか（見出しの向き）。 */
	readonly open: boolean;
	/** 見せる行。畳んでいてもピン留めの行は残す。 */
	readonly visibleRows: readonly T[];
	/** 畳んで隠している行の数。 */
	readonly hiddenCount: number;
}

/**
 * 「待機」の段の見え方を決める。
 *
 * - 利用者が開閉していなければ（`openOverride` が undefined）、既定で畳む。ただし段が「待機」
 *   だけのときは開いて出す（畳むと一覧が見出し1行だけになり、何も無いように見える）
 * - **ピン留めの行は畳んでも隠さない。** ピン留めは「すぐ触れる場所に置いておく」ための印で、
 *   手が空いて待機に落ちた途端に見えなくなると、ピン留めを先頭に出す（pinFirst）意味が無くなる
 */
export function idleSectionView<T>(
	sections: readonly HomeStatusSection<T>[],
	idleRows: readonly T[],
	openOverride: boolean | undefined,
	isPinned: (row: T) => boolean,
): CollapsibleSectionView<T> {
	const onlyIdle = sections.length === 1 && sections[0]?.key === 'idle';
	const open = openOverride ?? onlyIdle;
	const visibleRows = open ? idleRows : idleRows.filter(isPinned);
	return { open, visibleRows, hiddenCount: idleRows.length - visibleRows.length };
}
