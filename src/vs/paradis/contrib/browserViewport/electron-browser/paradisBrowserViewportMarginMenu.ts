/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 大きさを決めている間の、表示域の外の余白を右クリックしたときのメニュー（paracode-183 の報告）。
//
// 余白はページの外なので、ページの右クリック（main が出すページの中のメニュー）とは別に、ここで Para Code の
// メニューを出す。項目は chip の一覧（paradisBrowserViewportDropdown.ts）と upstream の Device Emulation の帯・
// 既存のコマンドが持つ操作を呼ぶだけで、新しい操作は作らない。組み立ては chip（paradisBrowserViewportChip.ts）が
// 渡す状態だけで決まる純関数にしてある。

import { IAction, Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { IParadisViewportSize, IParadisViewportState, paradisFormatViewportDimensions } from '../common/paradisBrowserViewport.js';

/**
 * upstream の Device Emulation の帯の倍率の候補（browserEditorEmulationFeatures.ts の
 * `BrowserEmulationToolbar.ZOOM_PRESETS`。private なので写している）。upstream 取り込み時に見比べる。
 */
export const PARADIS_VIEWPORT_SCALE_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface IParadisViewportMarginMenuState {
	readonly current: IParadisViewportState;
	readonly sizes: readonly IParadisViewportSize[];
	/** 帯で決めた倍率。自動で縮めているときは undefined。 */
	readonly scale: number | undefined;
	/** 今の実際の倍率（自動のときは自動で決まった値）。 */
	readonly effectiveScale: number | undefined;
	/** ページが読み込めているか（URL があり、読み込みの失敗が無い）。スクリーンショットと開発者ツールに使う。 */
	readonly pageReady: boolean;
	/** スクリーンショットに書き込める（書き込みの機能が載っていて、まだ書き込み中でない）か。 */
	readonly canMarkup: boolean;
}

export interface IParadisViewportMarginMenuHandlers {
	readonly onSelectSize: (size: IParadisViewportSize) => void;
	readonly onSelectFit: () => void;
	readonly onSetScale: (scale: number | undefined) => void;
	readonly onSwap: () => void;
	readonly onMarkupScreenshot: () => void;
	readonly onReload: () => void;
	readonly onToggleDevTools: () => void;
}

function percent(scale: number): number {
	return Math.round(scale * 100);
}

export function paradisBuildViewportMarginMenu(state: IParadisViewportMarginMenuState, handlers: IParadisViewportMarginMenuHandlers): IAction[] {
	const { current } = state;

	const sizeActions: IAction[] = state.sizes.map((size, index) => toAction({
		id: `paradis.browserViewport.margin.size.${index}`,
		label: size.mobile
			? localize('paradis.browserViewport.margin.sizeLabelMobile', "{0}  {1}・モバイル", size.name, paradisFormatViewportDimensions(size.width, size.height))
			: localize('paradis.browserViewport.margin.sizeLabel', "{0}  {1}", size.name, paradisFormatViewportDimensions(size.width, size.height)),
		checked: !current.fit && current.name === size.name,
		run: () => handlers.onSelectSize(size),
	}));
	sizeActions.push(new Separator(), toAction({
		id: 'paradis.browserViewport.margin.fit',
		label: localize('paradis.browserViewport.margin.fit', "エディタに合わせる（大きさを決めない）"),
		checked: current.fit,
		run: () => handlers.onSelectFit(),
	}));

	const autoLabel = state.scale === undefined && state.effectiveScale !== undefined
		? localize('paradis.browserViewport.margin.scaleAutoPercent', "自動（{0}%）", percent(state.effectiveScale))
		: localize('paradis.browserViewport.margin.scaleAuto', "自動");
	const scaleActions: IAction[] = [
		toAction({
			id: 'paradis.browserViewport.margin.scale.auto',
			label: autoLabel,
			checked: state.scale === undefined,
			run: () => handlers.onSetScale(undefined),
		}),
		new Separator(),
		...PARADIS_VIEWPORT_SCALE_PRESETS.map(preset => toAction({
			id: `paradis.browserViewport.margin.scale.${preset}`,
			label: localize('paradis.browserViewport.margin.scalePercent', "{0}%", percent(preset)),
			checked: state.scale !== undefined && Math.abs(state.scale - preset) < 0.005,
			run: () => handlers.onSetScale(preset),
		})),
	];

	return [
		new SubmenuAction('paradis.browserViewport.margin.sizes', localize('paradis.browserViewport.margin.sizes', "ページの大きさ"), sizeActions),
		new SubmenuAction('paradis.browserViewport.margin.scale', localize('paradis.browserViewport.margin.scale', "表示の倍率"), scaleActions),
		toAction({
			id: 'paradis.browserViewport.margin.swap',
			label: localize('paradis.browserViewport.margin.swap', "縦横を入れ替える"),
			enabled: !current.fit && !!current.width && !!current.height,
			run: () => handlers.onSwap(),
		}),
		new Separator(),
		toAction({
			id: 'paradis.browserViewport.margin.markup',
			label: localize('paradis.browserViewport.margin.markup', "スクリーンショットに書き込む"),
			enabled: state.pageReady && state.canMarkup,
			run: () => handlers.onMarkupScreenshot(),
		}),
		toAction({
			id: 'paradis.browserViewport.margin.reload',
			label: localize('paradis.browserViewport.margin.reload', "再読み込み"),
			run: () => handlers.onReload(),
		}),
		toAction({
			id: 'paradis.browserViewport.margin.devTools',
			label: localize('paradis.browserViewport.margin.devTools', "開発者ツール"),
			enabled: state.pageReady,
			run: () => handlers.onToggleDevTools(),
		}),
	];
}
