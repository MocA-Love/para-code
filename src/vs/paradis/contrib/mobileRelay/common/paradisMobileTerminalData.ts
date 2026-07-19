/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_TERMINAL_BINARY_DATA_ENCODING = 'terminal-binary-v1';

export interface IParadisBinaryTerminalDataMetadata {
	readonly terminalKey: string;
	readonly epoch: number;
	readonly seq: number;
	readonly snapshot?: true;
	readonly cols?: number;
	readonly rows?: number;
	readonly unicode?: string;
}

const HEADER_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isReversibleUtf8(value: string): boolean {
	return decoder.decode(encoder.encode(value)) === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidMetadata(metadata: IParadisBinaryTerminalDataMetadata): boolean {
	return typeof metadata.terminalKey === 'string' && metadata.terminalKey.length > 0 && metadata.terminalKey.length <= 200 && isReversibleUtf8(metadata.terminalKey)
		&& typeof metadata.epoch === 'number' && Number.isSafeInteger(metadata.epoch) && metadata.epoch >= 0
		&& typeof metadata.seq === 'number' && Number.isSafeInteger(metadata.seq) && metadata.seq >= 0
		&& (metadata.snapshot === undefined || metadata.snapshot === true)
		&& (metadata.cols === undefined || isPositiveSafeInteger(metadata.cols))
		&& (metadata.rows === undefined || isPositiveSafeInteger(metadata.rows))
		&& (metadata.unicode === undefined || (typeof metadata.unicode === 'string' && metadata.unicode.length > 0 && isReversibleUtf8(metadata.unicode)));
}

/** terminal dataをbinary v1へ可逆変換する。表現不能時は従来JSONへ戻せる。 */
export function paradisEncodeBinaryTerminalData(metadata: IParadisBinaryTerminalDataMetadata, data: string): Uint8Array | undefined {
	if (!isValidMetadata(metadata) || !isReversibleUtf8(data)) {
		return undefined;
	}
	const metadataBytes = encoder.encode(JSON.stringify(metadata));
	const dataBytes = encoder.encode(data);
	if (metadataBytes.length === 0 || metadataBytes.length > 0xffff || dataBytes.length > 0xffffffff) {
		return undefined;
	}
	const payload = new Uint8Array(HEADER_BYTES + metadataBytes.length + dataBytes.length);
	payload.set([0x50, 0x54, 0x44, 0x01, 0, 0], 0); // "PTD" + wire version 1 + reserved
	const view = new DataView(payload.buffer);
	view.setUint16(6, metadataBytes.length, false);
	view.setUint32(8, dataBytes.length, false);
	payload.set(metadataBytes, HEADER_BYTES);
	payload.set(dataBytes, HEADER_BYTES + metadataBytes.length);
	return payload;
}

/** 旧MobileにはJSONを維持し、明示交渉した購読だけbinary v1を使う。 */
export function paradisEncodeNegotiatedBinaryTerminalData(encoding: unknown, metadata: IParadisBinaryTerminalDataMetadata, data: string): Uint8Array | undefined {
	return encoding === PARADIS_TERMINAL_BINARY_DATA_ENCODING
		? paradisEncodeBinaryTerminalData(metadata, data)
		: undefined;
}
