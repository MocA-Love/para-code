// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Mobileがterminal attachで明示する、後方互換なdata encoding名。 */
export const TERMINAL_BINARY_DATA_ENCODING = 'terminal-binary-v1';

const HEADER_BYTES = 12;
const MAGIC = [0x50, 0x54, 0x44, 0x01] as const; // "PTD" + wire version 1
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BinaryTerminalDataMetadata {
	readonly terminalKey: string;
	readonly epoch: number;
	readonly seq: number;
	readonly snapshot?: true;
	readonly cols?: number;
	readonly rows?: number;
	readonly unicode?: string;
}

export interface BinaryTerminalData extends BinaryTerminalDataMetadata {
	readonly t: 'data';
	readonly data: string;
}

function isReversibleUtf8(value: string): boolean {
	return decoder.decode(encoder.encode(value)) === value;
}

function decodeReversibleUtf8(value: Uint8Array): string | undefined {
	const decoded = decoder.decode(value);
	const encoded = encoder.encode(decoded);
	if (encoded.length !== value.length || encoded.some((byte, index) => byte !== value[index])) {
		return undefined;
	}
	return decoded;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidMetadata(metadata: Partial<BinaryTerminalDataMetadata>): metadata is BinaryTerminalDataMetadata {
	return typeof metadata.terminalKey === 'string' && metadata.terminalKey.length > 0 && metadata.terminalKey.length <= 200 && isReversibleUtf8(metadata.terminalKey)
		&& typeof metadata.epoch === 'number' && Number.isSafeInteger(metadata.epoch) && metadata.epoch >= 0
		&& typeof metadata.seq === 'number' && Number.isSafeInteger(metadata.seq) && metadata.seq >= 0
		&& (metadata.snapshot === undefined || metadata.snapshot === true)
		&& (metadata.cols === undefined || isPositiveSafeInteger(metadata.cols))
		&& (metadata.rows === undefined || isPositiveSafeInteger(metadata.rows))
		&& (metadata.unicode === undefined || (typeof metadata.unicode === 'string' && metadata.unicode.length > 0 && isReversibleUtf8(metadata.unicode)));
}

export function isBinaryTerminalData(payload: Uint8Array): boolean {
	return payload.length >= HEADER_BYTES
		&& payload[0] === MAGIC[0]
		&& payload[1] === MAGIC[1]
		&& payload[2] === MAGIC[2]
		&& payload[3] === MAGIC[3];
}

/** terminal dataをbinary v1へ可逆変換する。表現不能時は従来JSONへ戻せる。 */
export function encodeBinaryTerminalData(metadata: BinaryTerminalDataMetadata, data: string): Uint8Array | undefined {
	if (!isValidMetadata(metadata) || !isReversibleUtf8(data)) {
		return undefined;
	}
	const metadataBytes = encoder.encode(JSON.stringify(metadata));
	const dataBytes = encoder.encode(data);
	if (metadataBytes.length === 0 || metadataBytes.length > 0xffff || dataBytes.length > 0xffffffff) {
		return undefined;
	}
	const payload = new Uint8Array(HEADER_BYTES + metadataBytes.length + dataBytes.length);
	payload.set(MAGIC, 0);
	const view = new DataView(payload.buffer);
	view.setUint16(6, metadataBytes.length, false);
	view.setUint32(8, dataBytes.length, false);
	payload.set(metadataBytes, HEADER_BYTES);
	payload.set(dataBytes, HEADER_BYTES + metadataBytes.length);
	return payload;
}

/** binary terminal data v1を検証し、従来のterminal data message形へ戻す。 */
export function decodeBinaryTerminalData(payload: Uint8Array): BinaryTerminalData | undefined {
	if (!isBinaryTerminalData(payload) || payload[4] !== 0 || payload[5] !== 0) {
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
		const metadataText = decodeReversibleUtf8(payload.subarray(HEADER_BYTES, dataOffset));
		const data = decodeReversibleUtf8(payload.subarray(dataOffset));
		if (metadataText === undefined || data === undefined) {
			return undefined;
		}
		const metadata = JSON.parse(metadataText) as Partial<BinaryTerminalDataMetadata>;
		if (!isValidMetadata(metadata)) {
			return undefined;
		}
		return { ...metadata, t: 'data', data };
	} catch {
		return undefined;
	}
}
