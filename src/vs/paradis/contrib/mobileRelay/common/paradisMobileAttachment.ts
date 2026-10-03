/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { extUri, extUriBiasedIgnorePathCase, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/**
 * モバイルから上げた添付画像の置き場（`<userData>/User/paraMobileUploads/`）を読む口（`fs.attachment.v1`）の、
 * DOM に依らない部分。
 *
 * 置き場はワークスペースの外（userData の下）にあるので、fs の `media` の検査（スペースの中に閉じる）は使えない。
 * 代わりに次の 3 段で「置き場の直下にある、アップロードが作った名前のファイル」だけを通す:
 * 1. 名前の形（{@link PARADIS_MOBILE_ATTACHMENT_NAME_PATTERN}）。区切り・`..`・制御文字は形の時点で入らない
 * 2. 置き場とファイルの両方を realpath し、ファイルの実体の親が置き場の実体と一致すること（シンボリックリンクで外へ出さない）。
 *    同じ検査を 2 回続けて行い、間に差し替えられていないことも確かめる（`paradisResolveMobileWorkspacePath` と同じ作法）
 * 3. 通常のファイルで、大きさが {@link PARADIS_MOBILE_ATTACHMENT_READ_LIMIT} 以下であること
 *
 * 読んだ後に呼び出し側がもう一度この解決を行い、実体のパス・大きさ・更新時刻が読む前と同じであることを
 * 確かめる（{@link paradisSameMobileAttachment}。読んでいる間に差し替えられたものは捨てる）。
 */

/** 置き場のディレクトリ名（userData の下）。アップロード（`paradisCreateMobileUploadTarget`）と同じ。 */
export const PARADIS_MOBILE_UPLOADS_DIRECTORY = 'paraMobileUploads';

/**
 * アップロードが作るファイル名（`attachment-<13 桁のミリ秒>-<乱数>.<拡張子>`）。
 * 乱数と拡張子の字種と長さは `paradisCreateMobileUploadTarget` の切り詰めと同じ。
 */
export const PARADIS_MOBILE_ATTACHMENT_NAME_PATTERN = /^attachment-\d{13}-[A-Za-z0-9]{1,12}(?:\.[A-Za-z0-9]{1,8})?$/;

/** 読む上限（バイト）。アップロードの上限は 10MB なので、それを超えるものは置き場に作られない。 */
export const PARADIS_MOBILE_ATTACHMENT_READ_LIMIT = 20 * 1024 * 1024;

/** サムネイルの長辺（px）。 */
export const PARADIS_MOBILE_ATTACHMENT_THUMB_EDGE = 512;

/** サムネイルを作る画像の画素数の上限。これを超える画像は縮めずに断る（展開でメモリを使い切らないように）。 */
export const PARADIS_MOBILE_ATTACHMENT_THUMB_MAX_PIXELS = 32 * 1024 * 1024;

/** サムネイルの列で待てる要求の数。超えた分は断る（アプリは見えている札の分しか頼まない）。 */
export const PARADIS_MOBILE_ATTACHMENT_THUMB_QUEUE_LIMIT = 8;

export type ParadisMobileAttachmentVariant = 'thumb' | 'full';

export function paradisIsMobileAttachmentName(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 64 && PARADIS_MOBILE_ATTACHMENT_NAME_PATTERN.test(value);
}

export function paradisParseMobileAttachmentVariant(value: unknown): ParadisMobileAttachmentVariant | undefined {
	return value === 'thumb' || value === 'full' ? value : undefined;
}

function normalizeRealUri(resource: URI): URI {
	// fileService.realpath は Windows の綴りを URI.path に入れて返すことがあるので、URI の形に直してから比べる
	return resource.scheme === 'file' && (resource.path.includes('\\') || !resource.path.startsWith('/'))
		? URI.file(resource.path)
		: resource;
}

export type ParadisMobileAttachmentResolution =
	| { readonly kind: 'ok'; readonly uri: URI; readonly size: number; readonly mtime: number }
	| { readonly kind: 'invalid' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'tooLarge'; readonly size: number };

/**
 * 置き場の直下の添付を、外へ出ていないことを確かめて URI にする。
 * `directory` は置き場（`<userData>/paraMobileUploads`）。
 */
export async function paradisResolveMobileAttachment(fileService: Pick<IFileService, 'realpath' | 'stat'>, directory: URI, name: unknown, limit = PARADIS_MOBILE_ATTACHMENT_READ_LIMIT): Promise<ParadisMobileAttachmentResolution> {
	if (!paradisIsMobileAttachmentName(name)) {
		return { kind: 'invalid' };
	}
	const candidate = joinPath(directory, name);
	// ローカルはホストの大文字小文字の扱いに合わせ、接続先（vscode-remote）は大文字小文字を区別する側に倒す
	const identity = directory.scheme === 'file' ? extUriBiasedIgnorePathCase : extUri;
	const resolveOnce = async (): Promise<URI | undefined> => {
		const [real, realDirectory] = await Promise.all([
			fileService.realpath(candidate).catch(() => undefined),
			fileService.realpath(directory).catch(() => undefined),
		]);
		if (!real || !realDirectory) {
			return undefined;
		}
		const realUri = normalizeRealUri(real);
		// 置き場の「直下」だけを通す。入れ子（置き場の中のディレクトリ）やリンク先が別の場所のものは断る
		return identity.isEqual(identity.dirname(realUri), normalizeRealUri(realDirectory)) ? realUri : undefined;
	};
	const first = await resolveOnce();
	if (first === undefined) {
		return { kind: 'missing' };
	}
	const second = await resolveOnce();
	if (second === undefined || !identity.isEqual(first, second)) {
		return { kind: 'missing' };
	}
	const stat = await fileService.stat(second).catch(() => undefined);
	if (stat === undefined || !stat.isFile || stat.isSymbolicLink) {
		return { kind: 'missing' };
	}
	const size = stat.size ?? 0;
	if (size > limit) {
		return { kind: 'tooLarge', size };
	}
	return { kind: 'ok', uri: second, size, mtime: stat.mtime ?? 0 };
}

/** 画像の先頭のバイト列から種類を当てる（拡張子は信用しない。HEIC の名前で JPEG が入っていることがある）。 */
export function paradisSniffImageMediaType(bytes: Uint8Array): string | undefined {
	const at = (index: number) => bytes[index];
	if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
		return 'image/jpeg';
	}
	if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
		return 'image/png';
	}
	if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
		return 'image/gif';
	}
	if (bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
		return 'image/webp';
	}
	if (bytes.length >= 12 && at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
		const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
		if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) {
			return 'image/heic';
		}
	}
	return undefined;
}

/**
 * 画像の縦横（px）をヘッダーだけから読む（PNG・GIF・JPEG・WebP）。読めなければ undefined。
 * 展開する前に画素数の上限を確かめるために使う。
 */
export function paradisReadImageDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
	const type = paradisSniffImageMediaType(bytes);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const valid = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : undefined;
	if (type === 'image/png') {
		return bytes.length >= 24 ? valid(view.getUint32(16, false), view.getUint32(20, false)) : undefined;
	}
	if (type === 'image/gif') {
		return bytes.length >= 10 ? valid(view.getUint16(6, true), view.getUint16(8, true)) : undefined;
	}
	if (type === 'image/webp') {
		if (bytes.length < 30) {
			return undefined;
		}
		const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
		if (chunk === 'VP8 ') {
			return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
		}
		if (chunk === 'VP8L') {
			const bits = view.getUint32(21, true);
			return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
		}
		if (chunk === 'VP8X') {
			const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
			const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
			return valid(width, height);
		}
		return undefined;
	}
	if (type === 'image/jpeg') {
		let offset = 2;
		while (offset + 4 <= bytes.length) {
			if (bytes[offset] !== 0xff) {
				return undefined;
			}
			const marker = bytes[offset + 1];
			// 詰め物の 0xff と、長さを持たない印（RST・SOI・TEM）は飛ばす
			if (marker === 0xff) {
				offset++;
				continue;
			}
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				offset += 2;
				continue;
			}
			if (marker === 0xd9 || marker === 0xda) {
				return undefined;
			}
			const length = view.getUint16(offset + 2, false);
			if (length < 2) {
				return undefined;
			}
			// SOF0〜SOF15（DHT=C4・JPG=C8・DAC=CC を除く）に縦横がある
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return offset + 9 <= bytes.length ? valid(view.getUint16(offset + 7, false), view.getUint16(offset + 5, false)) : undefined;
			}
			offset += 2 + length;
		}
		return undefined;
	}
	return undefined;
}

/** 長辺を `maxEdge` に収める縦横（元が小さければそのまま）。 */
export function paradisMobileAttachmentThumbSize(width: number, height: number, maxEdge = PARADIS_MOBILE_ATTACHMENT_THUMB_EDGE): { readonly width: number; readonly height: number } {
	const longest = Math.max(width, height);
	if (longest <= maxEdge) {
		return { width, height };
	}
	const scale = maxEdge / longest;
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** 読む前と読んだ後の解決が同じ実体（パス・大きさ・更新時刻）を指しているか。 */
export function paradisSameMobileAttachment(before: ParadisMobileAttachmentResolution, after: ParadisMobileAttachmentResolution): boolean {
	return before.kind === 'ok' && after.kind === 'ok'
		&& before.uri.toString() === after.uri.toString() && before.size === after.size && before.mtime === after.mtime;
}

/**
 * 作ったサムネイルの控え（置き場・実体・大きさ・更新時刻をキーにした LRU）。同じ札を何度開いても縮め直さない。
 * 件数と合計バイトの両方に上限を置き、古い順に捨てる。
 */
export class ParadisMobileThumbnailCache {
	private readonly entries = new Map<string, Uint8Array>();
	private bytes = 0;

	constructor(
		private readonly maxEntries = 48,
		private readonly maxBytes = 8 * 1024 * 1024,
	) { }

	static keyOf(directory: URI, resolution: { readonly uri: URI; readonly size: number; readonly mtime: number }): string {
		return `${directory.toString()}\0${resolution.uri.toString()}\0${resolution.size}\0${resolution.mtime}`;
	}

	get(key: string): Uint8Array | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			// 使ったものを新しい側へ回す
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	set(key: string, value: Uint8Array): void {
		if (value.byteLength > this.maxBytes) {
			return;
		}
		const existing = this.entries.get(key);
		if (existing !== undefined) {
			this.bytes -= existing.byteLength;
			this.entries.delete(key);
		}
		this.entries.set(key, value);
		this.bytes += value.byteLength;
		while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.bytes -= this.entries.get(oldest.value)?.byteLength ?? 0;
			this.entries.delete(oldest.value);
		}
	}

	stats(): { readonly count: number; readonly bytes: number } {
		return { count: this.entries.size, bytes: this.bytes };
	}
}
