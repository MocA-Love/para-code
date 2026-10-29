/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-webstore-download.ts, src/main/browser/extensions/browser-extension-archive.ts, src/main/host/electron-manual-redirect-fetch.ts
// The CRX download URL shape follows electron-chrome-web-store (MIT, Samuel Maddock), as Orca does.

// Chrome ウェブストアから CRX を落とし（P7）、署名を確かめてから展開する。
//
//  - 外と話すのは、利用者が管理画面でストアから追加を押したときだけ（ページを開いただけ・状態を聞かれただけでは話さない）
//  - 落とすのは https の Google の host だけ。リダイレクトは 1 回ずつ受け、そのたびに行き先の host を確かめる
//  - タブのセッションは使わない（拡張機能やエージェントの影響を受けない、cookie を持たないメモリだけのセッション）
//  - 署名を確かめる前の中身はディスクに書かない。展開では、フォルダの外へ出る名前・シンボリックリンク・大きすぎるものを断る

import * as electron from 'electron';
import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from '../../../../base/common/path.js';
import type { IParadisExtensionAccess } from '../common/paradisBrowserExtensionWebStore.js';
import { paradisVerifyCrx3, type IParadisVerifiedCrx } from './paradisBrowserExtensionCrx.js';

/** 落とす CRX の大きさの上限。 */
const MAX_CRX_BYTES = 256 * 1024 * 1024;
/** 展開した中身の上限（ファイル数・合計の大きさ）。写すときの上限（PARADIS_MAX_EXTENSION_*）より先に、解凍の前に断る。 */
const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 落とし終えるまでの期限（止まった通信で、入れている途中の印と管理画面の表示が残り続けないように）。 */
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const CRX_HOST_SUFFIXES = ['google.com', 'googleusercontent.com', 'googleapis.com', 'gvt1.com'];

/** ストアから入れる前の確認（main のダイアログ）に出すもの。 */
export interface IParadisInstallPrompt {
	readonly extensionName: string;
	readonly version: string;
	/** 落として確かめた中身の manifest から読んだ、拡張機能ができること。 */
	readonly access: IParadisExtensionAccess;
	/** 有効にする場所の名前（管理画面の選択肢の文字。画面に出すだけ）。 */
	readonly profileLabel: string;
}

/** 1 回の応答（リダイレクトはたどらずに返す）。 */
export interface IParadisWebStoreResponse {
	readonly status: number;
	/** リダイレクトの行き先。 */
	readonly location?: string;
	/** 本文を読む（`maxBytes` を超えたら読むのをやめて投げる）。 */
	read(maxBytes: number): Promise<Buffer>;
	/** 本文を読まずに閉じる。 */
	cancel(): void;
}

/** 外への GET（テストでは偽物）。 */
export type ParadisWebStoreFetcher = (url: string) => Promise<IParadisWebStoreResponse>;

function isHttpsUrlOnHosts(rawUrl: string, suffixes: readonly string[]): boolean {
	try {
		const url = new URL(rawUrl);
		return url.protocol === 'https:' && !url.username && !url.password && !url.port && suffixes.some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
	} catch {
		return false;
	}
}

/** CRX を落としてよい場所か（https の Google の host）。 */
export function paradisIsAllowedCrxUrl(rawUrl: string): boolean {
	return isHttpsUrlOnHosts(rawUrl, CRX_HOST_SUFFIXES);
}

/** ストアの CRX の場所（electron-chrome-web-store と同じ形）。 */
export function paradisWebStoreCrxUrl(extensionId: string, chromeVersion: string = process.versions.chrome ?? '0'): string {
	const url = new URL('https://clients2.google.com/service/update2/crx');
	url.searchParams.set('response', 'redirect');
	url.searchParams.set('acceptformat', 'crx3');
	url.searchParams.set('prodversion', chromeVersion);
	url.searchParams.set('x', new URLSearchParams({ id: extensionId, installsource: 'ondemand', uc: '' }).toString());
	return url.toString();
}

/**
 * ストアから CRX を落として確かめる（ストアの署名が要る）。`publisherKeyHash` はテストで差し替える。
 */
export async function paradisDownloadWebStoreCrx(extensionId: string, fetcher: ParadisWebStoreFetcher, options: { readonly url?: string; readonly publisherKeyHash?: string; readonly timeoutMs?: number } = {}): Promise<IParadisVerifiedCrx> {
	let current: IParadisWebStoreResponse | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			current?.cancel();
			reject(new Error('The Chrome Web Store download timed out'));
		}, options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
	});
	try {
		return await Promise.race([timeout, downloadCrx(extensionId, fetcher, options, response => current = response)]);
	} finally {
		clearTimeout(timer);
	}
}

async function downloadCrx(extensionId: string, fetcher: ParadisWebStoreFetcher, options: { readonly url?: string; readonly publisherKeyHash?: string }, onResponse: (response: IParadisWebStoreResponse) => void): Promise<IParadisVerifiedCrx> {
	let url = options.url ?? paradisWebStoreCrxUrl(extensionId);
	if (!paradisIsAllowedCrxUrl(url)) {
		throw new Error('The extension download address is not a Chrome Web Store address');
	}
	for (let redirects = 0; ; redirects++) {
		const response = await fetcher(url);
		onResponse(response);
		if (REDIRECT_STATUSES.has(response.status)) {
			response.cancel();
			const next = response.location !== undefined && URL.canParse(response.location, url) ? new URL(response.location, url).href : '';
			if (redirects >= MAX_REDIRECTS) {
				throw new Error('The extension download has too many redirects');
			}
			if (!paradisIsAllowedCrxUrl(next)) {
				throw new Error('The extension download was redirected away from Google');
			}
			url = next;
			continue;
		}
		if (response.status < 200 || response.status >= 300) {
			response.cancel();
			throw new Error(`The Chrome Web Store download failed (${response.status})`);
		}
		const bytes = await response.read(MAX_CRX_BYTES);
		return paradisVerifyCrx3(bytes, { expectedExtensionId: extensionId, requirePublisherProof: true, publisherKeyHash: options.publisherKeyHash });
	}
}

/** Electron の main から外へ GET する（メモリだけのセッション、cookie なし、リダイレクトは返す）。 */
export function paradisCreateWebStoreFetcher(): ParadisWebStoreFetcher {
	let session: electron.Session | undefined;
	return url => new Promise<IParadisWebStoreResponse>((resolvePromise, reject) => {
		// 名前に persist: を付けないのでディスクに残らない。タブのセッション（拡張機能が入る）とは別
		session ??= electron.session.fromPartition('paradis-browser-extension-web-store', { cache: false });
		const request = electron.net.request({ url, method: 'GET', redirect: 'manual', session, useSessionCookies: false, credentials: 'omit' });
		let settled = false;
		const settle = (value: IParadisWebStoreResponse) => {
			settled = true;
			resolvePromise(value);
		};
		request.on('redirect', (status, _method, redirectUrl) => {
			if (!settled) {
				settle({ status, location: redirectUrl, read: async () => Buffer.alloc(0), cancel: () => { } });
			}
			request.abort();
		});
		request.on('response', response => {
			const declared = Number(response.headers['content-length'] ?? '0');
			settle({
				status: response.statusCode,
				read: maxBytes => new Promise<Buffer>((resolveRead, rejectRead) => {
					if (declared > maxBytes) {
						request.abort();
						rejectRead(new Error('The download is too large'));
						return;
					}
					const chunks: Buffer[] = [];
					let total = 0;
					response.on('data', (chunk: Buffer) => {
						total += chunk.length;
						if (total > maxBytes) {
							request.abort();
							rejectRead(new Error('The download is too large'));
							return;
						}
						chunks.push(chunk);
					});
					response.on('end', () => resolveRead(Buffer.concat(chunks)));
					response.on('error', rejectRead);
					response.on('aborted', () => rejectRead(new Error('The download was interrupted')));
				}),
				cancel: () => request.abort(),
			});
		});
		request.on('error', error => {
			if (!settled) {
				reject(error);
			}
		});
		request.end();
	});
}

/** zip の名前として受け入れるもの（相対・`/` 区切り。絶対パス・ドライブ文字・`\`・`..`・`.`・空の部分は断る）。 */
export function paradisIsSafeArchiveEntryName(name: string): boolean {
	if (!name || name.length > 1024 || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
		return false;
	}
	return name.replace(/\/$/, '').split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

type Yauzl = typeof import('yauzl');

async function loadYauzl(): Promise<Yauzl> {
	// npm のパッケージは main では動的に読む（配布版の main の束が外に残し、静的に読むと起動前に止まるため）
	const loaded = await import('yauzl') as Yauzl & { readonly default?: Yauzl };
	return loaded.default ?? loaded;
}

/**
 * 確かめた CRX の zip を `directory`（まだ無いフォルダ）へ展開する。危ない名前・シンボリックリンク・同じ名前・多すぎる
 * ファイル・大きすぎる中身（宣言の合計で、解凍の前に）を断る。
 */
export async function paradisExtractCrxArchive(archive: Buffer, directory: string): Promise<void> {
	const yauzl = await loadYauzl();
	const root = resolve(directory);
	await fs.mkdir(root, { recursive: false });
	const zip = await new Promise<import('yauzl').ZipFile>((resolveZip, reject) => yauzl.fromBuffer(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, decodeStrings: true }, (error, opened) => error || !opened ? reject(error ?? new Error('unreadable zip')) : resolveZip(opened)));
	try {
		if (zip.entryCount > MAX_ENTRIES) {
			throw new Error('The extension package is too large');
		}
		let declaredBytes = 0;
		const seen = new Set<string>();
		await new Promise<void>((resolveAll, reject) => {
			const fail = (error: unknown) => {
				zip.close();
				reject(error);
			};
			zip.on('error', fail);
			zip.on('end', () => resolveAll());
			zip.on('entry', (entry: import('yauzl').Entry) => {
				void (async () => {
					const name = entry.fileName;
					if (!paradisIsSafeArchiveEntryName(name) || seen.has(name)) {
						throw new Error(`The extension package has an unsafe file name: ${JSON.stringify(name)}`);
					}
					seen.add(name);
					// 上位 16 ビットは Unix のファイルの種類と権限（シンボリックリンクは 0o120000）
					const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
					if (mode === 0o120000) {
						throw new Error(`The extension package has a symbolic link: ${JSON.stringify(name)}`);
					}
					declaredBytes += entry.uncompressedSize;
					if (declaredBytes > MAX_UNPACKED_BYTES) {
						throw new Error('The extension package is too large');
					}
					const target = resolve(root, name);
					const inside = relative(root, target);
					if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
						throw new Error(`The extension package has an unsafe file name: ${JSON.stringify(name)}`);
					}
					if (name.endsWith('/')) {
						await fs.mkdir(target, { recursive: true });
						zip.readEntry();
						return;
					}
					await fs.mkdir(dirname(target), { recursive: true });
					const data = await new Promise<Buffer>((resolveData, rejectData) => zip.openReadStream(entry, (error, stream) => {
						if (error || !stream) {
							rejectData(error ?? new Error('unreadable zip entry'));
							return;
						}
						const chunks: Buffer[] = [];
						stream.on('data', (chunk: Buffer) => chunks.push(chunk));
						stream.on('end', () => resolveData(Buffer.concat(chunks)));
						stream.on('error', rejectData);
					}));
					// 'wx': 同じ名前（大文字小文字だけが違う名前を区別しないファイルシステムを含む）は上書きせずに断る
					await fs.writeFile(target, data, { flag: 'wx' });
					zip.readEntry();
				})().catch(fail);
			});
			zip.readEntry();
		});
	} finally {
		zip.close();
	}
	if (!(await fs.stat(join(root, 'manifest.json')).then(stat => stat.isFile(), () => false))) {
		throw new Error('The extension package has no manifest');
	}
}
