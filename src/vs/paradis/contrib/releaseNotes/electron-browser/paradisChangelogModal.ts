/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ内更新履歴のモーダルダイアログ(案B: バージョンナビゲーター型)。
 * 左にバージョン一覧、右に本文。未インストールのバージョンには「利用可能な更新」を、
 * まだ読んでいない最新分には未読ドットを出す。データの取得と永続化は委譲側
 * (paradisReleaseNotes.contribution.ts)が行い、このクラスは表示に専念する。
 */

import './media/changelogModal.css';
import * as dom from '../../../../base/browser/dom.js';
import * as domSanitize from '../../../../base/browser/domSanitize.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { formatInlineMarkdown, IParadisChangelogRelease, IParadisChangelogSection } from '../common/paradisChangelogModel.js';

const $ = dom.$;

export interface IParadisChangelogViewRelease {
	readonly version: number;
	readonly label: string;
	readonly date?: string;
	readonly sections: readonly IParadisChangelogSection[];
	/** このビルドに同梱されたバージョンか(=インストール済み)。 */
	readonly installed: boolean;
}

export type ParadisChangelogRemoteState =
	| { readonly kind: 'fetching' }
	| { readonly kind: 'ok'; readonly fetchedAt: number }
	| { readonly kind: 'error' };

export interface IParadisChangelogModalDelegate {
	/** 起点となる「ここまで既読」バージョン。これより新しい項目に未読ドットが出る。 */
	readonly initialLastReadVersion: number;
	/** 項目を選択した(=そこまで読んだ)。永続化は委譲側が行う。 */
	onSelectRelease(version: number): void;
	/** 未インストール版バナーの「更新を確認…」。 */
	onCheckForUpdate(): void;
}

interface IParadisChangelogViewData {
	readonly releases: readonly IParadisChangelogViewRelease[];
	readonly installedVersion: number;
}

const CHIP_COLOR_VARS: Record<string, string> = {
	'新機能': 'var(--vscode-charts-blue)',
	'改善': 'var(--vscode-charts-green)',
	'修正': 'var(--vscode-charts-orange, var(--vscode-editorWarning-foreground))',
};

export class ParadisChangelogModal extends Disposable {

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	private readonly overlay: HTMLElement;
	private readonly dialog: HTMLElement;
	private readonly statusChip: HTMLElement;
	private readonly navElement: HTMLElement;
	private readonly bannerElement: HTMLElement;
	private readonly bannerTextElement: HTMLElement;
	private readonly contentElement: HTMLElement;

	/** フォーカストラップで Tab 循環の対象にする要素(DOM 順)。 */
	private closeButton!: HTMLButtonElement;
	private checkUpdateButton!: HTMLButtonElement;
	private footerCloseButton!: HTMLButtonElement;

	/** 再描画のたびに作り直すナビ項目のリスナー登録先。 */
	private readonly navListeners = this._register(new DisposableStore());
	/** renderNav() が作った項目要素。querySelectorAll に頼らず直接辿るため保持する。 */
	private readonly navItems = new Map<number, { readonly item: HTMLElement; readonly dot?: HTMLElement }>();

	private data: IParadisChangelogViewData;
	private selectedVersion: number | undefined;
	private lastReadVersion: number;
	private closed = false;

	/** dispose 済みか。取得完了後のコールバックからの二重操作防止に使う。 */
	get isDisposed(): boolean {
		return this.closed;
	}

	constructor(
		container: HTMLElement,
		data: IParadisChangelogViewData,
		private readonly delegate: IParadisChangelogModalDelegate,
	) {
		super();

		this.data = data;
		this.lastReadVersion = delegate.initialLastReadVersion;

		const previousFocus = container.ownerDocument.activeElement as HTMLElement | undefined;

		this.overlay = $('.para-cl-overlay');
		this.overlay.setAttribute('role', 'presentation');
		this._register(dom.addDisposableListener(this.overlay, dom.EventType.CLICK, e => {
			if (e.target === this.overlay) {
				this.close();
			}
		}));

		this.dialog = dom.append(this.overlay, $('.para-cl-dialog'));
		this.dialog.tabIndex = -1;
		this.dialog.setAttribute('role', 'dialog');
		this.dialog.setAttribute('aria-modal', 'true');
		this.dialog.setAttribute('aria-label', localize('paradis.changelog.title', "更新履歴"));

		// Esc はフォーカスがダイアログ外へ抜けても効くように document レベルで受ける。
		// workbench 側の Escape バインド(通知を閉じる等)との併走を避けるため伝播も止める
		this._register(dom.addDisposableListener(container.ownerDocument, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && !e.defaultPrevented) {
				e.preventDefault();
				e.stopPropagation();
				this.close();
			}
		}));

		// ヘッダー
		const header = dom.append(this.dialog, $('.para-cl-header'));
		dom.append(header, $('span.para-cl-title')).textContent =
			localize('paradis.changelog.title', "更新履歴");
		this.statusChip = dom.append(header, $('span.para-cl-status'));
		this.statusChip.style.display = 'none';
		this.statusChip.setAttribute('aria-live', 'polite');
		const closeButton = dom.append(header, $('button.para-cl-close')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.title = localize('paradis.changelog.close', "閉じる");
		closeButton.setAttribute('aria-label', closeButton.title);
		closeButton.append($(ThemeIcon.asClassName(Codicon.close)));
		this._register(dom.addDisposableListener(closeButton, dom.EventType.CLICK, () => this.close()));
		this.closeButton = closeButton;

		// レイアウト
		const layout = dom.append(this.dialog, $('.para-cl-layout'));
		this.navElement = dom.append(layout, $('nav.para-cl-nav'));
		this.navElement.setAttribute('aria-label', localize('paradis.changelog.versions', "バージョン一覧"));
		const main = dom.append(layout, $('.para-cl-main'));

		// 未インストール版向けバナー
		this.bannerElement = dom.append(main, $('.para-cl-banner'));
		this.bannerElement.style.display = 'none';
		this.bannerElement.append($(ThemeIcon.asClassName(Codicon.info)));
		this.bannerTextElement = dom.append(this.bannerElement, $('span.para-cl-banner-text'));
		const checkUpdateButton = dom.append(this.bannerElement, $('button.para-cl-btn')) as HTMLButtonElement;
		checkUpdateButton.type = 'button';
		checkUpdateButton.textContent = localize('paradis.changelog.checkUpdate', "更新を確認…");
		this._register(dom.addDisposableListener(checkUpdateButton, dom.EventType.CLICK, () => this.delegate.onCheckForUpdate()));
		this.checkUpdateButton = checkUpdateButton;

		this.contentElement = dom.append(main, $('.para-cl-content'));

		// フッター
		const footer = dom.append(this.dialog, $('.para-cl-footer'));
		const footnote = dom.append(footer, $('span.para-cl-footnote'));
		footnote.append($(ThemeIcon.asClassName(Codicon.info)));
		footnote.appendChild(document.createTextNode(
			localize('paradis.changelog.fallbackNote', "取得できないときは、このアプリに同梱された履歴のみを表示します")
		));
		dom.append(footer, $('div.para-cl-spacer'));
		const footerCloseButton = dom.append(footer, $('button.para-cl-btn.primary')) as HTMLButtonElement;
		footerCloseButton.type = 'button';
		footerCloseButton.textContent = localize('paradis.changelog.closeButton', "閉じる");
		this._register(dom.addDisposableListener(footerCloseButton, dom.EventType.CLICK, () => this.close()));
		this.footerCloseButton = footerCloseButton;

		// Tab の循環だけはダイアログ内で受ける(Esc は上の document リスナーが処理済み)
		this._register(dom.addDisposableListener(this.dialog, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Tab') {
				this.trapFocus(e);
			}
		}));

		container.appendChild(this.overlay);
		this.renderAll();

		this.dialog.focus();
		this._register({
			dispose: () => {
				if (previousFocus && previousFocus.isConnected) {
					previousFocus.focus();
				}
			}
		});
	}

	override dispose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.overlay.remove();
		this._onDidDispose.fire();
		super.dispose();
	}

	close(): void {
		this.dispose();
	}

	applyReleases(data: IParadisChangelogViewData): void {
		const selectionUnchanged = data.releases.some(release => release.version === this.selectedVersion);
		const previousScrollTop = this.contentElement.scrollTop;

		this.data = data;
		if (!selectionUnchanged) {
			this.selectedVersion = data.releases[0]?.version;
		}
		this.renderAll();

		// リモート反映による再描画でも、読んでいた位置が飛ばないようにする
		if (selectionUnchanged) {
			this.contentElement.scrollTop = previousScrollTop;
		}
	}

	setRemoteState(state: ParadisChangelogRemoteState): void {
		if (state.kind === 'error') {
			this.statusChip.style.display = 'none';
			return;
		}
		this.statusChip.style.display = '';
		dom.clearNode(this.statusChip);
		if (state.kind === 'fetching') {
			this.statusChip.append($(ThemeIcon.asClassName(Codicon.sync)));
			this.statusChip.appendChild(document.createTextNode(
				localize('paradis.changelog.fetching', "サーバーを確認中…")
			));
		} else {
			this.statusChip.append($(ThemeIcon.asClassName(Codicon.cloudDownload)));
			this.statusChip.appendChild(document.createTextNode(
				localize('paradis.changelog.fetchedAt', "サーバーから取得済み · {0}",
					new Date(state.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))
			));
		}
	}

	private selectVersion(version: number): void {
		this.selectedVersion = version;
		for (const [itemVersion, entry] of this.navItems) {
			entry.item.classList.toggle('active', itemVersion === version);
		}
		this.renderContent();
		if (version > this.lastReadVersion) {
			this.lastReadVersion = version;
			this.delegate.onSelectRelease(version);
			this.updateUnreadDots();
		}
	}

	private updateUnreadDots(): void {
		for (const [version, entry] of this.navItems) {
			if (!(version > this.lastReadVersion)) {
				entry.dot?.remove();
			}
		}
	}

	private renderAll(): void {
		this.renderNav();
		this.selectedVersion ??= this.data.releases[0]?.version;
		this.renderContent();
	}

	private renderNav(): void {
		this.navListeners.clear();
		this.navItems.clear();
		dom.clearNode(this.navElement);
		for (const release of this.data.releases) {
			const item = dom.append(this.navElement, $('button.para-cl-item')) as HTMLButtonElement;
			item.type = 'button';
			item.classList.toggle('active', release.version === this.selectedVersion);

			dom.append(item, $('div.para-cl-item-name')).textContent = release.label;
			if (release.date) {
				dom.append(item, $('div.para-cl-item-date')).textContent = release.date;
			}

			const tags = dom.append(item, $('div.para-cl-item-tags'));
			if (!release.installed) {
				const tag = $(`span.para-cl-tag.para-cl-tag-available${ThemeIcon.asCSSSelector(Codicon.cloudDownload)}`);
				tag.textContent = localize('paradis.changelog.availableTag', "利用可能な更新");
				tags.append(tag);
			} else if (release.version === this.data.installedVersion) {
				const tag = $(`span.para-cl-tag.para-cl-tag-current`);
				tag.textContent = localize('paradis.changelog.currentTag', "現在使用中");
				tags.append(tag);
			}

			let dot: HTMLElement | undefined;
			if (release.version > this.lastReadVersion && !release.installed) {
				dot = $('span.para-cl-dot');
				item.append(dot);
			}
			this.navItems.set(release.version, { item, dot });

			this.navListeners.add(dom.addDisposableListener(item, dom.EventType.CLICK, () => {
				this.selectVersion(release.version);
			}));
		}
	}

	private renderContent(): void {
		dom.clearNode(this.contentElement);
		this.bannerElement.style.display = 'none';

		const release = this.data.releases.find(r => r.version === this.selectedVersion);
		if (!release) {
			dom.append(this.contentElement, $('div.para-cl-empty')).textContent =
				localize('paradis.changelog.empty', "更新履歴はまだありません");
			return;
		}

		if (!release.installed) {
			this.bannerElement.style.display = '';
			this.bannerTextElement.textContent = localize('paradis.changelog.notInstalled',
				"{0} はまだインストールされていません。この変更点は次回の更新で反映されます。", release.label);
		}

		const head = dom.append(this.contentElement, $('.para-cl-ver-head'));
		dom.append(head, $('span.para-cl-ver-label')).textContent = release.label;
		if (release.date) {
			dom.append(head, $('span.para-cl-ver-date')).textContent = release.date;
		}

		for (const section of release.sections) {
			const card = dom.append(this.contentElement, $('.para-cl-card'));
			const cardHead = dom.append(card, $('.para-cl-card-head'));
			const chipColor = CHIP_COLOR_VARS[section.category];
			const dot = dom.append(cardHead, $('span.para-cl-card-dot'));
			if (chipColor) {
				dot.style.setProperty('--paradis-chip-color', chipColor);
			}
			dom.append(cardHead, $('span.para-cl-card-category')).textContent = section.category;
			dom.append(cardHead, $('span.para-cl-count')).textContent =
				localize('paradis.changelog.itemCount', "{0}件", section.items.length);

			const list = dom.append(card, $('ul.para-cl-items'));
			for (const entry of section.items) {
				const li = dom.append(list, $('li'));
				domSanitize.safeSetInnerHtml(li, formatInlineMarkdown(entry));
			}
		}
	}

	private trapFocus(e: KeyboardEvent): void {
		// 自分で作った要素を DOM 順に並べただけのフォーカス対象。表示中のものだけ循環する
		const focusables = [
			this.closeButton,
			...Array.from(this.navItems.values(), entry => entry.item),
			this.checkUpdateButton,
			this.footerCloseButton,
		].filter(el => el.offsetParent !== null);
		if (focusables.length === 0) {
			return;
		}
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = this.dialog.ownerDocument.activeElement;
		if (!dom.isHTMLElement(active) || !this.dialog.contains(active)) {
			e.preventDefault();
			first.focus();
		} else if (e.shiftKey && active === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}
}

export function toViewReleases(releases: readonly IParadisChangelogRelease[], installedVersion: number): IParadisChangelogViewRelease[] {
	return releases.map(release => ({
		...release,
		installed: release.version <= installedVersion,
	}));
}
