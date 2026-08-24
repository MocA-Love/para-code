/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventEmitter } from 'events';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ElectronPtyHostStarter } from '../../../../../platform/terminal/electron-main/electronPtyHostStarter.js';
import { ParadisDaemonPtyHostStarter } from '../../electron-main/paradisDaemonPtyHostStarter.js';

const CHANNEL = 'vscode:createPtyHostMessageChannel';
const reconnectConstants = { graceTime: 60_000, shortGraceTime: 6_000, scrollback: 100 };
const daemonPaths = {
	socketPath: '/tmp/paradis-pty-test.sock',
	buildKey: 'test-key',
	ledgerDir: '/tmp/paradis-pty-test',
	ledgerFile: '/tmp/paradis-pty-test/test-key.json',
	socketPathTooLong: false,
};

suite('PTY host starter lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function lifecycleService(): ILifecycleMainService {
		return { onWillShutdown: Event.None } as unknown as ILifecycleMainService;
	}

	function assertReturnsToBaseline(create: (ipc: EventEmitter) => { dispose(): void }): void {
		const ipc = new EventEmitter();
		const baseline = ipc.listenerCount(CHANNEL);
		const starter = create(ipc);
		assert.strictEqual(ipc.listenerCount(CHANNEL), baseline + 1);
		starter.dispose();
		assert.strictEqual(ipc.listenerCount(CHANNEL), baseline);
	}

	test('daemon starter removes its message-channel listener on dispose', () => {
		assertReturnsToBaseline(ipc => new ParadisDaemonPtyHostStarter(
			reconnectConstants,
			daemonPaths,
			'test-build',
			Object.create(null) as IEnvironmentMainService,
			lifecycleService(),
			new NullLogService(),
			ipc as never,
		));
	});

	test('fallback starter removes its message-channel listener on dispose', () => {
		assertReturnsToBaseline(ipc => new ElectronPtyHostStarter(
			reconnectConstants,
			{ getValue: () => undefined } as unknown as IConfigurationService,
			Object.create(null) as IEnvironmentMainService,
			lifecycleService(),
			new NullLogService(),
			ipc as never,
		));
	});
});
