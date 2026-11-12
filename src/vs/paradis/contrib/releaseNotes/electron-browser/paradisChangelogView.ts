/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ内更新履歴（統合のモーダルの「更新履歴」の領域。Q537 の 39 C・12）。
 * 左のナビにバージョン一覧（利用可能な更新 / インストール済み）、右に本文。まだ読んでいない
 * 利用可能な更新には未読ドットを出す。データの取得と永続化は委譲側
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
import { IParadisHubAreaContainers } from '../../paradisHub/electron-browser/paradisHub.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { IParadisHubNavItem, paradisHubNavCaption, paradisHubNavItem } from '../../paradisHub/electron-browser/paradisHubNav.js';

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
	/** 取れなかった。`cachedFetchedAt` は前回の取得分を出しているときのその時刻。 */
	| { readonly kind: 'error'; readonly cachedFetchedAt?: number };

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

export class ParadisChangelogView extends Disposable {

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	private readonly statusChip: HTMLElement;
	private readonly navElement: HTMLElement;
	private readonly bannerElement: HTMLElement;
	private readonly bannerTextElement: HTMLElement;
	private readonly contentElement: HTMLElement;

	/** 再描画のたびに作り直すナビ項目のリスナー登録先。 */
	private readonly navListeners = this._register(new DisposableStore());
	/** renderNav() が作った項目。querySelectorAll に頼らず直接辿るため保持する。 */
	private readonly navItems = new Map<number, { readonly item: IParadisHubNavItem; readonly dot?: HTMLElement }>();

	private data: IParadisChangelogViewData;
	private selectedVersion: number | undefined;
	private lastReadVersion: number;
	private closed = false;

	/** dispose 済みか。取得完了後のコールバックからの二重操作防止に使う。 */
	get isDisposed(): boolean {
		return this.closed;
	}

	constructor(
		containers: IParadisHubAreaContainers,
		data: IParadisChangelogViewData,
		private readonly delegate: IParadisChangelogModalDelegate,
	) {
		super();

		this.data = data;
		this.lastReadVersion = delegate.initialLastReadVersion;

		// 見出しの行: サーバーへの問い合わせの状態（キットの札。paradis-19-10 案 B）
		this.statusChip = createParadisChip(containers.header, '');
		this.statusChip.classList.add('para-cl-status');
		this.statusChip.style.display = 'none';
		this.statusChip.setAttribute('aria-live', 'polite');

		// 左のナビ: バージョンの一覧（利用可能な更新 / インストール済み）
		this.navElement = containers.nav;
		this.navElement.setAttribute('aria-label', localize('paradis.changelog.versions', "バージョン一覧"));

		containers.content.classList.add('paradis-changelog-area');
		const main = dom.append(containers.content, $('.para-cl-main'));

		// 未インストール版向けバナー
		this.bannerElement = dom.append(main, $('.para-cl-banner'));
		this.bannerElement.style.display = 'none';
		this.bannerElement.append($(ThemeIcon.asClassName(Codicon.info)));
		this.bannerTextElement = dom.append(this.bannerElement, $('span.para-cl-banner-text'));
		const checkUpdateButton = this._register(new ParadisButton(this.bannerElement, { kind: 'secondary', label: localize('paradis.changelog.checkUpdate', "更新を確認…") }));
		this._register(checkUpdateButton.onDidClick(() => this.delegate.onCheckForUpdate()));

		this.contentElement = dom.append(main, $('.para-cl-content'));

		const footnote = dom.append(main, $('.para-cl-footnote'));
		footnote.append($(ThemeIcon.asClassName(Codicon.info)));
		footnote.appendChild(document.createTextNode(
			localize('paradis.changelog.fallbackNote', "取得できないときは、このアプリに同梱された履歴のみを表示します")
		));

		this.renderAll();
	}

	override dispose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this._onDidDispose.fire();
		super.dispose();
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
		this.statusChip.style.display = '';
		dom.clearNode(this.statusChip);
		let icon: ThemeIcon;
		let label: string;
		if (state.kind === 'fetching') {
			icon = Codicon.sync;
			label = localize('paradis.changelog.fetching', "サーバーを確認中…");
		} else if (state.kind === 'ok') {
			icon = Codicon.cloudDownload;
			label = localize('paradis.changelog.fetchedAt', "サーバーから取得済み · {0}", formatFetchedTime(state.fetchedAt));
		} else {
			// 取れなかったことを札に残す。前回の取得分を出しているときはその時刻も添える（paradis-19-13 案 A）
			icon = Codicon.debugDisconnect;
			label = state.cachedFetchedAt !== undefined
				? localize('paradis.changelog.fetchFailedCached', "サーバーに接続できませんでした · 前回 {0} の取得分を表示中", formatFetchedTime(state.cachedFetchedAt))
				: localize('paradis.changelog.fetchFailed', "サーバーに接続できませんでした");
		}
		this.statusChip.append($(ThemeIcon.asClassName(icon)));
		dom.append(this.statusChip, $('span.paradis-chip-label')).textContent = label;
	}

	/** 選んでいるバージョン（`reveal` に渡せる形）と本文のスクロール位置。統合のモーダルを開き直したときに戻すため。 */
	get viewState(): { readonly version: string | undefined; readonly scrollTop: number } {
		return { version: this.selectedVersion !== undefined ? String(this.selectedVersion) : undefined, scrollTop: this.contentElement.scrollTop };
	}

	/** 本文のスクロール位置を戻す。 */
	set scrollTop(scrollTop: number) {
		this.contentElement.scrollTop = scrollTop;
	}

	/** バージョン（`paracode-N` の N。文字列でも数でもよい）を選ぶ。無ければ何もしない。 */
	reveal(version: string | undefined): void {
		const target = version !== undefined ? Number(String(version).replace(/^paracode-/, '')) : NaN;
		if (this.navItems.has(target)) {
			this.selectVersion(target);
		}
	}

	private selectVersion(version: number): void {
		this.selectedVersion = version;
		for (const [itemVersion, entry] of this.navItems) {
			entry.item.setActive(itemVersion === version);
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
			if (!(version > this.lastReadVersion) && entry.dot) {
				entry.dot.remove();
				entry.item.element.removeAttribute('aria-label');
			}
		}
	}

	private renderAll(): void {
		this.renderNav();
		this.selectedVersion ??= this.data.releases[0]?.version;
		for (const [version, entry] of this.navItems) {
			entry.item.setActive(version === this.selectedVersion);
		}
		this.renderContent();
	}

	private renderNav(): void {
		this.navListeners.clear();
		this.navItems.clear();
		dom.clearNode(this.navElement);
		let caption: 'available' | 'installed' | undefined;
		for (const release of this.data.releases) {
			const group = release.installed ? 'installed' : 'available';
			if (group !== caption) {
				caption = group;
				paradisHubNavCaption(this.navElement, group === 'available'
					? localize('paradis.changelog.availableCaption', "利用可能な更新")
					: localize('paradis.changelog.installedCaption', "インストール済み"));
			}
			const item = paradisHubNavItem(this.navElement, release.label, release.installed ? {} : { icon: Codicon.arrowDown });
			if (release.date) {
				// 一覧では年を省いて月と日だけを出す（本文の見出しには年まで出す）
				item.chip.textContent = release.date.replace(/^\d{4}-/, '');
			}
			let dot: HTMLElement | undefined;
			if (release.version > this.lastReadVersion && !release.installed) {
				dot = $('span.para-cl-dot');
				dot.setAttribute('aria-hidden', 'true');
				item.element.insertBefore(dot, item.chip);
				// 点は空なので名前に入らない。未読であることを読み上げの名前に入れる（paradis-19-12）
				item.element.setAttribute('aria-label', release.date
					? localize('paradis.changelog.unreadItemWithDate', "{0}、未読、{1}", release.label, release.date)
					: localize('paradis.changelog.unreadItem', "{0}、未読", release.label));
			}
			this.navItems.set(release.version, { item, dot });

			this.navListeners.add(dom.addDisposableListener(item.element, dom.EventType.CLICK, () => {
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
		if (release.version === this.data.installedVersion) {
			dom.append(head, $('span.para-cl-tag.para-cl-tag-current')).textContent = localize('paradis.changelog.currentTag', "現在使用中");
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
}

/** 取得した時刻（時と分）。 */
function formatFetchedTime(time: number): string {
	return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function toViewReleases(releases: readonly IParadisChangelogRelease[], installedVersion: number): IParadisChangelogViewRelease[] {
	return releases.map(release => ({
		...release,
		installed: release.version <= installedVersion,
	}));
}
