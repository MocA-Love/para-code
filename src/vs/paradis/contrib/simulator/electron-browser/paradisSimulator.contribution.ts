/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのエディタのペイン・タブの復元・コマンド「シミュレータを開く」を登録する
// （paradis.electron-browser.contribution.ts から読む）。設定 paradis.simulator.enabled がオフの間、
// コマンドはパレットに出ない。復元したタブはペインの中でオフであることを知らせる。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsMacContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisSimulatorDevice, PARADIS_SIMULATOR_ENABLED_SETTING, PARADIS_SIMULATOR_OPEN_FOR_PANE_COMMAND_ID, paradisSimulatorUdidOfDeviceId } from '../common/paradisSimulator.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';
import { ParadisSimulatorEditor } from './paradisSimulatorEditor.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { PARADIS_SIMULATOR_EDITOR_ID, PARADIS_SIMULATOR_INPUT_TYPE_ID, ParadisSimulatorEditorInput, ParadisSimulatorEditorInputSerializer } from './paradisSimulatorEditorInput.js';
import { paradisOpenSimulatorEditor } from './paradisSimulatorPlacement.js';
import './paradisSimulatorProbe.contribution.js';

/** コマンド「シミュレータを開く」。引数に udid を渡すと選ばずにその端末を開く。 */
export const PARADIS_SIMULATOR_OPEN_COMMAND_ID = 'paradis.simulator.open';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisSimulatorEditor, PARADIS_SIMULATOR_EDITOR_ID, localize('paradis.simulator.editorName', "シミュレータ")),
	[new SyncDescriptor(ParadisSimulatorEditorInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PARADIS_SIMULATOR_INPUT_TYPE_ID, ParadisSimulatorEditorInputSerializer);

interface IDeviceItem extends IQuickPickItem {
	readonly device: IParadisSimulatorDevice;
}

registerAction2(class ParadisOpenSimulatorAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_SIMULATOR_OPEN_COMMAND_ID,
			title: localize2('paradis.simulator.open', "シミュレータを開く"),
			category: localize2('paradis.category', "Para Code"),
			precondition: ContextKeyExpr.and(IsMacContext, ContextKeyExpr.equals(`config.${PARADIS_SIMULATOR_ENABLED_SETTING}`, true)),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, udid?: unknown): Promise<void> {
		const client = accessor.get(IParadisSimulatorClient);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const configurationService = accessor.get(IConfigurationService);

		let devices: IParadisSimulatorDevice[];
		try {
			devices = await client.listDevices();
		} catch (error) {
			notificationService.error(localize('paradis.simulator.open.listFailed', "シミュレータの一覧を取れませんでした: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}
		let device = typeof udid === 'string' ? devices.find(candidate => candidate.udid === udid) : undefined;
		if (!device) {
			if (devices.length === 0) {
				notificationService.info(localize('paradis.simulator.open.none', "使えるシミュレータがありません。Xcode でシミュレータを追加してください。"));
				return;
			}
			const picked = await quickInputService.pick<IDeviceItem>(devices.map(candidate => ({
				label: candidate.name,
				description: candidate.runtime,
				detail: candidate.state === 'Booted' ? localize('paradis.simulator.open.booted', "起動中") : localize('paradis.simulator.open.notBooted', "停止中（開いてから起動できます）"),
				device: candidate,
			})), { placeHolder: localize('paradis.simulator.open.pick', "開くシミュレータを選んでください") });
			device = picked?.device;
		}
		if (device) {
			await paradisOpenSimulatorEditor(device.udid, device.name, editorService, editorGroupsService, configurationService);
		}
	}
});

// エージェントの端末の要求を承認したとき（mobileCanvas/electron-browser/paradisMobileDeviceRequest.contribution.ts から）。
// 新しい仕組みのシミュレータなら、その画面をペインのターミナルの右に開き、止まっていれば起動する。
CommandsRegistry.registerCommand(PARADIS_SIMULATOR_OPEN_FOR_PANE_COMMAND_ID, async (accessor, paneToken: unknown, deviceId: unknown) => {
	const configurationService = accessor.get(IConfigurationService);
	if (!isMacintosh || configurationService.getValue<boolean>(PARADIS_SIMULATOR_ENABLED_SETTING) !== true || typeof paneToken !== 'string' || typeof deviceId !== 'string') {
		return;
	}
	const udid = paradisSimulatorUdidOfDeviceId(deviceId);
	if (!udid) {
		return;
	}
	const client = accessor.get(IParadisSimulatorClient);
	const editorService = accessor.get(IEditorService);
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const paneInstanceId = accessor.get(IParadisPaneTokenService).getInstanceForToken(paneToken);
	const device = (await client.listDevices().catch(() => [])).find(candidate => candidate.udid === udid);
	const input = await paradisOpenSimulatorEditor(udid, device?.name ?? '', editorService, editorGroupsService, configurationService, { paneInstanceId });
	input.requestBoot();
});
