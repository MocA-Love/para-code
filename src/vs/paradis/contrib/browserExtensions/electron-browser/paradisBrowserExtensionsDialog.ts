/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）の管理モーダル。一覧・プロファイルごとの有効/無効・フォルダから
// 読み込み直す・削除・フォルダから足す。モーダルの殻はブラウザプロファイルの管理と同じもの
// （backdrop が overlayManager に登録済みで、表示中はページの WebContentsView が止まる）を使う。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ParadisProfileModal } from '../../browserProfiles/electron-browser/paradisBrowserProfileDialogs.js';
import { IParadisAgentBrowserBindingModel } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisBrowserProfilesService } from '../../browserProfiles/electron-browser/paradisBrowserProfilesService.js';
import {
	IParadisAddExtensionResult,
	IParadisBrowserExtensionsMainService,
	IParadisBrowserExtensionsState,
	IParadisBrowserExtensionView,
	PARADIS_BROWSER_EXTENSIONS_CHANNEL,
	PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING,
	PARADIS_DEFAULT_EXTENSION_PROFILE,
	PARADIS_MAX_EXTENSION_BYTES,
	PARADIS_MAX_EXTENSION_FILES,
	paradisNamedExtensionProfile,
} from '../common/paradisBrowserExtensions.js';
import { paradisEnabledWhileSharedWarning, paradisSharedPageTitlesInPlace } from './paradisBrowserExtensionsService.js';

const $ = dom.$;

/** フォルダから足せなかった理由を、利用者に見せる文にする。 */
export function paradisDescribeAddExtensionFailure(result: Extract<IParadisAddExtensionResult, { ok: false }>): string {
	switch (result.reason) {
		case 'inactive':
			return localize('paradis.browserExtensions.error.inactive', "試験的な設定がオフのため、拡張機能を足せません。設定をオンにして再起動してください。");
		case 'notFolder':
			return localize('paradis.browserExtensions.error.notFolder', "フォルダが見つかりません。展開済みの拡張機能のフォルダを選んでください。");
		case 'noManifest':
			return localize('paradis.browserExtensions.error.noManifest', "選んだフォルダに manifest.json がありません。拡張機能のフォルダ（manifest.json がある階層）を選んでください。");
		case 'invalidManifest':
			return result.detail === 'id changed'
				? localize('paradis.browserExtensions.error.idChanged', "manifest.json の key が変わったため、別の拡張機能になりました。いったん削除してから足し直してください。")
				: localize('paradis.browserExtensions.error.invalidManifest', "manifest.json を拡張機能として読めません（{0}）。", result.detail ?? '');
		case 'linkOutside':
			return localize('paradis.browserExtensions.error.linkOutside', "フォルダの中の「{0}」は、フォルダの外を指すリンクです。外のファイルを読めないようにするため、このフォルダは読み込めません。リンクを実際のファイルに置き換えてください。", result.detail ?? '');
		case 'tooLarge':
			return result.detail === 'files'
				? localize('paradis.browserExtensions.error.tooManyFiles', "フォルダの中のファイルが多すぎます（上限 {0} 個）。ビルドした拡張機能のフォルダ（manifest.json がある階層）を選んでください。", PARADIS_MAX_EXTENSION_FILES)
				: localize('paradis.browserExtensions.error.tooLarge', "フォルダが大きすぎます（上限 {0} MB）。ビルドした拡張機能のフォルダ（manifest.json がある階層）を選んでください。", PARADIS_MAX_EXTENSION_BYTES / (1024 * 1024));
		case 'restartNeeded':
			return localize('paradis.browserExtensions.error.restartNeeded', "この拡張機能は削除したばかりです。前に保存したデータを消しきるため、再起動の後に入れ直してください。");
		case 'hardLink':
			return localize('paradis.browserExtensions.error.hardLink', "フォルダの中の「{0}」は、ほかの場所と中身を共有するファイル（ハードリンク）です。外のファイルを読めないようにするため、このフォルダは読み込めません。ふつうのファイルとして写してから選んでください。", result.detail ?? '');
		case 'nameClash':
			return localize('paradis.browserExtensions.error.nameClash', "フォルダの中に、大文字と小文字などだけが違う同じ名前（「{0}」）があります。写すと上書きされるため、読み込めません。", result.detail ?? '');
		case 'reservedName':
			return localize('paradis.browserExtensions.error.reservedName', "フォルダの中の「{0}」は、Para Code が拡張機能の写しに書くファイルと同じ名前です。名前を変えてから読み込んでください。", result.detail ?? '');
		case 'changed':
			return localize('paradis.browserExtensions.error.changed', "写している間にフォルダの中身（「{0}」）が変わりました。もう一度読み込んでください。", result.detail ?? '');
		case 'tooMany':
			return localize('paradis.browserExtensions.error.tooMany', "これ以上の拡張機能は足せません。使っていないものを削除してください。");
		case 'invalidInput':
			return localize('paradis.browserExtensions.error.invalidInput', "Chrome ウェブストアの拡張機能のページのリンクか、32 文字の拡張機能の ID を貼ってください。");
		case 'cancelled':
			return localize('paradis.browserExtensions.error.cancelled', "追加を取り消しました。");
		case 'busy':
			return localize('paradis.browserExtensions.error.busy', "この拡張機能は今入れている途中です。");
		case 'alreadyAdded':
			return localize('paradis.browserExtensions.error.alreadyAdded', "「{0}」はこの場所に入っています。", result.detail ?? '');
		case 'sameIdUnpacked':
			return localize('paradis.browserExtensions.error.sameIdUnpacked', "同じ ID の拡張機能（「{0}」）をフォルダから読み込んであります。ストアから入れるには、先にそれを削除してください。", result.detail ?? '');
		case 'sameIdWebStore':
			return localize('paradis.browserExtensions.error.sameIdWebStore', "同じ ID の拡張機能を Chrome ウェブストアから入れてあります。フォルダから読み込むには、先にそれを削除してください。");
		case 'webStoreFailed':
			return localize('paradis.browserExtensions.error.webStoreFailed', "Chrome ウェブストアから入れられませんでした（{0}）。", result.detail ?? '');
		case 'noPrompt':
			return localize('paradis.browserExtensions.error.noPrompt', "確認の画面を出せないため、ストアから入れられません。Para Code のウィンドウを前に出してからもう一度試してください。");
		default:
			return localize('paradis.browserExtensions.error.failed', "拡張機能を足せませんでした（{0}）。", result.detail ?? '');
	}
}

class ParadisBrowserExtensionsDialog extends ParadisProfileModal {

	private readonly _mainService: IParadisBrowserExtensionsMainService;
	private readonly _noticeElement: HTMLElement;
	private readonly _profileSelect: HTMLSelectElement;
	private readonly _listElement: HTMLElement;
	private readonly _messageElement: HTMLElement;
	private readonly _addButton: HTMLButtonElement;
	private readonly _storeInput: HTMLInputElement;
	private readonly _storeButton: HTMLButtonElement;
	/** 一覧の作り直しごとに捨てるリスナー置き場。 */
	private readonly _renderStore = this._register(new DisposableStore());
	private readonly _noticeStore = this._register(new DisposableStore());
	private _noticeButton: HTMLButtonElement | undefined;
	private _state: IParadisBrowserExtensionsState | undefined;
	private _profile = PARADIS_DEFAULT_EXTENSION_PROFILE;
	private _busy = false;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IParadisBrowserProfilesService private readonly profilesService: IParadisBrowserProfilesService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILayoutService layoutService: ILayoutService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
	) {
		super(localize('paradis.browserExtensions.title', "ブラウザの拡張機能（試験的）"), Codicon.extensions, layoutService);
		this._mainService = ProxyChannel.toService<IParadisBrowserExtensionsMainService>(mainProcessService.getChannel(PARADIS_BROWSER_EXTENSIONS_CHANNEL));

		dom.append(this.body, $('p.pbpm-description')).textContent = localize(
			'paradis.browserExtensions.description',
			"拡張機能は、入れたタブで開いたページの中身を読み書きできます。信頼できるものだけ入れてください。エージェントのタブ・使い捨てのタブ・SSH 先のページには入りません。",
		);
		this._noticeElement = dom.append(this.body, $('.pbe-notice'));

		const profileRow = dom.append(this.body, $('label.pbe-profile'));
		dom.append(profileRow, $('span')).textContent = localize('paradis.browserExtensions.profile', "有効にする場所");
		this._profileSelect = dom.append(profileRow, $<HTMLSelectElement>('select.pbe-select'));
		this.contentFocusables.push(this._profileSelect);
		this._register(dom.addDisposableListener(this._profileSelect, 'change', () => {
			this._profile = this._profileSelect.value;
			this._renderList();
		}));

		// Chrome ウェブストアのリンクか ID を貼って入れる（外と話すのは「追加」を押したときだけ）
		const storeRow = dom.append(this.body, $('.pbe-store'));
		this._storeInput = dom.append(storeRow, $<HTMLInputElement>('input.pbpm-input.pbe-store-input'));
		this._storeInput.type = 'text';
		this._storeInput.placeholder = localize('paradis.browserExtensions.store.placeholder', "Chrome ウェブストアのリンクか拡張機能の ID");
		this._storeInput.setAttribute('aria-label', localize('paradis.browserExtensions.store.label', "Chrome ウェブストアから追加する拡張機能のリンクか ID"));
		this._storeButton = dom.append(storeRow, $<HTMLButtonElement>('button.pbpm-btn.secondary'));
		this._storeButton.type = 'button';
		this._storeButton.textContent = localize('paradis.browserExtensions.store.add', "ストアから追加");
		this._register(dom.addDisposableListener(this._storeButton, dom.EventType.CLICK, () => void this._addFromWebStore()));
		this._register(dom.addDisposableListener(this._storeInput, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this._addFromWebStore();
			}
		}));

		this._listElement = dom.append(this.body, $('.pbpm-list.pbe-list'));
		this._messageElement = dom.append(this.body, $('.pbe-message'));
		this._messageElement.setAttribute('role', 'status');

		this._addButton = this.appendButton(localize('paradis.browserExtensions.add', "フォルダから読み込む…"), 'secondary', () => void this._addFromFolder());
		this.appendButton(localize('paradis.browserExtensions.done', "閉じる"), 'primary', () => this.close());

		this._register(this.profilesService.onDidChangeProfiles(() => this._renderProfiles()));
		this._renderProfiles();
		void this._refresh();
	}

	private async _refresh(): Promise<void> {
		try {
			this._state = await this._mainService.getState();
		} catch (error) {
			this._showMessage(localize('paradis.browserExtensions.error.state', "拡張機能の一覧を読めませんでした（{0}）。", error instanceof Error ? error.message : String(error)), true);
			return;
		}
		if (this._store.isDisposed) {
			return;
		}
		this._renderNotice();
		this._renderList();
	}

	private _showMessage(text: string, isError: boolean): void {
		this._messageElement.textContent = text;
		this._messageElement.classList.toggle('is-error', isError);
	}

	private _renderProfiles(): void {
		dom.clearNode(this._profileSelect);
		const options: Array<[string, string]> = [
			[PARADIS_DEFAULT_EXTENSION_PROFILE, localize('paradis.browserExtensions.profile.default', "既定（通常のタブ・ワークスペースのタブ）")],
			...this.profilesService.list().map((profile): [string, string] => [paradisNamedExtensionProfile(profile.id), localize('paradis.browserExtensions.profile.named', "プロファイル「{0}」", profile.name)]),
		];
		if (!options.some(([key]) => key === this._profile)) {
			this._profile = PARADIS_DEFAULT_EXTENSION_PROFILE;
		}
		for (const [key, label] of options) {
			const option = dom.append(this._profileSelect, $<HTMLOptionElement>('option'));
			option.value = key;
			option.textContent = label;
		}
		this._profileSelect.value = this._profile;
		this._renderList();
	}

	/** 試験的な設定の状態（オフ・再起動待ち）を出す。 */
	private _renderNotice(): void {
		this._noticeStore.clear();
		this._noticeButton = undefined;
		dom.clearNode(this._noticeElement);
		const state = this._state;
		if (!state || (state.active && state.setting)) {
			this._noticeElement.style.display = 'none';
			return;
		}
		this._noticeElement.style.display = '';
		const text = dom.append(this._noticeElement, $('span'));
		const button = dom.append(this._noticeElement, $<HTMLButtonElement>('button.pbpm-btn.primary'));
		button.type = 'button';
		this._noticeButton = button;
		if (!state.active && !state.setting) {
			text.textContent = localize('paradis.browserExtensions.notice.off', "試験的な機能です。今はオフになっています。オンにすると、再起動の後に使えます。");
			button.textContent = localize('paradis.browserExtensions.notice.turnOn', "オンにする");
			this._noticeStore.add(dom.addDisposableListener(button, 'click', async () => {
				await this.configurationService.updateValue(PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING, true, ConfigurationTarget.USER);
				await this._refresh();
			}));
		} else {
			text.textContent = state.setting
				? localize('paradis.browserExtensions.notice.restartOn', "設定をオンにしました。再起動すると拡張機能が使えます。")
				: localize('paradis.browserExtensions.notice.restartOff', "設定をオフにしました。再起動すると拡張機能は読み込まれなくなります（入れたものは残ります）。");
			button.textContent = localize('paradis.browserExtensions.notice.restart', "再起動");
			this._noticeStore.add(dom.addDisposableListener(button, 'click', () => void this.nativeHostService.relaunch()));
		}
	}

	private _renderList(): void {
		this._renderStore.clear();
		this.contentFocusables.length = 0;
		this.contentFocusables.push(this._profileSelect, this._storeInput, this._storeButton);
		if (this._noticeButton) {
			this.contentFocusables.push(this._noticeButton);
		}
		dom.clearNode(this._listElement);
		const state = this._state;
		this._addButton.disabled = !state?.active || this._busy;
		this._storeInput.disabled = !state?.active || this._busy;
		this._storeButton.disabled = !state?.active || this._busy;
		if (!state) {
			this.focusModal();
			return;
		}
		if (state.extensions.length === 0) {
			dom.append(this._listElement, $('.pbpm-empty')).textContent = localize('paradis.browserExtensions.emptyWithStore', "まだ拡張機能がありません。Chrome ウェブストアの拡張機能のリンクを上に貼って「ストアから追加」を押すか、展開済みの拡張機能のフォルダを「フォルダから読み込む…」で選んでください。");
			this.focusModal();
			return;
		}
		for (const extension of state.extensions) {
			this._renderRow(extension, state.active);
		}
		this.focusModal();
	}

	private _renderRow(extension: IParadisBrowserExtensionView, active: boolean): void {
		const row = dom.append(this._listElement, $('.pbpm-row'));
		const toggle = dom.append(row, $<HTMLInputElement>('input.pbe-toggle'));
		toggle.type = 'checkbox';
		toggle.checked = extension.enabledIn.includes(this._profile);
		toggle.disabled = !active || this._busy;
		toggle.setAttribute('aria-label', localize('paradis.browserExtensions.toggle', "「{0}」をこの場所で有効にする", extension.name));
		this.contentFocusables.push(toggle);
		this._renderStore.add(dom.addDisposableListener(toggle, 'change', () => {
			const enabling = toggle.checked;
			const place = this._profile;
			void this._run(async () => {
				await this._mainService.setEnabled(extension.id, place, enabling);
				// 共有した後に有効にしたタブは共有の確認を通らないので、ここで知らせる（D4）
				if (enabling && extension.touchesPages) {
					const titles = paradisSharedPageTitlesInPlace(
						this.bindingModel.bindings.map(binding => ({ pageId: binding.pageId, title: binding.pageInfo.title || binding.pageInfo.url })),
						place,
						pageId => this.profilesService.getViewSession(pageId),
					);
					if (titles.length > 0) {
						this._showMessage(paradisEnabledWhileSharedWarning(extension.name, titles), true);
					}
				}
			});
		}));

		const info = dom.append(row, $('.pbpm-info'));
		dom.append(info, $('.pbpm-name')).textContent = extension.name;
		dom.append(info, $('.pbpm-meta')).textContent = extension.source === 'webstore'
			? localize('paradis.browserExtensions.metaWebStore', "バージョン {0} ・ Manifest V{1} ・ Chrome ウェブストア", extension.version, extension.manifestVersion)
			: localize('paradis.browserExtensions.metaUnpacked', "バージョン {0} ・ Manifest V{1} ・ 開発用（フォルダから読み込み）: {2}", extension.version, extension.manifestVersion, extension.sourcePath);
		if (extension.touchesPages) {
			// 共有の確認で知らせる対象（入力欄に値を入れられる・ページの中身を読める）
			dom.append(info, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.touchesPages', "ページの中身を読み書きできます。このタブを共有すると、拡張機能が入力した値はエージェントからも読めます");
		}
		if (extension.userScripts) {
			// Chrome の「ユーザースクリプトを許可」と同じ（拡張機能ごと・この場所で。既定はオフ）
			const option = dom.append(info, $<HTMLLabelElement>('label.pbe-row-option'));
			const allow = dom.append(option, $<HTMLInputElement>('input'));
			allow.type = 'checkbox';
			allow.checked = extension.userScripts.allowedIn.includes(this._profile);
			allow.disabled = !active || this._busy;
			dom.append(option, $('span')).textContent = localize('paradis.browserExtensions.allowUserScripts', "ユーザースクリプトを許可");
			this.contentFocusables.push(allow);
			this._renderStore.add(dom.addDisposableListener(allow, 'change', () => {
				const allowing = allow.checked;
				const place = this._profile;
				void this._run(() => this._mainService.setUserScriptsAllowed(extension.id, place, allowing));
			}));
			dom.append(info, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.userScriptsNote', "許可すると、この拡張機能が登録したスクリプト（ユーザースクリプト）が、この場所のタブのページで動きます。エージェントのタブと、エージェントと共有中のタブでは動きません。");
		}
		if (extension.pagesWithoutApis?.length) {
			dom.append(info, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.pagesWithoutApis', "次のページは UTF-8 でないか Para Code が書き換えられない形式のため、Para Code が足す機能（chrome.storage.sync など）が使えません: {0}", extension.pagesWithoutApis.join('、'));
		}
		if (extension.nextVersion) {
			dom.append(info, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.nextVersion', "版 {0} に更新しました。次に Para Code を起動したときから使います。", extension.nextVersion);
		}
		if (extension.pendingUpdate) {
			// 新しく権限を求める更新は自動では入れない（確かめてから入れる）
			const added = [...extension.pendingUpdate.permissions, ...extension.pendingUpdate.hostPermissions].join('、');
			dom.append(info, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.pendingUpdate', "版 {0} への更新が確認待ちです。新しく次を求めています: {1}", extension.pendingUpdate.version, added);
		}
		if (extension.loadError) {
			dom.append(info, $('.pbe-row-error')).textContent = localize('paradis.browserExtensions.loadError', "読み込めませんでした: {0}", extension.loadError);
		}

		const actions = dom.append(row, $('.pbpm-row-actions'));
		// ストアから入れたものは読み込み直すフォルダが無い（更新はストアから）
		if (extension.source === 'unpacked') {
			this._appendRowAction(actions, Codicon.refresh, localize('paradis.browserExtensions.reload', "フォルダから読み込み直す"), !active, () => void this._run(async () => {
				const result = await this._mainService.reloadUnpacked(extension.id);
				if (!result.ok) {
					this._showMessage(paradisDescribeAddExtensionFailure(result), true);
					return false;
				}
				this._showMessage(localize('paradis.browserExtensions.reloaded', "「{0}」を読み込み直しました。開いているページには、読み込み直すと効きます。", result.extension.name), false);
				return true;
			}));
		}
		if (extension.source === 'webstore' && extension.pendingUpdate) {
			this._appendRowAction(actions, Codicon.cloudDownload, localize('paradis.browserExtensions.approveUpdate', "確かめて更新"), !active, () => void this._run(async () => {
				const result = await this._mainService.approveWebStoreUpdate(extension.id);
				if (!result.ok) {
					this._showMessage(paradisDescribeAddExtensionFailure(result), result.reason !== 'cancelled');
					return;
				}
				this._showMessage(localize('paradis.browserExtensions.updated', "「{0}」を版 {1} に更新しました。開いているページには、読み込み直すと効きます。", result.extension.name, result.extension.version), false);
			}));
		}
		this._appendRowAction(actions, Codicon.trash, localize('paradis.browserExtensions.remove', "削除"), !active, () => this._confirmRemove(extension));
	}

	private _appendRowAction(parent: HTMLElement, icon: ThemeIcon, label: string, disabled: boolean, run: () => void): void {
		const button = dom.append(parent, $<HTMLButtonElement>('button.pbpm-row-action'));
		button.type = 'button';
		button.title = label;
		button.disabled = disabled || this._busy;
		button.setAttribute('aria-label', label);
		button.appendChild($(ThemeIcon.asCSSSelector(icon)));
		this.contentFocusables.push(button);
		this._renderStore.add(dom.addDisposableListener(button, 'click', () => run()));
	}

	private _confirmRemove(extension: IParadisBrowserExtensionView): void {
		const popover = dom.append(this._listElement, $('.pbpm-confirm'));
		const title = dom.append(popover, $('.pbpm-confirm-title'));
		dom.append(title, $(ThemeIcon.asCSSSelector(Codicon.warning)));
		dom.append(title, $('span')).textContent = localize('paradis.browserExtensions.confirmTitle', "「{0}」を削除しますか？", extension.name);
		dom.append(popover, $('p')).textContent = localize('paradis.browserExtensions.confirmBody', "すべての場所から外し、この拡張機能が保存したデータも消します（消しきるのは次の起動の後です。それまでは入れ直せません）。元のフォルダは消しません。");
		const buttons = dom.append(popover, $('.pbpm-confirm-actions'));
		const cancel = dom.append(buttons, $<HTMLButtonElement>('button.pbpm-btn.secondary'));
		cancel.type = 'button';
		cancel.textContent = localize('paradis.browserExtensions.confirmCancel', "キャンセル");
		const confirm = dom.append(buttons, $<HTMLButtonElement>('button.pbpm-btn.danger'));
		confirm.type = 'button';
		confirm.textContent = localize('paradis.browserExtensions.confirmRemove', "削除する");
		this.contentFocusables.push(cancel, confirm);
		this._renderStore.add(dom.addDisposableListener(cancel, 'click', () => this._renderList()));
		this._renderStore.add(dom.addDisposableListener(confirm, 'click', () => void this._run(() => this._mainService.remove(extension.id))));
		confirm.focus();
	}

	/** main への操作を 1 つずつ行い、終わったら一覧を読み直す。 */
	private async _run(operation: () => Promise<unknown>): Promise<void> {
		if (this._busy) {
			return;
		}
		this._busy = true;
		this._renderList();
		try {
			await operation();
		} catch (error) {
			this._showMessage(localize('paradis.browserExtensions.error.operation', "操作できませんでした（{0}）。", error instanceof Error ? error.message : String(error)), true);
		} finally {
			this._busy = false;
		}
		if (!this._store.isDisposed) {
			await this._refresh();
		}
	}

	private async _addFromWebStore(): Promise<void> {
		const input = this._storeInput.value.trim();
		if (!input || this._busy) {
			return;
		}
		const place = this._profile;
		const label = this._profileSelect.selectedOptions[0]?.textContent ?? place;
		this._showMessage(localize('paradis.browserExtensions.store.downloading', "Chrome ウェブストアから落として、署名を確かめています…"), false);
		await this._run(async () => {
			const result = await this._mainService.addFromWebStore(input, place, label);
			if (!result.ok) {
				this._showMessage(paradisDescribeAddExtensionFailure(result), result.reason !== 'cancelled');
				return;
			}
			this._storeInput.value = '';
			this._showMessage(localize('paradis.browserExtensions.store.added', "「{0}」を Chrome ウェブストアから追加しました。開いているページには、読み込み直すと効きます。", result.extension.name), false);
		});
	}

	private async _addFromFolder(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('paradis.browserExtensions.pickTitle', "拡張機能のフォルダを選ぶ"),
			openLabel: localize('paradis.browserExtensions.pickOpen', "読み込む"),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			// 拡張機能はこのパソコンのブラウザに入るので、SSH 先のフォルダは選ばせない
			availableFileSystems: [Schemas.file],
		});
		const folder = picked?.[0];
		if (!folder || this._store.isDisposed) {
			return;
		}
		await this._run(async () => {
			const result = await this._mainService.addUnpacked(folder.fsPath, this._profile);
			if (!result.ok) {
				this._showMessage(paradisDescribeAddExtensionFailure(result), true);
				return;
			}
			this._showMessage(localize('paradis.browserExtensions.added', "「{0}」を足しました。開いているページには、読み込み直すと効きます。", result.extension.name), false);
		});
	}
}

/** 管理モーダルを開く。 */
export function paradisShowBrowserExtensionsDialog(instantiationService: IInstantiationService): void {
	instantiationService.createInstance(ParadisBrowserExtensionsDialog);
}
