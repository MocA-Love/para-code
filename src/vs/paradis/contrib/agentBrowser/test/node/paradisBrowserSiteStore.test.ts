/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisBrowserSiteStore } from '../../node/paradisBrowserSiteStore.js';

suite('ParadisBrowserSiteStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-site-store-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('sees what another Para Code wrote to the same file and keeps both', async () => {
		const file = join(root, 'store', 'notes.json');
		const stable = new ParadisBrowserSiteStore<string>(file, 'notes');
		const beta = new ParadisBrowserSiteStore<string>(file, 'notes');
		await stable.update('space', 'https://a.example', () => ({ value: undefined, items: ['from stable'] }));
		const firstRead = await stable.list('space', 'https://a.example');
		await beta.update('space', 'https://b.example', () => ({ value: undefined, items: ['from beta'] }));
		await stable.update('space', 'https://a.example', items => ({ value: undefined, items: [...items, 'again'] }));
		assert.deepStrictEqual({
			firstRead,
			a: await beta.list('space', 'https://a.example'),
			b: await stable.list('space', 'https://b.example'),
			file: JSON.parse(await fs.readFile(file, 'utf8')),
		}, {
			firstRead: ['from stable'],
			a: ['from stable', 'again'],
			b: ['from beta'],
			file: { version: 1, notes: { 'space\nhttps://b.example': ['from beta'], 'space\nhttps://a.example': ['from stable', 'again'] } },
		});
	});

	test('does not overwrite a file it could not read with only the new entry', async () => {
		const file = join(root, 'notes.json');
		// 読めない（ここでは JSON として壊れている）ファイル。空とみなして書き戻すと、中身を全部失う。
		await fs.writeFile(file, '{"version":1,"notes":{"space\\nhttps://a.example":["kept"]');
		const store = new ParadisBrowserSiteStore<string>(file, 'notes');
		await assert.rejects(store.update('space', 'https://b.example', () => ({ value: undefined, items: ['new'] })));
		assert.deepStrictEqual({
			list: await store.list('space', 'https://a.example'),
			file: await fs.readFile(file, 'utf8'),
		}, {
			list: [],
			file: '{"version":1,"notes":{"space\\nhttps://a.example":["kept"]',
		});
	});
});
