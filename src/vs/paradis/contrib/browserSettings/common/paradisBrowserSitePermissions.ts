/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「サイトの権限」の一覧の中身。権限はタブの保存先（プロファイル）ごとに記録されるので、開いているタブの
// 記録を集めてサイトごとにまとめる。同じサイトを別の保存先で違う内容にしていたら、別の行にする。

import { ALL_PERMISSION_CATEGORIES, IPermissionGrant, PermissionCategory, PermissionDecision } from '../../../../platform/browserView/common/browserPermissions.js';

export interface IParadisSitePermissionSource {
	/** タブ（ビュー）の ID。毎回確認に戻すときに、このタブの記録へ書く。 */
	readonly id: string;
	readonly grants: readonly IPermissionGrant[];
}

export interface IParadisSitePermissionRow {
	readonly origin: string;
	/** 分類の順（本家の並び）にそろえた記録。 */
	readonly decisions: readonly { readonly category: PermissionCategory; readonly state: PermissionDecision }[];
	/** この記録を持つタブ。同じ保存先のタブは同じ記録を持つ。 */
	readonly viewIds: readonly string[];
}

const CATEGORY_ORDER = new Map(ALL_PERMISSION_CATEGORIES.map((category, index) => [category, index]));

export function paradisCollectSitePermissions(sources: readonly IParadisSitePermissionSource[]): IParadisSitePermissionRow[] {
	const rows = new Map<string, { origin: string; decisions: { category: PermissionCategory; state: PermissionDecision }[]; viewIds: string[] }>();
	for (const source of sources) {
		const byOrigin = new Map<string, { category: PermissionCategory; state: PermissionDecision }[]>();
		for (const grant of source.grants) {
			const list = byOrigin.get(grant.origin) ?? [];
			list.push({ category: grant.category, state: grant.state });
			byOrigin.set(grant.origin, list);
		}
		for (const [origin, decisions] of byOrigin) {
			decisions.sort((a, b) => (CATEGORY_ORDER.get(a.category) ?? 99) - (CATEGORY_ORDER.get(b.category) ?? 99));
			const key = `${origin}\n${decisions.map(d => `${d.category}=${d.state}`).join(',')}`;
			const row = rows.get(key);
			if (row) {
				row.viewIds.push(source.id);
			} else {
				rows.set(key, { origin, decisions, viewIds: [source.id] });
			}
		}
	}
	return [...rows.values()].sort((a, b) => a.origin.localeCompare(b.origin));
}
