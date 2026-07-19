// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { gunzipSync } from 'fflate';

/** Mobileが大容量JSON要求で明示する、後方互換なgzip response encoding名。 */
export const JSON_GZIP_RESPONSE_ENCODING = 'json-gzip-v1';

const HEADER_BYTES = 12;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAGIC = [0x50, 0x43, 0x4a, 0x01] as const; // "PCJ" + wire version 1

/** payloadがgzip JSON response v1のmagicを持つか判定する。 */
export function isGzipJsonResponse(payload: Uint8Array): boolean {
	return payload.length >= HEADER_BYTES
		&& payload[0] === MAGIC[0]
		&& payload[1] === MAGIC[1]
		&& payload[2] === MAGIC[2]
		&& payload[3] === MAGIC[3];
}

/** gzip JSON response v1を検証し、従来と同じUTF-8 JSON bytesへ戻す。 */
export function decodeGzipJsonResponse(payload: Uint8Array): Uint8Array | undefined {
	if (!isGzipJsonResponse(payload) || payload[4] !== 1 || payload[5] !== 0 || payload[6] !== 0 || payload[7] !== 0) {
		return undefined;
	}
	const expectedLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(8, false);
	if (expectedLength === 0 || expectedLength > MAX_JSON_BYTES || payload.length === HEADER_BYTES) {
		return undefined;
	}
	try {
		// 宣言長+1に展開先を制限し、gzip footerや実データが不正でも無制限に確保しない。
		const decoded = gunzipSync(payload.subarray(HEADER_BYTES), { out: new Uint8Array(expectedLength + 1) });
		return decoded.length === expectedLength ? decoded : undefined;
	} catch {
		return undefined;
	}
}
