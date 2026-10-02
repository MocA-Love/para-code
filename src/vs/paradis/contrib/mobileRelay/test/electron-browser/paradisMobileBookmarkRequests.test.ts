/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ParadisBookmarkNode } from '../../../browserBookmarks/common/paradisBookmarkModel.js';
import { IParadisBookmarksService } from '../../../browserBookmarks/electron-browser/paradisBookmarksService.js';
import { PARADIS_MOBILE_BOOKMARK_FAVICON_MAX, PARADIS_MOBILE_BOOKMARKS_MAX_DEPTH, paradisParseMobileBookmarks } from '../../common/paradisMobileBrowserProtocol.js';
import { paradisMobileBookmarksPayload } from '../../common/paradisMobileBookmarks.js';
import '../../electron-browser/paradisMobileBookmarkRequests.js';
import { paradisCollectMobileBrowserScopes } from '../../electron-browser/paradisMobileBrowserScopeSync.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

function bookmark(id: string, url: string, faviconHash?: string): ParadisBookmarkNode {
	return { id, type: 'bookmark', url, title: id, createdAt: 0, ...(faviconHash !== undefined ? { faviconHash } : {}) };
}

suite('ParadisMobileBookmarkRequests', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('ブックマークの木をモバイルの形にする（favicon は上限内のものだけ、深すぎるものは落とす）', () => {
		let deep: ParadisBookmarkNode = bookmark('deepest', 'https://deep.example/');
		for (let depth = 0; depth < PARADIS_MOBILE_BOOKMARKS_MAX_DEPTH + 1; depth++) {
			deep = { id: `f${depth}`, type: 'folder', title: `f${depth}`, children: [deep], createdAt: 0 };
		}
		const favicons: Record<string, string> = {
			small: 'data:image/png;base64,AAAA',
			big: `data:image/png;base64,${'A'.repeat(PARADIS_MOBILE_BOOKMARK_FAVICON_MAX)}`,
			notImage: 'https://example.com/favicon.ico',
		};
		const payload = paradisMobileBookmarksPayload([
			{ id: 'work', type: 'folder', title: '仕事', icon: 'briefcase', color: '#2563eb', children: [bookmark('a', 'https://a.example/', 'small'), bookmark('b', 'https://b.example/', 'big')], createdAt: 0 },
			bookmark('c', 'https://c.example/', 'notImage'),
			bookmark('empty', ''),
			deep,
		], hash => favicons[hash]);
		let depth = 0;
		for (let node = payload.nodes[2]; node?.type === 'folder'; node = node.children[0]) {
			depth++;
		}
		assert.deepStrictEqual({
			head: payload.nodes.slice(0, 2),
			favicons: payload.favicons,
			folderDepth: depth,
			parsed: paradisParseMobileBookmarks(payload)?.nodes.slice(0, 2),
		}, {
			head: [
				{ type: 'folder', id: 'work', title: '仕事', icon: 'briefcase', color: '#2563eb', children: [{ type: 'bookmark', id: 'a', title: 'a', url: 'https://a.example/', favicon: 'small' }, { type: 'bookmark', id: 'b', title: 'b', url: 'https://b.example/' }] },
				{ type: 'bookmark', id: 'c', title: 'c', url: 'https://c.example/' },
			],
			favicons: { small: 'data:image/png;base64,AAAA' },
			folderDepth: PARADIS_MOBILE_BOOKMARKS_MAX_DEPTH,
			parsed: payload.nodes.slice(0, 2),
		});
	});

	test('fs の bookmarks に答え、変わったら購読したモバイルに知らせる', async () => {
		const changed = store.add(new Emitter<void>());
		const service = { nodes: [bookmark('a', 'https://a.example/')], getFavicon: () => undefined, onDidChange: changed.event } as unknown as IParadisBookmarksService;
		const sent: string[] = [];
		const host: IParadisMobileRequestHost = {
			invokeFunction: fn => fn({ get: (id: unknown) => { assert.strictEqual(id, IParadisBookmarksService); return service; } } as unknown as ServicesAccessor),
			resolveRoot: () => URI.file('/repo'),
			runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
			resolvePath: async () => undefined,
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, mobileId, payload) => sent.push(`${mobileId}:${new TextDecoder().decode(payload)}`),
		};
		paradisDispatchMobileRequest('fs', { t: 'bookmarks', id: 'r1' }, 'phone', host);
		changed.fire();
		assert.deepStrictEqual(sent, [
			'phone:{"t":"bookmarks","nodes":[{"type":"bookmark","id":"a","title":"a","url":"https://a.example/"}],"favicons":{},"id":"r1"}',
			'phone:{"t":"bookmarksChanged"}',
		]);
	});

	test('スペースの台帳を集める（pending は stateKey 無し）', () => {
		const scopes: Record<string, { kind: string; stateKey?: string }> = { v1: { kind: 'managed', stateKey: 'repo' }, v2: { kind: 'pending' }, v3: { kind: 'unscoped' } };
		assert.deepStrictEqual(paradisCollectMobileBrowserScopes(['v1', 'v2', 'v3'], viewId => scopes[viewId], true), {
			managed: true,
			views: [{ viewId: 'v1', stateKey: 'repo' }, { viewId: 'v2' }, { viewId: 'v3' }],
		});
	});
});
