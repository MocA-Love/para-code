/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ParadisJsonStateWriter } from '../../node/paradisJsonStateWriter.js';

suite('ParadisJsonStateWriter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-json-state-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('merges the writes that have not started into the latest one, writes again afterwards, and reports failures', async () => {
		const file = join(root, 'nested', 'state.json');
		const writer = new ParadisJsonStateWriter(file, true);
		const first = writer.write('"a"');
		const second = writer.write('"b"');
		const third = writer.write('"c"');
		await Promise.all([first, second, third]);
		const afterwards = writer.write('"d"');
		await afterwards;
		const failure = await new ParadisJsonStateWriter(join(root, 'missing', 'state.json')).write('{}').then(() => 'written', () => 'rejected');
		assert.deepStrictEqual({
			merged: first === second && second === third,
			separate: afterwards !== third,
			content: await fs.readFile(file, 'utf8'),
			files: await fs.readdir(join(root, 'nested')),
			failure,
		}, {
			merged: true,
			separate: true,
			content: '"d"',
			files: ['state.json'],
			failure: 'rejected',
		});
	});
});
