/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「設定 (Para Code)」の「内蔵ブラウザ・拡張機能」に足した行の中身（Orca のブラウザの設定に合わせたもの）。
//
//  - ホームページ: URL を決めずに人が開いた新しいタブで、設定のページを読み込む
//  - 「ほかのブラウザのログインを取り込む」: 今あるダイアログを開くコマンド（入口がプロファイルの一覧だけだったため）
//  - 「サイトの権限」: サイトごとに許可・ブロックした内容の一覧。本家は今のページの分しか出さないので、開いている
//    タブの保存先（プロファイル）に記録された分をまとめて出し、サイトごとに「毎回確認」へ戻せるようにする
//
// 本家のファイルは変えていない。

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputButton, IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { PERMISSION_CATEGORY_DESCRIPTORS, PermissionCategory, PermissionDecision } from '../../../../platform/browserView/common/browserPermissions.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { BrowserActionCategory, BrowserEditor, BrowserEditorContribution } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { paradisShowLoginImportDialog } from '../../browserProfiles/electron-browser/paradisBrowserLoginImportDialog.js';
import { PARADIS_BROWSER_HOME_PAGE_SETTING, PARADIS_BROWSER_IMPORT_LOGINS_COMMAND_ID, PARADIS_BROWSER_SITE_PERMISSIONS_COMMAND_ID, paradisNormalizeHomePage } from '../common/paradisBrowserSettings.js';
import { IParadisSitePermissionRow, paradisCollectSitePermissions } from '../common/paradisBrowserSitePermissions.js';

/** 人が URL を決めずに開いた新しいタブで、ホームページを読み込む。 */
class ParadisBrowserHomePageFeature extends BrowserEditorContribution {

	constructor(
		editor: BrowserEditor,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(editor);
	}

	protected override onModelAttached(model: IBrowserViewModel, _store: DisposableStore, isNew: boolean): void {
		// 新しく作ったタブだけ（復元したタブ・別のグループへ移したタブは URL を持つか、作り直しではない）
		if (!isNew || model.url) {
			return;
		}
		// エージェントが URL 無し（about:blank）で開くタブは、エージェント専用の保存先で URL が空のまま作られる
		if (model.storageScope === BrowserViewStorageScope.Agent) {
			return;
		}
		const homePage = paradisNormalizeHomePage(this._configurationService.getValue(PARADIS_BROWSER_HOME_PAGE_SETTING));
		if (homePage) {
			void model.loadURL(homePage);
		}
	}
}

BrowserEditor.registerContribution(ParadisBrowserHomePageFeature);

class ParadisImportBrowserLoginsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_BROWSER_IMPORT_LOGINS_COMMAND_ID,
			title: localize2('paradis.browserSettings.importLogins', "Import Logins from Another Browser..."),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		paradisShowLoginImportDialog(accessor.get(IInstantiationService));
	}
}

registerAction2(ParadisImportBrowserLoginsAction);

interface ISitePermissionPick extends IQuickPickItem {
	readonly row: IParadisSitePermissionRow;
}

class ParadisShowSitePermissionsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_BROWSER_SITE_PERMISSIONS_COMMAND_ID,
			title: localize2('paradis.browserSettings.sitePermissions', "Show Site Permissions"),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const browserViewService = accessor.get(IBrowserViewWorkbenchService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const models = [...browserViewService.getKnownBrowserViews().values()].map(input => input.model).filter((model): model is IBrowserViewModel => !!model);
		const rows = paradisCollectSitePermissions(models.map(model => ({ id: model.id, grants: model.permissions.list() })));
		if (rows.length === 0) {
			// allow-any-unicode-next-line
			notificationService.info(localize('paradis.browserSettings.sitePermissionsEmpty', "許可またはブロックしたサイトはありません（開いている内蔵ブラウザのタブの保存先の分）。"));
			return;
		}

		const byId = new Map(models.map(model => [model.id, model]));
		const reset: IQuickInputButton = {
			iconClass: ThemeIcon.asClassName(Codicon.discard),
			// allow-any-unicode-next-line
			tooltip: localize('paradis.browserSettings.sitePermissionsReset', "毎回確認に戻す"),
		};
		const store = new DisposableStore();
		const picker = store.add(quickInputService.createQuickPick<ISitePermissionPick>());
		// allow-any-unicode-next-line
		picker.title = localize('paradis.browserSettings.sitePermissionsTitle', "サイトの権限");
		// allow-any-unicode-next-line
		picker.placeholder = localize('paradis.browserSettings.sitePermissionsPlaceholder', "サイトごとに許可・ブロックした内容です。右のボタンで毎回確認に戻します");
		picker.matchOnDescription = true;
		const render = (list: readonly IParadisSitePermissionRow[]) => {
			picker.items = list.map(row => ({
				row,
				label: row.origin,
				description: row.decisions.map(({ category, state }) => formatDecision(category, state)).join(' · '),
				buttons: [reset],
			}));
		};
		let current = rows;
		render(current);
		store.add(picker.onDidTriggerItemButton(async ({ item }) => {
			const grants = item.row.decisions.map(({ category }) => ({ category, state: null }));
			await Promise.all(item.row.viewIds.map(id => byId.get(id)?.setPermissions(item.row.origin, grants)));
			current = current.filter(row => row !== item.row);
			if (current.length === 0) {
				picker.hide();
				return;
			}
			render(current);
		}));
		store.add(picker.onDidHide(() => store.dispose()));
		picker.show();
	}
}

function formatDecision(category: PermissionCategory, state: PermissionDecision): string {
	const label = PERMISSION_CATEGORY_DESCRIPTORS[category]?.label ?? category;
	return state === 'allow'
		// allow-any-unicode-next-line
		? localize('paradis.browserSettings.sitePermissionAllowed', "{0}: 許可", label)
		// allow-any-unicode-next-line
		: localize('paradis.browserSettings.sitePermissionBlocked', "{0}: ブロック", label);
}

registerAction2(ParadisShowSitePermissionsAction);
