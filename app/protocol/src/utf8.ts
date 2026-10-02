// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** 1 回の `String.fromCharCode.apply` に渡す数。引数の数には上限があるので大きくしすぎない。 */
const APPLY_UNITS = 8192;
/** ネイティブの関数に 1 度に渡すバイト数。 */
const BLOCK_BYTES = 64 * 1024;
const REPLACEMENT = 0xfffd;
const NON_ASCII = /[\x80-\xff]/;
/**
 * `escape` は ECMAScript の Annex B（Web 互換のための付属書）の機能で、エンジンによっては無い。
 * 無ければ速い経路を使わず、1 バイトずつ読む実装だけで読む。
 */
const latin1Escape: ((value: string) => string) | undefined = typeof escape === 'function' ? escape : undefined;

/**
 * UTF-8 のバイト列を文字列にする。`new TextDecoder().decode(bytes)`（utf-8、fatal なし、
 * ignoreBOM なし、stream なし）と同じ結果を返す。
 *
 * モバイル（Hermes）のグローバルの `TextDecoder` は Expo が入れた純 JS 版で、全バイトを
 * JS の配列に積み直し、1 文字ずつ `+=` で連結するため、21 MB で 6 秒以上かかる。Hermes は
 * JIT を持たないので、1 バイトずつ JS で回す限り自前で書いても数秒かかる。そこで 64 KiB ずつ、
 * どれもエンジンのネイティブ実装の関数だけで変換する。
 *
 * 1. `String.fromCharCode.apply` でバイトをそのまま 1 文字ずつの文字列（Latin-1）にする
 * 2. 0x80 以上のバイトが無ければ（ASCII だけなら）それが答え
 * 3. あれば `decodeURIComponent(escape(...))` で UTF-8 として読む。`escape` は 0x80 以上を
 *    `%XX` にし、`decodeURIComponent` は `%XX` の並びを UTF-8 として読む
 * 4. 不正なバイト列があると `decodeURIComponent` は投げるので、その塊だけ JS の実装で読む
 *
 * 塊の境目は文字の途中に置かない（継続バイトの手前まで戻す）。不正なバイト列の扱いも
 * 境目で変わらないことは、境目の位置で読み途中の文字は「次のバイトが継続バイトでない」ので
 * どちらの読み方でも U+FFFD 1 つで終わることによる。
 *
 * - 先頭の BOM（EF BB BF）は捨てる
 * - 不正なバイト列は WHATWG Encoding の UTF-8 decoder と同じく、「最長の正しい途中まで」を
 *   1 つの U+FFFD にし、合わなかったバイトは次の文字の先頭として読み直す
 * - 末尾で途切れたマルチバイト文字は 1 つの U+FFFD にする
 *
 * 速い経路が不正なバイト列を通さないことは、本番と同じ Hermes（hermes-ios-250829098.0.14 の
 * release、`hermesc -O` のバイトコード）で確かめた（2026-10-02）。次の 12 個はどれも
 * `decodeURIComponent` が URIError を投げて 1 バイトずつの経路に落ち、単体・ASCII で挟む・
 * 「あ」で挟むの 3 通り（計 36 件）で Expo の `TextDecoder` と結果が一致した:
 * `ED A0 80`, `ED BF BF`, `C0 80`, `C1 BF`, `E0 80 80`, `E0 9F BF`, `F0 80 80 80`,
 * `F0 8F BF BF`, `F4 90 80 80`, `F5 80 80 80`, `F8 88 80 80 80`, `FC 84 80 80 80 80`。
 * 同じ Hermes で、ランダムなバイト列などの 432,559 件も一致した。
 */
export function decodeUtf8(bytes: Uint8Array): string {
	const length = bytes.length;
	let start = 0;
	if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		start = 3;
	}
	const parts: string[] = [];
	while (start < length) {
		let end = Math.min(start + BLOCK_BYTES, length);
		if (end < length) {
			// 継続バイト（10xxxxxx）の手前に境目を置かない。どの文字も継続バイトは 3 つまでなので、
			// 3 つ戻っても継続バイトなら元の位置は読み途中の文字の中ではない。
			let back = end;
			while (back > end - 3 && back > start + 1 && (bytes[back]! & 0xc0) === 0x80) {
				back--;
			}
			if ((bytes[back]! & 0xc0) !== 0x80) {
				end = back;
			}
		}
		parts.push(decodeUtf8Block(bytes, start, end));
		start = end;
	}
	return parts.length === 1 ? parts[0]! : parts.join('');
}

/** `[start, end)` を、文字の途中で切れていない 1 つの塊として読む。 */
function decodeUtf8Block(bytes: Uint8Array, start: number, end: number): string {
	let latin1 = '';
	for (let offset = start; offset < end; offset += APPLY_UNITS) {
		// 型付き配列を引数の並びとして渡せる（Hermes・V8 とも）。バイト値がそのまま文字コードになる。
		latin1 += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + APPLY_UNITS, end)) as unknown as number[]);
	}
	if (!NON_ASCII.test(latin1)) {
		return latin1;
	}
	if (latin1Escape === undefined) {
		return decodeUtf8Range(bytes, start, end);
	}
	try {
		return decodeURIComponent(latin1Escape(latin1));
	} catch {
		return decodeUtf8Range(bytes, start, end);
	}
}

/**
 * 1 バイトずつ読む実装。不正なバイト列を含む塊だけに使う。
 */
function decodeUtf8Range(bytes: Uint8Array, start: number, end: number): string {
	const length = end;
	let index = start;
	// 小さい入力は 1 回の fromCharCode で済ませる。
	const units: number[] = new Array(Math.min(APPLY_UNITS, end - start));
	let unitCount = 0;
	const parts: string[] = [];
	const flush = () => {
		parts.push(String.fromCharCode.apply(null, unitCount === units.length ? units : units.slice(0, unitCount)));
		unitCount = 0;
	};
	while (index < length) {
		const lead = bytes[index]!;
		let codePoint: number;
		if (lead < 0x80) {
			codePoint = lead;
			index += 1;
		} else if (lead >= 0xc2 && lead <= 0xdf) {
			const b1 = index + 1 < length ? bytes[index + 1]! : -1;
			if (b1 >= 0x80 && b1 <= 0xbf) {
				codePoint = ((lead & 0x1f) << 6) | (b1 & 0x3f);
				index += 2;
			} else {
				codePoint = REPLACEMENT;
				index += 1;
			}
		} else if (lead >= 0xe0 && lead <= 0xef) {
			const lower = lead === 0xe0 ? 0xa0 : 0x80;
			const upper = lead === 0xed ? 0x9f : 0xbf;
			const b1 = index + 1 < length ? bytes[index + 1]! : -1;
			if (b1 < lower || b1 > upper) {
				codePoint = REPLACEMENT;
				index += 1;
			} else {
				const b2 = index + 2 < length ? bytes[index + 2]! : -1;
				if (b2 < 0x80 || b2 > 0xbf) {
					codePoint = REPLACEMENT;
					index += 2;
				} else {
					codePoint = ((lead & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
					index += 3;
				}
			}
		} else if (lead >= 0xf0 && lead <= 0xf4) {
			const lower = lead === 0xf0 ? 0x90 : 0x80;
			const upper = lead === 0xf4 ? 0x8f : 0xbf;
			const b1 = index + 1 < length ? bytes[index + 1]! : -1;
			if (b1 < lower || b1 > upper) {
				codePoint = REPLACEMENT;
				index += 1;
			} else {
				const b2 = index + 2 < length ? bytes[index + 2]! : -1;
				if (b2 < 0x80 || b2 > 0xbf) {
					codePoint = REPLACEMENT;
					index += 2;
				} else {
					const b3 = index + 3 < length ? bytes[index + 3]! : -1;
					if (b3 < 0x80 || b3 > 0xbf) {
						codePoint = REPLACEMENT;
						index += 3;
					} else {
						codePoint = ((lead & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
						index += 4;
					}
				}
			}
		} else {
			// 0x80〜0xC1（先頭に来られない継続バイトと過長表現）と 0xF5〜0xFF。
			codePoint = REPLACEMENT;
			index += 1;
		}
		if (codePoint > 0xffff) {
			// サロゲートペアは同じ塊に入れる（境目で割ると片割れの文字列ができる）。
			if (unitCount + 2 > units.length) {
				flush();
			}
			codePoint -= 0x10000;
			units[unitCount++] = 0xd800 + (codePoint >> 10);
			units[unitCount++] = 0xdc00 + (codePoint & 0x3ff);
		} else {
			if (unitCount === units.length) {
				flush();
			}
			units[unitCount++] = codePoint;
		}
	}
	if (unitCount > 0) {
		flush();
	}
	return parts.length === 1 ? parts[0]! : parts.join('');
}
