/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisDocCommentsChange } from '../../common/paradisDocComments.js';
import { IParadisDocCommentsStorage, ParadisDocCommentsStore, paradisDocCommentSidecarName } from '../../node/paradisDocCommentsStore.js';
import { ParadisDocCommentsChannel } from '../../node/paradisDocComments.sharedProcess.js';

class MemoryStorage implements IParadisDocCommentsStorage {
	readonly files = new Map<string, string>();
	writes = 0;
	async read(name: string): Promise<string | undefined> {
		return this.files.get(name);
	}
	async write(name: string, text: string): Promise<void> {
		this.writes++;
		await Promise.resolve();
		this.files.set(name, text);
	}
}

suite('Paradis doc comments: store', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create(storage = new MemoryStorage()) {
		let id = 0;
		const store = disposables.add(new ParadisDocCommentsStore(storage, error => { throw error; }, () => 100, () => `c-00000000000${++id}`));
		const changes: IParadisDocCommentsChange[] = [];
		disposables.add(store.onDidChange(change => changes.push(change)));
		return { store, storage, changes };
	}

	test('names the sidecar by the SHA-256 of the ledger key and keeps both of two comments added at once', async () => {
		const { store, storage, changes } = create();
		const [first, second] = await Promise.all([
			store.add('', '/w/a.md', { anchor: { quote: 'A' }, text: '1' }),
			store.add('', '/w/a.md', { anchor: { quote: 'B' }, text: '2' }),
		]);
		const sidecar = await store.get('', '/w/a.md');
		assert.deepStrictEqual({
			name: paradisDocCommentSidecarName('', '/w/a.md'),
			remoteName: paradisDocCommentSidecarName('ssh-remote-box', '/w/a.md') === paradisDocCommentSidecarName('', '/w/a.md'),
			ids: [first?.id, second?.id],
			threads: sidecar.threads.map(thread => ({ id: thread.id, quote: thread.anchor.quote, state: thread.state, messages: thread.messages })),
			files: [...storage.files.keys()],
			changes,
		}, {
			name: `${createHash('sha256').update('local:/w/a.md').digest('hex')}.json`,
			remoteName: false,
			ids: ['c-000000000001', 'c-000000000002'],
			threads: [
				{ id: 'c-000000000001', quote: 'A', state: 'queued', messages: [{ by: 'user', text: '1', at: 100 }] },
				{ id: 'c-000000000002', quote: 'B', state: 'queued', messages: [{ by: 'user', text: '2', at: 100 }] },
			],
			files: [paradisDocCommentSidecarName('', '/w/a.md')],
			changes: [{ hostId: '', path: '/w/a.md' }, { hostId: '', path: '/w/a.md' }],
		});
	});

	test('writes the places only when one of them changed', async () => {
		const { store, storage } = create();
		const thread = await store.add('', '/w/a.md', { anchor: { quote: 'A' }, text: '1' });
		await store.setPlaces('', '/w/a.md', new Map([[thread!.id, 'changed']]));
		await store.setPlaces('', '/w/a.md', new Map([[thread!.id, 'changed']]));
		await store.setPlaces('', '/w/a.md', new Map([['c-ffffffffffff', 'lost']]));
		assert.deepStrictEqual({ writes: storage.writes, place: (await store.get('', '/w/a.md')).threads[0].anchor.place }, { writes: 2, place: 'changed' });
	});

	test('the channel checks the arguments of the window again', async () => {
		const { store, storage } = create();
		const channel = new ParadisDocCommentsChannel(store);
		const rejected = async (args: unknown[]) => {
			try {
				await channel.call(undefined, 'add', args);
				return false;
			} catch {
				return true;
			}
		};
		assert.deepStrictEqual({
			notADocument: await rejected(['', '/w/a.txt', { anchor: { quote: 'A' }, text: '1' }]),
			relative: await rejected(['', 'a.md', { anchor: { quote: 'A' }, text: '1' }]),
			emptyText: await rejected(['', '/w/a.md', { anchor: { quote: 'A' }, text: ' ' }]),
			writes: storage.writes,
		}, { notADocument: true, relative: true, emptyText: true, writes: 0 });
	});
});
