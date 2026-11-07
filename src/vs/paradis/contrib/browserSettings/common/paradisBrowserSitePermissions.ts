/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「サイトの権限」の一覧の中身。権限はタブの保存先（プロファイル）ごとに記録されるので、開いているタブの
// 記録を集め、保存先とサイトの組ごとに 1 行にまとめる（同じ保存先のタブは同じ記録を持つ）。

import { ALL_PERMISSION_CATEGORIES, IPermissionGrant, PermissionCategory, PermissionDecision } from '../../../../platform/browserView/common/browserPermissions.js';

export interface IParadisSitePermissionSource {
	/** タブ（ビュー）の ID。毎回確認に戻すときに、このタブの記録へ書く。 */
	readonly id: string;
	/** タブの保存先を見分ける鍵（名前付きのプロファイルの ID か、組み込みの保存先の種類）。 */
	readonly profileKey: string;
	/** 一覧に出す保存先の名前。 */
	readonly profileLabel: string;
	readonly grants: readonly IPermissionGrant[];
}

export interface IParadisSitePermissionRow {
	readonly origin: string;
	readonly profileKey: string;
	readonly profileLabel: string;
	/** 分類の順（本家の並び）にそろえた記録。 */
	readonly decisions: readonly { readonly category: PermissionCategory; readonly state: PermissionDecision }[];
	/** この記録を持つタブ。同じ保存先のタブは同じ記録を持つ。 */
	readonly viewIds: readonly string[];
}

const CATEGORY_ORDER = new Map(ALL_PERMISSION_CATEGORIES.map((category, index) => [category, index]));

export function paradisCollectSitePermissions(sources: readonly IParadisSitePermissionSource[]): IParadisSitePermissionRow[] {
	const rows = new Map<string, { origin: string; profileKey: string; profileLabel: string; decisions: { category: PermissionCategory; state: PermissionDecision }[]; viewIds: string[] }>();
	for (const source of sources) {
		const byOrigin = new Map<string, { category: PermissionCategory; state: PermissionDecision }[]>();
		for (const grant of source.grants) {
			const list = byOrigin.get(grant.origin) ?? [];
			list.push({ category: grant.category, state: grant.state });
			byOrigin.set(grant.origin, list);
		}
		for (const [origin, decisions] of byOrigin) {
			decisions.sort((a, b) => (CATEGORY_ORDER.get(a.category) ?? 99) - (CATEGORY_ORDER.get(b.category) ?? 99));
			const key = `${source.profileKey}\n${origin}`;
			const row = rows.get(key);
			if (row) {
				row.viewIds.push(source.id);
			} else {
				rows.set(key, { origin, profileKey: source.profileKey, profileLabel: source.profileLabel, decisions, viewIds: [source.id] });
			}
		}
	}
	return [...rows.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.profileLabel.localeCompare(b.profileLabel));
}
