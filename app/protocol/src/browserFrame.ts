// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { toBase64 } from './util.js';

/** Mobileがbrowser start要求で明示する、後方互換なフレームencoding名。 */
export const BROWSER_JPEG_BINARY_ENCODING = 'jpeg-binary-v1';

const HEADER_BYTES = 12;
const MAGIC = [0x50, 0x4a, 0x46, 0x01] as const; // "PJF" + wire version 1

export interface BrowserJpegFrame {
	readonly data: string;
	readonly w: number;
	readonly h: number;
}

export function isBinaryBrowserJpegFrame(payload: Uint8Array): boolean {
	return payload.length >= HEADER_BYTES + 1
		&& payload[0] === MAGIC[0]
		&& payload[1] === MAGIC[1]
		&& payload[2] === MAGIC[2]
		&& payload[3] === MAGIC[3];
}

/** binary JPEG v1を従来のMobile表示モデルへ可逆変換する。未知・不正形式は取り込まない。 */
export function decodeBinaryBrowserJpegFrame(payload: Uint8Array): BrowserJpegFrame | undefined {
	if (!isBinaryBrowserJpegFrame(payload)) {
		return undefined;
	}
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	return {
		data: toBase64(payload.subarray(HEADER_BYTES)),
		w: view.getUint32(4, false),
		h: view.getUint32(8, false),
	};
}
