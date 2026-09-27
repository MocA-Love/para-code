/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type { Session } from 'electron';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY, paradisBuildBrowserUserAgent } from '../../common/paradisBrowserUserAgent.js';
import { paradisConfigureBrowserUserAgentWithAppName } from '../../electron-main/paradisBrowserUserAgentCore.js';

const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.139.1 Chrome/142.0.0.0 Electron/43.6.0 Safari/537.36';

suite('ParadisBrowserUserAgent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('removes Electron and app tokens by default, keeps the app token when asked', () => {
		assert.deepStrictEqual({
			default: paradisBuildBrowserUserAgent(ELECTRON_UA, 'Para Code', false),
			includeAppToken: paradisBuildBrowserUserAgent(ELECTRON_UA, 'Para Code', true),
			multipleElectronTokens: paradisBuildBrowserUserAgent('Mozilla/5.0 Chrome/128.0 Electron/32.1.2 Safari/537.36 Electron/custom', 'Para Code', false),
			regexCharsInName: paradisBuildBrowserUserAgent('Mozilla/5.0 Code-OSS+Dev/1.0 Chrome/1 Safari/1', 'Code-OSS+Dev', false),
		}, {
			default: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
			includeAppToken: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.139.1 Chrome/142.0.0.0 Safari/537.36',
			multipleElectronTokens: 'Mozilla/5.0 Chrome/128.0 Safari/537.36',
			regexCharsInName: 'Mozilla/5.0 Chrome/1 Safari/1',
		});
	});

	test('applies the setting to the session and re-applies it when the setting changes', () => {
		const applied: string[] = [];
		let current = 'Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.0.0 Chrome/142.0.0.0 Electron/43.6.0 Safari/537.36';
		const session = {
			getUserAgent: () => current,
			setUserAgent: (userAgent: string) => { current = userAgent; applied.push(userAgent); },
		} satisfies Pick<Session, 'getUserAgent' | 'setUserAgent'>;

		let includeAppToken = false;
		const onDidChangeConfiguration = store.add(new Emitter<IConfigurationChangeEvent>());
		const configurationService = {
			getValue: (key: string) => key === PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY ? includeAppToken : undefined,
			onDidChangeConfiguration: onDidChangeConfiguration.event,
		} as unknown as IConfigurationService;

		paradisConfigureBrowserUserAgentWithAppName(session as unknown as Session, configurationService, 'Para Code');
		// Configuring the same session twice must be a no-op.
		paradisConfigureBrowserUserAgentWithAppName(session as unknown as Session, configurationService, 'Para Code');
		includeAppToken = true;
		onDidChangeConfiguration.fire({ affectsConfiguration: (key: string) => key === PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY } as unknown as IConfigurationChangeEvent);

		assert.deepStrictEqual(applied, [
			'Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
			'Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.0.0 Chrome/142.0.0.0 Safari/537.36',
		]);
	});
});
