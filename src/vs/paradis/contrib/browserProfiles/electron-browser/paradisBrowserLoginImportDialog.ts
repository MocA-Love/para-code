/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「他のブラウザから取り込む…」ダイアログ（q.html Q66 の案A）。プロファイルのドロップダウン
// 下部から開く。取り込み元ブラウザ・プロファイル、取り込むサイト（ドメイン単位・既定すべてオフ・
// 検索可）、取り込み先の名前付きプロファイルを選ぶ。
//
// このダイアログはユーザーの操作からしか開かない。列挙は復号も鍵読みも伴わないが、[取り込む] を
// 押した時だけ main が鍵を読む（macOS はキーチェーンの確認ダイアログ）ので、その旨を先に案内する。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import {
	IParadisBrowserLoginImportMainService,
	IParadisImportBrowser,
	IParadisImportDomainListing,
	PARADIS_BROWSER_LOGIN_IMPORT_CHANNEL,
} from '../common/paradisBrowserLoginImport.js';
import { ParadisProfileModal } from './paradisBrowserProfileDialogs.js';
import { IParadisBrowserProfilesService } from './paradisBrowserProfilesService.js';

const $ = dom.$;

class ParadisLoginImportDialog extends ParadisProfileModal {

	private readonly _mainService: IParadisBrowserLoginImportMainService;
	private readonly _renderStore = this._register(new DisposableStore());

	private _browsers: readonly IParadisImportBrowser[] = [];
	private _selectedBrowserId: string | undefined;
	private _selectedSourceDir: string | undefined;
	private _domainListing: IParadisImportDomainListing | undefined;
	private readonly _selectedDomains = new Set<string>();
	private _search = '';
	private _destinationProfileId: string | undefined;
	private _importing = false;

	// 本文の各領域（作り直しやすいよう保持する）。
	private _sourceRow!: HTMLElement;
	private _domainSection!: HTMLElement;
	private _destinationRow!: HTMLElement;
	private _importButton: HTMLButtonElement | undefined;
	private _summary: HTMLElement | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IParadisBrowserProfilesService private readonly profilesService: IParadisBrowserProfilesService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super(localize('paradis.loginImport.title', "他のブラウザから取り込む"), Codicon.signIn, layoutService);
		this._mainService = ProxyChannel.toService<IParadisBrowserLoginImportMainService>(
			mainProcessService.getChannel(PARADIS_BROWSER_LOGIN_IMPORT_CHANNEL),
		);

		this._buildSkeleton();
		this.appendButton(localize('paradis.loginImport.cancel', "キャンセル"), 'secondary', () => this.close());
		this._importButton = this.appendButton(localize('paradis.loginImport.submit', "取り込む"), 'primary', () => void this._runImport());

		void this._loadSources();
	}

	private _buildSkeleton(): void {
		this._sourceRow = dom.append(this.body, $('.pbpm-import-source'));
		this._domainSection = dom.append(this.body, $('.pbpm-import-domains'));
		this._destinationRow = dom.append(this.body, $('.pbpm-import-destination'));

		// 2つの注意書き（案Aの仕様どおり、常時表示）。
		const notes = dom.append(this.body, $('.pbpm-import-notes'));
		dom.append(notes, $('p')).textContent = localize(
			'paradis.loginImport.noteGoogle',
			"Google のログインは取り込めません。内蔵ブラウザで直接サインインしてください。",
		);
		dom.append(notes, $('p')).textContent = localize(
			'paradis.loginImport.noteAgent',
			"取り込んだログインは、このプロファイルを使うエージェントの操作にも使われます。",
		);
	}

	private async _loadSources(): Promise<void> {
		let listing;
		try {
			listing = await this._mainService.listSources();
		} catch {
			listing = { browsers: [] };
		}
		if (this._store.isDisposed) {
			return;
		}
		this._browsers = listing.browsers;
		this._selectedBrowserId = this._browsers[0]?.id;
		this._selectedSourceDir = this._browsers[0]?.profiles[0]?.directory;
		this._renderSource();
		this._renderDestination();
		void this._loadDomains();
	}

	private _renderSource(): void {
		dom.clearNode(this._sourceRow);
		if (this._browsers.length === 0) {
			dom.append(this._sourceRow, $('.pbpm-hint')).textContent = localize(
				'paradis.loginImport.noBrowsers',
				"取り込めるブラウザが見つかりませんでした。macOS の Chrome / Edge / Brave / Arc などが対象です。",
			);
			return;
		}

		dom.append(this._sourceRow, $('label.pbpm-label')).textContent = localize('paradis.loginImport.source', "取り込み元");
		const browserSelect = dom.append(this._sourceRow, $('select.pbpm-select')) as HTMLSelectElement;
		browserSelect.setAttribute('aria-label', localize('paradis.loginImport.sourceBrowser', "取り込み元のブラウザ"));
		for (const browser of this._browsers) {
			const option = dom.append(browserSelect, $('option')) as HTMLOptionElement;
			option.value = browser.id;
			option.textContent = browser.label;
			option.selected = browser.id === this._selectedBrowserId;
		}
		this.contentFocusables.push(browserSelect);
		this._register(dom.addDisposableListener(browserSelect, dom.EventType.CHANGE, () => {
			this._selectedBrowserId = browserSelect.value;
			this._selectedSourceDir = this._currentBrowser()?.profiles[0]?.directory;
			this._selectedDomains.clear();
			this._renderSource();
			void this._loadDomains();
		}));

		const profiles = this._currentBrowser()?.profiles ?? [];
		if (profiles.length > 0) {
			const profileSelect = dom.append(this._sourceRow, $('select.pbpm-select')) as HTMLSelectElement;
			profileSelect.setAttribute('aria-label', localize('paradis.loginImport.sourceProfile', "取り込み元のプロファイル"));
			for (const profile of profiles) {
				const option = dom.append(profileSelect, $('option')) as HTMLOptionElement;
				option.value = profile.directory;
				option.textContent = profile.label;
				option.selected = profile.directory === this._selectedSourceDir;
			}
			this.contentFocusables.push(profileSelect);
			this._register(dom.addDisposableListener(profileSelect, dom.EventType.CHANGE, () => {
				this._selectedSourceDir = profileSelect.value;
				this._selectedDomains.clear();
				void this._loadDomains();
			}));
		}
	}

	private async _loadDomains(): Promise<void> {
		const browserId = this._selectedBrowserId;
		const sourceDir = this._selectedSourceDir;
		if (!browserId || !sourceDir) {
			this._domainListing = undefined;
			this._renderDomains();
			return;
		}
		dom.clearNode(this._domainSection);
		dom.append(this._domainSection, $('.pbpm-hint')).textContent = localize('paradis.loginImport.loading', "読み込み中…");
		let listing: IParadisImportDomainListing;
		try {
			listing = await this._mainService.listDomains(browserId as IParadisImportBrowser['id'], sourceDir);
		} catch {
			listing = { domains: [], needsKeychainConsent: false, unsupportedReason: localize('paradis.loginImport.readFailed', "Cookie を読み取れませんでした。") };
		}
		// 途中で元を切り替えていたら破棄する。
		if (this._store.isDisposed || browserId !== this._selectedBrowserId || sourceDir !== this._selectedSourceDir) {
			return;
		}
		this._domainListing = listing;
		this._renderDomains();
		this._updateImportButton();
	}

	private _renderDomains(): void {
		this._renderStore.clear();
		dom.clearNode(this._domainSection);

		const browser = this._currentBrowser();
		const unsupported = browser?.unsupportedReason ?? this._domainListing?.unsupportedReason;
		if (unsupported) {
			dom.append(this._domainSection, $('.pbpm-import-unsupported')).textContent = unsupported;
			return;
		}
		const listing = this._domainListing;
		if (!listing) {
			return;
		}

		dom.append(this._domainSection, $('label.pbpm-label')).textContent = localize('paradis.loginImport.sites', "取り込むサイト");

		if (listing.needsKeychainConsent) {
			dom.append(this._domainSection, $('.pbpm-import-keychain')).textContent = localize(
				'paradis.loginImport.keychainGuidance',
				"[取り込む] を押すと、Chrome などの鍵を読むためにキーチェーンの確認が出ます。「許可」を押してください（「常に許可」は不要です）。",
			);
		}

		const searchInput = dom.append(this._domainSection, $('input.pbpm-input.pbpm-import-search')) as HTMLInputElement;
		searchInput.type = 'search';
		searchInput.placeholder = localize('paradis.loginImport.searchPlaceholder', "ドメインを検索");
		searchInput.value = this._search;
		searchInput.setAttribute('aria-label', localize('paradis.loginImport.searchPlaceholder', "ドメインを検索"));
		this.contentFocusables.push(searchInput);
		this._renderStore.add(dom.addDisposableListener(searchInput, dom.EventType.INPUT, () => {
			this._search = searchInput.value;
			this._renderDomainRows(listElement);
		}));

		const listElement = dom.append(this._domainSection, $('.pbpm-import-list'));
		listElement.setAttribute('role', 'group');
		this._renderDomainRows(listElement);

		this._summary = dom.append(this._domainSection, $('.pbpm-import-summary'));
		this._updateSummary();
	}

	private _renderDomainRows(listElement: HTMLElement): void {
		dom.clearNode(listElement);
		const query = this._search.trim().toLowerCase();
		const domains = (this._domainListing?.domains ?? []).filter(group => query.length === 0 || group.domain.includes(query));
		if (domains.length === 0) {
			dom.append(listElement, $('.pbpm-hint')).textContent = query.length > 0
				? localize('paradis.loginImport.noMatch', "一致するドメインがありません。")
				: localize('paradis.loginImport.noDomains', "取り込めるドメインがありません。");
			return;
		}
		for (const group of domains) {
			const row = dom.append(listElement, $('label.pbpm-import-row')) as HTMLLabelElement;
			row.classList.toggle('is-disabled', !group.importable);
			const checkbox = dom.append(row, $('input.pbpm-import-check')) as HTMLInputElement;
			checkbox.type = 'checkbox';
			checkbox.checked = this._selectedDomains.has(group.domain);
			checkbox.disabled = !group.importable;
			checkbox.setAttribute('aria-label', group.domain);
			this._renderStore.add(dom.addDisposableListener(checkbox, dom.EventType.CHANGE, () => {
				if (checkbox.checked) {
					this._selectedDomains.add(group.domain);
				} else {
					this._selectedDomains.delete(group.domain);
				}
				this._updateSummary();
				this._updateImportButton();
			}));
			dom.append(row, $('.pbpm-import-domain')).textContent = group.domain;
			const meta = dom.append(row, $('.pbpm-import-meta'));
			meta.textContent = group.importable
				? localize('paradis.loginImport.cookieCount', "Cookie {0}件", group.cookieCount)
				: (group.reason ?? localize('paradis.loginImport.cannotImport', "取り込めません"));
		}
	}

	private _updateSummary(): void {
		if (!this._summary) {
			return;
		}
		const total = (this._domainListing?.domains ?? []).filter(group => group.importable).length;
		this._summary.textContent = localize(
			'paradis.loginImport.summary',
			"{0} サイト中 {1} サイトを選択（既定はすべてオフ）",
			total, this._selectedDomains.size,
		);
	}

	private _renderDestination(): void {
		dom.clearNode(this._destinationRow);
		// 取り込み先は「利用者の名前付きプロファイル」だけ。エージェントが作ったものは既定で除外する。
		const profiles = this.profilesService.list().filter(profile => !profile.createdByAgent);
		dom.append(this._destinationRow, $('label.pbpm-label')).textContent = localize('paradis.loginImport.destination', "取り込み先のプロファイル");
		if (profiles.length === 0) {
			dom.append(this._destinationRow, $('.pbpm-hint')).textContent = localize(
				'paradis.loginImport.noDestination',
				"取り込み先の名前付きプロファイルがありません。先にプロファイルを作成してください。",
			);
			this._destinationProfileId = undefined;
			return;
		}
		if (this._destinationProfileId === undefined || !profiles.some(profile => profile.id === this._destinationProfileId)) {
			this._destinationProfileId = profiles[0].id;
		}
		const select = dom.append(this._destinationRow, $('select.pbpm-select')) as HTMLSelectElement;
		select.setAttribute('aria-label', localize('paradis.loginImport.destination', "取り込み先のプロファイル"));
		for (const profile of profiles) {
			const option = dom.append(select, $('option')) as HTMLOptionElement;
			option.value = profile.id;
			option.textContent = profile.name;
			option.selected = profile.id === this._destinationProfileId;
		}
		this.contentFocusables.push(select);
		this._register(dom.addDisposableListener(select, dom.EventType.CHANGE, () => {
			this._destinationProfileId = select.value;
			this._updateImportButton();
		}));
	}

	private _updateImportButton(): void {
		if (!this._importButton) {
			return;
		}
		const ready = !this._importing
			&& this._selectedDomains.size > 0
			&& this._destinationProfileId !== undefined
			&& !(this._currentBrowser()?.unsupportedReason);
		this._importButton.disabled = !ready;
		this._importButton.textContent = this._selectedDomains.size > 0
			? localize('paradis.loginImport.submitCount', "取り込む（{0} サイト）", this._selectedDomains.size)
			: localize('paradis.loginImport.submit', "取り込む");
	}

	private async _runImport(): Promise<void> {
		if (this._importing || this._selectedDomains.size === 0 || !this._selectedBrowserId || !this._selectedSourceDir || !this._destinationProfileId) {
			return;
		}
		this._importing = true;
		this._updateImportButton();
		const result = await this._mainService.importCookies({
			browserId: this._selectedBrowserId as IParadisImportBrowser['id'],
			sourceDirectory: this._selectedSourceDir,
			destinationProfileId: this._destinationProfileId,
			domains: [...this._selectedDomains],
		}).catch(() => undefined);
		this._importing = false;
		if (this._store.isDisposed) {
			return;
		}
		if (!result || result.error) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: result?.error ?? localize('paradis.loginImport.failed', "ログインの取り込みに失敗しました。"),
			});
			this._updateImportButton();
			return;
		}
		this.notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'paradis.loginImport.done',
				"{0} サイト・{1} 件のログインを取り込みました。",
				result.importedDomains, result.importedCookies,
			),
		});
		this.close();
	}

	private _currentBrowser(): IParadisImportBrowser | undefined {
		return this._browsers.find(browser => browser.id === this._selectedBrowserId);
	}
}

/** 「他のブラウザから取り込む…」ダイアログを開く。 */
export function paradisShowLoginImportDialog(instantiationService: IInstantiationService): void {
	instantiationService.createInstance(ParadisLoginImportDialog);
}
