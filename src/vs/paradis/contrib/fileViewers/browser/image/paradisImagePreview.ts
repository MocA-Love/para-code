/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画像ビューアの DOM を持たない部分（対象の拡張子と MIME、ズームの段階、Git LFS の判定、読み込みと
// その結果の覚え方）。ペインとテストの両方から使う。
//
// upstream の画像プレビュー（extensions/media-preview）は webview の中の <img> が service worker 経由で
// ファイルを読み、URL に毎回 `?version=Date.now()` を付けるので、開くたびにファイル全体を読み直していた。
// ここでは IFileService でバイト列を受け取り、MIME を拡張子で決めた Blob にして、ワークベンチの <img> に
// Blob URL で渡す。同じファイルは etag（mtime と大きさ）が変わらない限り読み直さない。

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';

/** 画像ビューアの EditorPane / EditorInput 識別子。 */
export const PARADIS_IMAGE_EDITOR_ID = 'paradis.editor.imagePreview';
export const PARADIS_IMAGE_INPUT_TYPE_ID = 'paradis.input.imagePreview';
/** `false` にすると upstream の画像プレビュー（拡張機能）で開く。 */
export const PARADIS_IMAGE_VIEWER_ENABLED_KEY = 'paradis.imageViewer.enabled';

/**
 * 対象の拡張子と、Blob に付ける MIME。upstream の `imagePreview.previewEditor` の selector
 * （`*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif,svg}`）と同じ集合にしている。
 * MIME はファイルの中身から推測せず、ここで固定する（中身が HTML でも画像としてしか解釈されない）。
 */
const IMAGE_MIME_TYPES: ReadonlyMap<string, string> = new Map([
	['.jpg', 'image/jpeg'],
	['.jpe', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.png', 'image/png'],
	['.bmp', 'image/bmp'],
	['.gif', 'image/gif'],
	['.ico', 'image/x-icon'],
	['.webp', 'image/webp'],
	['.avif', 'image/avif'],
	['.svg', 'image/svg+xml'],
]);

export const PARADIS_IMAGE_EXTENSIONS: readonly string[] = [...IMAGE_MIME_TYPES.keys()];

/** 拡張子から決めた MIME。対象外なら undefined。 */
export function getParadisImageMimeType(resource: URI): string | undefined {
	return IMAGE_MIME_TYPES.get(extname(resource).toLowerCase());
}

export function isParadisImageResource(resource: URI): boolean {
	return getParadisImageMimeType(resource) !== undefined;
}

export function isParadisSvgResource(resource: URI): boolean {
	return extname(resource).toLowerCase() === '.svg';
}

// --- ズーム（upstream の media/imagePreview.js と同じ値） ---

export type ParadisImageScale = number | 'fit';

/** これより大きく拡大したら `image-rendering: pixelated` にする。 */
export const PARADIS_IMAGE_PIXELATION_THRESHOLD = 3;
const SCALE_PINCH_FACTOR = 0.075;
const MAX_SCALE = 20;
const MIN_SCALE = 0.1;
const ZOOM_LEVELS: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 7, 10, 15, 20];

/** ステータスバーの倍率を押したときに選べる倍率（upstream の zoomStatusBarEntry と同じ）。 */
export const PARADIS_IMAGE_PICKABLE_SCALES: readonly ParadisImageScale[] = [10, 5, 2, 1, 0.5, 0.2, 'fit'];

export function clampParadisImageScale(scale: number): number {
	return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

/** 今の倍率より 1 段大きい倍率。 */
export function getParadisImageZoomInScale(scale: number): number {
	return ZOOM_LEVELS.find(level => level > scale) ?? MAX_SCALE;
}

/** 今の倍率より 1 段小さい倍率。 */
export function getParadisImageZoomOutScale(scale: number): number {
	for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
		if (ZOOM_LEVELS[i] < scale) {
			return ZOOM_LEVELS[i];
		}
	}
	return MIN_SCALE;
}

/** ホイール（またはピンチ）1 回ぶんの倍率。 */
export function getParadisImageWheelScale(scale: number, deltaY: number): number {
	const delta = deltaY > 0 ? 1 : -1;
	return clampParadisImageScale(scale * (1 - delta * SCALE_PINCH_FACTOR));
}

// --- Git LFS ---

const GIT_LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const GIT_LFS_POINTER_MAX_SIZE = 1024;
/** git 拡張の読み取り専用ファイルシステム（差分の旧版）のスキーム。 */
const GIT_SCHEME = 'git';

/**
 * 差分の旧版（`git:`）が Git LFS のポインタファイルか。upstream の `isGitLfsPointer` と同じ条件
 * （git スキーム、1〜1024 バイト、先頭が LFS の宣言）。
 */
export function isParadisGitLfsPointer(resource: URI, bytes: VSBuffer): boolean {
	if (resource.scheme !== GIT_SCHEME || bytes.byteLength === 0 || bytes.byteLength > GIT_LFS_POINTER_MAX_SIZE) {
		return false;
	}
	return bytes.toString().startsWith(GIT_LFS_POINTER_PREFIX);
}

// --- 読み込みと、その結果の覚え方 ---

export interface ParadisImageData {
	/** 拡張子で決めた MIME を付けた Blob。 */
	readonly blob: Blob;
	readonly size: number;
	/** 読んだときの etag（mtime と大きさから作られる）。 */
	readonly etag: string;
	/**
	 * この Blob の URL。キャッシュから外れるまで同じ URL を使い続ける（Chromium は同じ文書の中で同じ URL の
	 * 画像をデコード済みのまま使い回すので、開き直したときにデコードもやり直さずに済む）。
	 */
	readonly url: string;
}

export type ParadisImageLoadResult =
	| { readonly kind: 'image'; readonly data: ParadisImageData; readonly fromCache: boolean }
	| { readonly kind: 'gitLfs' };

/**
 * etag が変わらないあいだ読み直さないで済むスキーム。`git:` は ref ごとに中身が変わりうる（`~` はインデックス）
 * のに etag が当てにならないので、毎回読む（差分を開くときだけなので回数は少ない）。
 */
const CACHEABLE_SCHEMES = new Set<string>([Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData]);

/** 覚えておく Blob の合計の上限。これを超えたら古く使ったものから手放す。 */
const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

/**
 * 読んだ画像の Blob を、ウィンドウ（レンダラ）につき 1 つ覚えておく LRU。Blob の実体は Chromium の
 * blob storage にあり、JS のヒープには載らない。手放すときに Blob URL も無効にする。
 */
export class ParadisImageCache {

	private readonly _entries = new Map<string, ParadisImageData>();
	private _totalBytes = 0;

	constructor(
		private readonly _maxBytes = DEFAULT_CACHE_BYTES,
		private readonly _revokeUrl: (url: string) => void = url => URL.revokeObjectURL(url),
	) { }

	get totalBytes(): number {
		return this._totalBytes;
	}

	get(key: string): ParadisImageData | undefined {
		const entry = this._entries.get(key);
		if (entry) {
			// 使ったものを末尾（新しい側）へ移す。
			this._entries.delete(key);
			this._entries.set(key, entry);
		}
		return entry;
	}

	/** 覚える。上限の半分を超える 1 枚は覚えない（ほかを全部追い出してしまうため）。 */
	set(key: string, entry: ParadisImageData): void {
		this.delete(key);
		if (entry.size > this._maxBytes / 2) {
			return;
		}
		this._entries.set(key, entry);
		this._totalBytes += entry.size;
		for (const [oldKey, old] of this._entries) {
			if (this._totalBytes <= this._maxBytes) {
				break;
			}
			if (oldKey !== key) {
				this._remove(oldKey, old);
			}
		}
	}

	delete(key: string): void {
		const entry = this._entries.get(key);
		if (entry) {
			this._remove(key, entry);
		}
	}

	/** その Blob URL を今も覚えているか（覚えていないものはペインが自分で手放す）。 */
	owns(url: string): boolean {
		for (const entry of this._entries.values()) {
			if (entry.url === url) {
				return true;
			}
		}
		return false;
	}

	clear(): void {
		for (const [key, entry] of [...this._entries]) {
			this._remove(key, entry);
		}
	}

	private _remove(key: string, entry: ParadisImageData): void {
		this._entries.delete(key);
		this._totalBytes -= entry.size;
		this._revokeUrl(entry.url);
	}
}

/**
 * 画像を読む。覚えている etag を渡し、ファイルが変わっていなければ stat だけで返る
 * （`IFileService.readFile` は etag が同じなら中身を送らずに FILE_NOT_MODIFIED_SINCE を投げる）。
 * 覚えられないもの（`git:` や大きすぎるもの）の URL は、呼び出し側が使い終わったら手放す（{@link ParadisImageCache.owns}）。
 */
export async function loadParadisImage(
	fileService: Pick<IFileService, 'readFile'>,
	resource: URI,
	cache: ParadisImageCache,
	token: CancellationToken = CancellationToken.None,
	createUrl: (blob: Blob) => string = blob => URL.createObjectURL(blob),
): Promise<ParadisImageLoadResult> {
	const mimeType = getParadisImageMimeType(resource) ?? 'application/octet-stream';
	const key = resource.toString();
	const cacheable = CACHEABLE_SCHEMES.has(resource.scheme);
	const cached = cacheable ? cache.get(key) : undefined;

	let content;
	try {
		content = await fileService.readFile(resource, cached ? { etag: cached.etag } : undefined, token);
	} catch (error) {
		if (cached && toFileOperationResult(error) === FileOperationResult.FILE_NOT_MODIFIED_SINCE) {
			return { kind: 'image', data: cached, fromCache: true };
		}
		throw error;
	}

	if (isParadisGitLfsPointer(resource, content.value)) {
		return { kind: 'gitLfs' };
	}

	const blob = new Blob([content.value.buffer as Uint8Array<ArrayBuffer>], { type: mimeType });
	const data: ParadisImageData = { blob, size: content.size, etag: content.etag, url: createUrl(blob) };
	if (cacheable) {
		cache.set(key, data);
	} else if (cached) {
		cache.delete(key);
	}
	return { kind: 'image', data, fromCache: false };
}
