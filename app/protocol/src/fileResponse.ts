// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Mobileがファイル閲覧要求で明示する、後方互換な応答encoding名。 */
export const FS_BINARY_RESPONSE_ENCODING = 'fs-binary-v1';

const HEADER_BYTES = 12;
const MAGIC = [0x50, 0x46, 0x42, 0x01] as const; // "PFB" + wire version 1
const decoder = new TextDecoder();

export type BinaryFsResponseType = 'pdf' | 'docx' | 'media';

export interface BinaryFsResponse {
	readonly id: string;
	readonly t: BinaryFsResponseType;
	readonly size: number;
	readonly data: Uint8Array;
}

export function isBinaryFsResponse(payload: Uint8Array): boolean {
	return payload.length >= HEADER_BYTES
		&& payload[0] === MAGIC[0]
		&& payload[1] === MAGIC[1]
		&& payload[2] === MAGIC[2]
		&& payload[3] === MAGIC[3];
}

/** binary fs response v1を検証して分解する。未知・不正形式は取り込まない。 */
export function decodeBinaryFsResponse(payload: Uint8Array): BinaryFsResponse | undefined {
	if (!isBinaryFsResponse(payload) || payload[5] !== 0) {
		return undefined;
	}
	const type: BinaryFsResponseType | undefined = payload[4] === 1 ? 'pdf' : payload[4] === 2 ? 'docx' : payload[4] === 3 ? 'media' : undefined;
	if (type === undefined) {
		return undefined;
	}
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const idLength = view.getUint16(6, false);
	const dataOffset = HEADER_BYTES + idLength;
	if (idLength === 0 || dataOffset > payload.length) {
		return undefined;
	}
	const id = decoder.decode(payload.subarray(HEADER_BYTES, dataOffset));
	if (id.length === 0) {
		return undefined;
	}
	return {
		id,
		t: type,
		size: view.getUint32(8, false),
		data: payload.subarray(dataOffset),
	};
}
