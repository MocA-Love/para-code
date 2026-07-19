// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** バイト列ユーティリティ（Node / Cloudflare Workers / React Native 共通の純JS実装）。 */

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((sum, a) => sum + a.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const a of arrays) {
		out.set(a, offset);
		offset += a.length;
	}
	return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64Url(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] ?? 0;
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		out += BASE64URL_ALPHABET[b0 >> 2];
		out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
		if (b1 !== undefined) {
			out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
		}
		if (b2 !== undefined) {
			out += BASE64URL_ALPHABET[b2 & 0x3f];
		}
	}
	return out;
}

/** data URI等で使うRFC 4648標準Base64（paddingあり）。 */
export function toBase64(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] ?? 0;
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		out += BASE64_ALPHABET[b0 >> 2];
		out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
		if (b1 === undefined) {
			out += '==';
			continue;
		}
		out += BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
		if (b2 === undefined) {
			out += '=';
			continue;
		}
		out += BASE64_ALPHABET[b2 & 0x3f];
	}
	return out;
}

export function fromBase64Url(text: string): Uint8Array {
	const len = text.length;
	const rem = len % 4;
	if (rem === 1) {
		throw new Error('invalid base64url length');
	}
	const outLen = Math.floor((len * 3) / 4);
	const out = new Uint8Array(outLen);
	let outPos = 0;
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < len; i++) {
		const idx = BASE64URL_ALPHABET.indexOf(text[i] ?? '');
		if (idx < 0) {
			throw new Error(`invalid base64url character at ${i}`);
		}
		buffer = (buffer << 6) | idx;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[outPos++] = (buffer >> bits) & 0xff;
		}
	}
	return out.subarray(0, outPos);
}
