/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML プレビューが読むファイルを、127.0.0.1 だけに開いた HTTP サーバから配る。
//
// なぜサーバなのか:
// これまで HTML プレビューは `<base href>` を webview のリソース URL に向けており、その解決は
// service worker が担っていた。ところが webview の origin に service worker の登録があると、その
// scope へのナビゲーションが worker の起動完了を待たされ、実機では `index.html` / `fake.html` の
// 読み込みが 60 秒止まる（プレビューが白紙になる主因）。service worker を切れば止まらなくなるが、
// 今度は相対パスの読み込みが全部死ぬ。
//
// Markdown は画像を data: に埋め込んで解決したが、HTML では同じ手が使えない。`fetch('./data.json')`、
// 動的 `import()`、JS が組み立てる `src` のように、**実行時に取りに行くもの**を静的には拾えないため。
// そこで素直に HTTP で配る。ブラウザで開いたときと同じ解決になるので、書く側は何も変えなくてよい。
//
// 安全側の作り:
//  - `127.0.0.1` にしか listen しない。ポートは OS 任せ（0 番指定）
//  - 載せたフォルダーごとに 128bit の乱数トークンを発行し、URL の先頭に置く。トークンが合わない
//    リクエストは中身を見ずに 404
//  - `Host` ヘッダーが localhost 以外なら 403（DNS リライトで外から叩かれるのを防ぐ）
//  - パスの各セグメントを個別にデコードしてから `..` と区切り文字を弾き、最後に realpath で
//    載せたフォルダーの中に居ることを確かめる（シンボリックリンクでの抜け出しも塞ぐ）
//  - ディレクトリ一覧は返さない
//  - GET / HEAD 以外は 405

// `http` は読み込みが重いので型だけ静的に取り、実体は最初に listen するときまで待つ
// （このリポジトリの `code-no-http-import` ルールが要求する形）。
import type * as http from 'http';
import { createReadStream, promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { extname, join, sep } from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IParadisHtmlPreviewService, IParadisPreviewMount } from '../common/paradisHtmlPreview.js';

/** 同時に載せておくフォルダーの上限。超えたら古いものから外す。 */
const PARADIS_HTML_PREVIEW_MAX_MOUNTS = 64;

/** 拡張子から Content-Type を引く。分からないものは中身を推測させない。 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
	['.html', 'text/html; charset=utf-8'],
	['.htm', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.mjs', 'text/javascript; charset=utf-8'],
	['.css', 'text/css; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.map', 'application/json; charset=utf-8'],
	['.txt', 'text/plain; charset=utf-8'],
	['.md', 'text/markdown; charset=utf-8'],
	['.csv', 'text/csv; charset=utf-8'],
	['.xml', 'text/xml; charset=utf-8'],
	['.svg', 'image/svg+xml'],
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.gif', 'image/gif'],
	['.webp', 'image/webp'],
	['.avif', 'image/avif'],
	['.bmp', 'image/bmp'],
	['.ico', 'image/x-icon'],
	['.woff', 'font/woff'],
	['.woff2', 'font/woff2'],
	['.ttf', 'font/ttf'],
	['.otf', 'font/otf'],
	['.wasm', 'application/wasm'],
	['.mp4', 'video/mp4'],
	['.webm', 'video/webm'],
	['.mp3', 'audio/mpeg'],
	['.wav', 'audio/wav'],
	['.ogg', 'audio/ogg'],
	['.pdf', 'application/pdf'],
]);

/** `Host` として受け付ける相手。ポートは問わない（OS 任せで決まるため）。 */
function isLoopbackHost(host: string | undefined): boolean {
	if (!host) {
		return false;
	}
	const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

/**
 * URL のパスから、載せたフォルダーの中の相対セグメント列を取り出す。
 *
 * **セグメントに割ってからデコードする。** 先に全体をデコードすると `%2f` が区切りに化けて
 * `..` の判定をすり抜ける。
 */
export function parseParadisPreviewPath(pathname: string): { token: string; segments: string[] } | undefined {
	const raw = pathname.split('/');
	// 先頭は空文字（`/` 始まりのため）。次がトークン。
	if (raw.length < 2 || raw[0] !== '') {
		return undefined;
	}
	const token = raw[1];
	if (!/^[0-9a-f]{32}$/.test(token)) {
		return undefined;
	}
	const segments: string[] = [];
	for (const part of raw.slice(2)) {
		if (part === '') {
			continue;
		}
		let decoded: string;
		try {
			decoded = decodeURIComponent(part);
		} catch {
			return undefined;
		}
		if (decoded === '.') {
			continue;
		}
		if (decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
			return undefined;
		}
		segments.push(decoded);
	}
	return { token, segments };
}

/** HTML プレビュー用のローカル配信サーバ。shared process に1つだけ持つ。 */
export class ParadisHtmlPreviewServer extends Disposable implements IParadisHtmlPreviewService {

	private _listening: Promise<number> | undefined;
	private _server: http.Server | undefined;
	/** 実パス → トークン。同じフォルダーを何度開いてもトークンを増やさない。 */
	private readonly _tokenByRoot = new Map<string, string>();
	/** トークン → 実パス。 */
	private readonly _rootByToken = new Map<string, string>();

	async mount(directory: string): Promise<IParadisPreviewMount> {
		const root = await fs.realpath(directory);
		const port = await this._listen();

		let token = this._tokenByRoot.get(root);
		if (token !== undefined) {
			// 使ったものを末尾へ送り、古い順に外せるようにする。
			this._tokenByRoot.delete(root);
		} else {
			token = randomBytes(16).toString('hex');
			this._rootByToken.set(token, root);
		}
		this._tokenByRoot.set(root, token);
		this._evictOldMounts();

		return { port, token };
	}

	override dispose(): void {
		this._server?.close();
		this._server = undefined;
		this._listening = undefined;
		this._tokenByRoot.clear();
		this._rootByToken.clear();
		super.dispose();
	}

	/** テスト用。listen 済みのポート。 */
	get port(): number | undefined {
		const address = this._server?.address();
		return address && typeof address !== 'string' ? address.port : undefined;
	}

	private _evictOldMounts(): void {
		while (this._tokenByRoot.size > PARADIS_HTML_PREVIEW_MAX_MOUNTS) {
			const oldest = this._tokenByRoot.keys().next();
			if (oldest.done) {
				return;
			}
			const token = this._tokenByRoot.get(oldest.value);
			this._tokenByRoot.delete(oldest.value);
			if (token !== undefined) {
				this._rootByToken.delete(token);
			}
		}
	}

	private _listen(): Promise<number> {
		if (this._listening) {
			return this._listening;
		}
		// 失敗したままだと二度と立ち上がらないので、次の呼び出しでやり直せるようにする。
		const listening = this._doListen().catch(error => {
			if (this._listening === listening) {
				this._listening = undefined;
			}
			throw error;
		});
		this._listening = listening;
		return listening;
	}

	private async _doListen(): Promise<number> {
		const { createServer } = await import('http');
		return new Promise<number>((resolve, reject) => {
			const server = createServer((request, response) => {
				this._handle(request, response).catch(() => this._fail(response, 500));
			});
			server.on('error', reject);
			// ループバックだけに開く。ポートは OS に選ばせる。
			server.listen({ host: '127.0.0.1', port: 0 }, () => {
				const address = server.address();
				if (!address || typeof address === 'string') {
					reject(new Error('Could not determine the HTML preview server port'));
					return;
				}
				this._server = server;
				resolve(address.port);
			});
		});
	}

	private async _handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return this._fail(response, 405);
		}
		if (!isLoopbackHost(request.headers.host)) {
			return this._fail(response, 403);
		}

		const pathname = (request.url ?? '/').split('?')[0].split('#')[0];
		const parsed = parseParadisPreviewPath(pathname);
		if (!parsed) {
			return this._fail(response, 404);
		}
		const root = this._rootByToken.get(parsed.token);
		if (root === undefined) {
			return this._fail(response, 404);
		}

		// フォルダーそのものを引かれたら、ブラウザと同じく index.html を返す。
		const segments = parsed.segments.length > 0 ? parsed.segments : ['index.html'];
		let target: string;
		try {
			// realpath まで通してから、載せたフォルダーの中に居ることを確かめる。
			// シンボリックリンクで外へ出るものはここで落ちる。
			target = await fs.realpath(join(root, ...segments));
		} catch {
			return this._fail(response, 404);
		}
		if (target !== root && !target.startsWith(root + sep)) {
			return this._fail(response, 403);
		}

		const stat = await fs.stat(target);
		if (!stat.isFile()) {
			// 一覧は出さない。
			return this._fail(response, 403);
		}

		response.writeHead(200, {
			'Content-Type': CONTENT_TYPES.get(extname(target).toLowerCase()) ?? 'application/octet-stream',
			'Content-Length': String(stat.size),
			// webview からは別オリジンとして見えるので、fetch やモジュール読み込みのために要る。
			// 中身に辿り着くにはトークンが要るため、ここを緩めても読める範囲は広がらない。
			'Access-Control-Allow-Origin': '*',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		});
		if (request.method === 'HEAD') {
			response.end();
			return;
		}

		await new Promise<void>(resolve => {
			const stream = createReadStream(target);
			stream.on('error', () => {
				response.destroy();
				resolve();
			});
			stream.on('end', () => resolve());
			stream.pipe(response);
		});
	}

	private _fail(response: http.ServerResponse, status: number): void {
		if (response.headersSent) {
			response.destroy();
			return;
		}
		response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end();
	}
}
