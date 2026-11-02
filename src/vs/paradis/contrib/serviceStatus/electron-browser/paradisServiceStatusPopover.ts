/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーのサービスの稼働状況の項目を押すと開く、3 サービスをまとめたポップオーバー(Q537 の 41 A)。
// 本家のホバーの色で、1 サービス 1 行に名前・状態・(障害のときだけ)ステータスページの説明・ステータス
// ページへのボタンを並べ、下段に「今すぐ確認」と「設定」を置く。paradisLimitsMonitorPanel.ts と同じ
// 自前DOM(position: fixed、layoutService.activeContainer直下)方式で、ポーリングはウィジェットが行い、
// ここは updateSnapshot() を受け取るだけの受け身のビュー。

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
	IParadisServiceStatusSnapshot,
	PARADIS_SERVICE_STATUS_PROVIDERS,
	PARADIS_SERVICE_STATUS_SOURCES,
	ParadisServiceStatusProvider,
	paradisServiceStatusSeverityLabel,
} from '../common/paradisServiceStatus.js';
import { appendParadisServiceStatusLogo } from './paradisServiceStatusLogos.js';

const $ = dom.$;

const POPOVER_WIDTH = 320;

export interface IParadisServiceStatusPopoverOptions {
	readonly snapshot: IParadisServiceStatusSnapshot | undefined;
	readonly onClose: () => void;
	/** 「今すぐ確認」: 最短間隔のガードを飛ばして取り直す。 */
	readonly onRefresh: () => void;
}

/** Enter/Space をクリック相当として扱う(行のボタン・下段のリンクで共有)。 */
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
	private snapshot: IParadisServiceStatusSnapshot | undefined;

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisServiceStatusPopoverOptions,
		@ILayoutService layoutService: ILayoutService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.snapshot = options.snapshot;
		this.element = $('.paradis-service-status-popover.paradis-overlay-popover');
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

	updateSnapshot(snapshot: IParadisServiceStatusSnapshot): void {
		this.snapshot = snapshot;
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
		const snapshot = this.snapshot;

		const title = dom.append(this.bodyElement, $('.pssp-title'));
		dom.append(title, $('span.pssp-title-text')).textContent = localize('paradis.serviceStatus.popoverTitle', "サービスの稼働状況");
		const meta = dom.append(title, $('span.pssp-meta'));
		meta.textContent = snapshot
			? localize('paradis.serviceStatus.checkedAt', "{0}に確認", fromNow(snapshot.generatedAt, true))
			: localize('paradis.serviceStatus.loading', "読み込み中…");

		for (const provider of PARADIS_SERVICE_STATUS_PROVIDERS) {
			this.renderRow(provider, snapshot?.entries[provider]);
		}

		const footer = dom.append(this.bodyElement, $('.pssp-footer'));
		this.appendLink(footer, localize('paradis.serviceStatus.refreshNow', "今すぐ確認"), () => this.options.onRefresh());
		this.appendLink(footer, localize('paradis.serviceStatus.settings', "設定"), () => { void this.commandService.executeCommand('workbench.action.openSettings', 'paradis.serviceStatus'); });
	}

	private renderRow(provider: ParadisServiceStatusProvider, entry: IParadisServiceStatusEntry | undefined): void {
		const source = PARADIS_SERVICE_STATUS_SOURCES[provider];
		const severity = entry?.severity ?? 'unknown';
		const row = dom.append(this.bodyElement, $('.pssp-row'));
		appendParadisServiceStatusLogo(row, provider);
		dom.append(row, $('span.pssp-name')).textContent = source.label;
		dom.append(row, $(`span.paradis-service-status-dot.${severity}`));
		dom.append(row, $('span.pssp-level')).textContent = paradisServiceStatusSeverityLabel(severity);
		// ステータスページの説明(英語のことが多い)は、何か起きているときだけ薄く添える。
		// 取得に失敗したときは失敗の理由を出す。
		const detail = entry?.error ?? (severity !== 'ok' && severity !== 'unknown' ? entry?.description : undefined);
		if (detail) {
			const desc = dom.append(row, $('span.pssp-desc'));
			desc.textContent = detail;
			desc.title = detail;
		} else {
			dom.append(row, $('span.pssp-spacer'));
		}
		const open = dom.append(row, $(`span.pssp-icon-button${ThemeIcon.asCSSSelector(Codicon.globe)}`));
		open.setAttribute('role', 'button');
		open.tabIndex = 0;
		const label = localize('paradis.serviceStatus.openStatusPage', "{0} を開く", source.statusPageUrl.replace(/^https:\/\//, ''));
		open.setAttribute('aria-label', label);
		open.title = label;
		const openStatusPage = () => { void this.openerService.open(URI.parse(source.statusPageUrl)); };
		this._bodyListeners.add(dom.addDisposableListener(open, 'click', e => { e.preventDefault(); openStatusPage(); }));
		this._bodyListeners.add(dom.addDisposableListener(open, 'keydown', e => onActivateKey(e, openStatusPage)));
	}

	private appendLink(parent: HTMLElement, text: string, run: () => void): void {
		const link = dom.append(parent, $('a.pssp-link'));
		link.setAttribute('role', 'button');
		link.tabIndex = 0;
		link.textContent = text;
		this._bodyListeners.add(dom.addDisposableListener(link, 'click', e => { e.preventDefault(); run(); }));
		this._bodyListeners.add(dom.addDisposableListener(link, 'keydown', e => onActivateKey(e, run)));
	}
}
