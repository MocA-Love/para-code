/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisSidebarTitle.css';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPartOptions } from '../../../../workbench/browser/part.js';
import { IPaneComposite } from '../../../../workbench/common/panecomposite.js';

/** 「スペース」の入れ物（Workspaces ビューの入れ物）の id。 */
export const PARADIS_SPACES_VIEW_CONTAINER_ID = 'workbench.view.paradisWorkspaces';

/** 題の行を隠している間、サイドバーの Part に付ける印（CSS が題の行を消す）。 */
export const PARADIS_SIDEBAR_TITLE_HIDDEN_CLASS = 'paradis-sidebar-title-hidden';

/**
 * サイドバーの題の行（「スペース: リポジトリ」と右のボタン）を隠すか。
 *
 * 隠すのは、アイコンの並びがサイドバーの上に出ていて（`workbench.activityBar.location: top`）、
 * 開いているのが「スペース」の入れ物で、その中のビューが 1 つだけ（題が「スペース: リポジトリ」になる）のとき。
 * このときは入れ物の切り替え・ドラッグ・右クリックのメニューが真上のアイコンの並びにあり、題の行で失う操作が無い。
 * 縦の列（default）・下（bottom）・非表示（hidden）では題の行がドラッグや右クリックの置き場なので残す。
 * 別のビューを同じ入れ物へ入れたときは、入れ物の題「スペース」と各ビューの見出しが要るので残す。
 */
export function paradisShouldHideSidebarTitle(activeContainerId: string | undefined, viewCount: number, compositeBarOnTop: boolean): boolean {
	return compositeBarOnTop && activeContainerId === PARADIS_SPACES_VIEW_CONTAINER_ID && viewCount === 1;
}

/** サイドバーの Part のうち、題の行の出し入れに使うもの。 */
export interface IParadisSidebarTitleHost {
	readonly element: HTMLElement | undefined;
	readonly onDidPaneCompositeOpen: Event<IPaneComposite>;
	getActivePaneComposite(): IPaneComposite | undefined;
}

/**
 * サイドバーの題の行を、{@link paradisShouldHideSidebarTitle} が真の間だけ隠す。
 * 高さは Part の `titleHeight` で 0 にし（内容がその分だけ上へ伸びる）、行そのものは CSS で消す。
 * 入れ物の切り替えとビューの出し入れで判定が変わったときは、Part に配置をし直させる。
 * アイコンの並びの位置の変更は、Part が上の行を足す・外すときに自分で配置をし直すので、ここでは追わない。
 */
export class ParadisSidebarTitle extends Disposable {

	private readonly compositeListeners = this._register(new DisposableStore());
	private hidden = false;

	constructor(
		private readonly host: IParadisSidebarTitleHost,
		private readonly compositeBarOnTop: () => boolean,
		private readonly relayout: () => void,
	) {
		super();
		this._register(host.onDidPaneCompositeOpen(composite => {
			this.compositeListeners.clear();
			const container = composite.getViewPaneContainer();
			if (container) {
				this.compositeListeners.add(Event.any(container.onDidAddViews, container.onDidRemoveViews)(() => this.relayoutIfChanged()));
			}
			this.relayoutIfChanged();
		}));
	}

	/** Part の options に `titleHeight` を足したものを返す。 */
	withTitleHeight(options: IPartOptions): IPartOptions {
		return { ...options, titleHeight: () => this.titleHeight() };
	}

	private shouldHide(): boolean {
		const composite = this.host.getActivePaneComposite();
		return paradisShouldHideSidebarTitle(composite?.getId(), composite?.getViewPaneContainer()?.views.length ?? 0, this.compositeBarOnTop());
	}

	/** 隠すときは 0、それ以外は既定の高さ（`undefined`）。DOM の印もここで合わせる。 */
	private titleHeight(): number | undefined {
		this.hidden = this.shouldHide();
		this.host.element?.classList.toggle(PARADIS_SIDEBAR_TITLE_HIDDEN_CLASS, this.hidden);
		return this.hidden ? 0 : undefined;
	}

	private relayoutIfChanged(): void {
		if (this.shouldHide() !== this.hidden) {
			this.relayout();
		}
	}
}
