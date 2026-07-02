/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドパレット「Paradis: Open Notification Settings」の登録。paradisAgentBrowser.contribution.ts
// の openBindingDialog と同じ「同時に1つだけ」パターンでダイアログを開く。
// 併せて、設定エディタの既存 'paradis' セクション（windowTransparency/workspaceSwitch と同じIDへの
// 相乗り、registerConfigurationは複数回呼んでも1セクションにマージされる）へ、このコマンドを
// 起動するリンクのみを持つ type:'null' の疑似プロパティを追加する（拡張機能の設定でよく使われる
// 「値を持たずmarkdownDescriptionのcommand:リンクだけを表示する」パターン）。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ParadisNotificationSettingsDialog } from './paradisNotificationSettingsDialog.js';

const CATEGORY = localize2('paradis.category', "Paradis");

let activeDialog: ParadisNotificationSettingsDialog | undefined;

class ParadisOpenNotificationSettingsAction extends Action2 {
	static readonly ID = 'paradis.notifications.openSettings';

	constructor() {
		super({
			id: ParadisOpenNotificationSettingsAction.ID,
			title: localize2('paradis.notifications.openSettings', "Open Notification Settings"),
			category: CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		activeDialog?.dispose();
		activeDialog = accessor.get(IInstantiationService).createInstance(ParadisNotificationSettingsDialog);
	}
}

registerAction2(ParadisOpenNotificationSettingsAction);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Paradis"),
	type: 'object',
	properties: {
		'paradis.notifications.openSettings': {
			type: 'null',
			// allow-any-unicode-next-line
			markdownDescription: localize({ key: 'paradis.notifications.openSettingsLink', comment: ['{Locked="](command:paradis.notifications.openSettings)"}'] }, "[通知設定を開く](command:{0})", ParadisOpenNotificationSettingsAction.ID),
		},
	},
});
