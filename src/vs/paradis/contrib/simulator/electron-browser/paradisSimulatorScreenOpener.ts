/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 共有ダイアログの「モバイル端末」タブの「画面を開く」（q.html Q585 の ④）。新しい仕組みのシミュレータ
// （macOS の `ios:core-simulator:<udid>`）と Android の端末だけ、その画面をエディタのタブに開ける。

import { isMacintosh } from '../../../../base/common/platform.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { paradisSimulatorUdidOfDeviceId } from '../common/paradisSimulator.js';
import { paradisAndroidSerialOf } from '../common/paradisAndroid.js';

/** コマンド「シミュレータを開く」（paradisSimulator.contribution.ts）。引数は udid。 */
export const PARADIS_SIMULATOR_OPEN_COMMAND_ID = 'paradis.simulator.open';
/** Android の端末の画面をタブに開くコマンド（引数は serial）。 */
export const PARADIS_SIMULATOR_OPEN_ANDROID_COMMAND_ID = 'paradis.simulator.openAndroid';

/**
 * 端末の id から、その画面を開く関数を返す。開けない端末（macOS 以外）なら undefined。
 * `accessor` はこの関数の中でだけ使う（返した関数は後から呼んでよい）。
 */
export function paradisSimulatorScreenOpener(accessor: ServicesAccessor): (deviceId: string) => (() => void) | undefined {
	const commandService = accessor.get(ICommandService);
	return deviceId => {
		// iOS のシミュレータは macOS だけ。Android は全 OS（Q588）
		const udid = isMacintosh ? paradisSimulatorUdidOfDeviceId(deviceId) : undefined;
		if (udid) {
			return () => void commandService.executeCommand(PARADIS_SIMULATOR_OPEN_COMMAND_ID, udid);
		}
		const serial = paradisAndroidSerialOf(deviceId);
		return serial ? () => void commandService.executeCommand(PARADIS_SIMULATOR_OPEN_ANDROID_COMMAND_ID, serial) : undefined;
	};
}
