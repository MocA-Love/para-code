/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDeviceHubAppPath, paradisDeviceHubInProcessList, ParadisSimulatorDeviceHub } from '../../node/paradisSimulatorDeviceHub.js';

suite('Paradis simulator: Device Hub', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds Device Hub in the process list and next to the selected Xcode', () => {
		assert.deepStrictEqual({
			running: paradisDeviceHubInProcessList('/sbin/launchd\n/Applications/Xcode.app/Contents/Applications/DeviceHub.app/Contents/MacOS/DeviceHub\n'),
			notRunning: paradisDeviceHubInProcessList('/sbin/launchd\n/Applications/Xcode.app/Contents/MacOS/Xcode\n'),
			path: paradisDeviceHubAppPath('/Applications/Xcode.app/Contents/Developer\n'),
		}, {
			running: true,
			notRunning: false,
			path: '/Applications/Xcode.app/Contents/Applications/DeviceHub.app',
		});
	});

	// 押したときだけ、前に出さずに（open -g）起動する。Xcode に Device Hub が無ければ理由を返す
	test('opens Device Hub in the background, and says so when Xcode has none', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-device-hub-test-'));
		try {
			const developer = join(root, 'Xcode.app', 'Contents', 'Developer');
			const calls: string[] = [];
			const hub = new ParadisSimulatorDeviceHub(async (file, args) => {
				calls.push([file, ...args].join(' '));
				return file === 'xcode-select' ? `${developer}\n` : '';
			});
			const missing = await hub.open().then(() => 'opened', (error: Error) => error.message.startsWith('Device Hub was not found'));
			await fs.mkdir(join(root, 'Xcode.app', 'Contents', 'Applications', 'DeviceHub.app'), { recursive: true });
			await hub.open();
			const app = join(root, 'Xcode.app', 'Contents', 'Applications', 'DeviceHub.app');
			assert.deepStrictEqual({ missing, calls }, { missing: true, calls: ['xcode-select -p', 'xcode-select -p', `open -g ${app}`] });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
