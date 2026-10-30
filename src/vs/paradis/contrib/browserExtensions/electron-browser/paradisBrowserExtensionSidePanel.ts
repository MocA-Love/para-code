/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能のサイドパネル（chrome.sidePanel、P9d）の置き場所。内蔵ブラウザのタブの中身を右に寄せて（beforeContainerLayout の
// padding）空けた所に、パネルの見出し（拡張機能の名前と閉じるボタン）を出し、その下の四角を main へ送る。パネルの中身は main が
// ウィンドウに置く WebContentsView（../electron-main/paradisBrowserExtensionSidePanel.ts）。
//  - どのタブの横に出すか・出してよいかは main が決める（そのウィンドウの前のタブで、エージェントのタブでも共有中でもないとき）
//  - エディタが見えないとき・前面の表示（quick pick・ダイアログ・メニュー）がパネルに重なるときは隠す（WebContentsView は
//    workbench の HTML より前に描かれるので、隠さないと前面の表示を覆う）
// upstream のファイルには触らず、BrowserEditor.registerContribution() の拡張点だけで足している。

import * as dom from '../../../../base/browser/dom.js';
import { getZoomFactor } from '../../../../base/browser/browser.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, IContainerLayoutOverride } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { BrowserOverlayManager } from '../../../../workbench/contrib/browserView/electron-browser/overlayManager.js';
import { IParadisSidePanelView } from '../common/paradisBrowserExtensions.js';
import { IParadisBrowserExtensionToolbarService } from './paradisBrowserExtensionToolbar.js';

const $ = dom.$;
/** パネルの見出しの高さ（CSS のピクセル）。 */
const HEADER_HEIGHT = 30;
/** パネルの幅の上限（タブの中身の幅に対する割合）。 */
const MAX_WIDTH_RATIO = 0.5;

export class ParadisBrowserExtensionSidePanelFeature extends BrowserEditorContribution {

	private readonly _element = $('.paradis-side-panel');
	private readonly _title = $('.paradis-side-panel-title');
	private _wrapper: HTMLElement | undefined;
	private _overlays: BrowserOverlayManager | undefined;
	private _panel: IParadisSidePanelView | undefined;
	private _visible = true;
	/**
	 * 最後に「出す」を送った内蔵ブラウザのタブ（view の id）。隠すときはこの id へ送る。エディタは model を外してから
	 * onModelDetached を呼ぶので、そのときの this.editor.model からは隠す先が分からない（別のエディタに切り替えたときに
	 * パネルが残った。2026-10-30 に配布版で確かめた）。
	 */
	private _shownFor: string | undefined;
	private _generation = 0;

	constructor(
		editor: BrowserEditor,
		@IParadisBrowserExtensionToolbarService private readonly _toolbarService: IParadisBrowserExtensionToolbarService,
	) {
		super(editor);
		const header = dom.append(this._element, $('.paradis-side-panel-header'));
		header.style.height = `${HEADER_HEIGHT}px`;
		dom.append(header, this._title);
		const close = dom.append(header, $<HTMLButtonElement>('button.paradis-side-panel-close'));
		close.type = 'button';
		close.title = localize('paradis.browserExtensions.sidePanel.close', "サイドパネルを閉じる");
		close.setAttribute('aria-label', close.title);
		close.appendChild($(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(dom.addDisposableListener(close, 'click', () => {
			const model = this.editor.model;
			if (model) {
				void this._toolbarService.main.setSidePanelOpen(model.id, this._panel?.extensionId ?? '', false);
			}
		}));
		this._element.style.display = 'none';
	}

	override onContainerCreated(container: HTMLElement): void {
		// タブの中身の外（padding で空けた所）に置く
		this._wrapper = container.parentElement ?? undefined;
		this._wrapper?.appendChild(this._element);
		this._overlays = this._register(new BrowserOverlayManager(this.editor.window));
		this._register(this._overlays.onDidChangeOverlayState(() => this._push()));
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		if (!this._toolbarService.active) {
			return;
		}
		store.add(this._toolbarService.onDidChangeToolbar(() => this._refresh(model)));
		this._refresh(model);
	}

	override onModelDetached(): void {
		this._generation++;
		this._set(undefined);
	}

	override onPaneVisibilityChanged(visible: boolean): void {
		this._visible = visible;
		this._push();
	}

	override beforeContainerLayout(): IContainerLayoutOverride | undefined {
		const width = this._width();
		return width > 0 ? { padding: { right: width } } : undefined;
	}

	override afterContainerLayout(): void {
		this._push();
	}

	private _width(): number {
		if (!this._panel || !this._wrapper) {
			return 0;
		}
		const available = this._wrapper.getBoundingClientRect().width;
		return Math.max(0, Math.min(this._panel.width, Math.floor(available * MAX_WIDTH_RATIO)));
	}

	private _refresh(model: IBrowserViewModel): void {
		const generation = ++this._generation;
		this._toolbarService.main.getSidePanel(model.id).then(panel => {
			if (generation === this._generation && this.editor.model === model) {
				this._set(panel);
			}
		}, () => { /* main が落ちている: 前のまま */ });
	}

	private _set(panel: IParadisSidePanelView | undefined): void {
		const changed = panel?.extensionId !== this._panel?.extensionId || panel?.width !== this._panel?.width;
		this._panel = panel;
		this._title.textContent = panel?.name ?? '';
		if (changed) {
			// タブの中身の幅を取り直す（padding が変わる）。その後に afterContainerLayout が場所を送る
			this.editor.layoutBrowserContainer();
		}
		this._push();
	}

	/** パネルの場所を main へ送る（出さないなら隠させる）。 */
	private _push(): void {
		const model = this.editor.model;
		const width = this._width();
		if (!model || !this._wrapper || width === 0) {
			this._element.style.display = 'none';
			this._hide();
			return;
		}
		const wrapperRect = this._wrapper.getBoundingClientRect();
		this._element.style.display = '';
		this._element.style.width = `${width}px`;
		const left = wrapperRect.right - width;
		const covered = (this._overlays?.getOverlappingOverlays(this._element).length ?? 0) > 0;
		if (!this._visible || covered || wrapperRect.height <= HEADER_HEIGHT) {
			this._hide();
			return;
		}
		if (this._shownFor !== undefined && this._shownFor !== model.id) {
			// 同じエディタで別のタブに替わった: 前のタブのパネルを先に隠させる
			this._hide();
		}
		this._shownFor = model.id;
		void this._toolbarService.main.layoutSidePanel(model.id, {
			x: left,
			y: wrapperRect.top + HEADER_HEIGHT,
			width,
			height: wrapperRect.height - HEADER_HEIGHT,
			zoomFactor: getZoomFactor(this.editor.window),
		}).catch(() => undefined);
	}

	private _hide(): void {
		const id = this._shownFor;
		if (id !== undefined) {
			this._shownFor = undefined;
			void this._toolbarService.main.layoutSidePanel(id, undefined).catch(() => undefined);
		}
	}
}

BrowserEditor.registerContribution(ParadisBrowserExtensionSidePanelFeature);
