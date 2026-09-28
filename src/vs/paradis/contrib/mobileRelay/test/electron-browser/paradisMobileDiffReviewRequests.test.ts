/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { InMemoryStorageService, IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { PARADIS_MOBILE_REVIEW_STORAGE_KEY } from '../../common/paradisMobileReviewStore.js';
import '../../electron-browser/paradisMobileDiffReviewRequests.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

suite('ParadisMobileDiffReviewRequests', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHost(storage: IStorageService, sent: unknown[], status: string): IParadisMobileRequestHost {
		return {
			invokeFunction: fn => fn({ get: id => { assert.strictEqual(id, IStorageService); return storage; } } as ServicesAccessor),
			resolveRoot: ws => ws === 'repo' ? URI.file('/repo') : undefined,
			runGit: async (_root, args) => ({ code: 0, stdout: args[0] === 'status' ? status : '', stderr: '' }),
			resolvePath: async () => undefined,
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, _mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
		};
	}

	const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

	test('marks files one at a time, keeps them in the workspace storage and drops committed ones on read', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: unknown[] = [];
		const host = createHost(storage, sent, ' M a.ts\n M b.ts\n');
		paradisDispatchMobileRequest('scm', { t: 'reviewSet', id: '1', ws: 'repo', marks: [{ path: 'a.ts', identity: '00aa' }, { path: 'gone.ts', identity: '00bb' }] }, 'phone', host);
		paradisDispatchMobileRequest('scm', { t: 'reviewSet', id: '2', ws: 'repo', marks: [{ path: 'b.ts', identity: '00cc' }] }, 'ipad', host);
		paradisDispatchMobileRequest('scm', { t: 'reviewGet', id: '3', ws: 'repo' }, 'ipad', host);
		await flush();

		const marks = (reply: unknown) => Object.keys((reply as { marks: Record<string, unknown> }).marks);
		assert.deepStrictEqual({
			afterPhone: marks(sent[0]),
			afterIpad: marks(sent[1]),
			read: marks(sent[2]),
			stored: Object.keys(JSON.parse(storage.get(PARADIS_MOBILE_REVIEW_STORAGE_KEY, StorageScope.WORKSPACE)!).repo.marks),
		}, {
			afterPhone: ['a.ts', 'gone.ts'],
			afterIpad: ['a.ts', 'gone.ts', 'b.ts'],
			read: ['a.ts', 'b.ts'],
			stored: ['a.ts', 'b.ts'],
		});
	});

	test('removes a mark with a null identity and rejects malformed requests and unknown spaces', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: unknown[] = [];
		const host = createHost(storage, sent, ' M a.ts\n');
		paradisDispatchMobileRequest('scm', { t: 'reviewSet', id: '1', ws: 'repo', marks: [{ path: 'a.ts', identity: '00aa' }] }, 'phone', host);
		paradisDispatchMobileRequest('scm', { t: 'reviewSet', id: '2', ws: 'repo', marks: [{ path: 'a.ts', identity: null }] }, 'phone', host);
		paradisDispatchMobileRequest('scm', { t: 'reviewSet', id: '3', ws: 'repo', marks: [{ path: '/etc/passwd', identity: '00aa' }] }, 'phone', host);
		paradisDispatchMobileRequest('scm', { t: 'reviewSet', id: '4', ws: 'repo', marks: [{ path: 'a.ts', identity: 'NOT HEX' }] }, 'phone', host);
		paradisDispatchMobileRequest('scm', { t: 'reviewGet', id: '5', ws: 'elsewhere' }, 'phone', host);
		await flush();

		assert.deepStrictEqual(sent.slice(1), [
			{ t: 'review', ws: 'repo', marks: {}, id: '2' },
			{ error: 'invalid marks', id: '3' },
			{ error: 'invalid marks', id: '4' },
			{ error: 'unknown workspace: elsewhere', id: '5' },
		]);
	});
});
