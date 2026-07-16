/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisResolveLocalAgentPaneCwd } from '../../electron-browser/paradisMobileWorkspaceProvider.js';

suite('ParadisMobileWorkspaceProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses shell-integration cwd when available', async () => {
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: undefined,
			getCwdResource: async () => URI.file('/workspace/detected'),
			getSpeculativeCwd: async () => '/workspace/speculative',
		}), URI.file('/workspace/detected').fsPath);
	});

	test('falls back to speculative cwd for a local terminal without shell integration', async () => {
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: undefined,
			getCwdResource: async () => undefined,
			getSpeculativeCwd: async () => '/workspace/naive',
		}), '/workspace/naive');
	});

	test('does not report a local path for a remote terminal', async () => {
		let speculativeCalls = 0;
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: 'ssh-remote+host',
			getCwdResource: async () => undefined,
			getSpeculativeCwd: async () => { speculativeCalls++; return '/remote/workspace'; },
		}), undefined);
		assert.strictEqual(speculativeCalls, 0);
	});
});
