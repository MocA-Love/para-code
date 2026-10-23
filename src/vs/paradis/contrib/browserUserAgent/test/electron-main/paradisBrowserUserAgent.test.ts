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
import { IParadisChromeIdentityView, paradisAttachChromeIdentity, paradisInstallChromeClientHintHeaders } from '../../electron-main/paradisChromeIdentity.js';
import { timeout } from '../../../../../base/common/async.js';

const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.139.1 Chrome/142.0.0.0 Electron/43.6.0 Safari/537.36';

suite('ParadisBrowserUserAgent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('removes Electron and app tokens by default, keeps the app token when asked', () => {
		assert.deepStrictEqual({
			default: paradisBuildBrowserUserAgent(ELECTRON_UA, 'Para Code', false),
			includeAppToken: paradisBuildBrowserUserAgent(ELECTRON_UA, 'Para Code', true),
			multipleElectronTokens: paradisBuildBrowserUserAgent('Mozilla/5.0 Chrome/128.0 Electron/32.1.2 Safari/537.36 Electron/custom', 'Para Code', false),
			regexCharsInName: paradisBuildBrowserUserAgent('Mozilla/5.0 Code-OSS+Dev/1.0 Chrome/1 Safari/1', 'Code-OSS+Dev', false),
			reducedVersion: paradisBuildBrowserUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.142.0 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36', 'Para Code', false),
			fullVersionWithAppToken: paradisBuildBrowserUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.142.0 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36', 'Para Code', true),
		}, {
			default: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
			includeAppToken: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.139.1 Chrome/142.0.0.0 Safari/537.36',
			multipleElectronTokens: 'Mozilla/5.0 Chrome/128.0 Safari/537.36',
			regexCharsInName: 'Mozilla/5.0 Chrome/1 Safari/1',
			reducedVersion: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
			fullVersionWithAppToken: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.142.0 Chrome/150.0.7871.250 Safari/537.36',
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

	test('gives each tab the Chrome identity over CDP and follows device emulation', async () => {
		const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
		let headerListener: ((details: { requestHeaders: Record<string, string> }, callback: (response: { requestHeaders?: Record<string, string> }) => void) => void) | undefined;
		const session = {
			getUserAgent: () => userAgent,
			webRequest: { onBeforeSendHeaders: (_filter: unknown, listener: typeof headerListener) => { headerListener = listener; } },
		};
		paradisInstallChromeClientHintHeaders(session as unknown as Session, () => true, '150.0.7871.250', false);

		const sent: { method: string; params: unknown; sessionId?: string }[] = [];
		const onSessionCreated = store.add(new Emitter<{ session: { sessionId: string; targetId: string; onClose: Emitter<void>['event'] } }>());
		const onDidDetach = store.add(new Emitter<void>());
		const onDidChangeDevice = store.add(new Emitter<unknown>());
		const iframeClose = store.add(new Emitter<void>());
		const emulation: { device?: { userAgent?: string } } = {};
		const view: IParadisChromeIdentityView = {
			webContents: { session, getUserAgent: () => userAgent, isDestroyed: () => false } as unknown as IParadisChromeIdentityView['webContents'],
			debugger: {
				knownTargets: new Map([['frame-1', { type: 'iframe' }], ['worker-1', { type: 'worker' }]]),
				onSessionCreated: onSessionCreated.event,
				onDidDetach: onDidDetach.event,
				sendCommandRaw: async (method, params, sessionId) => { sent.push({ method, params, ...(sessionId ? { sessionId } : {}) }); return {}; },
			},
			emulator: { get device() { return emulation.device; }, onDidChange: onDidChangeDevice.event },
		};
		const native = { platform: 'macOS', platformVersion: '15.6.1', architecture: 'arm', model: '', mobile: false, bitness: '64', wow64: false, formFactors: ['Desktop'] };
		store.add(paradisAttachChromeIdentity(view, { readNativeHints: async () => native, chromeVersion: '150.0.7871.250' }));
		await timeout(0);
		onSessionCreated.fire({ session: { sessionId: 'S-frame', targetId: 'frame-1', onClose: iframeClose.event } });
		onSessionCreated.fire({ session: { sessionId: 'S-worker', targetId: 'worker-1', onClose: store.add(new Emitter<void>()).event } });
		await timeout(0);
		emulation.device = { userAgent: 'Mozilla/5.0 (iPhone)' };
		onDidChangeDevice.fire(emulation.device);
		await timeout(0);

		let rewritten: Record<string, string> | undefined;
		headerListener!({ requestHeaders: { 'User-Agent': userAgent, 'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150"' } }, response => rewritten = response.requestHeaders);

		const metadata = (sent[0].params as { userAgentMetadata: { brands: { brand: string }[]; platformVersion: string } }).userAgentMetadata;
		assert.deepStrictEqual({
			calls: sent.map(c => `${c.method} ${c.sessionId ?? 'root'} ${(c.params as { userAgent: string }).userAgent === '' ? 'cleared' : 'chrome'}`),
			brands: metadata.brands.map(b => b.brand),
			platformVersion: metadata.platformVersion,
			header: rewritten?.['sec-ch-ua'],
		}, {
			calls: [
				'Emulation.setUserAgentOverride root chrome',
				'Emulation.setUserAgentOverride S-frame chrome',
				'Emulation.setUserAgentOverride root cleared',
				'Emulation.setUserAgentOverride S-frame cleared',
			],
			brands: ['Not;A=Brand', 'Chromium', 'Google Chrome'],
			platformVersion: '15.6.1',
			header: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
		});
	});
});
