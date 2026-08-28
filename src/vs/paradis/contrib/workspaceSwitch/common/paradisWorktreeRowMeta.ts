/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';

/**
 * Workspaces ツリーの worktree 行に出す「メタ情報」の並び (案E: メタ専用段)。
 *
 * 行は常に「名前 + エージェントのドット列」「ブランチ名」の2段で、メタ情報を1つでも
 * 持つ行だけ3段目 (メタ段) が生えて高くなる。どの情報を出すか・どの順で出すか・
 * 左右どちらへ寄せるかはユーザー設定 (PARADIS_WORKTREE_ROW_META_SETTING_ID) で決まり、
 * 全部を非表示にすればメタ段ごと消えて従来の2段表示に戻る。
 *
 * ここは描画にも行の高さ計算にも共通で使う純粋ロジックだけを置く (DOM を持たない)。
 */

export const PARADIS_WORKTREE_ROW_META_SETTING_ID = 'paradis.workspaceSwitch.rowMeta';

/** メタ段に並べられる情報の種類。 */
export type ParadisWorktreeMetaId = 'pr' | 'issues' | 'diff' | 'notes';

/** メタ段の中での寄せ方向。left は左端から、right は右端から詰める。 */
export type ParadisWorktreeMetaAlign = 'left' | 'right';

export interface IParadisWorktreeMetaEntry {
	readonly id: ParadisWorktreeMetaId;
	readonly visible: boolean;
	readonly align: ParadisWorktreeMetaAlign;
}

/** その行が実際にその情報を持っているか (設定による表示/非表示とは独立)。 */
export interface IParadisWorktreeMetaPresence {
	readonly pr: boolean;
	readonly issues: boolean;
	readonly diff: boolean;
	readonly notes: boolean;
}

export const PARADIS_WORKTREE_META_IDS: readonly ParadisWorktreeMetaId[] = ['pr', 'issues', 'diff', 'notes'];

// 設定レジストリの default としても、正規化の戻り値としても使う同じ実体なので凍結する。
// (getValue 経由で受け取った側が書き換えると、以降の既定値が全ウィンドウで壊れる)
export const PARADIS_DEFAULT_WORKTREE_ROW_META: readonly IParadisWorktreeMetaEntry[] = Object.freeze([
	Object.freeze({ id: 'pr', visible: true, align: 'left' }),
	Object.freeze({ id: 'issues', visible: true, align: 'left' }),
	Object.freeze({ id: 'diff', visible: true, align: 'right' }),
	Object.freeze({ id: 'notes', visible: true, align: 'right' }),
] as const);

/** メタ段を持たない行 (2段) の高さ。 */
export const PARADIS_WORKTREE_ROW_HEIGHT = 44;
/** メタ段を持つ行 (3段) の高さ。 */
export const PARADIS_WORKTREE_ROW_HEIGHT_WITH_META = 60;

export function paradisWorktreeMetaLabel(id: ParadisWorktreeMetaId): string {
	switch (id) {
		// allow-any-unicode-next-line
		case 'pr': return localize('paradis.rowMeta.pr', "プルリクエスト");
		// allow-any-unicode-next-line
		case 'issues': return localize('paradis.rowMeta.issues', "Issue 件数");
		// allow-any-unicode-next-line
		case 'diff': return localize('paradis.rowMeta.diff', "未コミットの差分");
		// allow-any-unicode-next-line
		case 'notes': return localize('paradis.rowMeta.notes', "メモの未完了件数");
	}
}

function isMetaId(value: unknown): value is ParadisWorktreeMetaId {
	return typeof value === 'string' && (PARADIS_WORKTREE_META_IDS as readonly string[]).includes(value);
}

/**
 * 設定値 (ユーザーが settings.json を直接編集できる) を、必ず4項目ちょうど・重複なしの
 * 並びへ正規化する。壊れた値・欠けた項目は既定で補い、知らない id は捨てる。
 * 設定エディタや手書きの JSON がどんな形でも描画側が破綻しないための境界。
 */
export function paradisNormalizeWorktreeRowMeta(value: unknown): readonly IParadisWorktreeMetaEntry[] {
	if (!Array.isArray(value)) {
		return PARADIS_DEFAULT_WORKTREE_ROW_META;
	}
	const seen = new Set<ParadisWorktreeMetaId>();
	const entries: IParadisWorktreeMetaEntry[] = [];
	for (const raw of value) {
		if (typeof raw !== 'object' || raw === null) {
			continue;
		}
		const candidate = raw as { id?: unknown; visible?: unknown; align?: unknown };
		if (!isMetaId(candidate.id) || seen.has(candidate.id)) {
			continue;
		}
		seen.add(candidate.id);
		const fallback = PARADIS_DEFAULT_WORKTREE_ROW_META.find(entry => entry.id === candidate.id)!;
		entries.push({
			id: candidate.id,
			visible: typeof candidate.visible === 'boolean' ? candidate.visible : fallback.visible,
			align: candidate.align === 'left' || candidate.align === 'right' ? candidate.align : fallback.align,
		});
	}
	// 設定に書かれていない項目は既定の順序を保ったまま末尾へ足す (項目が消えたままにしない)
	for (const fallback of PARADIS_DEFAULT_WORKTREE_ROW_META) {
		if (!seen.has(fallback.id)) {
			entries.push(fallback);
		}
	}
	return entries;
}

/** 設定上「出す」ことになっていて、かつその行が実際に持っている情報か。 */
export function paradisWorktreeMetaShown(entries: readonly IParadisWorktreeMetaEntry[], presence: IParadisWorktreeMetaPresence, id: ParadisWorktreeMetaId): boolean {
	const entry = entries.find(candidate => candidate.id === id);
	return !!entry?.visible && presence[id];
}

/** メタ段を出すべき行か (= 3段になるか)。行の高さもこの判定で決まる。 */
export function paradisWorktreeRowHasMeta(entries: readonly IParadisWorktreeMetaEntry[], presence: IParadisWorktreeMetaPresence): boolean {
	return PARADIS_WORKTREE_META_IDS.some(id => paradisWorktreeMetaShown(entries, presence, id));
}

export function paradisWorktreeRowHeight(entries: readonly IParadisWorktreeMetaEntry[], presence: IParadisWorktreeMetaPresence): number {
	return paradisWorktreeRowHasMeta(entries, presence) ? PARADIS_WORKTREE_ROW_HEIGHT_WITH_META : PARADIS_WORKTREE_ROW_HEIGHT;
}

/** メタ段に置く DOM の並び (左寄せ群 → spacer → 右寄せ群)。表示/非表示は呼び出し側が hidden で表す。 */
export function paradisWorktreeMetaOrder(entries: readonly IParadisWorktreeMetaEntry[]): { readonly left: readonly ParadisWorktreeMetaId[]; readonly right: readonly ParadisWorktreeMetaId[] } {
	return {
		left: entries.filter(entry => entry.align === 'left').map(entry => entry.id),
		right: entries.filter(entry => entry.align === 'right').map(entry => entry.id),
	};
}

/** 指定した項目を1つ前 / 1つ後ろへ動かした新しい並びを返す (端では元の並びをそのまま返す)。 */
/**
 * 並びを1つ動かす。**同じ寄せ (左/右) の中の隣**と入れ替える。
 *
 * 配列は平坦に持つが、描画は寄せごとに2群へ分かれる (paradisWorktreeMetaOrder)。素朴に
 * 配列の隣と入れ替えると、群をまたいだときに配列だけ変わって見た目が一切変わらない
 * (既定の [pr(左), issues(左), diff(右), notes(右)] で「issues を下へ」を押すと
 * [pr, diff, issues, notes] になるが、左群も右群も並びは元のまま) 。押しても何も起きない
 * メニュー項目にしないため、動かす相手は同じ群の中から探す。
 */
export function paradisMoveWorktreeMeta(entries: readonly IParadisWorktreeMetaEntry[], id: ParadisWorktreeMetaId, delta: -1 | 1): readonly IParadisWorktreeMetaEntry[] {
	const index = entries.findIndex(entry => entry.id === id);
	if (index < 0) {
		return entries;
	}
	const align = entries[index].align;
	let target = index + delta;
	while (target >= 0 && target < entries.length && entries[target].align !== align) {
		target += delta;
	}
	if (target < 0 || target >= entries.length) {
		return entries;
	}
	const next = entries.slice();
	[next[index], next[target]] = [next[target], next[index]];
	return next;
}

/** その項目を `delta` 方向へ動かせるか (同じ寄せの中に相手がいるか)。 */
export function paradisCanMoveWorktreeMeta(entries: readonly IParadisWorktreeMetaEntry[], id: ParadisWorktreeMetaId, delta: -1 | 1): boolean {
	return paradisMoveWorktreeMeta(entries, id, delta) !== entries;
}

export function paradisSetWorktreeMetaVisible(entries: readonly IParadisWorktreeMetaEntry[], id: ParadisWorktreeMetaId, visible: boolean): readonly IParadisWorktreeMetaEntry[] {
	return entries.map(entry => entry.id === id ? { ...entry, visible } : entry);
}

export function paradisSetWorktreeMetaAlign(entries: readonly IParadisWorktreeMetaEntry[], id: ParadisWorktreeMetaId, align: ParadisWorktreeMetaAlign): readonly IParadisWorktreeMetaEntry[] {
	return entries.map(entry => entry.id === id ? { ...entry, align } : entry);
}
