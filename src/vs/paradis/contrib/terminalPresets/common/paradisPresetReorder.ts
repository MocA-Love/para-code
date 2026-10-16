/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドプリセットの並び替え（挿入）の計算。DOM にもサービスにも触らない純関数だけを置く。
//
// 保存形式は変えない。並びは保存先ごとの配列（ユーザー設定の paradis.terminal.presets と
// .paracode.json の presets）の順そのもので、フォルダは同じ folder 文字列を持つプリセットを
// 「中身の最初の 1 件が配列に出てくる位置」にまとめて表示しているだけ（paradisGroupPresetsByFolder）。
// 以前の並び替えは 2 件の入れ替えだけだったので、フォルダの中身とフォルダなしが配列のどの番号を
// 占めるかが変わらず、「フォルダの下の 1 件をフォルダの上へ」のような移動がどうやってもできなかった。
//
// ここでは「動かすものを配列から抜き、目印のプリセットの前か後ろへ差し込み、folder も同時に書く」
// という挿入で表す。目印は必ず同じ保存先の見えているプリセットにするので、
//   - フォルダの前へ入れる = フォルダの中身の最初の 1 件（配列で一番前）の前に差し込む
//   - フォルダの中の最後へ入れる = 中身の最後の 1 件の後ろに差し込む
//   - 保存先の最後へ入れる = 見えている最後の 1 件の後ろに差し込む
// となり、表示位置の決まり方（中身の最初の 1 件）とそのまま両立する。一覧に出ないプリセット
// （appliesTo が別リポジトリのユーザー設定など）は動かさず、見えている行との前後関係も保たれる。
// 古い版はこの配列をそのまま読むだけなので、互換の問題も生じない。

import { IParadisResolvedPreset, isValidPresetDefinition, paradisGroupPresetsByFolder, paradisPresetScopeKey, paradisResolvePresetIndex } from './paradisTerminalPresets.js';

/** 並び替えで動かすもの: プリセット 1 件か、フォルダ 1 つ（中身ごと）。 */
export type ParadisPresetMoveItem =
	| { readonly kind: 'preset'; readonly preset: IParadisResolvedPreset }
	| { readonly kind: 'folder'; readonly scopeKey: string; readonly folder: string };

/** 一覧の中の位置。 */
export type ParadisPresetPosition =
	/** フォルダの外。before の塊（プリセットかフォルダ）の直前。before が無ければ保存先の最後。 */
	| { readonly kind: 'top'; readonly scopeKey: string; readonly before: ParadisPresetMoveItem | undefined }
	/** フォルダの中。before のプリセットの直前。before が無ければフォルダの中の最後。 */
	| { readonly kind: 'folder'; readonly scopeKey: string; readonly folder: string; readonly before: IParadisResolvedPreset | undefined };

/** 位置から決めた、保存先の配列への書き込み方（IParadisPresetService.movePresets に渡す）。 */
export interface IParadisPresetMovePlan {
	readonly item: ParadisPresetMoveItem;
	/** 動かす見えているプリセット（フォルダなら見えている中身すべて）。配列の順。 */
	readonly moving: readonly IParadisResolvedPreset[];
	/** 位置の目印（同じ保存先の、動かさない見えているプリセット）。undefined は保存先に他の行が無いとき。 */
	readonly anchor: IParadisResolvedPreset | undefined;
	/** 目印の前に入れるか、後ろに入れるか。 */
	readonly side: 'before' | 'after';
	/** プリセット 1 件を動かすときの移動後の所属フォルダ（undefined はフォルダなし）。フォルダを動かすときは使わない。 */
	readonly folder: string | undefined;
}

/**
 * 動かせない理由。
 * - otherScope: 保存先（ユーザー設定 / .paracode.json）を跨ぐ
 * - scopeStart / scopeEnd: 保存先の先頭・最後でそれ以上動けない
 * - nestFolder: フォルダの中へフォルダは入れられない
 * - noFolderNearby: すぐ上にも下にもフォルダが無い（Alt+→）
 * - notInFolder: フォルダに入っていない（Alt+←）
 * - unchanged: 動かしても並びが変わらない
 */
export type ParadisPresetMoveRefusal = 'otherScope' | 'scopeStart' | 'scopeEnd' | 'nestFolder' | 'noFolderNearby' | 'notInFolder' | 'unchanged';

export function isParadisPresetMoveRefusal(result: IParadisPresetMovePlan | ParadisPresetMoveRefusal): result is ParadisPresetMoveRefusal {
	return typeof result === 'string';
}

/** 一覧の塊（フォルダなしのプリセット 1 件か、フォルダ 1 つ）。 */
export interface IParadisPresetBlock {
	readonly item: ParadisPresetMoveItem;
	readonly members: readonly IParadisResolvedPreset[];
}

function folderOf(preset: IParadisResolvedPreset): string | undefined {
	return preset.folder?.trim() || undefined;
}

function itemScopeKey(item: ParadisPresetMoveItem): string {
	return item.kind === 'preset' ? paradisPresetScopeKey(item.preset) : item.scopeKey;
}

/** 2 つの {@link ParadisPresetMoveItem} が同じものを指すか。 */
export function paradisPresetSameItem(a: ParadisPresetMoveItem, b: ParadisPresetMoveItem): boolean {
	if (a.kind === 'preset' || b.kind === 'preset') {
		return a.kind === 'preset' && b.kind === 'preset' && a.preset.key === b.preset.key;
	}
	return a.scopeKey === b.scopeKey && a.folder === b.folder;
}

/** 1 つの保存先の見えているプリセット（配列の順）を、一覧の塊に分ける。 */
export function paradisPresetBlocks(presets: readonly IParadisResolvedPreset[], scopeKey: string): IParadisPresetBlock[] {
	return paradisGroupPresetsByFolder(presets.filter(preset => paradisPresetScopeKey(preset) === scopeKey)).map(group => ({
		item: group.folder ? { kind: 'folder', scopeKey, folder: group.folder } : { kind: 'preset', preset: group.presets[0] },
		members: group.presets,
	}));
}

/**
 * 配列の並び替えの本体。`moving` の位置の要素を抜き、`anchorIndex` の要素の前（後ろ）へ、元の
 * 順のまま差し込む。`anchorIndex` が undefined なら最後へ。目印が動かすものに含まれていても、
 * 「その要素があった場所」を指すものとして扱う。動かした要素には `mapMoved`（要素と元の位置）を通す。
 */
export function paradisMoveListEntries<T>(list: readonly T[], moving: readonly number[], anchorIndex: number | undefined, side: 'before' | 'after', mapMoved: (entry: T, index: number) => T): T[] {
	const movingSet = new Set(moving);
	const moved = [...movingSet].sort((a, b) => a - b).map(index => mapMoved(list[index], index));
	const rest: T[] = [];
	let insertAt: number | undefined;
	list.forEach((entry, index) => {
		if (index === anchorIndex && side === 'before') {
			insertAt = rest.length;
		}
		if (!movingSet.has(index)) {
			rest.push(entry);
		}
		if (index === anchorIndex && side === 'after') {
			insertAt = rest.length;
		}
	});
	rest.splice(insertAt ?? rest.length, 0, ...moved);
	return rest;
}

/**
 * 保存先の配列（ユーザー設定の値、または .paracode.json の presets）に移動を当てる。サービスが
 * 書き込む直前に呼ぶ。
 *
 * 一覧を開いてから並び替えるまでの間に配列が変わっていたら、対象の位置を信じずに `missing` の
 * 例外にする（{@link paradisResolvePresetIndex}）。フォルダを動かすときは、一覧に出ていない中身
 * （appliesTo が別リポジトリのもの等）も一緒に動かす。置いていくと、別のリポジトリでそのフォルダ
 * だけ元の位置に残る。プリセットを動かすときは folder だけを書き換え、解決済みの値（source 等）は
 * 書かない。
 */
export function paradisMovePresetDefinitions(list: readonly unknown[], plan: IParadisPresetMovePlan, missing: () => Error): unknown[] {
	const requireIndex = (preset: IParadisResolvedPreset): number => {
		const index = paradisResolvePresetIndex(list, preset);
		if (index < 0) {
			throw missing();
		}
		return index;
	};
	const visibleIndices = plan.moving.map(requireIndex);
	const anchorIndex = plan.anchor ? requireIndex(plan.anchor) : undefined;
	const item = plan.item;
	const moving = item.kind === 'folder'
		? list.map((entry, index) => isValidPresetDefinition(entry) && entry.folder?.trim() === item.folder ? index : -1).filter(index => index >= 0)
		: visibleIndices;
	const folder = plan.folder?.trim() || undefined;
	return paradisMoveListEntries(list, moving, anchorIndex, plan.side, entry => {
		if (item.kind !== 'preset') {
			return entry;
		}
		if (!isValidPresetDefinition(entry)) {
			throw missing();
		}
		return { ...entry, folder };
	});
}

/**
 * 見えているプリセットの並び（保存先ごと・配列の順。IParadisPresetService.presets と同じ）に
 * 移動を当てた結果。表示の確認（並びが変わるか）とテストに使う。
 */
export function paradisApplyPresetMovePlan(presets: readonly IParadisResolvedPreset[], plan: IParadisPresetMovePlan): IParadisResolvedPreset[] {
	const scopeKey = itemScopeKey(plan.item);
	const scopeIndices = presets.map((preset, index) => paradisPresetScopeKey(preset) === scopeKey ? index : -1).filter(index => index >= 0);
	const scopePresets = scopeIndices.map(index => presets[index]);
	const movingKeys = new Set(plan.moving.map(preset => preset.key));
	const moving = scopePresets.map((preset, index) => movingKeys.has(preset.key) ? index : -1).filter(index => index >= 0);
	const anchorIndex = plan.anchor ? scopePresets.findIndex(preset => preset.key === plan.anchor?.key) : undefined;
	const reordered = paradisMoveListEntries(scopePresets, moving, anchorIndex === -1 ? undefined : anchorIndex, plan.side, preset =>
		plan.item.kind === 'preset' ? { ...preset, folder: plan.folder } : preset);
	const result = presets.slice();
	scopeIndices.forEach((index, i) => result[index] = reordered[i]);
	return result;
}

function signature(presets: readonly IParadisResolvedPreset[]): string {
	return presets.map(preset => `${preset.key}\u0000${folderOf(preset) ?? ''}`).join('\u0001');
}

/**
 * 動かすものと位置から、書き込み方を決める。`presets` は絞り込み前の見えているプリセット全部
 * （IParadisPresetService.presets）。位置が動かすもの自身の前後を指していても、自分以外の
 * 行を目印に選び直す。
 */
export function paradisPlanPresetMove(presets: readonly IParadisResolvedPreset[], item: ParadisPresetMoveItem, position: ParadisPresetPosition): IParadisPresetMovePlan | ParadisPresetMoveRefusal {
	const scopeKey = itemScopeKey(item);
	if (position.scopeKey !== scopeKey) {
		return 'otherScope';
	}
	if (item.kind === 'folder' && position.kind === 'folder') {
		return 'nestFolder';
	}
	const scopePresets = presets.filter(preset => paradisPresetScopeKey(preset) === scopeKey);
	const moving = item.kind === 'preset'
		? scopePresets.filter(preset => preset.key === item.preset.key)
		: scopePresets.filter(preset => folderOf(preset) === item.folder);
	if (moving.length === 0) {
		return 'unchanged';
	}
	const movingKeys = new Set(moving.map(preset => preset.key));
	const rest = scopePresets.filter(preset => !movingKeys.has(preset.key));
	const blocks = paradisPresetBlocks(scopePresets, scopeKey);

	let anchor: IParadisResolvedPreset | undefined;
	let side: 'before' | 'after' = 'before';
	let folder: string | undefined;
	if (position.kind === 'top') {
		// 指された塊から後ろへ、動かさない行を持つ最初の塊を探してその最初の行の前へ。動かすもの
		// 自身や、動かすものだけが入ったフォルダを指していても、同じ場所の次の行が目印になる。
		const start = position.before ? blocks.findIndex(block => paradisPresetSameItem(block.item, position.before!)) : blocks.length;
		const target = blocks.slice(start < 0 ? blocks.length : start).map(block => block.members.find(member => !movingKeys.has(member.key))).find(member => !!member);
		if (target) {
			anchor = target;
		} else {
			anchor = rest[rest.length - 1];
			side = 'after';
		}
		folder = undefined;
	} else {
		folder = position.folder;
		const members = scopePresets.filter(preset => folderOf(preset) === position.folder);
		const start = position.before ? members.findIndex(member => member.key === position.before!.key) : members.length;
		const target = members.slice(start < 0 ? members.length : start).find(member => !movingKeys.has(member.key));
		const restMembers = members.filter(member => !movingKeys.has(member.key));
		if (target) {
			anchor = target;
		} else if (restMembers.length > 0) {
			anchor = restMembers[restMembers.length - 1];
			side = 'after';
		} else {
			// フォルダの中が動かす 1 件だけ。その場に留まる。
			return 'unchanged';
		}
	}

	const plan: IParadisPresetMovePlan = { item, moving, anchor, side, folder };
	if (signature(paradisApplyPresetMovePlan(scopePresets, plan)) === signature(scopePresets)) {
		return 'unchanged';
	}
	return plan;
}

/**
 * ↑↓・Alt+↑↓ の 1 歩。フォルダの外ではフォルダをひとまとまりとして飛び越え、フォルダの中では
 * 中身の間を動き、中の先頭で ↑・最後で ↓ を押すとフォルダの外（前・後ろ）へ出る。
 */
export function paradisPlanPresetStep(presets: readonly IParadisResolvedPreset[], item: ParadisPresetMoveItem, direction: -1 | 1): IParadisPresetMovePlan | ParadisPresetMoveRefusal {
	const scopeKey = itemScopeKey(item);
	const scopePresets = presets.filter(preset => paradisPresetScopeKey(preset) === scopeKey);
	const blocks = paradisPresetBlocks(scopePresets, scopeKey);
	const memberFolder = item.kind === 'preset' ? folderOf(item.preset) : undefined;
	if (!memberFolder) {
		const index = blocks.findIndex(block => paradisPresetSameItem(block.item, item));
		if (index < 0) {
			return 'unchanged';
		}
		if (direction < 0) {
			return index === 0 ? 'scopeStart' : paradisPlanPresetMove(presets, item, { kind: 'top', scopeKey, before: blocks[index - 1].item });
		}
		return index === blocks.length - 1 ? 'scopeEnd' : paradisPlanPresetMove(presets, item, { kind: 'top', scopeKey, before: blocks[index + 2]?.item });
	}
	const folderIndex = blocks.findIndex(block => block.item.kind === 'folder' && block.item.folder === memberFolder);
	const members = blocks[folderIndex].members;
	const index = members.findIndex(member => item.kind === 'preset' && member.key === item.preset.key);
	if (direction < 0) {
		return index > 0
			? paradisPlanPresetMove(presets, item, { kind: 'folder', scopeKey, folder: memberFolder, before: members[index - 1] })
			: paradisPlanPresetMove(presets, item, { kind: 'top', scopeKey, before: blocks[folderIndex].item });
	}
	return index < members.length - 1
		? paradisPlanPresetMove(presets, item, { kind: 'folder', scopeKey, folder: memberFolder, before: members[index + 2] })
		: paradisPlanPresetMove(presets, item, { kind: 'top', scopeKey, before: blocks[folderIndex + 1]?.item });
}

/**
 * Alt+→（into）: すぐ上のフォルダの中の最後へ、無ければすぐ下のフォルダの中の先頭へ入れる。
 * Alt+←: フォルダから出して、フォルダのすぐ後ろへ置く。
 */
export function paradisPlanPresetNest(presets: readonly IParadisResolvedPreset[], item: ParadisPresetMoveItem, into: boolean): IParadisPresetMovePlan | ParadisPresetMoveRefusal {
	if (item.kind === 'folder') {
		return into ? 'nestFolder' : 'notInFolder';
	}
	const scopeKey = itemScopeKey(item);
	const scopePresets = presets.filter(preset => paradisPresetScopeKey(preset) === scopeKey);
	const blocks = paradisPresetBlocks(scopePresets, scopeKey);
	const memberFolder = folderOf(item.preset);
	if (into) {
		if (memberFolder) {
			return 'unchanged';
		}
		const index = blocks.findIndex(block => paradisPresetSameItem(block.item, item));
		const above = blocks[index - 1];
		if (above && above.item.kind === 'folder') {
			return paradisPlanPresetMove(presets, item, { kind: 'folder', scopeKey, folder: above.item.folder, before: undefined });
		}
		const below = blocks[index + 1];
		if (below && below.item.kind === 'folder') {
			return paradisPlanPresetMove(presets, item, { kind: 'folder', scopeKey, folder: below.item.folder, before: below.members[0] });
		}
		return 'noFolderNearby';
	}
	if (!memberFolder) {
		return 'notInFolder';
	}
	const folderIndex = blocks.findIndex(block => block.item.kind === 'folder' && block.item.folder === memberFolder);
	return paradisPlanPresetMove(presets, item, { kind: 'top', scopeKey, before: blocks[folderIndex + 1]?.item });
}

/** 右クリック「フォルダへ移動」: 同じ保存先の一覧にあるフォルダの中の最後へ入れる。 */
export function paradisPlanPresetMoveToFolder(presets: readonly IParadisResolvedPreset[], preset: IParadisResolvedPreset, folder: string): IParadisPresetMovePlan | ParadisPresetMoveRefusal {
	return paradisPlanPresetMove(presets, { kind: 'preset', preset }, { kind: 'folder', scopeKey: paradisPresetScopeKey(preset), folder, before: undefined });
}

/** 右クリックの「フォルダへ移動」に並べるフォルダ（同じ保存先の一覧に中身があるもの、自分の入っているフォルダを除く）。 */
export function paradisPresetMoveFolderChoices(presets: readonly IParadisResolvedPreset[], preset: IParadisResolvedPreset): readonly string[] {
	const scopeKey = paradisPresetScopeKey(preset);
	const own = folderOf(preset);
	return paradisPresetBlocks(presets, scopeKey)
		.map(block => block.item.kind === 'folder' ? block.item.folder : undefined)
		.filter((name): name is string => !!name && name !== own);
}

/**
 * 手動の並び替え（ドラッグ・↑↓・Alt+↑↓/←→・右クリック）を止めるか。検索語や左ナビの絞り込みが
 * あると、見えていない行を挟んだ位置が見た目と一致しなくなるので丸ごと止める。
 */
export function paradisPresetReorderBlocked(searchQuery: string, filterKind: 'all' | 'folder' | 'source'): boolean {
	return searchQuery.trim().length > 0 || filterKind !== 'all';
}
