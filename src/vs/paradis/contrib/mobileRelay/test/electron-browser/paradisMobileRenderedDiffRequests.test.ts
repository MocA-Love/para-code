/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisGitResult } from '../../common/paradisMobileRelay.js';
import { renderParadisMobileRenderedDiffHtml } from '../../electron-browser/paradisMobileRenderedDiffHtml.js';
import { replaceOutsideImages } from '../../electron-browser/paradisMobileRenderedDiffRequests.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

const ROOT = URI.file('/repo');

suite('ParadisMobileRenderedDiffRequests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 変更前（インデックス）と変更後（作業ツリー）の中身を返すホスト。 */
	function createHost(files: { readonly index: string; readonly worktree: string; readonly others?: Readonly<Record<string, string>> }, add: (payload: Uint8Array) => void): IParadisMobileRequestHost {
		const other = (uri: URI) => {
			const value = files.others?.[uri.path];
			if (value === undefined) {
				throw new Error(`missing ${uri.toString()}`);
			}
			return VSBuffer.fromString(value);
		};
		const services = new Map<unknown, unknown>([
			[IRemoteAgentService, { getConnection: () => null }],
			[IFileService, {
				readFileStream: async (uri: URI) => ({ value: bufferToStream(uri.scheme === 'git' ? VSBuffer.fromString(files.index) : /\/docs\/a\.\w+$/.test(uri.path) ? VSBuffer.fromString(files.worktree) : other(uri)) }),
				stat: async (uri: URI) => ({ size: other(uri).byteLength, mtime: 1 }),
				readFile: async (uri: URI) => { const value = other(uri); return { value, size: value.byteLength, mtime: 1 }; },
			}],
		]);
		return {
			invokeFunction: fn => fn({ get: id => services.get(id) ?? {} } as ServicesAccessor),
			resolveRoot: ws => ws === 'repo' ? ROOT : undefined,
			runGit: async (_root, args): Promise<IParadisGitResult> => ({ code: /^:\.\/docs\/a\.(?:md|html)$/.test(args[args.length - 1]) ? 0 : 1, stdout: '', stderr: '' }),
			resolvePath: async (_ws, relativePath) => relativePath.length === 0 ? ROOT : URI.file(`/repo/${relativePath}`),
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, _mobileId, payload) => add(payload),
		};
	}

	/** 応答の受け口。`count` 件そろったら `done` が解ける。 */
	function inbox(count: number): { readonly sent: Uint8Array[]; readonly done: Promise<void>; add(payload: Uint8Array): void } {
		const sent: Uint8Array[] = [];
		const ready = new DeferredPromise<void>();
		return {
			sent,
			done: ready.p,
			add: payload => {
				if (sent.push(payload) >= count) {
					ready.complete();
				}
			},
		};
	}

	function replies(sent: readonly Uint8Array[]): Record<string, unknown>[] {
		return sent.map(payload => JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
	}

	test('makes the one-column rendered diff of a Markdown file from the two sides, without scripts', async () => {
		const { sent, done, add } = inbox(1);
		const host = createHost({ index: '# Title\n\nThe old text.\n', worktree: '# Title\n\nThe new text.\n\nAdded paragraph.\n' }, add);
		paradisDispatchMobileRequest('scm', { t: 'renderedDiff', id: 'one', ws: 'repo', path: 'docs/a.md', original: 'index', modified: 'worktree' }, 'phone', host);
		await done;
		const [reply] = replies(sent);
		const html = String(reply.html);
		assert.deepStrictEqual({
			t: reply.t,
			changes: reply.changes,
			unified: html.includes('paradis-rdiff paradis-rdiff-unified'),
			removed: /<del class="paradis-rdiff-w">old<\/del>/.test(html),
			inserted: /<ins class="paradis-rdiff-w">new<\/ins>/.test(html),
			added: html.includes('paradis-rdiff-b paradis-rdiff-added'),
			scripts: html.includes('<script'),
		}, { t: 'renderedDiff', changes: 2, unified: true, removed: true, inserted: true, added: true, scripts: false });
	});

	test('makes the one-column rendered diff of an HTML file with scripts removed and the working-tree CSS and images embedded', async () => {
		const { sent, done, add } = inbox(1);
		const page = (body: string) => `<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="../../outside.css"><link rel="stylesheet" href="https://example.com/a.css"><script>alert(1)</script></head><body>${body}</body></html>`;
		const host = createHost({
			index: page('<h1>Title</h1><p>The old text.</p><img src="./a.png" alt="figure">'),
			worktree: page('<h1>Title</h1><p onclick="alert(2)">The new text.</p><img src="./a.png" alt="figure"><img src="file:///etc/passwd" alt="root"><img src="https://example.com/b.png" alt="remote">'),
			others: { '/repo/docs/style.css': 'p { color: rebeccapurple; }', '/repo/docs/a.png': 'PNG' },
		}, add);
		paradisDispatchMobileRequest('scm', { t: 'renderedDiff', id: 'html', ws: 'repo', path: 'docs/a.html', original: 'index', modified: 'worktree' }, 'phone', host);
		await done;
		const [reply] = replies(sent);
		const html = String(reply.html);
		assert.deepStrictEqual({
			t: reply.t,
			changes: reply.changes,
			removed: /<del class="paradis-rdiff-w">old<\/del>/.test(html),
			inserted: /<ins class="paradis-rdiff-w">new<\/ins>/.test(html),
			csp: /script-src 'none'/.test(html) && /img-src data:;/.test(html) && /style-src 'unsafe-inline'/.test(html),
			css: html.includes('<style>p { color: rebeccapurple; }</style>'),
			image: html.includes('src="data:image/png;base64,'),
			outside: [html.includes('<script'), html.includes('onclick'), html.includes('<link'), html.includes('example.com'), html.includes('passwd'), html.includes('<base')],
			alt: [html.includes('>root</span>'), html.includes('>remote</span>')],
			notes: [html.includes('スクリプトは止めています'), html.includes('変更前の CSS・画像は今の作業ツリーのものです')],
		}, {
			t: 'renderedDiff', changes: 3, removed: true, inserted: true, csp: true, css: true, image: true,
			outside: [false, false, false, false, false, false], alt: [true, true], notes: [true, true],
		});
	});

	test('refuses other file types, both sides missing, and paths that leave the space', async () => {
		const { sent, done, add } = inbox(4);
		const host = createHost({ index: '', worktree: '' }, add);
		const dispatch = (id: string, path: string, original: string, modified: string) => paradisDispatchMobileRequest('scm', { t: 'renderedDiff', id, ws: 'repo', path, original, modified }, 'phone', host);
		dispatch('text', 'docs/a.txt', 'index', 'worktree');
		dispatch('none', 'docs/a.md', 'missing', 'missing');
		dispatch('escape', '../a.md', 'index', 'worktree');
		dispatch('side', 'docs/a.md', 'worktree', 'worktree');
		await done;
		assert.deepStrictEqual(replies(sent).map(reply => [reply.id, reply.error]), [
			['text', 'unsupported file type'],
			['none', 'invalid renderedDiff request'],
			['escape', 'invalid path'],
			['side', 'invalid renderedDiff request'],
		]);
	});

	test('replaces images that are not embedded with their alt text', () => {
		const root = mainWindow.document.createElement('div');
		root.innerHTML = '<p><img src="data:image/png;base64,AA==" alt="kept"><img src="https://example.com/a.png" alt="outside"><img src="./big.png"></p>';
		replaceOutsideImages(root);
		assert.strictEqual(root.innerHTML, '<p><img src="data:image/png;base64,AA==" alt="kept"><span class="paradis-mobile-rdiff-ext-img">outside</span></p>');
	});

	test('builds a document that blocks scripts and outside loads, and escapes the note', () => {
		const html = renderParadisMobileRenderedDiffHtml('<div class="paradis-rdiff paradis-rdiff-unified"></div>', '<b>note</b>', 'n0nce');
		assert.deepStrictEqual({
			csp: /script-src 'none'; connect-src 'none'/.test(html) && /img-src data:;/.test(html),
			viewport: html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'),
			note: html.includes('<p class="paradis-mobile-rdiff-note">&lt;b&gt;note&lt;/b&gt;</p>'),
			scripts: html.includes('<script'),
		}, { csp: true, viewport: true, note: true, scripts: false });
	});
});
