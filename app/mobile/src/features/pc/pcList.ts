// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { arrangeHomeRows, reconcileSecondary, statusBucket, type HomeListPreferences, type HomeSortKey, type HomeStatusBucket, type SortableTerminal } from '../../homeSort.js';
import { pinKeyForTerminal } from '../../store.js';
import { status } from '../../theme.js';

/**
 * PC の画面（`/pc/[pcId]`）の一覧を組み立てる純関数。絞り込み・並び替え・グループ化をここに集め、
 * 画面は「選ばれた設定を渡して段（見出しと行）を受け取る」だけにする。
 *
 * 並びの判定（状態の重み・スペース順・名前順・追加順と最後の決着）は既存の `homeSort.ts` の
 * `arrangeHomeRows` をそのまま使い、ここでは書き直さない。状態のまとまりも `statusBucket` を使う。
 *
 * モック（concept-orca.html の `hostSections`）との対応:
 *  - ピン留めは並びやグループに関係なく先頭の「ピン留め」の段に集める
 *  - グループは「なし」「状態」「スペース」の3つ。「スペース」では行からスペース名を省く（見出しが言う）
 *  - 1行はエージェントかターミナル1つ（Orca の行はワークツリーだが、Para Code の単位はターミナル）
 */

/** グループの仕方。 */
export type PcListGroup = 'none' | 'state' | 'space';

/** 行の種類の絞り込み。エージェントかどうかで 1 つだけ選ぶ（`all` は絞らない）。 */
export type PcListKind = 'all' | 'agent' | 'terminal';

/** 種類の選択肢（シートのセグメントと、ツールバーのチップに出す呼び名）。 */
export const PC_LIST_KIND_OPTIONS: readonly { readonly value: PcListKind; readonly label: string }[] = [
	{ value: 'all', label: 'すべて' },
	{ value: 'agent', label: 'エージェント' },
	{ value: 'terminal', label: 'ターミナル' },
];

/** 絞り込み。何も選んでいない軸は「すべて」。 */
export interface PcListFilter {
	/**
	 * 種類。状態（`states`）はエージェントにだけ効くので、`terminal` のときは状態を見ない。
	 * 状態を選んでいるときは、`all` でもふつうのターミナルは出さない（状態を持たないため）。
	 */
	readonly kind: PcListKind;
	readonly states: readonly HomeStatusBucket[];
	readonly spaces: readonly string[];
	/** 検索語（名前・スペース名・ブランチの部分一致。大文字小文字は区別しない）。 */
	readonly query: string;
}

export const EMPTY_PC_LIST_FILTER: PcListFilter = { kind: 'all', states: [], spaces: [], query: '' };

/** 一覧に載せるスペースの形（実体は `workspace.workspaces`）。 */
export interface PcListSpace {
	readonly id: string;
	readonly name: string;
	readonly branch?: string;
	readonly color?: string;
}

/** 一覧に載せるターミナルの形（実体は `workspace.terminals`）。 */
export interface PcListTerminal extends SortableTerminal {
	readonly title: string;
	readonly agent?: boolean;
}

export interface PcListRow<T extends PcListTerminal> {
	readonly terminal: T;
	/** 行が属するスペース（解決できなければ undefined）。 */
	readonly space: PcListSpace | undefined;
	readonly pinned: boolean;
}

export interface PcListSection<T extends PcListTerminal> {
	readonly key: string;
	readonly kind: 'pinned' | 'state' | 'space' | 'all';
	/** 見出し。undefined なら見出しを出さない（グループなしでピン留めも無いとき）。 */
	readonly title: string | undefined;
	/** 状態の段なら、そのまとまり（見出しの点の色に使う）。 */
	readonly bucket?: HomeStatusBucket;
	/** スペースの段なら、そのスペース。 */
	readonly space?: PcListSpace;
	readonly rows: readonly PcListRow<T>[];
	/**
	 * スペースの段で、そのスペースにターミナルが1つも無い（アーカイブを除く）。
	 * 画面は「エージェントはいません」の行を出し、押すとそのスペースのセッションを開く
	 * （旧ドロワーのスペース一覧の代わりに、空のスペースにもここから入れるようにする）。
	 */
	readonly emptySpace?: boolean;
}

/** 状態の段の並びと呼び名（呼び名は theme.status に揃える）。 */
export const STATE_SECTIONS: readonly { readonly bucket: HomeStatusBucket; readonly title: string }[] = [
	{ bucket: 'waiting', title: status.attention.label },
	{ bucket: 'working', title: status.running.label },
	{ bucket: 'review', title: status.review.label },
	{ bucket: 'idle', title: status.idle.label },
];

/** 並び替えの選択肢（シートの行と、ツールバーに出す短い呼び名）。既定は先頭の「エージェントの状態」。 */
export const PC_LIST_SORT_OPTIONS: readonly { readonly value: HomeSortKey; readonly label: string; readonly hint: string; readonly short: string }[] = [
	{ value: 'status', label: 'エージェントの状態', hint: '要対応 → 実行中 → 未確認 → 待機', short: '状態順' },
	{ value: 'space', label: 'スペース', hint: 'スペースの並び、次に状態', short: 'スペース順' },
	{ value: 'name', label: '名前', hint: '名前の五十音順', short: '名前順' },
	{ value: 'added', label: '開いた順', hint: 'PC で開いた順', short: '開いた順' },
];

/** グループの選択肢。ツールバーには `short` を出す（「なし」のときは「グループ」）。 */
export const PC_LIST_GROUP_OPTIONS: readonly { readonly value: PcListGroup; readonly label: string; readonly short: string }[] = [
	{ value: 'none', label: 'グループなし', short: 'グループ' },
	{ value: 'state', label: '状態', short: '状態' },
	{ value: 'space', label: 'スペース', short: 'スペース' },
];

/** 既定のグループ。スペースごとの段で出す（空のスペースにも入れるように）。 */
export const DEFAULT_PC_LIST_GROUP: PcListGroup = 'space';

export function sortShortLabel(sort: HomeSortKey): string {
	return PC_LIST_SORT_OPTIONS.find(option => option.value === sort)?.short ?? '';
}

export function groupShortLabel(group: PcListGroup): string {
	return PC_LIST_GROUP_OPTIONS.find(option => option.value === group)?.short ?? '';
}

/**
 * 並び替えの第1キーを変える。第2キーが同じ値になってしまうときは既存の規則（`reconcileSecondary`）で寄せる。
 * 保存形式（`HomeListPreferences`）は変えない。
 */
export function withSort(preferences: HomeListPreferences, sort: HomeSortKey): HomeListPreferences {
	return { ...preferences, sort, secondary: reconcileSecondary(sort, preferences.secondary) };
}

/** 絞り込みで選んでいる数（ツールバーのチップに添える）。検索語と種類は数えない（種類は呼び名で出す）。 */
export function filterCount(filter: Pick<PcListFilter, 'states' | 'spaces'>): number {
	return filter.states.length + filter.spaces.length;
}

/** 種類を絞っているときの呼び名（ツールバーのチップに出す）。絞っていなければ undefined。 */
export function kindLabel(kind: PcListKind): string | undefined {
	return kind === 'all' ? undefined : PC_LIST_KIND_OPTIONS.find(option => option.value === kind)?.label;
}

/** 状態の絞り込みが効くか（ターミナルだけを出しているときは状態を見ない）。 */
export function statesApply(filter: Pick<PcListFilter, 'kind'>): boolean {
	return filter.kind !== 'terminal';
}

/** 行がエージェントか（PC がエージェントとして見つけたターミナル）。 */
function isAgentTerminal(terminal: PcListTerminal): boolean {
	return terminal.agent === true;
}

/** 選択を1つ足す／外す（新しい配列を返す）。 */
export function toggleValue<T>(values: readonly T[], value: T): T[] {
	return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

/**
 * ターミナルが属するスペースを引く。ws 未タグのものは PC 側のアクティブなスペース、それも無ければ
 * 先頭のスペースに属するとみなす（旧ホームと同じ規則。PC のスペース切り替え中は ws が一時的に落ちる）。
 */
export function resolveTerminalSpace<S extends PcListSpace>(
	terminal: { readonly ws?: string },
	spaces: readonly S[],
	activeWs: string | undefined,
): S | undefined {
	const byId = (id: string | undefined) => (id === undefined ? undefined : spaces.find(space => space.id === id));
	return byId(terminal.ws) ?? byId(activeWs) ?? spaces[0];
}

function matchesQuery(query: string, terminal: PcListTerminal, space: PcListSpace | undefined): boolean {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) {
		return true;
	}
	const haystack = [terminal.title, space?.name, space?.branch].filter((part): part is string => typeof part === 'string').join('\n').toLowerCase();
	return haystack.includes(needle);
}

export interface BuildPcListInput<T extends PcListTerminal> {
	readonly terminals: readonly T[];
	readonly spaces: readonly PcListSpace[];
	readonly activeWs: string | undefined;
	readonly archivedKeys: ReadonlySet<string>;
	readonly pinnedKeys: ReadonlySet<string>;
	readonly preferences: HomeListPreferences;
	readonly group: PcListGroup;
	readonly filter: PcListFilter;
}

/**
 * 段（見出しと行）を組み立てる。
 *
 * - アーカイブしたものは載せない（アーカイブの一覧は別に出す）
 * - ピン留めは先頭の「ピン留め」の段にまとめ、他の段には出さない
 * - スペースの段は PC から届いた順。絞り込みも検索もしていないときだけ、ターミナルの無いスペースも
 *   空の段として残す（絞り込み中に出すと「該当しないのに出ている」ように見える）
 * - 行の無い段は返さない
 */
export function buildPcList<T extends PcListTerminal>(input: BuildPcListInput<T>): PcListSection<T>[] {
	const { terminals, spaces, activeWs, archivedKeys, pinnedKeys, preferences, group, filter } = input;
	const spaceIndex = new Map(spaces.map((space, index) => [space.id, index]));
	const live = terminals.filter(terminal => !archivedKeys.has(pinKeyForTerminal(terminal)));
	const filtered = live.filter(terminal => {
		const space = resolveTerminalSpace(terminal, spaces, activeWs);
		const agent = isAgentTerminal(terminal);
		if ((filter.kind === 'agent' && !agent) || (filter.kind === 'terminal' && agent)) {
			return false;
		}
		// 状態はエージェントにだけ効く。ふつうのターミナルは状態を持たないので、状態を選んでいれば出さない
		// （以前は「待機」に混ざっていた）。
		if (statesApply(filter) && filter.states.length > 0 && (!agent || !filter.states.includes(statusBucket(terminal.agentStatus)))) {
			return false;
		}
		if (filter.spaces.length > 0 && (space === undefined || !filter.spaces.includes(space.id))) {
			return false;
		}
		return matchesQuery(filter.query, terminal, space);
	});
	const isPinned = (terminal: T) => pinnedKeys.has(pinKeyForTerminal(terminal));
	// ピン留めは自前の段で先頭に出すので、並びの中では先頭へ寄せない。
	const sorted = arrangeHomeRows(filtered, { ...preferences, pinFirst: false }, {
		spaceIndexOf: terminal => {
			const space = resolveTerminalSpace(terminal, spaces, activeWs);
			return space !== undefined ? spaceIndex.get(space.id) : undefined;
		},
		isPinned,
	});
	const toRow = (terminal: T): PcListRow<T> => ({ terminal, space: resolveTerminalSpace(terminal, spaces, activeWs), pinned: isPinned(terminal) });
	const pinnedRows = sorted.filter(isPinned).map(toRow);
	const restRows = sorted.filter(terminal => !isPinned(terminal)).map(toRow);

	const sections: PcListSection<T>[] = [];
	if (pinnedRows.length > 0) {
		sections.push({ key: 'pinned', kind: 'pinned', title: 'ピン留め', rows: pinnedRows });
	}
	if (group === 'state') {
		for (const { bucket, title } of STATE_SECTIONS) {
			const rows = restRows.filter(row => statusBucket(row.terminal.agentStatus) === bucket);
			if (rows.length > 0) {
				sections.push({ key: `state:${bucket}`, kind: 'state', title, bucket, rows });
			}
		}
		return sections;
	}
	if (group === 'space') {
		const unfiltered = filter.kind === 'all' && filter.states.length === 0 && filter.query.trim().length === 0;
		const occupied = new Set(live.map(terminal => resolveTerminalSpace(terminal, spaces, activeWs)?.id));
		for (const space of spaces) {
			if (filter.spaces.length > 0 && !filter.spaces.includes(space.id)) {
				continue;
			}
			const rows = restRows.filter(row => row.space?.id === space.id);
			const emptySpace = !occupied.has(space.id);
			if (rows.length > 0 || (emptySpace && unfiltered)) {
				sections.push({ key: `space:${space.id}`, kind: 'space', title: space.name, space, rows, ...(emptySpace ? { emptySpace: true } : {}) });
			}
		}
		// どのスペースにも解決できなかった行（スペースが1つも届いていない間）を落とさない。
		const orphans = restRows.filter(row => row.space === undefined);
		if (orphans.length > 0) {
			sections.push({ key: 'all', kind: 'all', title: 'その他', rows: orphans });
		}
		return sections;
	}
	if (restRows.length > 0) {
		sections.push({ key: 'all', kind: 'all', title: pinnedRows.length > 0 ? 'エージェント' : undefined, rows: restRows });
	}
	return sections;
}

/** アーカイブした行（新しくしまったものほど下。PC から届いた順のまま）。 */
export function archivedTerminals<T extends PcListTerminal>(terminals: readonly T[], archivedKeys: ReadonlySet<string>): T[] {
	return terminals.filter(terminal => archivedKeys.has(pinKeyForTerminal(terminal)));
}
