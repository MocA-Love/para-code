/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.tabGroups と tabs.group・tabs.ungroup の中身（タブのグループの台帳）。
//
// 内蔵ブラウザのタブはエディタのタブで、Chrome のタブのグループに当たるものが無い（エディタのグループは
// 画面の分割で、拡張機能に並べ替えさせてよいものではない）。そこで、グループは拡張機能ごと・セッションごとの
// メモリ上の台帳として持ち、画面には何も出さない。
//  - 拡張機能ごと: ほかの拡張機能が作ったグループは見えない（groupId も -1 に見える）。グループの名前に
//    作業の中身を書く拡張機能（Claude など）がいるため、ほかの拡張機能へ漏らさない
//  - メモリ上: Para Code を終えると消える。Chrome でもグループの id は起動ごとに変わるので、拡張機能は
//    tabGroups.get で確かめて作り直す
//  - タブは動かさない: グループに入れても、別のウィンドウへ移したり並べ替えたりはしない（tabGroups.move は
//    同じウィンドウなら何もせずに答え、別のウィンドウへは断る）

/** chrome.tabGroups.Color の値（Chrome と同じ並び）。 */
export const PARADIS_TAB_GROUP_COLORS: readonly string[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** Chrome の形のタブのグループ。 */
export interface IParadisTabGroup {
	readonly id: number;
	readonly windowId: number;
	readonly title: string;
	readonly color: string;
	readonly collapsed: boolean;
	readonly shared: boolean;
}

interface IGroupRecord {
	readonly id: number;
	readonly windowId: number;
	title: string;
	color: string;
	collapsed: boolean;
	readonly tabs: Set<number>;
}

/** 台帳を変えた結果（呼び出し側がイベントにする）。 */
export interface IParadisTabGroupChanges {
	readonly created: IParadisTabGroup[];
	readonly removed: IParadisTabGroup[];
	/** グループが替わったタブ（新しい groupId。外れたら -1）。 */
	readonly tabs: { readonly tabId: number; readonly groupId: number }[];
}

function snapshot(record: IGroupRecord): IParadisTabGroup {
	return { id: record.id, windowId: record.windowId, title: record.title, color: record.color, collapsed: record.collapsed, shared: false };
}

/**
 * タブのグループの台帳。持ち主（セッションと拡張機能の組）ごとに分ける。持ち主のセッションは呼び出し側の
 * オブジェクトをそのまま鍵にする（WeakMap）。
 */
export class ParadisTabGroupLedger {

	private readonly _owners = new WeakMap<object, Map<string, Map<number, IGroupRecord>>>();
	/** id は Chrome と同じく正の整数で、起動の間は使い回さない。 */
	private _nextId = 1;

	private _groups(session: object, extensionId: string, create: boolean): Map<number, IGroupRecord> | undefined {
		let bySession = this._owners.get(session);
		if (!bySession && create) {
			bySession = new Map();
			this._owners.set(session, bySession);
		}
		let groups = bySession?.get(extensionId);
		if (!groups && create && bySession) {
			groups = new Map();
			bySession.set(extensionId, groups);
		}
		return groups;
	}

	/** タブのグループの id（入っていなければ -1）。 */
	groupOf(session: object, extensionId: string, tabId: number): number {
		for (const group of this._groups(session, extensionId, false)?.values() ?? []) {
			if (group.tabs.has(tabId)) {
				return group.id;
			}
		}
		return -1;
	}

	get(session: object, extensionId: string, groupId: number): IParadisTabGroup | undefined {
		const record = this._groups(session, extensionId, false)?.get(groupId);
		return record ? snapshot(record) : undefined;
	}

	list(session: object, extensionId: string): IParadisTabGroup[] {
		return [...this._groups(session, extensionId, false)?.values() ?? []].map(snapshot);
	}

	/** グループのタブ（入れた順）。 */
	tabsOf(session: object, extensionId: string, groupId: number): number[] {
		return [...this._groups(session, extensionId, false)?.get(groupId)?.tabs ?? []];
	}

	/**
	 * タブをグループへ入れる。`groupId` が無ければ、`windowId` のウィンドウに新しいグループを作る。答えは入れた
	 * グループの id と、変わったもの。
	 */
	group(session: object, extensionId: string, tabIds: readonly number[], groupId: number | undefined, windowId: number): { readonly groupId: number; readonly changes: IParadisTabGroupChanges } {
		const groups = this._groups(session, extensionId, true)!;
		const created: IParadisTabGroup[] = [];
		let target: IGroupRecord | undefined;
		if (groupId !== undefined) {
			target = groups.get(groupId);
			if (!target) {
				throw new Error(`No group with id: ${groupId}.`);
			}
		} else {
			// Chrome と同じく、使われている数が一番少ない色から選ぶ
			const used = new Map(PARADIS_TAB_GROUP_COLORS.map(color => [color, 0]));
			for (const group of groups.values()) {
				used.set(group.color, (used.get(group.color) ?? 0) + 1);
			}
			const color = [...used.entries()].reduce((best, entry) => entry[1] < best[1] ? entry : best)[0];
			target = { id: this._nextId++, windowId, title: '', color, collapsed: false, tabs: new Set() };
			groups.set(target.id, target);
			created.push(snapshot(target));
		}
		const into = target;
		const moved = [...new Set(tabIds)].filter(tabId => !into.tabs.has(tabId));
		const removed = this._take(groups, moved, into.id);
		for (const tabId of moved) {
			into.tabs.add(tabId);
		}
		return { groupId: into.id, changes: { created, removed, tabs: moved.map(tabId => ({ tabId, groupId: into.id })) } };
	}

	/** タブをグループから外す（空になったグループは消す）。 */
	ungroup(session: object, extensionId: string, tabIds: readonly number[]): IParadisTabGroupChanges {
		const groups = this._groups(session, extensionId, false);
		if (!groups) {
			return { created: [], removed: [], tabs: [] };
		}
		const grouped = [...new Set(tabIds)].filter(tabId => [...groups.values()].some(group => group.tabs.has(tabId)));
		return { created: [], removed: this._take(groups, grouped, undefined), tabs: grouped.map(tabId => ({ tabId, groupId: -1 })) };
	}

	/** タブを今のグループ（`keep` 以外）から抜く。空になったグループは消して返す。 */
	private _take(groups: Map<number, IGroupRecord>, tabIds: readonly number[], keep: number | undefined): IParadisTabGroup[] {
		const removed: IParadisTabGroup[] = [];
		for (const group of [...groups.values()]) {
			if (group.id === keep) {
				continue;
			}
			for (const tabId of tabIds) {
				group.tabs.delete(tabId);
			}
			if (group.tabs.size === 0) {
				groups.delete(group.id);
				removed.push(snapshot(group));
			}
		}
		return removed;
	}

	/** tabGroups.update（色は Color のどれか）。 */
	update(session: object, extensionId: string, groupId: number, properties: { readonly title?: string; readonly color?: string; readonly collapsed?: boolean }): IParadisTabGroup {
		const record = this._groups(session, extensionId, false)?.get(groupId);
		if (!record) {
			throw new Error(`No group with id: ${groupId}.`);
		}
		if (properties.color !== undefined && !PARADIS_TAB_GROUP_COLORS.includes(properties.color)) {
			throw new Error(`Invalid color: ${properties.color}.`);
		}
		record.title = properties.title ?? record.title;
		record.color = properties.color ?? record.color;
		record.collapsed = properties.collapsed ?? record.collapsed;
		return snapshot(record);
	}

	/** タブが閉じた: どの持ち主のグループからも抜く。空になったグループを持ち主ごとに返す。 */
	forgetTab(session: object, tabId: number): { readonly extensionId: string; readonly removed: IParadisTabGroup[] }[] {
		const result: { readonly extensionId: string; readonly removed: IParadisTabGroup[] }[] = [];
		for (const [extensionId, groups] of this._owners.get(session) ?? []) {
			const removed = this._take(groups, [tabId], undefined);
			if (removed.length > 0) {
				result.push({ extensionId, removed });
			}
		}
		return result;
	}

	/** 拡張機能を外した: その拡張機能のグループを忘れる。 */
	forgetExtension(session: object, extensionId: string): void {
		this._owners.get(session)?.delete(extensionId);
	}
}
