/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペース（リポジトリ本体 / worktree）ごとの「新しいタブの既定のプロファイル」の純粋な部分。
//
// 表は「スペースの状態キー → 既定」だけを持つ。既定が効くのは、ユーザーがそのスペースで新しく
// 開くタブだけ（開いているタブ・復元するタブ・エージェントが開くタブには効かない）。その判断は
// サービス側にあり、ここは保存形式の読み書きと「どの既定を使うか」の判定だけを持つ。

import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { paradisIsValidProfileId } from './paradisBrowserProfileId.js';

/** スペースの既定の表を置くストレージキー（WORKSPACE スコープ）。 */
export const PARADIS_BROWSER_SPACE_DEFAULTS_STORAGE_KEY = 'paradis.browser.spaceDefaults';

/**
 * worktree のスペースが、親（メインツリー）のスペースの既定を引き継ぐか。
 * 引き継ぐ場合も、worktree 自身の既定があればそちらが勝つ。
 *
 * Q370 の案 A（引き継ぐ）。引き継ぎ中はドロップダウンで薄い印を出す。
 */
export const PARADIS_WORKTREE_INHERITS_PARENT_BROWSER_DEFAULT = true;

/** 既定にできるもの。エージェント専用のスコープはユーザーの既定にはしない。 */
export type ParadisSpaceDefaultTarget =
	| { readonly kind: 'profile'; readonly profileId: string }
	| { readonly kind: 'scope'; readonly scope: BrowserViewStorageScope.Global | BrowserViewStorageScope.Workspace | BrowserViewStorageScope.Ephemeral };

/** あるスペースで使う既定と、それがどこで決められたものか。 */
export interface IParadisSpaceDefaultResolution {
	readonly target: ParadisSpaceDefaultTarget;
	/** 親（メインツリー）のスペースから引き継いだものか。 */
	readonly inherited: boolean;
}

/**
 * スペースで使う既定を決める（唯一の判定点）。
 *
 * @param stateKey 対象のスペース
 * @param parentStateKey worktree のスペースなら親（メインツリー）の状態キー。リポジトリ本体なら undefined
 * @param inheritFromParent 親の既定を引き継ぐか（既定は {@link PARADIS_WORKTREE_INHERITS_PARENT_BROWSER_DEFAULT}）
 */
export function paradisResolveSpaceDefault(
	defaults: ReadonlyMap<string, ParadisSpaceDefaultTarget>,
	stateKey: string,
	parentStateKey: string | undefined,
	inheritFromParent: boolean = PARADIS_WORKTREE_INHERITS_PARENT_BROWSER_DEFAULT,
): IParadisSpaceDefaultResolution | undefined {
	const own = defaults.get(stateKey);
	if (own) {
		return { target: own, inherited: false };
	}
	if (inheritFromParent && parentStateKey !== undefined && parentStateKey !== stateKey) {
		const parent = defaults.get(parentStateKey);
		if (parent) {
			return { target: parent, inherited: true };
		}
	}
	return undefined;
}

/** 2つの既定が同じものを指すか。 */
export function paradisSpaceDefaultTargetsEqual(left: ParadisSpaceDefaultTarget | undefined, right: ParadisSpaceDefaultTarget | undefined): boolean {
	if (!left || !right) {
		return left === right;
	}
	return left.kind === 'profile'
		? right.kind === 'profile' && left.profileId === right.profileId
		: right.kind === 'scope' && left.scope === right.scope;
}

/** 既定にできるものかを確かめて、その形にする。できないものは undefined。 */
export function paradisReviveSpaceDefaultTarget(value: unknown): ParadisSpaceDefaultTarget | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as { readonly kind?: unknown; readonly profileId?: unknown; readonly scope?: unknown };
	if (candidate.kind === 'profile') {
		return typeof candidate.profileId === 'string' && paradisIsValidProfileId(candidate.profileId)
			? { kind: 'profile', profileId: candidate.profileId }
			: undefined;
	}
	if (candidate.kind === 'scope') {
		switch (candidate.scope) {
			case BrowserViewStorageScope.Global:
			case BrowserViewStorageScope.Workspace:
			case BrowserViewStorageScope.Ephemeral:
				return { kind: 'scope', scope: candidate.scope };
		}
	}
	return undefined;
}

/** 表を読み戻す。壊れた JSON は空の表、壊れた1件はその1件だけ捨てる。 */
export function paradisParseSpaceDefaults(raw: string | undefined): Map<string, ParadisSpaceDefaultTarget> {
	const defaults = new Map<string, ParadisSpaceDefaultTarget>();
	if (!raw) {
		return defaults;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return defaults;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return defaults;
	}
	for (const [stateKey, value] of Object.entries(parsed as Record<string, unknown>)) {
		const target = paradisReviveSpaceDefaultTarget(value);
		if (stateKey.length > 0 && target) {
			defaults.set(stateKey, target);
		}
	}
	return defaults;
}

/** 表をストレージへ書く形にする。 */
export function paradisSerializeSpaceDefaults(defaults: ReadonlyMap<string, ParadisSpaceDefaultTarget>): string {
	return JSON.stringify(Object.fromEntries(defaults));
}

/**
 * 台帳に無いプロファイルを指す既定を外す（削除されたプロファイル）。
 *
 * @returns 外した状態キー
 */
export function paradisPruneSpaceDefaults(defaults: Map<string, ParadisSpaceDefaultTarget>, existingProfileIds: ReadonlySet<string>): string[] {
	const removed: string[] = [];
	for (const [stateKey, target] of [...defaults]) {
		if (target.kind === 'profile' && !existingProfileIds.has(target.profileId)) {
			defaults.delete(stateKey);
			removed.push(stateKey);
		}
	}
	return removed;
}
