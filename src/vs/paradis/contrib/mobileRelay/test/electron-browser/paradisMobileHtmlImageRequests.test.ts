/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer, encodeBase64 } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS } from '../../common/paradisMobileHtmlImages.js';
import '../../electron-browser/paradisMobileHtmlImageRequests.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

/** 見出しだけが本物の PNG を `data:` の文字列にする。 */
function pngDataUrl(width: number, height: number): string {
	const png = new Uint8Array(PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS);
	png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(png.buffer).setUint32(16, width);
	new DataView(png.buffer).setUint32(20, height);
	return `data:image/png;base64,${encodeBase64(VSBuffer.wrap(png))}`;
}

async function tokenOf(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest).subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

suite('ParadisMobileHtmlImageRequests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rereads a document once for images asked at the same time after the cache was dropped, and reports a changed document as stale', async () => {
		const first = pngDataUrl(800, 600);
		const second = pngDataUrl(640, 480);
		// 控えに無い文書（このテストだけの中身）。PC を開き直した後の取り寄せと同じ状態
		const html = `<h1>架空のお知らせ ${Date.now()}</h1><img src="${first}"><p>本文</p><img src="${second}">`;
		const token = await tokenOf(html);
		const reads: string[] = [];
		const services = new Map<unknown, unknown>([
			[IFileService, {
				stat: async () => ({ isDirectory: false, size: html.length }),
				readFile: async (uri: URI) => {
					reads.push(uri.path);
					return { value: VSBuffer.fromString(html) };
				},
			}],
		]);
		const sent: Uint8Array[] = [];
		const host: IParadisMobileRequestHost = {
			invokeFunction: fn => fn({ get: id => services.get(id) ?? {} } as ServicesAccessor),
			resolveRoot: () => URI.file('/space'),
			runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
			resolvePath: async (_ws, relativePath) => URI.file(`/space/${relativePath}`),
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, _mobileId, payload) => sent.push(payload),
		};
		const ask = (id: string, index: number, askedToken = token) => paradisDispatchMobileRequest('fs', { t: 'htmlImage', id, ws: 'space', path: 'notice.html', token: askedToken, index }, 'phone', host);
		ask('a', 0);
		ask('b', 1);
		ask('c', 2);
		ask('d', 0, 'f'.repeat(32));
		for (let turn = 0; turn < 50 && sent.length < 4; turn++) {
			await new Promise<void>(resolve => setTimeout(resolve, 5));
		}
		const replies = sent.map(payload => JSON.parse(new TextDecoder().decode(payload)) as { id: string; t?: string; data?: string; code?: string });
		assert.deepStrictEqual({
			reads,
			replies: replies.map(reply => ({ id: reply.id, data: reply.data === first ? 'first' : reply.data === second ? 'second' : undefined, code: reply.code })).sort((a, b) => a.id.localeCompare(b.id)),
		}, {
			// 同じ token の a・b・c は 1 回の読み直しを分け合う。d は別の token なので読み直し、中身が違うので stale
			reads: ['/space/notice.html', '/space/notice.html'],
			replies: [
				{ id: 'a', data: 'first', code: undefined },
				{ id: 'b', data: 'second', code: undefined },
				{ id: 'c', data: undefined, code: 'missing' },
				{ id: 'd', data: undefined, code: 'stale' },
			],
		});
	});
});
