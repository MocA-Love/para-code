/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画像を Chromium にデコードさせる前に、ヘッダーだけを読んで縦横の大きさを確かめる。
//
// upstream の画像プレビューは webview の中で画像をデコードしていたので、巨大な画像（展開すると何 GB にも
// なる「画像の爆弾」）で落ちてもそのフレームだけで済んだ。画像ビューアはワークベンチの renderer で
// デコードするので、展開後の大きさが上限を超える画像は、デコードさせずに断る。
//
// 形式は拡張子ではなく先頭の署名で決める（Chromium も <img> では署名で形式を決めるため。拡張子と中身が
// 食い違っていても、実際にデコードされる形式で確かめる）。ここではヘッダーを読むだけで、展開はしない。
// Word の画像の検査（common/word/paradisWordImageInspection.ts）はチャンク全体の CRC を JS で計算し、
// 動く PNG を断るので、開くたびに全体を見る画像ビューアには使わない。

export type ParadisImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico' | 'avif';

export interface ParadisImageDimensions {
	readonly format: ParadisImageFormat;
	readonly width: number;
	readonly height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u16le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function i32le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let value = '';
	for (let index = 0; index < length && offset + index < bytes.byteLength; index++) {
		value += String.fromCharCode(bytes[offset + index]);
	}
	return value;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array, offset = 0): boolean {
	return bytes.byteLength >= offset + 24 && PNG_SIGNATURE.every((value, index) => bytes[offset + index] === value);
}

function pngDimensions(bytes: Uint8Array, offset = 0): { width: number; height: number } {
	// 最初のチャンクは IHDR（幅・高さの順に 4 バイトずつ）。
	if (ascii(bytes, offset + 12, 4) !== 'IHDR') {
		return { width: 0, height: 0 };
	}
	return { width: u32be(bytes, offset + 16), height: u32be(bytes, offset + 20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
	let offset = 2;
	while (offset + 4 <= bytes.byteLength) {
		if (bytes[offset] !== 0xff) {
			return { width: 0, height: 0 };
		}
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			// 詰め物の 0xFF。
			offset++;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) {
			// SOF より前に画像データ（SOS）や終わり（EOI）が来た。
			return { width: 0, height: 0 };
		}
		const length = u16be(bytes, offset + 2);
		const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isStartOfFrame) {
			if (offset + 9 > bytes.byteLength) {
				return { width: 0, height: 0 };
			}
			return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
		}
		if (length < 2) {
			return { width: 0, height: 0 };
		}
		offset += 2 + length;
	}
	return { width: 0, height: 0 };
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
	const chunk = ascii(bytes, 12, 4);
	if (chunk === 'VP8X' && bytes.byteLength >= 30) {
		return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
	}
	if (chunk === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
		const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
		return { width: 1 + (b1 | ((b2 & 0x3f) << 8)), height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) };
	}
	if (chunk === 'VP8 ' && bytes.byteLength >= 30) {
		return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
	}
	return { width: 0, height: 0 };
}

function bmpDimensions(bytes: Uint8Array, offset: number, iconHalfHeight: boolean): { width: number; height: number } {
	if (bytes.byteLength < offset + 12) {
		return { width: 0, height: 0 };
	}
	const headerSize = i32le(bytes, offset);
	if (headerSize === 12) {
		const height = u16le(bytes, offset + 6);
		return { width: u16le(bytes, offset + 4), height: iconHalfHeight ? height / 2 : height };
	}
	if (headerSize < 40) {
		return { width: 0, height: 0 };
	}
	const height = Math.abs(i32le(bytes, offset + 8));
	return { width: Math.abs(i32le(bytes, offset + 4)), height: iconHalfHeight ? height / 2 : height };
}

/** ICO / CUR: 中の画像のうち一番大きいもの（Chromium はその中から 1 枚を選んでデコードする）。 */
function icoDimensions(bytes: Uint8Array): { width: number; height: number } {
	const count = u16le(bytes, 4);
	if (count === 0 || bytes.byteLength < 6 + count * 16) {
		return { width: 0, height: 0 };
	}
	let best = { width: 0, height: 0 };
	for (let index = 0; index < count; index++) {
		const entry = 6 + index * 16;
		const dataOffset = i32le(bytes, entry + 12) >>> 0;
		let size = { width: bytes[entry] || 256, height: bytes[entry + 1] || 256 };
		if (isPng(bytes, dataOffset)) {
			size = pngDimensions(bytes, dataOffset);
		} else if (dataOffset + 12 <= bytes.byteLength) {
			const bmp = bmpDimensions(bytes, dataOffset, true);
			if (bmp.width && bmp.height) {
				size = bmp;
			}
		}
		if (!size.width || !size.height) {
			return { width: 0, height: 0 };
		}
		if (size.width * size.height > best.width * best.height) {
			best = size;
		}
	}
	return best;
}

/** ISOBMFF の箱をたどるときの上限（壊れた・細工したファイルで回り続けないため）。 */
const MAX_BOXES = 10_000;
const MAX_BOX_DEPTH = 8;
/**
 * トップレベルの箱は数えるだけで、`meta` と `moov` のほかは覚えない。断片化した長い動く AVIF（`moof` と
 * `mdat` が何千と並ぶ）を、中の箱の上限で誤って断らないよう、上限を中の箱とは別にする。
 */
const MAX_TOP_LEVEL_BOXES = 1_000_000;
const TOP_LEVEL_TYPES: ReadonlySet<string> = new Set(['meta', 'moov']);

interface IsoBox {
	readonly type: string;
	/** 中身（ヘッダーの後ろ）の始まりと終わり。 */
	readonly start: number;
	readonly end: number;
}

/**
 * `[start, end)` の中の箱を順に返す（`keep` を渡したときはその型だけ）。長さが範囲をはみ出す箱が来たら
 * undefined（壊れている）。
 */
function readIsoBoxes(bytes: Uint8Array, start: number, end: number, budget: { boxes: number }, keep?: ReadonlySet<string>): IsoBox[] | undefined {
	const boxes: IsoBox[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		if (--budget.boxes < 0) {
			return undefined;
		}
		let size = u32be(bytes, offset);
		const type = ascii(bytes, offset + 4, 4);
		let header = 8;
		if (size === 1) {
			// 64 ビットの長さ。上位 32 ビットが 0 でなければ、上限（256 MiB）を超えている。
			if (offset + 16 > end || u32be(bytes, offset + 8) !== 0) {
				return undefined;
			}
			size = u32be(bytes, offset + 12);
			header = 16;
		} else if (size === 0) {
			size = end - offset;
		}
		if (size < header || offset + size > end) {
			return undefined;
		}
		if (!keep || keep.has(type)) {
			boxes.push({ type, start: offset + header, end: offset + size });
		}
		offset += size;
	}
	return boxes;
}

type Size = { readonly width: number; readonly height: number };

/**
 * AVIF（ISOBMFF）の画像の大きさ。箱の長さで飛ばしてたどるので、ファイルのどこにあっても読む。
 * - 静止画: `meta` → `iprp` → `ipco` の中の `ispe`（画像の空間的な大きさ）
 * - 動く AVIF（brand `avis`）: 上に加えて、`moov` → `trak` の `tkhd` と、`trak` → `mdia` → `minf` → `stbl` →
 *   `stsd` の `av01` の幅と高さ（`meta` を持たずトラックだけのものもあり、`meta` の `ispe` よりトラックが
 *   大きいこともある）
 * 見つかったもののうち一番大きいものを返す。どちらも無い、または箱が壊れていれば 0（呼び出し側で断る）。
 */
function avifDimensions(bytes: Uint8Array): Size {
	const none = { width: 0, height: 0 };
	const budget = { boxes: MAX_BOXES };
	const children = (parent: IsoBox, depth: number, skip = 0): IsoBox[] | undefined =>
		depth > MAX_BOX_DEPTH ? undefined : readIsoBoxes(bytes, parent.start + skip, parent.end, budget);
	/** 子のうち、その型の箱がちょうど 1 つならそれ、無ければ null、2 つ以上か壊れていれば undefined。 */
	const single = (boxes: IsoBox[] | undefined, type: string): IsoBox | null | undefined => {
		const found = boxes?.filter(box => box.type === type);
		return !found || found.length > 1 ? undefined : found[0] ?? null;
	};

	const top = readIsoBoxes(bytes, 0, bytes.byteLength, { boxes: MAX_TOP_LEVEL_BOXES }, TOP_LEVEL_TYPES);
	const meta = single(top, 'meta');
	const moov = single(top, 'moov');
	if (meta === undefined || moov === undefined) {
		return none;
	}
	const sizes: Size[] = [];
	if (meta) {
		// meta は FullBox（版とフラグの 4 バイトの後ろに子の箱）。iprp・ipco が無いのは、トラックだけの avis。
		const iprp = single(children(meta, 1, 4), 'iprp');
		const ipco = iprp ? single(children(iprp, 2), 'ipco') : iprp;
		if (iprp === undefined || ipco === undefined) {
			return none;
		}
		const properties = ipco ? children(ipco, 3) : [];
		if (!properties) {
			return none;
		}
		for (const ispe of properties.filter(box => box.type === 'ispe')) {
			// FullBox の 4 バイトの後ろに、幅と高さが 4 バイトずつ。
			if (ispe.end - ispe.start < 12) {
				return none;
			}
			sizes.push({ width: u32be(bytes, ispe.start + 4), height: u32be(bytes, ispe.start + 8) });
		}
	}
	if (moov) {
		const tracks = children(moov, 1)?.filter(box => box.type === 'trak');
		if (!tracks) {
			return none;
		}
		for (const trak of tracks) {
			const trakChildren = children(trak, 2);
			const tkhd = single(trakChildren, 'tkhd');
			if (tkhd === undefined) {
				return none;
			}
			if (tkhd) {
				// tkhd は FullBox。幅と高さ（16.16 の固定小数）は箱の末尾の 8 バイトで、箱の長さは版 0 で 84、
				// 版 1 で 96 バイト（時刻と長さが 64 ビットになる）。推測: libavif はトラックの大きさをここから取る。
				const length = bytes[tkhd.start] === 1 ? 96 : bytes[tkhd.start] === 0 ? 84 : 0;
				if (!length || tkhd.end - tkhd.start < length) {
					return none;
				}
				sizes.push({ width: Math.ceil(u32be(bytes, tkhd.start + length - 8) / 0x10000), height: Math.ceil(u32be(bytes, tkhd.start + length - 4) / 0x10000) });
			}
			const mdia = single(trakChildren, 'mdia');
			const minf = mdia ? single(children(mdia, 3), 'minf') : mdia;
			const stbl = minf ? single(children(minf, 4), 'stbl') : minf;
			const stsd = stbl ? single(children(stbl, 5), 'stsd') : stbl;
			if (mdia === undefined || minf === undefined || stbl === undefined || stsd === undefined) {
				return none;
			}
			// stsd は FullBox（4 バイト）と、項目の数（4 バイト）の後ろに見本の記述が並ぶ。
			if (stsd && stsd.end - stsd.start < 8) {
				return none;
			}
			const entries = stsd ? children(stsd, 6, 8) : [];
			if (!entries) {
				return none;
			}
			for (const entry of entries.filter(box => box.type === 'av01')) {
				// VisualSampleEntry: 予約 6・データ参照 2・予約 16 バイトの後ろに、幅と高さが 2 バイトずつ。
				if (entry.end - entry.start < 28) {
					return none;
				}
				sizes.push({ width: u16be(bytes, entry.start + 24), height: u16be(bytes, entry.start + 26) });
			}
		}
	}
	let best: Size = none;
	for (const size of sizes) {
		if (size.width * size.height > best.width * best.height) {
			best = size;
		}
	}
	return best;
}

/** GIF のサブブロック列（長さ 1 バイト + データ、長さ 0 で終わる）を飛ばした次の位置。壊れていれば undefined。 */
function skipGifSubBlocks(bytes: Uint8Array, offset: number): number | undefined {
	while (offset < bytes.byteLength) {
		const length = bytes[offset];
		offset += 1 + length;
		if (length === 0) {
			return offset;
		}
	}
	return undefined;
}

/**
 * GIF: 論理画面と、すべてのフレーム（画像記述子）の右下のうち一番大きい範囲。Chromium は論理画面より
 * 大きいフレームに合わせて画像を広げるので、論理画面だけでは足りない。フレームが 1 つも無ければ 0。
 */
function gifDimensions(bytes: Uint8Array): { width: number; height: number } {
	const none = { width: 0, height: 0 };
	if (bytes.byteLength < 13) {
		return none;
	}
	let width = u16le(bytes, 6);
	let height = u16le(bytes, 8);
	const flags = bytes[10];
	let offset = 13 + ((flags & 0x80) ? 3 * (1 << ((flags & 0x07) + 1)) : 0);
	let frames = 0;
	while (offset < bytes.byteLength) {
		const introducer = bytes[offset];
		if (introducer === 0x3b) {
			break;
		}
		if (introducer === 0x21) {
			// 拡張ブロック: ラベル 1 バイトの後ろにサブブロック列。
			const next = skipGifSubBlocks(bytes, offset + 2);
			if (next === undefined) {
				break;
			}
			offset = next;
			continue;
		}
		if (introducer !== 0x2c || offset + 10 > bytes.byteLength) {
			break;
		}
		frames++;
		width = Math.max(width, u16le(bytes, offset + 1) + u16le(bytes, offset + 5));
		height = Math.max(height, u16le(bytes, offset + 3) + u16le(bytes, offset + 7));
		const localFlags = bytes[offset + 9];
		offset += 10 + ((localFlags & 0x80) ? 3 * (1 << ((localFlags & 0x07) + 1)) : 0);
		// LZW の最小符号長 1 バイトと、画像データのサブブロック列。
		const next = skipGifSubBlocks(bytes, offset + 1);
		if (next === undefined) {
			break;
		}
		offset = next;
	}
	return frames ? { width, height } : none;
}

/**
 * 先頭の署名で形式を決め、ヘッダーから縦横の大きさを読む。署名が分からなければ undefined。
 * 形式は分かったが大きさが読めなかったときは width/height が 0 になる。
 */
export function readParadisImageHeader(bytes: Uint8Array): ParadisImageDimensions | undefined {
	if (isPng(bytes)) {
		return { format: 'png', ...pngDimensions(bytes) };
	}
	if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { format: 'jpeg', ...jpegDimensions(bytes) };
	}
	const head = ascii(bytes, 0, 6);
	if (head === 'GIF87a' || head === 'GIF89a') {
		return { format: 'gif', ...gifDimensions(bytes) };
	}
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
		return { format: 'webp', ...webpDimensions(bytes) };
	}
	if (ascii(bytes, 0, 2) === 'BM') {
		return { format: 'bmp', ...bmpDimensions(bytes, 14, false) };
	}
	if (bytes.byteLength >= 6 && bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) {
		return { format: 'ico', ...icoDimensions(bytes) };
	}
	if (ascii(bytes, 4, 4) === 'ftyp' && ['avif', 'avis', 'mif1', 'msf1'].includes(ascii(bytes, 8, 4))) {
		return { format: 'avif', ...avifDimensions(bytes) };
	}
	return undefined;
}

export type ParadisImageDecodeVerdict = 'ok' | 'tooLarge' | 'invalid';

/**
 * デコードさせてよいか。展開後の画素数が `maxPixels` を超えるもの、署名の分かる形式なのに大きさが
 * 読めないもの（AVIF の `ispe` が無い、GIF にフレームが無いなども含む）は断る。SVG（ベクタ。<img> では
 * 表示の大きさで描く）は、バイト数の上限だけで通す。署名の分からないものは、SVG 以外は断る。
 */
export function judgeParadisImageDecode(bytes: Uint8Array, mimeType: string, maxPixels: number): ParadisImageDecodeVerdict {
	const header = readParadisImageHeader(bytes);
	if (!header) {
		return mimeType === 'image/svg+xml' ? 'ok' : 'invalid';
	}
	if (!header.width || !header.height) {
		return 'invalid';
	}
	return header.width * header.height > maxPixels ? 'tooLarge' : 'ok';
}
