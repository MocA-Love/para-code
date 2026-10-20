/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 別のスペースへ預けた「生きた」エディタのターミナルの置き場所の台帳。
//
// 子プロセスが動いているエディタのターミナルは、切り替えのときに working set へ入れず、
// メモリの預け先 (`ParadisEditorScopeService` の `liveWorkingSets`) にだけ置き場所を残す。
// 同じウィンドウの中ではそれで戻るが、ウィンドウを閉じる (SSH で「実行したまま残す」、
// 常駐へ残す、再読み込み) と預け先ごと消える。端末そのものは起動時の孤児の取り戻しで
// スペースへ戻るものの、どのグループの何番目だったかが分からず、切り替えたときに今の
// グループへまとめて開かれていた。
//
// そこで預けるときに、端末ごと (nonce) の置き場所をこの台帳に書いておき、開き直すときに
// 引く。グループは working set の中の id で指す。working set を適用すると、グループは
// 直列化した id のまま作り直される (`editorPart.ts` の `doApplyState` は既存のグループを
// 使い回さずに破棄してから作る。`editorGroupModel.ts` の deserialize が保存された id を使う)。
// 台帳は working set と同じ瞬間に書くので、2 つの id は必ず揃う。

import { paradisTerminalIdentityNonce } from '../../mobileRelay/common/paradisTerminalPersistence.js';

/** 台帳の保存先（WORKSPACE スコープ）。書くのは切り替えサービス、読むのは端末の所属の担当。 */
export const PARADIS_TERMINAL_EDITOR_PLACEMENTS_STORAGE_KEY = 'paradis.workspaceSwitch.terminalEditorPlacements';

const VERSION = 1;
const MAX_SCOPES = 4096;
const MAX_PLACEMENTS_PER_SCOPE = 512;
const MAX_STORAGE_LENGTH = 524_288;

/** 預けたときの、エディタのターミナル 1 本の置き場所。 */
export interface IParadisTerminalEditorPlacement {
	/** working set の中のグループの id。 */
	readonly groupId: number;
	/** グループの中のタブの位置（預けた時点の、ほかのタブを含めた並び）。 */
	readonly index: number;
	/** グループのアクティブなタブだったか。 */
	readonly active: boolean;
	readonly pinned: boolean;
	readonly sticky: boolean;
}

interface ISerializedTerminalEditorPlacementState {
	readonly version: number;
	readonly scopes: readonly {
		readonly stateKey: string;
		readonly placements: readonly ({ readonly nonce: string } & IParadisTerminalEditorPlacement)[];
	}[];
}

export type ParadisTerminalEditorPlacements = ReadonlyMap<string /* nonce */, IParadisTerminalEditorPlacement>;

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPlacement(value: Partial<IParadisTerminalEditorPlacement>): value is IParadisTerminalEditorPlacement {
	return isNonNegativeInteger(value.groupId)
		&& isNonNegativeInteger(value.index)
		&& typeof value.active === 'boolean'
		&& typeof value.pinned === 'boolean'
		&& typeof value.sticky === 'boolean';
}

/** 台帳を読む。形が崩れていれば空として扱う（置き場所が分からないだけで、端末は今までどおり開く）。 */
export function paradisParseTerminalEditorPlacements(raw: string | undefined): Map<string, Map<string, IParadisTerminalEditorPlacement>> {
	if (raw === undefined || raw.length > MAX_STORAGE_LENGTH) {
		return new Map();
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ISerializedTerminalEditorPlacementState>;
		if (parsed.version !== VERSION || !Array.isArray(parsed.scopes) || parsed.scopes.length > MAX_SCOPES) {
			return new Map();
		}
		const result = new Map<string, Map<string, IParadisTerminalEditorPlacement>>();
		for (const scope of parsed.scopes) {
			if (!scope || typeof scope.stateKey !== 'string' || scope.stateKey.length === 0 || result.has(scope.stateKey)
				|| !Array.isArray(scope.placements) || scope.placements.length > MAX_PLACEMENTS_PER_SCOPE) {
				return new Map();
			}
			const placements = new Map<string, IParadisTerminalEditorPlacement>();
			for (const entry of scope.placements) {
				const nonce = paradisTerminalIdentityNonce(entry?.nonce);
				if (nonce === undefined || placements.has(nonce) || !isPlacement(entry)) {
					return new Map();
				}
				placements.set(nonce, { groupId: entry.groupId, index: entry.index, active: entry.active, pinned: entry.pinned, sticky: entry.sticky });
			}
			result.set(scope.stateKey, placements);
		}
		return result;
	} catch {
		return new Map();
	}
}

/**
 * 台帳を書く。大きすぎて書けないときは undefined。呼び出し側は前の値を残さずに消すこと
 * （古い置き場所が残ると、そのスペースの端末を前の配置の位置へ開いてしまう）。
 */
export function paradisSerializeTerminalEditorPlacements(scopes: ReadonlyMap<string, ParadisTerminalEditorPlacements>): string | undefined {
	if (scopes.size > MAX_SCOPES) {
		return undefined;
	}
	const serialized: ISerializedTerminalEditorPlacementState = {
		version: VERSION,
		scopes: [...scopes]
			.filter(([, placements]) => placements.size > 0)
			.map(([stateKey, placements]) => ({
				stateKey,
				placements: [...placements].map(([nonce, placement]) => ({ nonce, ...placement })),
			})),
	};
	if (serialized.scopes.some(scope => scope.placements.length > MAX_PLACEMENTS_PER_SCOPE)) {
		return undefined;
	}
	const raw = JSON.stringify(serialized);
	return raw.length <= MAX_STORAGE_LENGTH ? raw : undefined;
}

/**
 * 1 つのスペースの置き場所を、最新の保存内容に書き込む（同じワークスペースの別ウィンドウが書いた
 * スペースは残す）。`placements` が空か undefined ならそのスペースを消す。書けなければ undefined。
 */
export function paradisUpdateTerminalEditorPlacements(raw: string | undefined, stateKey: string, placements: ParadisTerminalEditorPlacements | undefined): string | undefined {
	const scopes = paradisParseTerminalEditorPlacements(raw);
	if (placements === undefined || placements.size === 0) {
		scopes.delete(stateKey);
	} else {
		scopes.set(stateKey, new Map(placements));
	}
	return paradisSerializeTerminalEditorPlacements(scopes);
}

/**
 * 開き直す順番。グループごとに、元の位置の小さい順に並べる。
 *
 * 位置は預けた時点の、ほかのタブも含めた並びなので、小さい順にその位置へ差し込めば元の並びに戻る
 * （大きい方から差し込むと、後から入れたタブが前のタブを右へずらす）。
 */
export function paradisOrderTerminalEditorPlacements<T extends { readonly placement: IParadisTerminalEditorPlacement }>(items: readonly T[]): T[] {
	return [...items].sort((left, right) => left.placement.groupId - right.placement.groupId || left.placement.index - right.placement.index);
}
