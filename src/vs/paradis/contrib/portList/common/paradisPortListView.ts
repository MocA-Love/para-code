/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポート一覧のパネルの「並び」と「プロセスごとのまとめ」。DOM を持たない純関数だけを置く
// （パネルは electron-browser/paradisPortListPanel.ts）。選んだ並びはパネルが IStorageService に保存し、
// 読むときはここの paradisParsePortListView で確かめる（知らない値は既定に落とす）。

import { IParadisPortEntry } from './paradisPortList.js';

/** 並び替えの列。`scope` は公開の範囲（昇順で全公開が上）。 */
export type ParadisPortSortKey = 'port' | 'process' | 'pid' | 'scope';

export type ParadisPortSortDirection = 'asc' | 'desc';

export interface IParadisPortListView {
	readonly sortKey: ParadisPortSortKey;
	readonly sortDirection: ParadisPortSortDirection;
	/** 同じプロセス名の行を 1 つの見出しにまとめる。 */
	readonly grouped: boolean;
}

export const PARADIS_PORT_LIST_DEFAULT_VIEW: IParadisPortListView = { sortKey: 'port', sortDirection: 'asc', grouped: false };

const SORT_KEYS: readonly ParadisPortSortKey[] = ['port', 'process', 'pid', 'scope'];

/** 保存してあった並びを読む。壊れた値・知らない値は項目ごとに既定へ落とす。 */
export function paradisParsePortListView(raw: string | undefined): IParadisPortListView {
	if (!raw) {
		return PARADIS_PORT_LIST_DEFAULT_VIEW;
	}
	let stored: Partial<Record<keyof IParadisPortListView, unknown>>;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) {
			return PARADIS_PORT_LIST_DEFAULT_VIEW;
		}
		stored = parsed;
	} catch {
		return PARADIS_PORT_LIST_DEFAULT_VIEW;
	}
	const sortKey = SORT_KEYS.find(key => key === stored.sortKey) ?? PARADIS_PORT_LIST_DEFAULT_VIEW.sortKey;
	const sortDirection = stored.sortDirection === 'desc' ? 'desc' : stored.sortDirection === 'asc' ? 'asc' : PARADIS_PORT_LIST_DEFAULT_VIEW.sortDirection;
	return { sortKey, sortDirection, grouped: stored.grouped === true };
}

/** 列の見出しを押した後の並び。同じ列なら昇順と降順を入れ替え、別の列ならその列の昇順にする。 */
export function paradisNextPortSort(view: IParadisPortListView, key: ParadisPortSortKey): IParadisPortListView {
	if (view.sortKey !== key) {
		return { ...view, sortKey: key, sortDirection: 'asc' };
	}
	return { ...view, sortDirection: view.sortDirection === 'asc' ? 'desc' : 'asc' };
}

function compareText(first: string, second: string): number {
	return first < second ? -1 : first > second ? 1 : 0;
}

function compareByKey(first: IParadisPortEntry, second: IParadisPortEntry, key: ParadisPortSortKey): number {
	switch (key) {
		case 'port': return first.port - second.port;
		case 'pid': return first.pid - second.pid;
		case 'process': return compareText(first.processName.toLowerCase(), second.processName.toLowerCase());
		case 'scope': return Number(second.risky) - Number(first.risky);
	}
}

/**
 * 行を並べ替えた新しい配列を返す。選んだ列が同じ行は、いつもポート・PID・アドレスの昇順で決める
 * （一覧は数秒ごとに描き直すので、同じ値の行が入れ替わって見えないよう、順序を 1 通りに決める）。
 */
export function paradisSortPortEntries(entries: readonly IParadisPortEntry[], key: ParadisPortSortKey, direction: ParadisPortSortDirection): IParadisPortEntry[] {
	const sign = direction === 'asc' ? 1 : -1;
	return [...entries].sort((first, second) =>
		sign * compareByKey(first, second, key)
		|| first.port - second.port
		|| first.pid - second.pid
		|| compareText(first.address, second.address));
}

export interface IParadisPortGroup {
	readonly processName: string;
	readonly entries: readonly IParadisPortEntry[];
	/** この中に全公開の行があるか（畳んだ見出しにも札を出すため）。 */
	readonly risky: boolean;
}

/**
 * 並べ替え済みの行を、プロセス名ごとにまとめる。まとまりの順は、その中の最初の行が出てきた順
 * （＝選んだ並びで一番上に来る行の位置）。まとまりの中の行の順は変えない。
 */
export function paradisGroupPortEntries(sortedEntries: readonly IParadisPortEntry[]): IParadisPortGroup[] {
	const byName = new Map<string, IParadisPortEntry[]>();
	for (const entry of sortedEntries) {
		const list = byName.get(entry.processName);
		if (list) {
			list.push(entry);
		} else {
			byName.set(entry.processName, [entry]);
		}
	}
	return [...byName].map(([processName, entries]) => ({ processName, entries, risky: entries.some(entry => entry.risky) }));
}
