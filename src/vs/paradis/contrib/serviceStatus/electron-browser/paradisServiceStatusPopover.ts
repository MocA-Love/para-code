/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// サービスステータスチップをクリックすると開く、単一サービス分の詳細ポップオーバー(案A)。
// paradisLimitsMonitorPanel.ts と同じ自前DOM(position: fixed、layoutService.activeContainer直下)
// 方式で、ポーリングは行わずウィジェットから updateEntry() を受け取るだけの受け身のビュー。

import './media/paradisServiceStatus.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { fromNow } from '../../../../base/common/date.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import {
	IParadisServiceStatusEntry,
	PARADIS_SERVICE_STATUS_SOURCES,
	ParadisServiceStatusProvider,
	ParadisServiceStatusSeverity,
	paradisServiceStatusSeverityLabel,
} from '../common/paradisServiceStatus.js';
import { appendParadisServiceStatusLogo } from './paradisServiceStatusLogos.js';

const $ = dom.$;

const POPOVER_WIDTH = 300;

export interface IParadisServiceStatusPopoverOptions {
	readonly provider: ParadisServiceStatusProvider;
	readonly entry: IParadisServiceStatusEntry | undefined;
	readonly onClose: () => void;
}

function fallbackDescription(severity: ParadisServiceStatusSeverity): string {
	switch (severity) {
		case 'ok':
			return localize('paradis.serviceStatus.desc.ok', "すべてのシステムが正常に稼働しています。");
		case 'minor':
			return localize('paradis.serviceStatus.desc.minor', "軽微な障害が発生しています。");
		case 'major':
			return localize('paradis.serviceStatus.desc.major', "大規模な障害が発生しています。");
		case 'maintenance':
			return localize('paradis.serviceStatus.desc.maintenance', "計画メンテナンスが実施されています。");
		default:
			return localize('paradis.serviceStatus.desc.unknown', "ステータスを取得できませんでした。");
	}
}

/** Enter/Space をクリック相当として扱う(フッターのリンク・管理ボタンで共有)。 */
function onActivateKey(e: KeyboardEvent, run: () => void): void {
	if (e.key === 'Enter' || e.key === ' ') {
		e.preventDefault();
		run();
	}
}

export class ParadisServiceStatusPopover extends Disposable {

	private readonly element: HTMLElement;
	private readonly bodyElement: HTMLElement;
	private readonly _bodyListeners = this._register(new DisposableStore());
	private entry: IParadisServiceStatusEntry | undefined;

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisServiceStatusPopoverOptions,
		@ILayoutService layoutService: ILayoutService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.entry = options.entry;
		this.element = $('.paradis-service-status-popover');
		this.element.style.width = `${POPOVER_WIDTH}px`;
		this.element.tabIndex = -1;
		this.bodyElement = dom.append(this.element, $('.pssp-body'));

		layoutService.activeContainer.appendChild(this.element);
		this.reposition();
		this.render();
		this.element.focus();

		this._register(dom.addDisposableListener(dom.getActiveWindow(), 'resize', () => this.reposition()));
		this._register(dom.addDisposableListener(dom.getActiveWindow(), 'mousedown', e => this.onWindowMouseDown(e), true));
		this._register(dom.addDisposableListener(this.element, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.options.onClose();
			}
		}));
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	updateEntry(entry: IParadisServiceStatusEntry): void {
		this.entry = entry;
		this.render();
	}

	private onWindowMouseDown(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (!target) {
			return;
		}
		if (dom.isAncestor(target, this.element) || dom.isAncestor(target, this.anchor)) {
			return;
		}
		this.options.onClose();
	}

	private reposition(): void {
		const rect = this.anchor.getBoundingClientRect();
		const win = dom.getActiveWindow();
		const left = Math.max(8, Math.min(rect.left, win.innerWidth - POPOVER_WIDTH - 8));
		const maxTop = win.innerHeight - 40;
		this.element.style.top = `${Math.min(rect.bottom + 6, maxTop)}px`;
		this.element.style.left = `${left}px`;
	}

	private render(): void {
		this._bodyListeners.clear();
		dom.clearNode(this.bodyElement);

		const { provider } = this.options;
		const entry = this.entry;
		const source = PARADIS_SERVICE_STATUS_SOURCES[provider];
		const severity = entry?.severity ?? 'unknown';

		const title = dom.append(this.bodyElement, $('.pssp-title'));
		appendParadisServiceStatusLogo(title, provider);
		dom.append(title, $('span')).textContent = source.label;
		const badge = dom.append(title, $(`.pssp-level.${severity}`));
		badge.textContent = paradisServiceStatusSeverityLabel(severity);

		dom.append(this.bodyElement, $('.pssp-desc')).textContent = entry?.description ?? fallbackDescription(severity);

		const meta = dom.append(this.bodyElement, $('.pssp-meta'));
		if (!entry) {
			meta.textContent = localize('paradis.serviceStatus.loading', "読み込み中…");
		} else if (entry.error) {
			meta.textContent = localize('paradis.serviceStatus.checkedAtWithError', "{0}に確認(取得失敗: {1})", fromNow(entry.fetchedAt, true), entry.error);
		} else {
			meta.textContent = localize('paradis.serviceStatus.checkedAt', "{0}に確認", fromNow(entry.fetchedAt, true));
		}

		const footer = dom.append(this.bodyElement, $('.pssp-footer'));
		const link = dom.append(footer, $('a.pssp-link'));
		link.setAttribute('role', 'button');
		link.tabIndex = 0;
		link.textContent = localize('paradis.serviceStatus.openStatusPage', "{0} を開く", source.statusPageUrl.replace(/^https:\/\//, ''));
		const openStatusPage = () => { void this.openerService.open(URI.parse(source.statusPageUrl)); };
		this._bodyListeners.add(dom.addDisposableListener(link, 'click', e => { e.preventDefault(); openStatusPage(); }));
		this._bodyListeners.add(dom.addDisposableListener(link, 'keydown', e => onActivateKey(e, openStatusPage)));

		const manage = dom.append(footer, $('span.pssp-manage'));
		manage.setAttribute('role', 'button');
		manage.tabIndex = 0;
		manage.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.gear)}`));
		dom.append(manage, $('span')).textContent = localize('paradis.serviceStatus.manage', "管理");
		const openSettings = () => { void this.commandService.executeCommand('workbench.action.openSettings', 'paradis.serviceStatus'); };
		this._bodyListeners.add(dom.addDisposableListener(manage, 'click', openSettings));
		this._bodyListeners.add(dom.addDisposableListener(manage, 'keydown', e => onActivateKey(e, openSettings)));
	}
}
