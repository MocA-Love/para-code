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
import { PARADIS_PTY_DAEMON_LEGACY_ENABLED, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../../common/paradisPtyDaemonSettingKey.js';
import { paradisAnyDaemonEnabled, paradisCreatePtyHostStarter } from '../../electron-main/paradisPtyHostStarterFactory.js';
import { ParadisScopedEnvPtyHostStarter } from '../../electron-main/paradisScopedEnvPtyHostStarter.js';
import { isWindows } from '../../../../../base/common/platform.js';

suite('ParadisPtyHostStarterFactory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('親から受け継いだ常駐の内部用の変数を、どの分岐でも main の環境から消し、前の鍵でも薄い常駐を選ぶ', () => {
		const saved = PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS.map(key => [key, process.env[key]] as const);
		const remainingPerBranch: Record<string, string[]> = {};
		// 前の鍵（paradis.terminal.daemon.enabled）だけを書いた人も、薄い常駐（引き継ぎ）になる。前の方式は選ばれない
		const handoverPerBranch: Record<string, boolean> = {};
		const enabledPerBranch: Record<string, boolean> = {};
		try {
			for (const [branch, enabledSetting] of [['in-app', undefined], ['host-daemon', PARADIS_PTY_HOST_DAEMON_ENABLED], ['legacy-key', PARADIS_PTY_DAEMON_LEGACY_ENABLED]] as const) {
				for (const key of PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS) {
					process.env[key] = '/Users/example/Library/Application Support/Para Code';
				}
				const configurationService = { getValue: (key: string) => key === enabledSetting ? true : undefined } as unknown as IConfigurationService;
				const starter = paradisCreatePtyHostStarter(
					{ graceTime: 60_000, shortGraceTime: 6_000, scrollback: 100 },
					configurationService,
					{ userDataPath: '/tmp/paradis-factory-test' } as IEnvironmentMainService,
					{ onWillShutdown: Event.None } as unknown as ILifecycleMainService,
					new NullLogService(),
					{ version: '1.0.0', commit: undefined } as unknown as IProductService,
					new EventEmitter() as never,
				);
				remainingPerBranch[branch] = PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS.filter(key => Object.prototype.hasOwnProperty.call(process.env, key));
				handoverPerBranch[branch] = starter instanceof ParadisScopedEnvPtyHostStarter;
				enabledPerBranch[branch] = paradisAnyDaemonEnabled(configurationService);
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

		assert.deepStrictEqual({ remainingPerBranch, handoverPerBranch, enabledPerBranch }, {
			remainingPerBranch: { 'in-app': [], 'host-daemon': [], 'legacy-key': [] },
			// Windows では常駐を使わない（名前付きパイプが相手を確かめられない）
			handoverPerBranch: { 'in-app': false, 'host-daemon': !isWindows, 'legacy-key': !isWindows },
			enabledPerBranch: { 'in-app': false, 'host-daemon': true, 'legacy-key': true },
		});
	});
});
