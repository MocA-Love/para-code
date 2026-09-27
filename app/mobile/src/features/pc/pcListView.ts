// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { HomeStatusBucket } from '../../homeSort.js';
import { DEFAULT_PC_LIST_GROUP, EMPTY_PC_LIST_FILTER, PC_LIST_GROUP_OPTIONS, STATE_SECTIONS, type PcListFilter, type PcListGroup } from './pcList.js';

/**
 * PC の画面の一覧の表示条件のうち、アプリを終了しても残すもの（保存形式と、その読み書きの純関数）。
 * 読み書きと保存は `pcListViewStore.ts`。
 *
 * 残すもの:
 *  - グループ（全体で1つ）。並び順は既存の `homeListPreferences`（`appState.ts`）が全体で1つ持っているので、
 *    それと同じ単位にする。「一覧をどう読むか」は利用者の癖で、PC ごとに変える理由が薄く、
 *    新しく足した PC にもそのまま効いてほしい
 *  - 絞り込みの状態とスペース、畳んだ段（PC ごと）。スペースの ID と段の鍵（`space:<id>`）は PC の中でしか
 *    意味を持たない。状態の絞り込みは同じシートでスペースと一緒に選び、「クリア」で一緒に消えるので、同じ単位に揃える
 *
 * 残さないもの: 検索語と検索欄を開いているか（その場の入力。次に開いたとき前の語で絞られていると
 * 「エージェントが消えた」ように見える）。これはストアのメモリにだけ置き、iPad の2列 ⇄ 1列の切り替えでは残す。
 */

/** PC ごとに残す表示条件。 */
export interface PcListViewOfPc {
	readonly states: readonly HomeStatusBucket[];
	readonly spaces: readonly string[];
	/** 畳んだ段の鍵（`PcListSection.key`）。 */
	readonly collapsed: readonly string[];
}

/** 保存する形。 */
export interface PcListViewSaved {
	readonly group: PcListGroup;
	readonly byPc: Readonly<Record<string, PcListViewOfPc>>;
}

export const EMPTY_PC_LIST_VIEW_OF_PC: PcListViewOfPc = { states: [], spaces: [], collapsed: [] };

export const DEFAULT_PC_LIST_VIEW: PcListViewSaved = { group: DEFAULT_PC_LIST_GROUP, byPc: {} };

/** 1つの PC に残す鍵の数の上限（閉じたスペースの鍵が溜まり続けないように。超えたら古いものから落とす）。 */
export const MAX_PC_LIST_VIEW_KEYS = 64;

const BUCKETS: ReadonlySet<string> = new Set(STATE_SECTIONS.map(section => section.bucket));
const GROUPS: ReadonlySet<string> = new Set(PC_LIST_GROUP_OPTIONS.map(option => option.value));

function uniqueStrings(value: unknown, accept: (item: string) => boolean): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === 'string' && item.length > 0 && accept(item) && !out.includes(item)) {
			out.push(item);
		}
	}
	return out.slice(-MAX_PC_LIST_VIEW_KEYS);
}

function isEmptyView(view: PcListViewOfPc): boolean {
	return view.states.length === 0 && view.spaces.length === 0 && view.collapsed.length === 0;
}

/** 保存値を読む。壊れた値・知らない値は捨てて既定に寄せる。 */
export function parsePcListView(raw: unknown): PcListViewSaved {
	if (typeof raw !== 'object' || raw === null) {
		return DEFAULT_PC_LIST_VIEW;
	}
	const record = raw as { group?: unknown; byPc?: unknown };
	const group = typeof record.group === 'string' && GROUPS.has(record.group) ? record.group as PcListGroup : DEFAULT_PC_LIST_GROUP;
	const byPc: Record<string, PcListViewOfPc> = {};
	if (typeof record.byPc === 'object' && record.byPc !== null && !Array.isArray(record.byPc)) {
		for (const [pcId, value] of Object.entries(record.byPc as Record<string, unknown>)) {
			if (typeof value !== 'object' || value === null) {
				continue;
			}
			const entry = value as { states?: unknown; spaces?: unknown; collapsed?: unknown };
			const view: PcListViewOfPc = {
				states: uniqueStrings(entry.states, item => BUCKETS.has(item)) as HomeStatusBucket[],
				spaces: uniqueStrings(entry.spaces, () => true),
				collapsed: uniqueStrings(entry.collapsed, () => true),
			};
			if (!isEmptyView(view)) {
				byPc[pcId] = view;
			}
		}
	}
	return { group, byPc };
}

/** PC の表示条件（無ければ空）。 */
export function pcListViewOf(saved: PcListViewSaved, pcId: string | undefined): PcListViewOfPc {
	return (pcId !== undefined ? saved.byPc[pcId] : undefined) ?? EMPTY_PC_LIST_VIEW_OF_PC;
}

/** PC の表示条件を書き換える。空になったら項目ごと消す（保存値に空の PC を溜めない）。 */
export function withPcListView(saved: PcListViewSaved, pcId: string, edit: (view: PcListViewOfPc) => PcListViewOfPc): PcListViewSaved {
	const edited = edit(pcListViewOf(saved, pcId));
	const next: PcListViewOfPc = {
		states: edited.states.slice(-MAX_PC_LIST_VIEW_KEYS),
		spaces: edited.spaces.slice(-MAX_PC_LIST_VIEW_KEYS),
		collapsed: edited.collapsed.slice(-MAX_PC_LIST_VIEW_KEYS),
	};
	const byPc = { ...saved.byPc };
	if (isEmptyView(next)) {
		delete byPc[pcId];
	} else {
		byPc[pcId] = next;
	}
	return { ...saved, byPc };
}

/** ペアリングを解除した PC の分を消す。 */
export function withoutPc(saved: PcListViewSaved, pcId: string): PcListViewSaved {
	if (saved.byPc[pcId] === undefined) {
		return saved;
	}
	const byPc = { ...saved.byPc };
	delete byPc[pcId];
	return { ...saved, byPc };
}

/** 同じ項目が同じ順で並んでいるか。 */
export function sameItems(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** 段を畳む／開く（畳んでいれば外し、無ければ末尾に足す）。 */
export function toggleCollapsedKey(collapsed: readonly string[], key: string): string[] {
	return collapsed.includes(key) ? collapsed.filter(item => item !== key) : [...collapsed, key];
}

/**
 * 画面に効かせる絞り込み（保存した条件＋その場の検索語）を作る。
 *
 * 選んでいたスペースが PC 側で閉じられて一覧に無ければ、そのスペースの条件は外して見せる
 * （絞り込みのシートにはいまあるスペースしか並ばず、外す手段が無いまま一覧が空になるため）。
 * スペースがまだ1つも届いていない間（接続中）は外さない。保存値そのものは書き換えない
 * （同じ ID のスペースがまた届けば、そのまま効く）。
 */
export function effectivePcListFilter(view: PcListViewOfPc, query: string, spaceIds: readonly string[]): PcListFilter {
	const spaces = spaceIds.length > 0 ? view.spaces.filter(id => spaceIds.includes(id)) : view.spaces;
	return { ...EMPTY_PC_LIST_FILTER, states: view.states, spaces, query };
}
