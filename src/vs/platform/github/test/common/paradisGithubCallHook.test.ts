/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IParadisGithubTransportCall, paradisNotifyGithubTransportCall, paradisSetGithubTransportCallHook } from '../../common/paradisGithubCallHook.js';

suite('paradisGithubCallHook', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes calls to the hook until it is disposed, and a throwing hook does not reach the request', () => {
		const calls: IParadisGithubTransportCall[] = [];
		const hook = paradisSetGithubTransportCallHook(call => calls.push(call));
		paradisNotifyGithubTransportCall({ kind: 'GraphQL', operation: 'pullRequest', durationMs: 5 });
		hook.dispose();
		paradisNotifyGithubTransportCall({ kind: 'REST', operation: 'repos.get', durationMs: 1 });

		const throwing = paradisSetGithubTransportCallHook(() => { throw new Error('boom'); });
		paradisNotifyGithubTransportCall({ kind: 'REST', operation: 'repos.get', durationMs: 1 });
		throwing.dispose();

		assert.deepStrictEqual(calls, [{ kind: 'GraphQL', operation: 'pullRequest', durationMs: 5 }]);
	});
});
