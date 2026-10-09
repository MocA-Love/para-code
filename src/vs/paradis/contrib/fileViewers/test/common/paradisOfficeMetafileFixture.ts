/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テスト用の架空の最小の EMF・WMF を組み立てる。中身は数と短い英字だけ。

/** リトルエンディアンでバイト列を書き足す。 */
export class ParadisMetafileBytes {
	private readonly values: number[] = [];

	get length(): number {
		return this.values.length;
	}

	u8(...values: number[]): this {
		for (const value of values) {
			this.values.push(value & 0xff);
		}
		return this;
	}

	u16(...values: number[]): this {
		for (const value of values) {
			this.u8(value, value >> 8);
		}
		return this;
	}

	u32(...values: number[]): this {
		for (const value of values) {
			this.u8(value, value >> 8, value >> 16, value >>> 24);
		}
		return this;
	}

	f32(...values: number[]): this {
		for (const value of values) {
			const buffer = new DataView(new ArrayBuffer(4));
			buffer.setFloat32(0, value, true);
			this.u8(buffer.getUint8(0), buffer.getUint8(1), buffer.getUint8(2), buffer.getUint8(3));
		}
		return this;
	}

	utf16(value: string, units = value.length): this {
		for (let index = 0; index < units; index++) {
			this.u16(index < value.length ? value.charCodeAt(index) : 0);
		}
		return this;
	}

	bytes(value: Uint8Array | readonly number[]): this {
		this.u8(...value);
		return this;
	}

	pad(multiple: number): this {
		while (this.values.length % multiple !== 0) {
			this.values.push(0);
		}
		return this;
	}

	toBytes(): Uint8Array {
		return new Uint8Array(this.values);
	}
}

/** EMF の 1 つの記録（種類と大きさを先頭に付け、4 バイトに揃える）。 */
export function emfRecord(type: number, body: ParadisMetafileBytes = new ParadisMetafileBytes()): Uint8Array {
	const content = body.pad(4).toBytes();
	return new ParadisMetafileBytes().u32(type, 8 + content.length).bytes(content).toBytes();
}

/** 見出しと EOF を付けた EMF。frame は 0.01 mm、装置は 1 mm あたり 4 px。 */
export function minimalEmf(records: readonly Uint8Array[], options: { readonly frame?: readonly [number, number, number, number]; readonly handles?: number } = {}): Uint8Array {
	const frame = options.frame ?? [0, 0, 2000, 1000];
	const eof = emfRecord(14, new ParadisMetafileBytes().u32(0, 16, 20));
	const total = 108 + records.reduce((sum, record) => sum + record.length, 0) + eof.length;
	const header = new ParadisMetafileBytes()
		.u32(1, 108)
		.u32(0, 0, 79, 39) // bounds（装置の座標）
		.u32(...frame)
		.u32(0x464d4520, 0x10000, total, records.length + 2)
		.u16(options.handles ?? 8, 0)
		.u32(0, 0, 0)
		.u32(400, 400, 100, 100) // 装置 400 px・100 mm
		.u32(0, 0, 0)
		.u32(0, 0); // 108 バイトにする
	const out = new ParadisMetafileBytes().bytes(header.toBytes());
	for (const record of records) {
		out.bytes(record);
	}
	return out.bytes(eof).toBytes();
}

/** 24 ビットの DIB（BITMAPINFOHEADER と、下の行から並べた画素）。色は 0xRRGGBB を上の行から。 */
export function minimalDib(width: number, height: number, colors: readonly number[]): { readonly info: Uint8Array; readonly bits: Uint8Array } {
	const info = new ParadisMetafileBytes().u32(40, width, height).u16(1, 24).u32(0, 0, 0, 0, 0, 0).toBytes();
	const bits = new ParadisMetafileBytes();
	for (let row = height - 1; row >= 0; row--) {
		for (let x = 0; x < width; x++) {
			const color = colors[row * width + x];
			bits.u8(color, color >> 8, color >> 16);
		}
		bits.pad(4);
	}
	return { info, bits: bits.toBytes() };
}

/** EMR_STRETCHDIBITS（SRCCOPY）。 */
export function emfStretchDib(dest: readonly [number, number, number, number], dib: { readonly info: Uint8Array; readonly bits: Uint8Array }, width: number, height: number, rop = 0x00cc0020): Uint8Array {
	const offBmi = 80;
	const offBits = offBmi + dib.info.length;
	const body = new ParadisMetafileBytes()
		.u32(0, 0, 0, 0)
		.u32(dest[0], dest[1], 0, 0, width, height)
		.u32(offBmi, dib.info.length, offBits, dib.bits.length, 0, rop)
		.u32(dest[2], dest[3])
		.bytes(dib.info).bytes(dib.bits);
	return emfRecord(81, body);
}

/** EMR_EXTTEXTOUTW。`advances` を渡すと文字ごとの送り幅を付ける。 */
export function emfText(x: number, y: number, value: string, advances?: readonly number[]): Uint8Array {
	const offString = 76;
	const stringBytes = Math.ceil(value.length * 2 / 4) * 4;
	const offDx = advances ? offString + stringBytes : 0;
	const body = new ParadisMetafileBytes()
		.u32(0, 0, 0, 0)
		.u32(1).f32(1, 1)
		.u32(x, y, value.length, offString, 0)
		.u32(0, 0, 0, 0)
		.u32(offDx)
		.utf16(value).pad(4);
	for (const advance of advances ?? []) {
		body.u32(advance);
	}
	return emfRecord(84, body);
}

/** EMR_EXTCREATEFONTINDIRECTW。 */
export function emfFont(handle: number, height: number, face: string, weight = 400): Uint8Array {
	return emfRecord(82, new ParadisMetafileBytes().u32(handle, height >>> 0, 0, 0, 0, weight).u8(0, 0, 0, 1, 0, 0, 0, 0x20).utf16(face, 32));
}

/** EMF+ のコメント（見出しの flags と、続く記録の種類）。 */
export function emfPlusComment(headerFlags: number, recordTypes: readonly number[] = []): Uint8Array {
	const plus = new ParadisMetafileBytes().u16(0x4001, headerFlags).u32(28, 16).u32(0xdbc01002, 0, 96, 96);
	for (const type of recordTypes) {
		plus.u16(type, 0).u32(12, 0);
	}
	const data = plus.toBytes();
	return emfRecord(70, new ParadisMetafileBytes().u32(data.length + 4, 0x2b464d45).bytes(data));
}

/** WMF の 1 つの記録（16 ビットの引数の並び）。 */
export function wmfRecord(fn: number, params: readonly number[] = [], extra: Uint8Array = new Uint8Array()): Uint8Array {
	const body = new ParadisMetafileBytes().u16(...params).bytes(extra).pad(2).toBytes();
	return new ParadisMetafileBytes().u32(3 + body.length / 2).u16(fn).bytes(body).toBytes();
}

/** 置き場所の見出し（placeable）と EOF を付けた WMF。 */
export function minimalWmf(records: readonly Uint8Array[], bbox: readonly [number, number, number, number] = [0, 0, 1000, 500], objects = 4): Uint8Array {
	const body = [...records, wmfRecord(0)];
	const words = 9 + body.reduce((sum, record) => sum + record.length / 2, 0);
	const out = new ParadisMetafileBytes()
		.u32(0x9ac6cdd7).u16(0, ...bbox, 1000).u32(0).u16(0)
		.u16(1, 9, 0x0300).u32(words).u16(objects).u32(64).u16(0);
	for (const record of body) {
		out.bytes(record);
	}
	return out.toBytes();
}
