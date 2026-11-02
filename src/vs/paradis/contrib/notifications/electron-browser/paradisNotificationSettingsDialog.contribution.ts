/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 統合のモーダルに「通知」の領域を登録し、コマンドパレット「Para Code: Open Notification Settings」で
// その領域を開く。
// 併せて、設定エディタの既存 'paradis' セクション（windowTransparency/workspaceSwitch と同じIDへの
// 相乗り、registerConfigurationは複数回呼んでも1セクションにマージされる）へ、このコマンドを
// 起動するリンクのみを持つ type:'null' の疑似プロパティを追加する（拡張機能の設定でよく使われる
// 「値を持たずmarkdownDescriptionのcommand:リンクだけを表示する」パターン）。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ParadisHubAreaId, paradisRegisterHubArea } from '../../paradisHub/electron-browser/paradisHub.js';
import { paradisOpenHub } from '../../paradisHub/electron-browser/paradisHubOpen.js';
import { ParadisNotificationSettingsArea } from './paradisNotificationSettingsArea.js';

const CATEGORY = localize2('paradis.category', "Para Code");

paradisRegisterHubArea({
	id: ParadisHubAreaId.Notifications,
	// allow-any-unicode-next-line
	label: localize('paradis.notifications.areaLabel', "通知"),
	order: 30,
	create: (instantiationService, containers, host) => instantiationService.createInstance(ParadisNotificationSettingsArea, containers, host),
});

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

	/** @param sectionId 開いたときに出す節（`pns-sec-*`）。 */
	run(accessor: ServicesAccessor, sectionId?: unknown): void {
		paradisOpenHub(accessor, ParadisHubAreaId.Notifications, typeof sectionId === 'string' ? sectionId : undefined);
	}
}

registerAction2(ParadisOpenNotificationSettingsAction);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		'paradis.notifications.openSettings': {
			type: 'null',
			// allow-any-unicode-next-line
			markdownDescription: localize({ key: 'paradis.notifications.openSettingsLink', comment: ['{Locked="](command:paradis.notifications.openSettings)"}'] }, "[通知設定を開く](command:{0})", ParadisOpenNotificationSettingsAction.ID),
		},
	},
});
