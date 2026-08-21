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
//  - **CORS は `*` にしない。** トークンは `<base href>` としてページに丸ごと渡るので、ページ自身に
//    とって秘密ではない。`*` にすると、トークンを外へ持ち出された後に**別のブラウザのタブ**から
//    `fetch` で中身を読めてしまう（Para Code の外から読める）。読み取りを許すのは webview だけに絞る
//  - パスの各セグメントを個別にデコードしてから `..` と区切り文字を弾き、最後に realpath で
//    載せたフォルダーの中に居ることを確かめる（シンボリックリンクでの抜け出しも塞ぐ）
//  - ディレクトリ一覧は返さない
//  - GET / HEAD 以外は 405

// `http` は読み込みが重いので型だけ静的に取り、実体は最初に listen するときまで待つ
// （このリポジトリの `code-no-http-import` ルールが要求する形）。
import type * as http from 'http';
import { createReadStream, promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { basename, dirname, extname, join, sep } from '../../../../base/common/path.js';
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

/**
 * この Origin からの読み取りを許すか。
 *
 * `<img>` / `<script src>` / `<link>` は `Origin` を送らない（CORS も要らない）ので、ヘッダーが
 * 無いものは許す。付いているのに webview 以外なら、**応答に許可ヘッダーを付けない** — ブラウザ側で
 * 中身の読み取りが落ちる。
 */
function isWebviewOrigin(origin: string | undefined): boolean {
	return origin === undefined || origin.startsWith('vscode-webview://');
}

/** `Host` として受け付ける相手。ポートは問わない（OS 任せで決まるため）。 */
/** ヘッダーは配列で来ることがある。先頭だけを見る。 */
function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

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
	/** トークン → 配信範囲。`onlyFile` があるとそのファイル以外は返さない。 */
	private readonly _rootByToken = new Map<string, { readonly root: string; readonly onlyFile: string | undefined }>();

	/**
	 * フォルダーを載せる。**ファイルのパスを渡すと、そのファイルだけ**を載せる。
	 *
	 * PDF や Word は1ファイルしか要らないのに親フォルダーごと載せていたため、`~/契約書.pdf` を
	 * 一度開くとホーム全体（`~/.ssh` を含む）が配信対象になっていた。1ファイルで済む呼び出しは
	 * ファイルを渡すこと。
	 */
	async mount(directory: string): Promise<IParadisPreviewMount> {
		const resolved = await fs.realpath(directory);
		const asFile = (await fs.stat(resolved)).isFile();
		const root = asFile ? dirname(resolved) : resolved;
		// ファイル単位のときは、同じフォルダーの別ファイルと台帳を分ける。
		const key = asFile ? resolved : root;
		const port = await this._listen();

		let token = this._tokenByRoot.get(key);
		if (token !== undefined) {
			// 使ったものを末尾へ送り、古い順に外せるようにする。
			this._tokenByRoot.delete(key);
		} else {
			token = randomBytes(16).toString('hex');
			this._rootByToken.set(token, { root, onlyFile: asFile ? basename(resolved) : undefined });
		}
		this._tokenByRoot.set(key, token);
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
		if (!isLoopbackHost(firstHeader(request.headers.host))) {
			return this._fail(response, 403);
		}
		if (!isWebviewOrigin(firstHeader(request.headers.origin))) {
			// webview 以外からの読み取りは、許可ヘッダーを出さないだけでなく応答自体を返さない。
			return this._fail(response, 403);
		}

		const pathname = (request.url ?? '/').split('?')[0].split('#')[0];
		const parsed = parseParadisPreviewPath(pathname);
		if (!parsed) {
			return this._fail(response, 404);
		}
		const mounted = this._rootByToken.get(parsed.token);
		if (mounted === undefined) {
			return this._fail(response, 404);
		}
		const root = mounted.root;

		// ファイル単位で載せたトークンは、そのファイル以外を一切返さない。
		if (mounted.onlyFile !== undefined) {
			if (parsed.segments.length !== 1 || parsed.segments[0] !== mounted.onlyFile) {
				return this._fail(response, 404);
			}
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

		const origin = firstHeader(request.headers.origin);
		response.writeHead(200, {
			'Content-Type': CONTENT_TYPES.get(extname(target).toLowerCase()) ?? 'application/octet-stream',
			'Content-Length': String(stat.size),
			// webview からは別オリジンとして見えるので、fetch やモジュール読み込みには許可が要る。
			// **`*` にはしない**（上の説明を参照）。Origin ごとに応答が変わるので `Vary` を添える。
			...(origin !== undefined && isWebviewOrigin(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
			'Vary': 'Origin',
			// トークンは URL の中にある。ページが `<meta name="referrer" content="unsafe-url">` を
			// 書くと、外部への全リクエストに URL ごと載ってしまうので、こちらから止めておく。
			'Referrer-Policy': 'no-referrer',
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
