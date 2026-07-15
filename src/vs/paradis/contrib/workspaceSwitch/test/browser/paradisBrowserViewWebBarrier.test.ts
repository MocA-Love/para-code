/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WebBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/browser/browserView.contribution.js';

suite('WebBrowserViewWorkbenchService initialization', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('has an already resolved initialization barrier', async () => {
		const service = new WebBrowserViewWorkbenchService();
		assert.strictEqual(await service.whenInitialized, true);
	});
});
