/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileTerminalViewportStatus } from '../../common/paradisMobileTerminalViewportStatus.js';

suite('ParadisMobileTerminalViewportStatus', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('tells which terminal changed, forwards the take-back to the provider and clears its overrides when the provider goes away', () => {
		const status = store.add(new ParadisMobileTerminalViewportStatus());
		const changed: number[] = [];
		const takenBack: number[] = [];
		store.add(status.onDidChange(id => changed.push(id)));
		status.takeBack(1);
		const controller = status.setController({ takeBack: id => takenBack.push(id) });
		status.set(1, { cols: 45, rows: 30 });
		status.set(1, { cols: 45, rows: 30 });
		status.set(2, { cols: 45 });
		status.takeBack(2);
		const before = [status.get(1), status.get(2)];
		controller.dispose();
		assert.deepStrictEqual({ changed, takenBack, before, after: [status.get(1), status.get(2)] }, {
			changed: [1, 2, 1, 2],
			takenBack: [2],
			before: [{ cols: 45, rows: 30 }, { cols: 45 }],
			after: [undefined, undefined],
		});
	});
});
