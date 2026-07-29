/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Extension, Extensions, Session } from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisInstallBrowserExtensions } from '../../electron-main/paradisBrowserExtensions.js';

type BrowserExtensionsSessionFake = Pick<Session, 'isPersistent'> & {
	readonly extensions: Pick<Extensions, 'loadExtension'>;
};

const extensionResult = {
	id: 'react-devtools',
	manifest: {},
	name: 'React Developer Tools',
	path: '/extension',
	url: 'chrome-extension://react-devtools/',
	version: '1.0.0',
} satisfies Extension;

suite('ParadisBrowserExtensions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not attempt to load extensions into an in-memory session', () => {
		let loadCalls = 0;
		const session = {
			isPersistent: () => false,
			extensions: {
				loadExtension: async () => {
					loadCalls++;
					return extensionResult;
				},
			},
		} satisfies BrowserExtensionsSessionFake;

		paradisInstallBrowserExtensions(session as unknown as Session);

		assert.strictEqual(loadCalls, 0);
	});

	test('loads bundled React DevTools with local file access only once per persistent session', () => {
		const loadCalls: Array<{ path: string; options: unknown }> = [];
		const session = {
			isPersistent: () => true,
			extensions: {
				loadExtension: async (extensionPath, options) => {
					loadCalls.push({ path: extensionPath, options });
					return extensionResult;
				},
			},
		} satisfies BrowserExtensionsSessionFake;

		paradisInstallBrowserExtensions(session as unknown as Session);
		paradisInstallBrowserExtensions(session as unknown as Session);

		assert.strictEqual(loadCalls.length, 1);
		assert.strictEqual(
			loadCalls[0].path.replaceAll('\\', '/').endsWith('/vs/paradis/contrib/browserExtensions/electron-main/media/react-devtools'),
			true,
		);
		assert.deepStrictEqual(loadCalls[0].options, { allowFileAccess: true });
	});
});
