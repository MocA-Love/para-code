/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中央のパレットの器の幅と行の高さ（Q609・Q610、mock/ui/palette-ideas.html の案 11 の 2 と 5）。本家の quick input から
// 2 か所の PARA-PATCH で呼ぶ: quickInputController.ts の updateLayout（器の幅）と quickInputList.ts の行の高さ。
// どの入力を広げるか・英語の名前を 1 行に畳むかは、fork（src/vs/paradis/contrib/crossJump）が入力の contextKey で登録する。
// ここは vs/paradis を import しない（platform から fork の層へ逆向きの依存を作らない）。
//
// - 器の幅: 登録された入力が中央に出て、プレビューが有効で、窓が 1100px 以上なら、窓の幅の段で器を広げ、右に
//   プレビューの面の幅を空ける（2400 以上: 器 1200・面 420、1600 以上: 1040・360、1100 以上: 880・300）。それ以外は本家の幅。
// - 行の高さ: 1 行に畳む入力（コマンドパレット）で一覧の幅（器から面を引いた幅）が 560px 以上なら、2 行目（英語の名前）の
//   ある行も 28px（CSS で同じ行に並べる）。一覧の高さは行ごとに覚えられるので、しきい値をまたいだときは
//   onDidChangeParadisQuickInputLayout を受けた fork が行を入れ直す。

import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IQuickInput } from '../common/quickInput.js';

/** 窓の幅の段（下限 → 器の幅・プレビューの面の幅）。広い順。 */
export const PARADIS_QUICK_INPUT_PREVIEW_TIERS: readonly { readonly minWindowWidth: number; readonly width: number; readonly previewWidth: number }[] = [
	{ minWindowWidth: 2400, width: 1200, previewWidth: 420 },
	{ minWindowWidth: 1600, width: 1040, previewWidth: 360 },
	{ minWindowWidth: 1100, width: 880, previewWidth: 300 },
];

/** 英語の名前を同じ行に畳む、一覧の幅の下限。 */
export const PARADIS_QUICK_INPUT_INLINE_DETAIL_MIN_LIST_WIDTH = 560;

/** 行の高さ（UI キットのモーダルの行 28px と、2 行の行 44px。#867 の PARA-PATCH と同じ値）。 */
const ROW_HEIGHT = 28;
const ROW_HEIGHT_WITH_DETAIL = 44;

export interface IParadisQuickInputLayoutOptions {
	/** 右にプレビューの面を置けるか。 */
	readonly preview: boolean;
	/** 2 行目（コマンドの英語の名前）を同じ行に畳めるか。 */
	readonly inlineDetail: boolean;
}

export interface IParadisQuickInputLayout {
	/** 器の幅。 */
	readonly width: number;
	/** プレビューの面の幅（面を出さないときは 0）。 */
	readonly previewWidth: number;
	/** 一覧の幅（器から面と境の線を引いた幅）。 */
	readonly listWidth: number;
	/** 2 行目を同じ行に畳むか。 */
	readonly inlineDetail: boolean;
}

/** 窓の幅に合う段（1100px 未満は無し）。 */
export function paradisQuickInputPreviewTier(windowWidth: number): typeof PARADIS_QUICK_INPUT_PREVIEW_TIERS[number] | undefined {
	return PARADIS_QUICK_INPUT_PREVIEW_TIERS.find(tier => windowWidth >= tier.minWindowWidth);
}

/** 器の幅・面の幅・一覧の幅・1 行化を決める（純関数）。`upstreamWidth` は本家の `min(窓 × 0.62, 600)`。 */
export function paradisComputeQuickInputLayout(windowWidth: number, upstreamWidth: number, options: IParadisQuickInputLayoutOptions | undefined, previewEnabled: boolean): IParadisQuickInputLayout {
	const tier = options?.preview && previewEnabled ? paradisQuickInputPreviewTier(windowWidth) : undefined;
	const width = tier ? tier.width : upstreamWidth;
	const previewWidth = tier ? tier.previewWidth : 0;
	const listWidth = tier ? width - previewWidth - 1 : width;
	return { width, previewWidth, listWidth, inlineDetail: !!options?.inlineDetail && listWidth >= PARADIS_QUICK_INPUT_INLINE_DETAIL_MIN_LIST_WIDTH };
}

const registered = new Map<string, IParadisQuickInputLayoutOptions>();
let previewEnabled = true;
const INITIAL_LAYOUT: IParadisQuickInputLayout = { width: 0, previewWidth: 0, listWidth: 0, inlineDetail: false };
let current: IParadisQuickInputLayout = INITIAL_LAYOUT;
const onDidChange = new Emitter<IParadisQuickInputLayout>();

/** 器の幅か 1 行化が変わったとき（fork が面の付け外しと行の入れ直しをする）。 */
export const onDidChangeParadisQuickInputLayout: Event<IParadisQuickInputLayout> = onDidChange.event;

/** contextKey ごとに、広げる・畳む入力を登録する（fork の contribution が起動時に呼ぶ）。 */
export function paradisRegisterQuickInputLayout(contextKey: string, options: IParadisQuickInputLayoutOptions): IDisposable {
	registered.set(contextKey, options);
	return toDisposable(() => registered.delete(contextKey));
}

/** プレビューの on/off（設定 `paradis.palette.preview`）。次の layout から効く。 */
export function paradisSetQuickInputPreviewEnabled(enabled: boolean): void {
	previewEnabled = enabled;
}

/** プレビューの on/off と覚えている器の幅を始めの状態に戻す（単体テストが終わるたびに呼ぶ。登録は各自の dispose で外す）。 */
export function paradisResetQuickInputLayout(): void {
	previewEnabled = true;
	current = INITIAL_LAYOUT;
}

/** 今の器の幅・面・1 行化。 */
export function paradisCurrentQuickInputLayout(): IParadisQuickInputLayout {
	return current;
}

/** 器を中央に出す入力か（部品の横に出すもの・他所を押しても閉じない手順の入力は広げない）。 */
function isCentered(input: IQuickInput | null | undefined): input is IQuickInput {
	return !!input && input.anchor === undefined && !input.ignoreFocusOut;
}

/**
 * quickInputController.ts の updateLayout から呼ぶ（PARA-PATCH）。器の幅を返し、面の幅と 1 行化を覚える。
 * 変わったら onDidChangeParadisQuickInputLayout を出す。
 */
export function paradisQuickInputWidth(windowWidth: number, upstreamWidth: number, input: IQuickInput | null | undefined): number {
	const options = isCentered(input) && input.contextKey !== undefined ? registered.get(input.contextKey) : undefined;
	const next = paradisComputeQuickInputLayout(windowWidth, upstreamWidth, options, previewEnabled);
	const changed = next.width !== current.width || next.previewWidth !== current.previewWidth || next.inlineDetail !== current.inlineDetail;
	current = next;
	if (changed) {
		onDidChange.fire(next);
	}
	return next.width;
}

/** quickInputList.ts の行の高さから呼ぶ（PARA-PATCH）。 */
export function paradisQuickPickItemHeight(detail: string | undefined): number {
	return detail && !current.inlineDetail ? ROW_HEIGHT_WITH_DETAIL : ROW_HEIGHT;
}
