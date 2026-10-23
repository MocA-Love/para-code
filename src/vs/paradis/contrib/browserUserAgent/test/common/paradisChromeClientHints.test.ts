/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisChromeBrandLists, paradisChromeUserAgentMetadata, paradisNeutralizeDefaultUserAgentOverride, paradisReadNativeClientHints, paradisRewriteClientHintHeaders, paradisSerializeClientHintBrands } from '../../common/paradisChromeClientHints.js';

const GENUINE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

suite('ParadisChromeClientHints', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds the brand lists of Google Chrome', () => {
		const chrome141 = paradisChromeBrandLists('141.0.7390.108')!;
		const chrome150 = paradisChromeBrandLists('150.0.7871.250')!;
		assert.deepStrictEqual({
			// Google Chrome 141 sends `"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"`
			chrome141: paradisSerializeClientHintBrands(chrome141.brands),
			chrome150: paradisSerializeClientHintBrands(chrome150.brands),
			chrome150Full: paradisSerializeClientHintBrands(chrome150.fullVersionList),
			invalid: paradisChromeBrandLists('150'),
		}, {
			chrome141: '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
			chrome150: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
			chrome150Full: '"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.250", "Google Chrome";v="150.0.7871.250"',
			invalid: undefined,
		});
	});

	test('keeps the native values other than the brands', () => {
		const native = paradisReadNativeClientHints({ brands: [{ brand: 'Chromium', version: '150' }], platform: 'macOS', platformVersion: '15.6.1', architecture: 'arm', model: '', mobile: false, bitness: '64', wow64: false, formFactors: ['Desktop'] })!;
		const metadata = paradisChromeUserAgentMetadata('150.0.7871.250', native)!;
		assert.deepStrictEqual({
			brands: metadata.brands.map(b => b.brand),
			fullVersion: metadata.fullVersion,
			platform: metadata.platform,
			platformVersion: metadata.platformVersion,
			architecture: metadata.architecture,
			missingRequired: paradisReadNativeClientHints({ platform: 'macOS' }),
		}, {
			brands: ['Not;A=Brand', 'Chromium', 'Google Chrome'],
			fullVersion: '150.0.7871.250',
			platform: 'macOS',
			platformVersion: '15.6.1',
			architecture: 'arm',
			missingRequired: undefined,
		});
	});

	test('rewrites only the brand headers of requests that use the browser UA', () => {
		const electronBrands = '"Not;A=Brand";v="8", "Chromium";v="150"';
		assert.deepStrictEqual({
			rewritten: paradisRewriteClientHintHeaders({ 'User-Agent': GENUINE_UA, 'sec-ch-ua': electronBrands, 'sec-ch-ua-platform': '"macOS"', 'Sec-CH-UA-Full-Version-List': '"Chromium";v="150.0.7871.250"' }, GENUINE_UA, '150.0.7871.250'),
			emulatedDevice: paradisRewriteClientHintHeaders({ 'User-Agent': 'Mozilla/5.0 (iPhone)', 'sec-ch-ua': electronBrands }, GENUINE_UA, '150.0.7871.250'),
			serviceWorker: paradisRewriteClientHintHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.142.0 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36', 'sec-ch-ua': electronBrands }, GENUINE_UA, '150.0.7871.250'),
			noHints: paradisRewriteClientHintHeaders({ 'User-Agent': GENUINE_UA }, GENUINE_UA, '150.0.7871.250'),
		}, {
			rewritten: {
				'User-Agent': GENUINE_UA,
				'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
				'sec-ch-ua-platform': '"macOS"',
				'Sec-CH-UA-Full-Version-List': '"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.250", "Google Chrome";v="150.0.7871.250"',
			},
			emulatedDevice: undefined,
			serviceWorker: { 'User-Agent': GENUINE_UA, 'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"' },
			noHints: undefined,
		});
	});

	test('neutralizes the Electron default UA that the agent connection sends', () => {
		const electronUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ParaCode/1.142.0 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36';
		assert.deepStrictEqual({
			network: paradisNeutralizeDefaultUserAgentOverride('Network.setUserAgentOverride', { userAgent: electronUA }),
			emulation: paradisNeutralizeDefaultUserAgentOverride('Emulation.setUserAgentOverride', { userAgent: electronUA, acceptLanguage: 'ja', userAgentMetadata: {} }),
			chosenByAgent: paradisNeutralizeDefaultUserAgentOverride('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone)' }),
			otherMethod: paradisNeutralizeDefaultUserAgentOverride('Page.navigate', { userAgent: electronUA }),
		}, {
			network: { userAgent: '' },
			emulation: { userAgent: '', acceptLanguage: 'ja' },
			chosenByAgent: undefined,
			otherMethod: undefined,
		});
	});
});
