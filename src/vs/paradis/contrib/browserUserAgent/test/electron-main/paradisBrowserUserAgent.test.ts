/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Session } from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisApplyChromeLikeUserAgent } from '../../electron-main/paradisBrowserUserAgent.js';

suite('ParadisBrowserUserAgent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('removes every Electron product token before applying the session user agent', () => {
		let appliedUserAgent: string | undefined;
		const session = {
			getUserAgent: () => 'Mozilla/5.0 Chrome/128.0 Electron/32.1.2 Safari/537.36 Electron/custom',
			setUserAgent: (userAgent: string) => appliedUserAgent = userAgent,
		} satisfies Pick<Session, 'getUserAgent' | 'setUserAgent'>;

		paradisApplyChromeLikeUserAgent(session as unknown as Session);

		assert.strictEqual(appliedUserAgent, 'Mozilla/5.0 Chrome/128.0 Safari/537.36');
	});
});
