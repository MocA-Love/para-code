// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** MobileがDesktop Stateで確認する、後方互換なupload encoding名。 */
export const FS_BINARY_UPLOAD_ENCODING = 'fs-binary-v1';

const HEADER_BYTES = 12;
const MAGIC = [0x50, 0x46, 0x55, 0x01] as const; // "PFU" + wire version 1
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BinaryFsUploadMetadata {
	readonly id: string;
	readonly protocolVersion: 3;
	readonly desktopEpoch: string;
	readonly windowId: number;
	readonly ws: string;
	readonly name: string;
}

export interface BinaryFsUpload extends BinaryFsUploadMetadata {
	readonly t: 'upload';
	readonly base64Length: number;
	readonly data: Uint8Array;
}

/** VS Codeの既存decodeBase64と同じ文字集合・padding許容で、標準Base64を復号する。 */
function decodeBase64(text: string): Uint8Array {
	let building = 0;
	let remainder = 0;
	let outputIndex = 0;
	const output = new Uint8Array(Math.floor(text.length / 4 * 3));
	const append = (value: number) => {
		switch (remainder) {
			case 3:
				output[outputIndex++] = building | value;
				remainder = 0;
				break;
			case 2:
				output[outputIndex++] = building | (value >>> 2);
				building = value << 6;
				remainder = 3;
				break;
			case 1:
				output[outputIndex++] = building | (value >>> 4);
				building = value << 4;
				remainder = 2;
				break;
			default:
				building = value << 2;
				remainder = 1;
		}
	};
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 65 && code <= 90) {
			append(code - 65);
		} else if (code >= 97 && code <= 122) {
			append(code - 97 + 26);
		} else if (code >= 48 && code <= 57) {
			append(code - 48 + 52);
		} else if (code === 43 || code === 45) {
			append(62);
		} else if (code === 47 || code === 95) {
			append(63);
		} else if (code === 61) {
			break;
		} else {
			throw new SyntaxError(`Unexpected base64 character ${text[index]}`);
		}
	}
	const unpaddedLength = outputIndex;
	while (remainder > 0) {
		append(0);
	}
	return output.subarray(0, unpaddedLength);
}

function validMetadata<T extends Partial<BinaryFsUploadMetadata>>(metadata: T): metadata is T & BinaryFsUploadMetadata {
	return metadata.protocolVersion === 3
		&& typeof metadata.id === 'string' && metadata.id.length > 0
		&& typeof metadata.desktopEpoch === 'string' && metadata.desktopEpoch.length > 0
		&& typeof metadata.windowId === 'number'
		&& Number.isSafeInteger(metadata.windowId)
		&& typeof metadata.ws === 'string' && metadata.ws.length > 0
		&& typeof metadata.name === 'string' && metadata.name.length > 0;
}

export function isBinaryFsUpload(payload: Uint8Array): boolean {
	return payload.length >= HEADER_BYTES
		&& payload[0] === MAGIC[0]
		&& payload[1] === MAGIC[1]
		&& payload[2] === MAGIC[2]
		&& payload[3] === MAGIC[3];
}

/** Base64画像をbinary fs upload v1へ可逆変換する。失敗時は従来JSONへ戻せる。 */
export function encodeBinaryFsUpload(metadata: BinaryFsUploadMetadata, dataBase64: string): Uint8Array | undefined {
	if (!validMetadata(metadata)) {
		return undefined;
	}
	try {
		const data = decodeBase64(dataBase64);
		const metadataBytes = encoder.encode(JSON.stringify({ ...metadata, t: 'upload', base64Length: dataBase64.length }));
		if (metadataBytes.length === 0 || metadataBytes.length > 0xffff || data.length > 0xffffffff) {
			return undefined;
		}
		const payload = new Uint8Array(HEADER_BYTES + metadataBytes.length + data.length);
		payload.set(MAGIC, 0);
		const view = new DataView(payload.buffer);
		view.setUint16(6, metadataBytes.length, false);
		view.setUint32(8, data.length, false);
		payload.set(metadataBytes, HEADER_BYTES);
		payload.set(data, HEADER_BYTES + metadataBytes.length);
		return payload;
	} catch {
		return undefined;
	}
}

/** binary fs upload v1を検証してrouting metadataとraw file bytesへ戻す。 */
export function decodeBinaryFsUpload(payload: Uint8Array): BinaryFsUpload | undefined {
	if (!isBinaryFsUpload(payload) || payload[4] !== 0 || payload[5] !== 0) {
		return undefined;
	}
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const metadataLength = view.getUint16(6, false);
	const dataLength = view.getUint32(8, false);
	const dataOffset = HEADER_BYTES + metadataLength;
	if (metadataLength === 0 || dataOffset + dataLength !== payload.length) {
		return undefined;
	}
	try {
		const metadata = JSON.parse(decoder.decode(payload.subarray(HEADER_BYTES, dataOffset))) as Partial<BinaryFsUpload>;
		if (metadata.t !== 'upload' || metadata.protocolVersion !== 3 || typeof metadata.id !== 'string'
			|| typeof metadata.desktopEpoch !== 'string' || typeof metadata.windowId !== 'number'
			|| typeof metadata.ws !== 'string' || typeof metadata.name !== 'string'
			|| typeof metadata.base64Length !== 'number' || !Number.isSafeInteger(metadata.base64Length) || metadata.base64Length < 0
			|| metadata.base64Length < Math.ceil(dataLength * 4 / 3)
			|| !validMetadata(metadata)) {
			return undefined;
		}
		return {
			id: metadata.id,
			protocolVersion: 3,
			desktopEpoch: metadata.desktopEpoch,
			windowId: metadata.windowId,
			ws: metadata.ws,
			name: metadata.name,
			t: 'upload',
			base64Length: metadata.base64Length,
			data: payload.subarray(dataOffset),
		};
	} catch {
		return undefined;
	}
}
