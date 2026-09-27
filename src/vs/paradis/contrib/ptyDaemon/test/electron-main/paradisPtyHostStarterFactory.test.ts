/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventEmitter } from 'events';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS } from '../../common/paradisPtyEnvHygiene.js';
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../../common/paradisPtyDaemonSettingKey.js';
import { paradisCreatePtyHostStarter } from '../../electron-main/paradisPtyHostStarterFactory.js';

suite('ParadisPtyHostStarterFactory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('親から受け継いだ常駐の内部用の変数を、どの分岐でも main の環境から消す', () => {
		const saved = PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS.map(key => [key, process.env[key]] as const);
		const remainingPerBranch: Record<string, string[]> = {};
		try {
			for (const [branch, enabledSetting] of [['in-app', undefined], ['host-daemon', PARADIS_PTY_HOST_DAEMON_ENABLED], ['daemon', PARADIS_PTY_DAEMON_ENABLED]] as const) {
				for (const key of PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS) {
					process.env[key] = '/Users/example/Library/Application Support/Para Code';
				}
				const starter = paradisCreatePtyHostStarter(
					{ graceTime: 60_000, shortGraceTime: 6_000, scrollback: 100 },
					{ getValue: (key: string) => key === enabledSetting ? true : undefined } as unknown as IConfigurationService,
					{ userDataPath: '/tmp/paradis-factory-test' } as IEnvironmentMainService,
					{ onWillShutdown: Event.None } as unknown as ILifecycleMainService,
					new NullLogService(),
					{ version: '1.0.0', commit: undefined } as unknown as IProductService,
					new EventEmitter() as never,
				);
				remainingPerBranch[branch] = PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS.filter(key => Object.prototype.hasOwnProperty.call(process.env, key));
				starter.dispose();
			}
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}

		assert.deepStrictEqual(remainingPerBranch, { 'in-app': [], 'host-daemon': [], 'daemon': [] });
	});
});
