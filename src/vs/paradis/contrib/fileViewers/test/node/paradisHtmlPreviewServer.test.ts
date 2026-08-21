/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ok, strictEqual } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisHtmlPreviewServer, parseParadisPreviewPath } from '../../node/paradisHtmlPreviewServer.js';

suite('ParadisHtmlPreviewServer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createRoot(): Promise<string> {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-html-preview-'));
		await fs.writeFile(join(root, 'index.html'), '<h1>hello</h1>', 'utf8');
		await fs.mkdir(join(root, 'assets'));
		await fs.writeFile(join(root, 'assets', 'app.js'), 'export const a = 1;', 'utf8');
		await fs.writeFile(join(root, 'secret.txt'), 'private', 'utf8');
		return root;
	}

	/** 任意のヘッダーを付けて叩く（`Host` や `Origin` は fetch から確実に送れないため）。 */
	async function requestWith(url: string, headers: Record<string, string>): Promise<{ status: number; allowOrigin: string | undefined }> {
		const { request } = await import('http');
		const target = new URL(url);
		return new Promise((resolve, reject) => {
			const call = request(
				{ hostname: target.hostname, port: target.port, path: target.pathname, method: 'GET', headers: { Host: `127.0.0.1:${target.port}`, ...headers } },
				response => {
					response.resume();
					response.on('end', () => resolve({
						status: response.statusCode ?? 0,
						allowOrigin: response.headers['access-control-allow-origin'] as string | undefined,
					}));
				});
			call.on('error', reject);
			call.end();
		});
	}

	/** `Host` は fetch から確実には送れないので、この検査だけ生の http で行う。 */
	async function statusWithHost(url: string, host: string): Promise<number> {
		const { request } = await import('http');
		const target = new URL(url);
		return new Promise<number>((resolve, reject) => {
			const call = request(
				{ hostname: target.hostname, port: target.port, path: target.pathname, method: 'GET', headers: { Host: host } },
				response => {
					response.resume();
					response.on('end', () => resolve(response.statusCode ?? 0));
				});
			call.on('error', reject);
			call.end();
		});
	}

	async function mount(disposables: DisposableStore): Promise<{ base: string; root: string; server: ParadisHtmlPreviewServer }> {
		const server = disposables.add(new ParadisHtmlPreviewServer());
		const root = await createRoot();
		disposables.add({ dispose: () => { void fs.rm(root, { recursive: true, force: true }); } });
		const location = await server.mount(root);
		return { base: `http://127.0.0.1:${location.port}/${location.token}/`, root, server };
	}

	suite('parseParadisPreviewPath', () => {

		const TOKEN = '0123456789abcdef0123456789abcdef';

		test('splits the token from the path', () => {
			strictEqual(parseParadisPreviewPath(`/${TOKEN}/assets/app.js`)?.segments.join('/'), 'assets/app.js');
			strictEqual(parseParadisPreviewPath(`/${TOKEN}/`)?.segments.length, 0);
		});

		test('decodes each segment on its own so escaped separators cannot slip through', () => {
			strictEqual(parseParadisPreviewPath(`/${TOKEN}/my%20file.css`)?.segments.join('/'), 'my file.css');
			strictEqual(parseParadisPreviewPath(`/${TOKEN}/%2e%2e/secret.txt`), undefined);
			strictEqual(parseParadisPreviewPath(`/${TOKEN}/a%2fb`), undefined);
			strictEqual(parseParadisPreviewPath(`/${TOKEN}/..`), undefined);
		});

		test('refuses anything that is not a token', () => {
			strictEqual(parseParadisPreviewPath('/'), undefined);
			strictEqual(parseParadisPreviewPath('/short/index.html'), undefined);
			strictEqual(parseParadisPreviewPath(`/${TOKEN.toUpperCase()}/index.html`), undefined);
		});
	});

	suite('serving', () => {

		test('serves files under the mounted folder', async () => {
			const disposables = store.add(new DisposableStore());
			const { base } = await mount(disposables);

			ok(base.startsWith('http://127.0.0.1:'), base);

			const page = await fetch(`${base}index.html`);
			strictEqual(page.status, 200);
			strictEqual(page.headers.get('content-type'), 'text/html; charset=utf-8');
			// Origin を送らない取得（`<img>` や `<script src>`）には許可ヘッダーを付けない。
			strictEqual(page.headers.get('access-control-allow-origin'), null);
			strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
			strictEqual(await page.text(), '<h1>hello</h1>');

			const script = await fetch(`${base}assets/app.js`);
			strictEqual(script.status, 200);
			strictEqual(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
		});

		test('serves index.html for the folder itself', async () => {
			const disposables = store.add(new DisposableStore());
			const { base } = await mount(disposables);

			strictEqual(await (await fetch(base)).text(), '<h1>hello</h1>');
		});

		test('hands out the same token for the same folder', async () => {
			const disposables = store.add(new DisposableStore());
			const { base, root, server } = await mount(disposables);

			const again = await server.mount(root);
			strictEqual(`http://127.0.0.1:${again.port}/${again.token}/`, base);
		});

		test('refuses an unknown token, a missing file and a folder listing', async () => {
			const disposables = store.add(new DisposableStore());
			const { base, server } = await mount(disposables);

			strictEqual((await fetch(`http://127.0.0.1:${server.port}/ffffffffffffffffffffffffffffffff/index.html`)).status, 404);
			strictEqual((await fetch(`${base}nope.html`)).status, 404);
			// フォルダーは中身の一覧を出さない。
			strictEqual((await fetch(`${base}assets/`)).status, 403);
		});

		test('refuses escaping the mounted folder', async () => {
			const disposables = store.add(new DisposableStore());
			const { base } = await mount(disposables);

			strictEqual((await fetch(`${base}%2e%2e/secret.txt`)).status, 404);
			strictEqual((await fetch(`${base}assets/../../secret.txt`)).status, 404);
		});

		test('refuses a symlink that points outside the mounted folder', async () => {
			const disposables = store.add(new DisposableStore());
			const { base, root } = await mount(disposables);
			const outside = await fs.mkdtemp(join(tmpdir(), 'paradis-html-outside-'));
			disposables.add({ dispose: () => { void fs.rm(outside, { recursive: true, force: true }); } });
			await fs.writeFile(join(outside, 'secret.txt'), 'private', 'utf8');
			await fs.symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));

			strictEqual((await fetch(`${base}escape.txt`)).status, 403);
		});

		test('lets a webview read the response but not another site', async () => {
			// トークンは `<base href>` としてページに渡るので、ページにとって秘密ではない。
			// 持ち出された後に**別のブラウザのタブ**から読めてしまわないよう、読み取りを許すのは
			// webview だけに絞る。
			const disposables = store.add(new DisposableStore());
			const { base } = await mount(disposables);

			const webview = await requestWith(`${base}index.html`, { Origin: 'vscode-webview://abcdef' });
			strictEqual(webview.status, 200);
			strictEqual(webview.allowOrigin, 'vscode-webview://abcdef');

			const site = await requestWith(`${base}index.html`, { Origin: 'https://evil.example' });
			strictEqual(site.status, 403);

			// `<img>` や `<script src>` は Origin を送らない。ここを塞ぐとページが壊れる。
			const subresource = await requestWith(`${base}assets/app.js`, {});
			strictEqual(subresource.status, 200);
			strictEqual(subresource.allowOrigin, undefined);
		});

		test('serves only the one file when a file was mounted', async () => {
			// PDF / Word は1ファイルしか要らない。親フォルダーごと載せると、`~/x.pdf` を開いた
			// だけでホーム全体が配信対象になる。
			const disposables = store.add(new DisposableStore());
			const server = disposables.add(new ParadisHtmlPreviewServer());
			const root = await createRoot();
			disposables.add({ dispose: () => { void fs.rm(root, { recursive: true, force: true }); } });

			const mounted = await server.mount(join(root, 'index.html'));
			const base = `http://127.0.0.1:${mounted.port}/${mounted.token}/`;

			strictEqual((await fetch(`${base}index.html`)).status, 200);
			strictEqual((await fetch(`${base}secret.txt`)).status, 404);
			strictEqual((await fetch(`${base}assets/app.js`)).status, 404);
			strictEqual((await fetch(base)).status, 404);
		});

		test('refuses requests that did not come through loopback', async () => {
			const disposables = store.add(new DisposableStore());
			const { base } = await mount(disposables);

			strictEqual(await statusWithHost(`${base}index.html`, 'evil.example'), 403);
			strictEqual(await statusWithHost(`${base}index.html`, 'localhost:1'), 200);
		});

		test('refuses methods other than GET and HEAD', async () => {
			const disposables = store.add(new DisposableStore());
			const { base } = await mount(disposables);

			strictEqual((await fetch(`${base}index.html`, { method: 'DELETE' })).status, 405);
			const head = await fetch(`${base}index.html`, { method: 'HEAD' });
			strictEqual(head.status, 200);
			strictEqual(head.headers.get('content-length'), '14');
		});

		test('does not listen until something is mounted', async () => {
			const disposables = store.add(new DisposableStore());
			const server = disposables.add(new ParadisHtmlPreviewServer());

			strictEqual(server.port, undefined);
		});
	});
});
