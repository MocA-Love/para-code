/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 開発ビルドだけのコマンド「シミュレータの土台を確かめる」（q.html Q585 の ①）。Mac で、
// ホストの起動 → 端末の起動 → 1 枚取って保存 → 真ん中をタップ → 開閉（折りたたみの端末だけ）→
// Device Hub の判定 → ホストの後始末、までを 1 回で通し、各段の結果を通知に出す。
// エディタのペイン（②）ができるまで、映像と入力の口が Mac で動くかをこれで確かめる。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IsDevelopmentContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INativeWorkbenchEnvironmentService } from '../../../../workbench/services/environment/electron-browser/environmentService.js';
import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, IParadisSimulatorStatus, PARADIS_SIMULATOR_CHANNEL, ParadisSimulatorInput } from '../common/paradisSimulator.js';

const PARADIS_SIMULATOR_PROBE_COMMAND_ID = 'paradis.simulator.probeFoundation';

interface IDeviceItem extends IQuickPickItem {
	readonly device: IParadisSimulatorDevice;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_SIMULATOR_PROBE_COMMAND_ID,
			title: localize2('paradis.simulator.probeFoundation', "シミュレータの土台を確かめる（開発用）"),
			category: localize2('paradis.category', "Para Code"),
			precondition: IsDevelopmentContext,
			f1: false,
			menu: [{ id: MenuId.CommandPalette, when: IsDevelopmentContext }],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const channel: IChannel = accessor.get(ISharedProcessService).getChannel(PARADIS_SIMULATOR_CHANNEL);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);
		const fileService = accessor.get(IFileService);
		const environmentService = accessor.get(INativeWorkbenchEnvironmentService);

		const status = await channel.call<IParadisSimulatorStatus>('getStatus');
		if (!status.supported) {
			notificationService.warn(localize('paradis.simulator.probe.unsupported', "iOS のシミュレータは macOS でだけ使えます。"));
			return;
		}

		let devices: IParadisSimulatorDevice[];
		try {
			devices = await channel.call<IParadisSimulatorDevice[]>('listDevices');
		} catch (error) {
			notificationService.error(localize('paradis.simulator.probe.listFailed', "端末の一覧を取れませんでした: {0}", message(error)));
			return;
		}
		const picked = await quickInputService.pick<IDeviceItem>(devices.map(device => ({ label: device.name, description: `${device.runtime} · ${device.state}`, device })), {
			placeHolder: localize('paradis.simulator.probe.pick', "確かめる端末を選んでください（起動していなければ起動します）"),
		});
		if (!picked) {
			return;
		}
		const udid = picked.device.udid;
		const results: string[] = [];
		const step = async <T>(label: string, run: () => Promise<T>, describe: (value: T) => string = () => 'ok'): Promise<T | undefined> => {
			try {
				const value = await run();
				results.push(`${label}: ${describe(value)}`);
				return value;
			} catch (error) {
				results.push(`${label}: FAILED (${message(error)})`);
				return undefined;
			}
		};

		await step('boot', () => channel.call('boot', { udid }));
		const frame = await step('frame', () => channel.call<VSBuffer>('captureFrame', { udid }), jpeg => `${jpeg.byteLength} bytes`);
		if (frame) {
			const target = joinPath(environmentService.tmpDir, `paradis-simulator-probe-${Date.now()}.jpg`);
			await step('save', () => fileService.writeFile(target, frame), () => target.fsPath);
		}
		const config = await step('config', () => channel.call<IParadisSimulatorScreenConfig>('getScreenConfig', { udid }), value => JSON.stringify(value));
		const tap = (phase: 'begin' | 'end'): ParadisSimulatorInput => ({ kind: 'touch', phase, x: 0.5, y: 0.5 });
		await step('tap', async () => {
			await channel.call('sendInput', { udid, input: tap('begin') });
			await channel.call('sendInput', { udid, input: tap('end') });
		});
		if (config?.hingeDegrees !== undefined) {
			await step('fold book', () => channel.call<{ ok: boolean }>('fold', { udid, fold: { pose: 'book' } }), value => String(value.ok));
			await step('fold open', () => channel.call<{ ok: boolean }>('fold', { udid, fold: { pose: 'open' } }), value => String(value.ok));
		} else {
			results.push('fold: skipped (not a foldable device)');
		}
		await step('device hub', () => channel.call<boolean>('deviceHubActive', { udid }), active => active ? 'taking the input' : 'not active');
		await step('stop host', () => channel.call('stopHost'));

		const failed = results.some(line => line.includes('FAILED'));
		notificationService.notify({
			severity: failed ? Severity.Warning : Severity.Info,
			message: localize('paradis.simulator.probe.result', "シミュレータの土台（{0}）: {1}", picked.device.name, results.join(' / ')),
		});
	}
});
