/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 統合のモーダル（Q537 の 11 C）の領域の型と登録先。
//
// 1 つの器（モーダルの段 L）の上段で領域（使用量・設定・通知・ブラウザ拡張機能・更新履歴）を選び、左のナビで節を選ぶ。
// 器は上段・左のナビの入れ物・本文の入れ物だけを持ち、各領域は自分の contribution から登録する。領域の中身（ナビの項目、
// 本文、見出しの右に出すボタン）は領域が描く。器は領域を初めて開いたときに作り、閉じるまで持っておく。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/** 領域の ID。今のコマンドと引数（`psd-sec-*` など）は、各領域がこの ID と節へ読み替えて器を開く。 */
export const enum ParadisHubAreaId {
	Usage = 'usage',
	Settings = 'settings',
	Notifications = 'notifications',
	Extensions = 'extensions',
	Changelog = 'changelog',
}

/** 器が領域ごとに用意する入れ物。領域はここへ自分の中身を描く。 */
export interface IParadisHubAreaContainers {
	/** 左のナビ。項目は {@link paradisHubNavItem} などの器の共通のクラスで描く。 */
	readonly nav: HTMLElement;
	/** 右の本文。 */
	readonly content: HTMLElement;
	/** 見出しの行の、上段の切り替えと閉じるボタンの間（検索欄や「更新」ボタンを置く）。 */
	readonly header: HTMLElement;
}

/**
 * 統合のモーダルの中のボタンから実行したコマンドが、この値を返したら器を閉じる。
 * 本家のダイアログを器の上に出し、その中で設定エディタなどのエディタのタブを開くと選ばれたときに使う
 * （エディタのタブは器の下に出て見えないため）。
 */
export const PARADIS_HUB_CLOSE_AFTER_COMMAND = 'paradis.hub.closeAfterCommand';

/** 器を閉じて開き直したときに戻す、領域の中の場所。 */
export interface IParadisHubAreaViewState {
	/** 開いていた節（`reveal` に渡す ID）。 */
	readonly section?: string;
	/** 本文のスクロール位置。 */
	readonly scrollTop?: number;
}

/** 領域から器へ頼むこと。 */
export interface IParadisHubHost {
	/** 器を閉じる。 */
	close(): void;
	/** 別の領域（と節）を開く。設定のナビの「ほかの領域」から使用量・通知へ移るときなど。 */
	open(area: ParadisHubAreaId, section?: string): void;
}

/** 器の中の 1 つの領域。 */
export interface IParadisHubAreaView extends IDisposable {
	/** 節を開く（`undefined` なら、その領域で最後に見ていた節か既定の節）。 */
	reveal(section: string | undefined): void;
	/** 見えるか。見えない間はポーリングなどを止める。 */
	setVisible(visible: boolean): void;
	/** 本文の幅が変わった。 */
	layout(width: number): void;
	/** Esc を領域で使うとき（検索語を消すなど）は true を返す。false なら器を閉じる。 */
	handleEscape?(): boolean;
	/** 器を閉じる直前に呼ぶ。いまの節とスクロール位置を返すと、同じ窓で同じ領域を開き直したときに戻す。 */
	saveViewState?(): IParadisHubAreaViewState | undefined;
	/** 開き直したときに、{@link saveViewState} が返した場所へ戻す（`reveal` の後に呼ぶ）。 */
	restoreViewState?(state: IParadisHubAreaViewState): void;
}

/** 領域の登録。 */
export interface IParadisHubAreaDescriptor {
	readonly id: ParadisHubAreaId;
	/** 上段のボタンの文言。 */
	readonly label: string;
	/** 上段での並び（小さいほど左）。 */
	readonly order: number;
	create(instantiationService: IInstantiationService, containers: IParadisHubAreaContainers, host: IParadisHubHost): IParadisHubAreaView;
}

const areas = new Map<ParadisHubAreaId, IParadisHubAreaDescriptor>();

/** 領域を登録する。各領域の contribution から 1 回呼ぶ。戻り値を破棄すると前の登録に戻す（テスト用）。 */
export function paradisRegisterHubArea(descriptor: IParadisHubAreaDescriptor): IDisposable {
	const previous = areas.get(descriptor.id);
	areas.set(descriptor.id, descriptor);
	return toDisposable(() => {
		if (areas.get(descriptor.id) !== descriptor) {
			return;
		}
		if (previous) {
			areas.set(descriptor.id, previous);
		} else {
			areas.delete(descriptor.id);
		}
	});
}

/** 登録された領域（上段の並び順）。 */
export function paradisHubAreas(): readonly IParadisHubAreaDescriptor[] {
	return [...areas.values()].sort((a, b) => a.order - b.order);
}
