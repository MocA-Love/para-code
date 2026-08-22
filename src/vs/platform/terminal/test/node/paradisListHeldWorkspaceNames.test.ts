/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PtyService } from '../../node/ptyService.js';

/**
 * `paradisListHeldWorkspaceNames` is the lightweight counterpart of `paradisListHeldTerminals`
 * used by the pty daemon's pollers (status display, idle check). Both walk `_ptys` and filter on
 * `shouldPersistTerminal`; this covers that this method keeps the same enumeration condition and
 * order without paying for `_buildProcessDetails` (getCwd/orphan barrier per terminal).
 */
suite('PtyService#paradisListHeldWorkspaceNames', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function withPtys(entries: readonly (readonly [number, { shouldPersistTerminal: boolean; workspaceName: string }])[]): PtyService {
		const service = Object.create(PtyService.prototype) as PtyService;
		(service as unknown as { _ptys: Map<number, { shouldPersistTerminal: boolean; workspaceName: string }> })._ptys = new Map(entries);
		return service;
	}

	test('returns only entries marked to persist', async () => {
		const service = withPtys([
			[1, { shouldPersistTerminal: true, workspaceName: 'kept' }],
			[2, { shouldPersistTerminal: false, workspaceName: 'dropped' }],
		]);

		deepStrictEqual(await service.paradisListHeldWorkspaceNames(), [{ workspaceName: 'kept' }]);
	});

	test('preserves insertion order across several held terminals', async () => {
		const service = withPtys([
			[1, { shouldPersistTerminal: true, workspaceName: 'first' }],
			[2, { shouldPersistTerminal: true, workspaceName: 'second' }],
			[3, { shouldPersistTerminal: true, workspaceName: 'third' }],
		]);

		deepStrictEqual(await service.paradisListHeldWorkspaceNames(), [
			{ workspaceName: 'first' },
			{ workspaceName: 'second' },
			{ workspaceName: 'third' },
		]);
	});

	test('returns an empty list when nothing is held', async () => {
		const service = withPtys([]);

		deepStrictEqual(await service.paradisListHeldWorkspaceNames(), []);
	});
});
