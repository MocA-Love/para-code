/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 統合のモーダルの器（Q537 の 11 C）。見出しの行に上段の領域の切り替え、下に左のナビと本文を置く。
// 大きさはモーダルの段 L（paradisModal.ts）。領域の中身は paradisHub.ts に登録された各領域が描く。

import './media/paradisHub.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { paradisModalClasses, ParadisModalSize } from '../../../browser/paradisModal.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { IParadisHubAreaContainers, IParadisHubAreaDescriptor, IParadisHubAreaView, IParadisHubHost, ParadisHubAreaId, paradisHubAreas } from './paradisHub.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.hub.title', "Para Code");
// allow-any-unicode-next-line
const STR_CLOSE_ARIA = localize('paradis.hub.closeAria', "閉じる");
// allow-any-unicode-next-line
const STR_AREAS_ARIA = localize('paradis.hub.areasAria', "領域");

interface IAreaEntry {
	readonly descriptor: IParadisHubAreaDescriptor;
	readonly button: HTMLButtonElement;
	readonly header: HTMLElement;
	readonly body: HTMLElement;
	readonly containers: IParadisHubAreaContainers;
}

export class ParadisHubDialog extends Disposable implements IParadisHubHost {

	private readonly backdrop: HTMLElement;
	private readonly modal: HTMLElement;
	private readonly entries = new Map<ParadisHubAreaId, IAreaEntry>();
	private readonly views = this._register(new DisposableMap<ParadisHubAreaId, IParadisHubAreaView>());
	private activeArea: ParadisHubAreaId | undefined;

	private readonly _onDidDispose = this._register(new Emitter<void>());
	/** 閉じた（破棄された）ことを、開いた側が参照を手放すために知らせる。 */
	readonly onDidDispose = this._onDidDispose.event;

	constructor(
		area: ParadisHubAreaId,
		section: string | undefined,
		@ILayoutService layoutService: ILayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		// `paradis-modal-backdrop` は、内蔵ブラウザのページがこのモーダルより前に出ないための印（overlayManager.ts）
		this.backdrop = $('.paradis-hub-backdrop.paradis-modal-backdrop');
		this.modal = dom.append(this.backdrop, $('.paradis-hub'));
		this.modal.classList.add(...paradisModalClasses(ParadisModalSize.Large));
		this.modal.setAttribute('role', 'dialog');
		this.modal.setAttribute('aria-modal', 'true');
		this.modal.setAttribute('aria-label', STR_TITLE);
		this.modal.tabIndex = -1;

		const header = dom.append(this.modal, $('.phub-header'));
		dom.append(header, $('h2')).textContent = STR_TITLE;
		const areaSeg = dom.append(header, $('.phub-areas'));
		areaSeg.setAttribute('role', 'tablist');
		areaSeg.setAttribute('aria-label', STR_AREAS_ARIA);
		const headerSlots = dom.append(header, $('.phub-header-slots'));
		const close = dom.append(header, $('button.phub-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', STR_CLOSE_ARIA);
		close.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.dispose()));

		const bodies = dom.append(this.modal, $('.phub-bodies'));
		for (const descriptor of paradisHubAreas()) {
			const button = dom.append(areaSeg, $('button')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.textContent = descriptor.label;
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.open(descriptor.id)));

			const areaHeader = dom.append(headerSlots, $('.phub-header-slot'));
			const body = dom.append(bodies, $('.phub-body'));
			const nav = dom.append(body, $('nav.phub-nav'));
			const content = dom.append(body, $('.phub-content'));
			areaHeader.style.display = 'none';
			body.style.display = 'none';
			this.entries.set(descriptor.id, { descriptor, button, header: areaHeader, body, containers: { nav, content, header: areaHeader } });

			// ナビの項目はキーボードでも押せるようにする（Enter・Space）
			this._register(dom.addDisposableListener(nav, dom.EventType.KEY_DOWN, e => {
				const event = new StandardKeyboardEvent(e);
				const item = dom.isHTMLElement(e.target) ? e.target.closest<HTMLElement>('.phub-nav-item') : null;
				if (item && (event.keyCode === KeyCode.Enter || event.keyCode === KeyCode.Space)) {
					event.preventDefault();
					item.click();
				}
			}));
		}

		// 本文の幅は器でしか分からないので、実測して開いている領域へ渡す（窓の大きさの変化にも付いていく）
		const observer = new ResizeObserver(() => this.layoutActive());
		observer.observe(bodies);
		this._register({ dispose: () => observer.disconnect() });

		this._register(dom.addDisposableListener(this.backdrop, dom.EventType.MOUSE_DOWN, e => {
			if (e.target === this.backdrop) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this.backdrop);
		this._register(new ParadisModalFocus({
			backdrop: this.backdrop,
			modal: this.modal,
			onEscape: () => {
				const view = this.activeArea !== undefined ? this.views.get(this.activeArea) : undefined;
				if (!view?.handleEscape?.()) {
					this.dispose();
				}
			},
			close: () => this.dispose(),
		}));
		this.open(area, section);
		this.modal.focus();
	}

	/** 領域（と節）を開く。まだ作っていない領域はここで作る。 */
	open(area: ParadisHubAreaId, section?: string): void {
		const entry = this.entries.get(area) ?? this.entries.values().next().value;
		if (!entry) {
			return;
		}
		const id = entry.descriptor.id;
		let view = this.views.get(id);
		if (!view) {
			view = entry.descriptor.create(this.instantiationService, entry.containers, this);
			this.views.set(id, view);
		}
		if (this.activeArea !== id) {
			const previous = this.activeArea !== undefined ? this.entries.get(this.activeArea) : undefined;
			if (previous) {
				previous.body.style.display = 'none';
				previous.header.style.display = 'none';
				this.views.get(previous.descriptor.id)?.setVisible(false);
			}
			this.activeArea = id;
			for (const other of this.entries.values()) {
				const selected = other === entry;
				other.button.classList.toggle('checked', selected);
				other.button.setAttribute('aria-selected', String(selected));
			}
			entry.body.style.display = '';
			entry.header.style.display = '';
			view.setVisible(true);
		}
		view.reveal(section);
		this.layoutActive();
	}

	close(): void {
		this.dispose();
	}

	/** この器が `container`（窓の作業領域）の中に出ているか。 */
	isShownIn(container: HTMLElement): boolean {
		return container.contains(this.backdrop);
	}

	private layoutActive(): void {
		const entry = this.activeArea !== undefined ? this.entries.get(this.activeArea) : undefined;
		const width = entry?.containers.content.clientWidth ?? 0;
		if (entry && width > 0) {
			this.views.get(entry.descriptor.id)?.layout(width);
		}
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		this.backdrop.remove();
		this._onDidDispose.fire();
		super.dispose();
	}
}
