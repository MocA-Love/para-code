/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 名前付きブラウザプロファイルの登録エントリ。
// paradis.electron-browser.contribution.ts への import 1行だけで全部が有効になる。

import './media/paradisBrowserProfiles.css';
// ナビバーのピル（BrowserEditor.registerContribution を副作用で呼ぶ）。
import './paradisBrowserProfilePill.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { localize, localize2 } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { BrowserActionCategory } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { paradisShowCreateProfileDialog, paradisShowManageProfilesDialog } from './paradisBrowserProfileDialogs.js';
import { IParadisBrowserProfilesService, ParadisBrowserProfilesService } from './paradisBrowserProfilesService.js';

registerSingleton(IParadisBrowserProfilesService, ParadisBrowserProfilesService, InstantiationType.Delayed);

/**
 * コマンドパレットからプロファイルを選んで新しいタブで開く。
 *
 * ナビバーのピルと違い、ここでは「今開いているタブを差し替える」ことはしない。コマンドは
 * ブラウザを開いていないときにも実行できるため、常に新しいタブで開く方が予測しやすい。
 * 選択自体は QuickPick に任せる（ピルのドロップダウンはナビバーへアンカーする前提の実装）。
 */
class ParadisOpenBrowserProfileAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.browser.openProfile',
			title: localize2('paradis.browserProfiles.action.open', "Open Page in Browser Profile"),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const profilesService = accessor.get(IParadisBrowserProfilesService);
		const quickInputService = accessor.get(IQuickInputService);
		const instantiationService = accessor.get(IInstantiationService);

		if (!profilesService.canUseProfiles()) {
			await quickInputService.pick([], {
				placeHolder: localize('paradis.browserProfiles.action.untrusted', "このワークスペースを信頼していないため、プロファイルは使えません。"),
			});
			return;
		}

		const profiles = profilesService.list();
		if (profiles.length === 0) {
			paradisShowCreateProfileDialog(instantiationService, profile => void profilesService.openInProfile(profile.id));
			return;
		}

		const picked = await quickInputService.pick(
			profiles.map(profile => ({ label: profile.name, id: profile.id })),
			{ placeHolder: localize('paradis.browserProfiles.action.pick', "開くブラウザプロファイルを選択") },
		);
		if (picked?.id) {
			await profilesService.openInProfile(picked.id);
		}
	}
}

class ParadisManageBrowserProfilesAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.browser.manageProfiles',
			title: localize2('paradis.browserProfiles.action.manage', "Manage Browser Profiles"),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		paradisShowManageProfilesDialog(accessor.get(IInstantiationService));
	}
}

class ParadisCreateBrowserProfileAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.browser.createProfile',
			title: localize2('paradis.browserProfiles.action.create', "Create Browser Profile"),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const profilesService = accessor.get(IParadisBrowserProfilesService);
		paradisShowCreateProfileDialog(accessor.get(IInstantiationService), profile => void profilesService.openInProfile(profile.id));
	}
}

registerAction2(ParadisOpenBrowserProfileAction);
registerAction2(ParadisManageBrowserProfilesAction);
registerAction2(ParadisCreateBrowserProfileAction);

/**
 * AfterRestored の起動役。
 *
 * Delayed のままだと、誰かがサービスを引くまでインスタンス化されない = ルーターが未登録の
 * 状態でブラウザタブの復元が走り得る。その瞬間に開かれたビューは既定のスコープになり、
 * ユーザーから見ると「ログイン状態が消えた」になる。ここで必ず起こしておく。
 */
class ParadisBrowserProfilesStarter implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisBrowserProfiles';

	constructor(@IParadisBrowserProfilesService _profilesService: IParadisBrowserProfilesService) { }
}

registerWorkbenchContribution2(ParadisBrowserProfilesStarter.ID, ParadisBrowserProfilesStarter, WorkbenchPhase.AfterRestored);
