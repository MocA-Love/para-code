/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { getWindow } from '../../../../base/browser/dom.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import './media/paradisTitlebarFit.css';

/**
 * 幅の段。タイトルバー自身の幅がこの値以下になったら `paradis-fit-<値>` をタイトルバーに付け、
 * CSS (paradisTitlebarFit.css) がそのクラスを見て優先度の低い部品から畳む。
 */
const FIT_STEPS = [1400, 1200, 1000] as const;

/** カスタムメニューバーがタイトルバー左側に見えているあいだ付けるクラス。 */
const MENUBAR_VISIBLE_CLASS = 'paradis-fit-menubar-visible';

/** titlebarPart.ts の PARA-PATCH 点 (NativeTitlebarPart.createContentArea) から呼ばれるファクトリ。 */
export function createParadisTitlebarFit(rootContainer: HTMLElement, leftContent: HTMLElement): IDisposable {
	return new ParadisTitlebarFit(rootContainer, leftContent);
}

/**
 * タイトルバーに fork が足した部品 (左: CPU/RAM・リミット・サービス状態・ポート、右: エージェント一覧・
 * ブラウザ一覧) を、狭いウィンドウでも中央のコマンドセンターに重ねないための状態をクラスで出す。
 *
 * - 幅はウィンドウのメディアクエリではなくタイトルバー自身の幅で測る。ズームアウトするとタイトルバーは
 *   `counter-zoom` で等倍に戻して描かれ、ウィンドウの CSS px とタイトルバー内の px がずれるため
 * - カスタムメニューバー (Windows/Linux) が左側に見えているかも出す。見えているときは左側を内容の幅に
 *   固定しない (メニューバーは自分の幅を測ってメニューを畳むので、固定すると畳めなくなる)。`.menubar` は
 *   メニューを隠す設定でも要素としては残るため、要素の有無ではなく実際の表示を見る
 */
class ParadisTitlebarFit extends Disposable {

	private readonly resizeObserver: ResizeObserver;
	private observedMenubar: HTMLElement | undefined;

	constructor(
		private readonly rootContainer: HTMLElement,
		private readonly leftContent: HTMLElement,
	) {
		super();

		const targetWindow = getWindow(rootContainer);
		this.resizeObserver = new targetWindow.ResizeObserver(() => this.update());
		this._register(toDisposable(() => this.resizeObserver.disconnect()));
		this.resizeObserver.observe(rootContainer);

		// メニューバーは設定の変更で作り直される。付け替わった要素を追いかけて、表示の切り替え
		// (display: none ⇄ flex) も ResizeObserver で拾う。左側の部品の `active` (パネルを開いている)
		// の付け外しも見て、閉じたときに止めていた段を追いつかせる
		const mutationObserver = new targetWindow.MutationObserver(() => this.update());
		this._register(toDisposable(() => mutationObserver.disconnect()));
		mutationObserver.observe(leftContent, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

		this.update();
	}

	override dispose(): void {
		for (const step of FIT_STEPS) {
			this.rootContainer.classList.remove(`paradis-fit-${step}`);
		}
		this.rootContainer.classList.remove(MENUBAR_VISIBLE_CLASS);
		super.dispose();
	}

	private update(): void {
		const menubar = this.findMenubar();
		if (menubar !== this.observedMenubar) {
			if (this.observedMenubar) {
				this.resizeObserver.unobserve(this.observedMenubar);
			}
			this.observedMenubar = menubar;
			if (menubar) {
				this.resizeObserver.observe(menubar);
			}
		}
		this.rootContainer.classList.toggle(MENUBAR_VISIBLE_CLASS, !!menubar && menubar.offsetWidth > 0);

		// clientWidth はタイトルバー自身の座標 (counter-zoom の中の px) で返る。中の部品の幅と同じ単位
		const width = this.rootContainer.clientWidth;
		if (width === 0) {
			return; // 非表示 (全画面の一部状態など) のあいだは段を変えない
		}
		if (this.hasOpenPanel()) {
			// 左側のパネルやポップオーバーは開いた時点のボタンの位置に置かれる。開いているあいだに段を
			// 変えると、そのボタンが隠れたり隣が畳まれてずれたりしてパネルだけが取り残されるので止める
			return;
		}
		for (const step of FIT_STEPS) {
			this.rootContainer.classList.toggle(`paradis-fit-${step}`, width <= step);
		}
	}

	private hasOpenPanel(): boolean {
		for (const child of this.leftContent.children) {
			if (child.classList.contains('active')) {
				return true;
			}
		}
		return false;
	}

	private findMenubar(): HTMLElement | undefined {
		for (const child of this.leftContent.children) {
			if (child.classList.contains('menubar')) {
				return child as HTMLElement;
			}
		}
		return undefined;
	}
}
