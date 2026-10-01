/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown / HTML ビューアの Rendered 表示の拡大縮小（ツールバーの［−］［100%］［＋］）。
// 倍率は Superset と同じ 1.2^level（範囲 -3〜+5）で、ページの中の `html` に CSS zoom を当てる。
// 描画時は倍率を CSS に焼き込み、ボタン操作のときは {@link paradisViewerZoomScript} が受け取る
// postMessage で、描き直さずにスクロール位置を保ったまま反映する。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';

const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
const ZOOM_BASE = 1.2;

/** ページの中でライブに倍率を変える postMessage の印。 */
const ZOOM_MESSAGE_KEY = '__paradisZoom';

/**
 * ボタン操作の倍率を受け取って反映するページ内スクリプト。CSP が nonce でスクリプトを絞る文書では
 * `nonce` を渡す。
 */
export function paradisViewerZoomScript(nonce?: string): string {
	const nonceAttribute = nonce ? ` nonce="${nonce}"` : '';
	return `<script${nonceAttribute}>(function(){try{window.addEventListener('message',function(e){var d=e.data;if(d&&typeof d.${ZOOM_MESSAGE_KEY}==='number'){document.documentElement.style.zoom=String(d.${ZOOM_MESSAGE_KEY});}});}catch(err){}})();</script>`;
}

/** ページへ送る、倍率を変えるメッセージ。 */
export function paradisViewerZoomMessage(factor: number): { readonly [ZOOM_MESSAGE_KEY]: number } {
	return { [ZOOM_MESSAGE_KEY]: factor };
}

/**
 * ツールバーの拡大縮小ボタンと、いまの段階を持つ。段階はペインごと（開き直したファイルにも引き継ぐ）。
 * 段階が変わったら `onDidChange` を呼ぶので、ページへの反映（postMessage か描き直し）は呼び出し側が決める。
 */
export class ParadisViewerZoomControls extends Disposable {

	private _level = 0;
	private _zoomOutButton: HTMLButtonElement | undefined;
	private _zoomInButton: HTMLButtonElement | undefined;
	private _percentButton: HTMLButtonElement | undefined;

	constructor(private readonly _onDidChange: () => void) {
		super();
	}

	get level(): number {
		return this._level;
	}

	get factor(): number {
		return ZOOM_BASE ** this._level;
	}

	/** ツールバーに［−］［100%］［＋］を足す。 */
	createButtons(toolbar: HTMLElement): void {
		this._zoomOutButton = createParadisViewerIconButton(toolbar, Codicon.zoomOut, localize('paradis.viewer.zoomOut', "ズームアウト"));
		this._register(dom.addDisposableListener(this._zoomOutButton, dom.EventType.CLICK, () => this.setLevel(this._level - 1)));

		this._percentButton = dom.append(toolbar, dom.$('button.paradis-html-zoom-percent')) as HTMLButtonElement;
		this._percentButton.title = localize('paradis.viewer.resetZoom', "ズームをリセット");
		this._register(dom.addDisposableListener(this._percentButton, dom.EventType.CLICK, () => this.setLevel(0)));

		this._zoomInButton = createParadisViewerIconButton(toolbar, Codicon.zoomIn, localize('paradis.viewer.zoomIn', "ズームイン"));
		this._register(dom.addDisposableListener(this._zoomInButton, dom.EventType.CLICK, () => this.setLevel(this._level + 1)));

		this._updateButtons();
	}

	/** 段階を変える（範囲外は端に寄せる）。変わったときだけ `onDidChange` を呼ぶ。 */
	setLevel(level: number): void {
		const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
		if (clamped !== this._level) {
			this._level = clamped;
			this._onDidChange();
		}
		this._updateButtons();
	}

	private _updateButtons(): void {
		if (this._percentButton) {
			this._percentButton.textContent = `${Math.round(this.factor * 100)}%`;
		}
		if (this._zoomOutButton) {
			this._zoomOutButton.disabled = this._level <= ZOOM_MIN;
		}
		if (this._zoomInButton) {
			this._zoomInButton.disabled = this._level >= ZOOM_MAX;
		}
	}
}

/** ビューアのツールバーに置くアイコンだけのボタン。 */
export function createParadisViewerIconButton(parent: HTMLElement, icon: ThemeIcon, title: string): HTMLButtonElement {
	const button = dom.append(parent, dom.$('button.paradis-html-zoom-button')) as HTMLButtonElement;
	button.title = title;
	dom.append(button, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`));
	return button;
}
