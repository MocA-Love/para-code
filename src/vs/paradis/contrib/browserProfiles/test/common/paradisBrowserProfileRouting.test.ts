/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserViewStorageScope, getBrowserViewSessionNetwork, IBrowserViewSessionOptions } from '../../../../../platform/browserView/common/browserView.js';
import { paradisRegisterBrowserProfileRouter, paradisResolveBrowserSessionSelector } from '../../common/paradisBrowserProfileRouting.js';

suite('paradisBrowserProfileRouting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const network = { authority: 'ssh-remote+example' };
	const resolved: IBrowserViewSessionOptions = { scope: BrowserViewStorageScope.Workspace, affinity: 'window-1', network };

	function resolveWith(override: IBrowserViewSessionOptions | undefined) {
		const unregister = paradisRegisterBrowserProfileRouter({ resolveSessionOptions: (_viewId, fallback) => override ?? fallback });
		try {
			return paradisResolveBrowserSessionSelector('view', resolved);
		} finally {
			unregister();
		}
	}

	test('a named profile never carries a network; other overrides keep the resolved network and affinity', () => {
		const profile = resolveWith({ scope: BrowserViewStorageScope.Profile, profileId: '0123456789ab' });
		assert.deepStrictEqual({
			profile,
			profileNetwork: typeof profile === 'string' ? 'selector' : getBrowserViewSessionNetwork(profile),
			sameScope: resolveWith({ scope: BrowserViewStorageScope.Workspace }),
			agent: resolveWith({ scope: BrowserViewStorageScope.Agent }),
			global: resolveWith({ scope: BrowserViewStorageScope.Global }),
			none: resolveWith(undefined),
			selector: paradisResolveBrowserSessionSelector('view', 'session-id'),
		}, {
			profile: { scope: BrowserViewStorageScope.Profile, profileId: '0123456789ab' },
			profileNetwork: undefined,
			sameScope: resolved,
			agent: { scope: BrowserViewStorageScope.Agent, affinity: 'window-1', network },
			global: { scope: BrowserViewStorageScope.Global },
			none: resolved,
			selector: 'session-id',
		});
	});
});
