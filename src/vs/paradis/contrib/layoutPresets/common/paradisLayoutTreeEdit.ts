/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// レイアウトの木を編集する純粋関数（分割・削除・枠の中身の差し替え）。
//
// キャンバスの操作をここに閉じ込めているのは、木の入れ子と VS Code のグリッドの
// 「子は親と直交する向きに並ぶ」という規則の噛み合わせが、この機能で一番間違えやすいため。
// EditorPane 側は DOM の描画だけを持ち、形の計算は必ずここを通す。

import {
	IParadisLayoutNode,
	IParadisLayoutSlot,
	ParadisLayoutOrientation,
	PARADIS_LAYOUT_MAX_DEPTH,
	PARADIS_LAYOUT_MAX_SLOTS,
	paradisCountLayoutSlots,
	paradisNormalizeLayoutNodes,
	withoutSize,
} from './paradisLayoutPresets.js';

/** 枠を指す道順（ルート直下からの添字の並び）。 */
export type ParadisLayoutPath = readonly number[];

/** 分割の向き。 */
export const PARADIS_LAYOUT_SPLIT_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type ParadisLayoutSplitDirection = typeof PARADIS_LAYOUT_SPLIT_DIRECTIONS[number];

/** 逆の向き。 */
function flip(orientation: ParadisLayoutOrientation): ParadisLayoutOrientation {
	return orientation === 'columns' ? 'rows' : 'columns';
}

/** その分割方向を実現するには、親がどちらの向きで並んでいる必要があるか。 */
function orientationFor(direction: ParadisLayoutSplitDirection): ParadisLayoutOrientation {
	return direction === 'left' || direction === 'right' ? 'columns' : 'rows';
}

/** 新しい枠を既存の枠より前に置くか。 */
function insertsBefore(direction: ParadisLayoutSplitDirection): boolean {
	return direction === 'up' || direction === 'left';
}

/**
 * 深さ `depth`（ルート直下を1とする）のノードが並んでいる向き。
 * ルート直下はプリセットの orientation、以降は1段ごとに直交する。
 */
export function paradisOrientationAtDepth(rootOrientation: ParadisLayoutOrientation, depth: number): ParadisLayoutOrientation {
	return depth % 2 === 1 ? rootOrientation : flip(rootOrientation);
}

/** 道順の指すノード。見つからなければ undefined。 */
export function paradisNodeAt(root: readonly IParadisLayoutNode[], path: ParadisLayoutPath): IParadisLayoutNode | undefined {
	let list: readonly IParadisLayoutNode[] | undefined = root;
	let node: IParadisLayoutNode | undefined;
	for (const index of path) {
		node = list?.[index];
		if (!node) {
			return undefined;
		}
		list = node.children;
	}
	return node;
}

/** 道順の指す位置のノード列を差し替えた新しい木を返す（元の木は変更しない）。 */
function replaceAt(
	list: readonly IParadisLayoutNode[],
	path: ParadisLayoutPath,
	replacer: (siblings: readonly IParadisLayoutNode[], index: number) => IParadisLayoutNode[],
): IParadisLayoutNode[] {
	const [index, ...rest] = path;
	if (rest.length === 0) {
		return replacer(list, index);
	}
	const node = list[index];
	if (!node?.children) {
		return [...list];
	}
	const next = [...list];
	next[index] = { ...node, children: replaceAt(node.children, rest, replacer) };
	return next;
}

/** 分割の結果。`root` が新しい木、`path` が新しく増えた枠の道順。 */
export interface IParadisLayoutSplitResult {
	readonly root: readonly IParadisLayoutNode[];
	readonly orientation: ParadisLayoutOrientation;
	/** 新しく増えた枠。分割できなかった場合は undefined。 */
	readonly created?: ParadisLayoutPath;
}

/**
 * 枠を指定方向に分割して、新しい空の枠を1つ増やす。
 *
 * 木の形は3通りに分かれる:
 *   1. 分割方向が親の並び方と同じ → 兄弟として差し込む（入れ子を増やさない）
 *   2. ルート直下の枠が1つだけで、方向がルートの並び方と違う → **ルートの向きを反転**して
 *      兄弟として差し込む。ここで入れ子にしてしまうと、単純な左右2分割が
 *      「1列の中に上下2段」という余計に深い木になり、以後の分割の意味がずれていく
 *   3. それ以外 → その枠を分岐に置き換え、元の枠と新しい枠を子にする
 *
 * 上限（枠の総数・入れ子の深さ）を超える分割は行わず、元の木をそのまま返す。
 */
export function paradisSplitLayoutSlot(
	root: readonly IParadisLayoutNode[],
	rootOrientation: ParadisLayoutOrientation,
	path: ParadisLayoutPath,
	direction: ParadisLayoutSplitDirection,
): IParadisLayoutSplitResult {
	const unchanged: IParadisLayoutSplitResult = { root, orientation: rootOrientation };
	if (path.length === 0 || !paradisNodeAt(root, path) || paradisCountLayoutSlots(root) >= PARADIS_LAYOUT_MAX_SLOTS) {
		return unchanged;
	}

	const wanted = orientationFor(direction);
	const parentOrientation = paradisOrientationAtDepth(rootOrientation, path.length);
	const before = insertsBefore(direction);
	const created: IParadisLayoutNode = { slot: { kind: 'empty' } };

	// 1. 親の並び方と同じ向き → 兄弟として差し込む
	if (wanted === parentOrientation) {
		const at = path[path.length - 1] + (before ? 0 : 1);
		return {
			root: replaceAt(root, path, (siblings, index) => {
				const next = [...siblings];
				// 兄弟が増えると比率の合計が 1 でなくなり VS Code 側で無視される。
				// 中途半端に効く比率は「指定したのに効かない」より分かりにくいので、揃えて捨てる。
				next.splice(index + (before ? 0 : 1), 0, created);
				return next.map(node => stripSize(node));
			}),
			orientation: rootOrientation,
			created: [...path.slice(0, -1), at],
		};
	}

	// 2. ルート直下が1枠だけ → ルートの向きを反転して兄弟にする
	if (path.length === 1 && root.length === 1) {
		return {
			root: before ? [created, stripSize(root[0])] : [stripSize(root[0]), created],
			orientation: wanted,
			created: [before ? 0 : 1],
		};
	}

	// 3. その枠を分岐へ置き換える
	if (path.length + 1 > PARADIS_LAYOUT_MAX_DEPTH) {
		return unchanged;
	}
	return {
		root: replaceAt(root, path, (siblings, index) => {
			const next = [...siblings];
			const original = stripSize(siblings[index]);
			const children = before ? [created, original] : [original, created];
			// 分岐は元の枠が占めていた比率をそのまま引き継ぐ（未指定なら未指定のまま持たせない）。
			next[index] = siblings[index].size === undefined ? { children } : { size: siblings[index].size, children };
			return next;
		}),
		orientation: rootOrientation,
		created: [...path, before ? 0 : 1],
	};
}

/**
 * 枠を1つ削除する。
 * 削除の結果、親の子が1つだけになったら親ごとその子に畳む（意味のない1階層を残さない）。
 * すべての枠が消える場合は、白紙の1枠に戻す（枠0個のプリセットは適用できないため）。
 */
export function paradisRemoveLayoutSlot(root: readonly IParadisLayoutNode[], path: ParadisLayoutPath): readonly IParadisLayoutNode[] {
	if (path.length === 0 || !paradisNodeAt(root, path)) {
		return root;
	}
	const removed = replaceAt(root, path, (siblings, index) => {
		const next = [...siblings];
		next.splice(index, 1);
		return next.map(node => stripSize(node));
	});
	// 意味のない1階層（子が1つだけの分岐）を残さない。残すとグリッド側で潰され、
	// 枠と中身の対応が1つずれる（paradisNormalizeLayoutNodes のコメント参照）。
	const collapsed = paradisNormalizeLayoutNodes(removed);
	return collapsed.length > 0 ? collapsed : [{ slot: { kind: 'empty' } }];
}

/** 枠の中身を差し替える。 */
export function paradisUpdateLayoutSlot(
	root: readonly IParadisLayoutNode[],
	path: ParadisLayoutPath,
	slot: IParadisLayoutSlot,
): readonly IParadisLayoutNode[] {
	if (path.length === 0 || !paradisNodeAt(root, path)) {
		return root;
	}
	return replaceAt(root, path, (siblings, index) => {
		const next = [...siblings];
		// 分岐だったノードを枠に変える場合もあるので children は引き継がない
		// （キーごと落とす——`children: undefined` が残ると分岐判定は通らないのに形が汚れる）。
		const { children, ...rest } = siblings[index];
		next[index] = { ...rest, slot };
		return next;
	});
}

/** 比率を落とす（兄弟の構成が変わって、揃えていた比率の意味がなくなるとき）。 */
const stripSize = withoutSize;

/** 「テンプレートから開始」で選べる形。 */
export interface IParadisLayoutTemplate {
	readonly id: string;
	readonly orientation: ParadisLayoutOrientation;
	readonly root: readonly IParadisLayoutNode[];
}

/**
 * 全テンプレートで使い回す白紙の枠。
 * 木の編集はすべてコピーオンライトだが、`applyLayout()` へ渡す先には木を破壊的に書き換える
 * upstream の関数（`sanitizeGridNodeDescriptor`）があるので、共有する定数は凍らせて
 * 「1つのテンプレートを触ったら全テンプレートが変わる」事故を1段防いでおく。
 */
const EMPTY: IParadisLayoutNode = Object.freeze({ slot: Object.freeze({ kind: 'empty' as const }) });

/**
 * よく使う形の雛形。中身（何を開くか）は空のままにしてある——形と中身を同時に決め打ちすると、
 * 「テンプレートを選んだら知らないコマンドが入っていた」という状態になるため。
 */
export const PARADIS_LAYOUT_TEMPLATES: readonly IParadisLayoutTemplate[] = [
	{ id: 'single', orientation: 'columns', root: [EMPTY] },
	{ id: 'columns2', orientation: 'columns', root: [EMPTY, EMPTY] },
	{ id: 'rows2', orientation: 'rows', root: [EMPTY, EMPTY] },
	{ id: 'grid4', orientation: 'columns', root: [{ children: [EMPTY, EMPTY] }, { children: [EMPTY, EMPTY] }] },
	{ id: 'left1right2', orientation: 'columns', root: [EMPTY, { children: [EMPTY, EMPTY] }] },
	{ id: 'left2right1', orientation: 'columns', root: [{ children: [EMPTY, EMPTY] }, EMPTY] },
];
