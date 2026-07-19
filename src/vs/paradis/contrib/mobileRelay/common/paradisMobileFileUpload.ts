/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_FS_BINARY_UPLOAD_ENCODING = 'fs-binary-v1';

export interface IParadisBinaryFsUpload {
	readonly t: 'upload';
	readonly id: string;
	readonly protocolVersion: 3;
	readonly desktopEpoch: string;
	readonly windowId: number;
	readonly ws: string;
	readonly name: string;
	readonly base64Length: number;
	readonly data: Uint8Array;
}

const HEADER_BYTES = 12;
const decoder = new TextDecoder();

function isBinaryFsUpload(payload: Uint8Array): boolean {
	return payload.length >= HEADER_BYTES
		&& payload[0] === 0x50
		&& payload[1] === 0x46
		&& payload[2] === 0x55
		&& payload[3] === 0x01;
}

/** binary fs upload v1を検証し、shared process routingとRenderer保存に共用する。 */
export function paradisDecodeBinaryFsUpload(payload: Uint8Array): IParadisBinaryFsUpload | undefined {
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
		const metadata = JSON.parse(decoder.decode(payload.subarray(HEADER_BYTES, dataOffset))) as Partial<IParadisBinaryFsUpload>;
		if (metadata.t !== 'upload' || metadata.protocolVersion !== 3 || typeof metadata.id !== 'string' || metadata.id.length === 0
			|| typeof metadata.desktopEpoch !== 'string' || metadata.desktopEpoch.length === 0
			|| typeof metadata.windowId !== 'number' || !Number.isSafeInteger(metadata.windowId)
			|| typeof metadata.ws !== 'string' || metadata.ws.length === 0
			|| typeof metadata.name !== 'string' || metadata.name.length === 0
			|| typeof metadata.base64Length !== 'number' || !Number.isSafeInteger(metadata.base64Length) || metadata.base64Length < Math.ceil(dataLength * 4 / 3)) {
			return undefined;
		}
		return {
			t: 'upload',
			id: metadata.id,
			protocolVersion: 3,
			desktopEpoch: metadata.desktopEpoch,
			windowId: metadata.windowId,
			ws: metadata.ws,
			name: metadata.name,
			base64Length: metadata.base64Length,
			data: payload.subarray(dataOffset),
		};
	} catch {
		return undefined;
	}
}
