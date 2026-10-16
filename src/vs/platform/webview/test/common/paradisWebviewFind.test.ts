/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { paradisFindWebviewFrame } from '../../common/paradisWebviewFind.js';

suite('paradisFindWebviewFrame', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('looks a missing frame up once more, and gives up after that', () => runWithFakedTimers({}, async () => {
		const lookups = (answers: (string | undefined)[]) => {
			let calls = 0;
			return { lookup: () => answers[calls++], calls: () => calls };
		};
		const present = lookups(['frame']);
		const late = lookups([undefined, 'frame']);
		const missing = lookups([undefined, undefined, 'never asked']);
		assert.deepStrictEqual({
			present: [await paradisFindWebviewFrame(present.lookup), present.calls()],
			late: [await paradisFindWebviewFrame(late.lookup), late.calls()],
			missing: [await paradisFindWebviewFrame(missing.lookup), missing.calls()],
		}, {
			present: ['frame', 1],
			late: ['frame', 2],
			missing: [undefined, 2],
		});
	}));
});
