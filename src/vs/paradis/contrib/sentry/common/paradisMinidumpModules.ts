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
 *
 * もう1つ、crashpad の注記（MinidumpCrashpadInfo）から、こちらが Node モードの子に付けた役割の印
 * （`paradisCrashRole.ts`）も読む。こちらは決まった語だけなので、照合したうえでタグにする。
 */

const MINIDUMP_SIGNATURE = 0x504d444d; // 'MDMP' little-endian
const MODULE_LIST_STREAM = 4;
/** MinidumpCrashpadInfo: the annotations crashpad records, Electron's own (`ptype`, `pid`) among them. */
const CRASHPAD_INFO_STREAM = 0x43500001;
/** `version`, then the 16-byte `report_id` and `client_id`. */
const CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET = 36;
const CRASHPAD_INFO_MODULE_LIST_OFFSET = 44;
/** MinidumpModuleCrashpadInfoLink: module index, then the location of its MinidumpModuleCrashpadInfo. */
const CRASHPAD_MODULE_LINK_SIZE = 12;
/** MinidumpModuleCrashpadInfo: `version`, `list_annotations`, `simple_annotations`, `annotation_objects`. */
const CRASHPAD_MODULE_SIMPLE_ANNOTATIONS_OFFSET = 12;
const CRASHPAD_MODULE_ANNOTATION_OBJECTS_OFFSET = 20;
/** MinidumpAnnotation: name RVA, `type` and `reserved` (u16 each), value RVA. */
const CRASHPAD_ANNOTATION_SIZE = 12;
const CRASHPAD_SIMPLE_ENTRY_SIZE = 8;
/** crashpad::Annotation::Type::kString. */
const CRASHPAD_ANNOTATION_STRING = 1;
/** Guards against a malformed dump making us walk an absurd annotation or module list. */
const MAX_CRASHPAD_ENTRIES = 1024;
/** Annotation names and the values we look for are short; anything longer is not one of ours. */
const MAX_ANNOTATION_BYTES = 256;
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

/** The RVA of the first stream of `streamType` in the directory, or `undefined`. */
function readStreamRva(view: DataView, byteLength: number, streamType: number): number | undefined {
	if (byteLength < MINIDUMP_HEADER_SIZE || view.getUint32(0, true) !== MINIDUMP_SIGNATURE) {
		return undefined;
	}
	const streamCount = view.getUint32(8, true);
	const directoryRva = view.getUint32(12, true);
	for (let index = 0; index < Math.min(streamCount, MAX_STREAMS); index++) {
		const entry = directoryRva + index * MINIDUMP_DIRECTORY_SIZE;
		if (entry + MINIDUMP_DIRECTORY_SIZE > byteLength) {
			return undefined;
		}
		if (view.getUint32(entry, true) === streamType) {
			return view.getUint32(entry + 8, true);
		}
	}
	return undefined;
}

/**
 * Returns the path of the crashed process's executable (the first module of the module list), or
 * `undefined` when the dump is missing, malformed or has no module list. Never throws.
 */
export function paradisReadMinidumpExecutablePath(data: Uint8Array): string | undefined {
	try {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const listRva = readStreamRva(view, data.byteLength, MODULE_LIST_STREAM);
		if (listRva === undefined || listRva + 4 + MINIDUMP_MODULE_SIZE > data.byteLength || view.getUint32(listRva, true) === 0) {
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
	} catch {
		return undefined;
	}
}

/** A length-prefixed UTF-8 string or byte array (MinidumpUTF8String / MinidumpByteArray). */
function readSizedText(data: Uint8Array, view: DataView, rva: number): string | undefined {
	if (rva === 0 || rva + 4 > data.byteLength) {
		return undefined;
	}
	const length = view.getUint32(rva, true);
	if (length > MAX_ANNOTATION_BYTES || rva + 4 + length > data.byteLength) {
		return undefined;
	}
	return new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(rva + 4, rva + 4 + length));
}

/** Looks `name` up in a MinidumpSimpleStringDictionary. */
function readSimpleAnnotation(data: Uint8Array, view: DataView, location: number, name: string): string | undefined {
	if (view.getUint32(location, true) === 0) {
		return undefined;
	}
	const rva = view.getUint32(location + 4, true);
	if (rva + 4 > data.byteLength) {
		return undefined;
	}
	const count = Math.min(view.getUint32(rva, true), MAX_CRASHPAD_ENTRIES);
	for (let index = 0; index < count; index++) {
		const entry = rva + 4 + index * CRASHPAD_SIMPLE_ENTRY_SIZE;
		if (entry + CRASHPAD_SIMPLE_ENTRY_SIZE > data.byteLength) {
			return undefined;
		}
		if (readSizedText(data, view, view.getUint32(entry, true)) === name) {
			return readSizedText(data, view, view.getUint32(entry + 4, true));
		}
	}
	return undefined;
}

/** Looks `name` up in a MinidumpAnnotationList (string annotations only). */
function readAnnotationObject(data: Uint8Array, view: DataView, location: number, name: string): string | undefined {
	if (view.getUint32(location, true) === 0) {
		return undefined;
	}
	const rva = view.getUint32(location + 4, true);
	if (rva + 4 > data.byteLength) {
		return undefined;
	}
	const count = Math.min(view.getUint32(rva, true), MAX_CRASHPAD_ENTRIES);
	for (let index = 0; index < count; index++) {
		const entry = rva + 4 + index * CRASHPAD_ANNOTATION_SIZE;
		if (entry + CRASHPAD_ANNOTATION_SIZE > data.byteLength) {
			return undefined;
		}
		if (view.getUint16(entry + 4, true) === CRASHPAD_ANNOTATION_STRING && readSizedText(data, view, view.getUint32(entry, true)) === name) {
			return readSizedText(data, view, view.getUint32(entry + 8, true));
		}
	}
	return undefined;
}

/**
 * Returns the value of the crashpad annotation `name`, or `undefined` when the dump has none or is
 * malformed. Never throws.
 *
 * Electron's crash keys, including those set with `crashReporter.addExtraParameter`, are annotation
 * objects of the Electron framework module (`Electron Framework` in Sentry's event contexts); the
 * dump-wide and per-module simple dictionaries are searched too.
 */
export function paradisReadMinidumpAnnotation(data: Uint8Array, name: string): string | undefined {
	try {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const infoRva = readStreamRva(view, data.byteLength, CRASHPAD_INFO_STREAM);
		if (infoRva === undefined || infoRva + CRASHPAD_INFO_MODULE_LIST_OFFSET + 8 > data.byteLength) {
			return undefined;
		}
		const simple = readSimpleAnnotation(data, view, infoRva + CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET, name);
		if (simple !== undefined) {
			return simple;
		}
		if (view.getUint32(infoRva + CRASHPAD_INFO_MODULE_LIST_OFFSET, true) === 0) {
			return undefined;
		}
		const listRva = view.getUint32(infoRva + CRASHPAD_INFO_MODULE_LIST_OFFSET + 4, true);
		if (listRva + 4 > data.byteLength) {
			return undefined;
		}
		const modules = Math.min(view.getUint32(listRva, true), MAX_CRASHPAD_ENTRIES);
		for (let index = 0; index < modules; index++) {
			const link = listRva + 4 + index * CRASHPAD_MODULE_LINK_SIZE;
			if (link + CRASHPAD_MODULE_LINK_SIZE > data.byteLength) {
				return undefined;
			}
			const moduleRva = view.getUint32(link + 8, true);
			if (moduleRva + CRASHPAD_MODULE_ANNOTATION_OBJECTS_OFFSET + 8 > data.byteLength) {
				continue;
			}
			const value = readAnnotationObject(data, view, moduleRva + CRASHPAD_MODULE_ANNOTATION_OBJECTS_OFFSET, name)
				?? readSimpleAnnotation(data, view, moduleRva + CRASHPAD_MODULE_SIMPLE_ANNOTATIONS_OFFSET, name);
			if (value !== undefined) {
				return value;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Reads the crashpad annotation `name` from the minidump attached to a capture, if there is one. */
export function paradisMinidumpAnnotation(attachments: readonly IParadisSentryAttachment[] | undefined, name: string): string | undefined {
	for (const attachment of attachments ?? []) {
		if (attachment.attachmentType !== 'event.minidump') {
			continue;
		}
		const bytes = asBytes(attachment.data);
		if (bytes) {
			return paradisReadMinidumpAnnotation(bytes, name);
		}
	}
	return undefined;
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
