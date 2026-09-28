/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * minidump を送る前に「どのプロセスが落ちたか」を読むための最小限のパーサ。
 *
 * `@sentry/electron` の minidump 送信は `platform: 'native'` の空のイベントに dmp を添付するだけで、
 * スタックも `debug_meta.images` もサーバー側の symbolicator が後から作る。そのため beforeSend の
 * 時点ではイベントから外部プロセスかどうかを判定できない（`paradisIsForeignNativeCrash` が
 * 常に fail-open で残していた）。添付の dmp そのものは beforeSend の hint に載っているので、
 * モジュール一覧（MINIDUMP_MODULE_LIST）の先頭＝実行ファイルのパスをここで読む。
 *
 * 読んだパスは判定にだけ使い、イベントには載せない（利用者のホームなどを含み得る）。
 */

const MINIDUMP_SIGNATURE = 0x504d444d; // 'MDMP' little-endian
const MODULE_LIST_STREAM = 4;
const MINIDUMP_HEADER_SIZE = 32;
const MINIDUMP_DIRECTORY_SIZE = 12;
const MINIDUMP_MODULE_SIZE = 108;
const MODULE_NAME_RVA_OFFSET = 20;
/** Guards against a malformed dump making us walk an absurd directory. */
const MAX_STREAMS = 256;
/** A module name longer than this is not a path we need; it is a corrupt dump. */
const MAX_MODULE_NAME_BYTES = 8 * 1024;

/**
 * The attachment shape `@sentry/electron` passes in the capture hint (`event.minidump` with the raw
 * file contents), reduced to what is read here.
 */
export interface IParadisSentryAttachment {
	readonly attachmentType?: string;
	readonly data?: unknown;
}

function asBytes(data: unknown): Uint8Array | undefined {
	return data instanceof Uint8Array ? data : undefined;
}

/**
 * Returns the path of the crashed process's executable (the first module of the module list), or
 * `undefined` when the dump is missing, malformed or has no module list. Never throws.
 */
export function paradisReadMinidumpExecutablePath(data: Uint8Array): string | undefined {
	try {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		if (data.byteLength < MINIDUMP_HEADER_SIZE || view.getUint32(0, true) !== MINIDUMP_SIGNATURE) {
			return undefined;
		}
		const streamCount = view.getUint32(8, true);
		const directoryRva = view.getUint32(12, true);
		for (let index = 0; index < Math.min(streamCount, MAX_STREAMS); index++) {
			const entry = directoryRva + index * MINIDUMP_DIRECTORY_SIZE;
			if (entry + MINIDUMP_DIRECTORY_SIZE > data.byteLength) {
				return undefined;
			}
			if (view.getUint32(entry, true) !== MODULE_LIST_STREAM) {
				continue;
			}
			const listRva = view.getUint32(entry + 8, true);
			if (listRva + 4 + MINIDUMP_MODULE_SIZE > data.byteLength || view.getUint32(listRva, true) === 0) {
				return undefined;
			}
			// MINIDUMP_MODULE is packed to 4 bytes, so the first entry starts right after the count.
			const nameRva = view.getUint32(listRva + 4 + MODULE_NAME_RVA_OFFSET, true);
			if (nameRva + 4 > data.byteLength) {
				return undefined;
			}
			// MINIDUMP_STRING: a byte length, then UTF-16LE without the terminator.
			const byteLength = view.getUint32(nameRva, true);
			if (byteLength === 0 || byteLength > MAX_MODULE_NAME_BYTES || byteLength % 2 !== 0 || nameRva + 4 + byteLength > data.byteLength) {
				return undefined;
			}
			let name = '';
			for (let offset = 0; offset < byteLength; offset += 2) {
				name += String.fromCharCode(view.getUint16(nameRva + 4 + offset, true));
			}
			return name;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Reads the crashed executable's path from the minidump attached to a capture, if there is one. */
export function paradisMinidumpExecutablePath(attachments: readonly IParadisSentryAttachment[] | undefined): string | undefined {
	for (const attachment of attachments ?? []) {
		if (attachment.attachmentType !== 'event.minidump') {
			continue;
		}
		const bytes = asBytes(attachment.data);
		if (bytes) {
			return paradisReadMinidumpExecutablePath(bytes);
		}
	}
	return undefined;
}
