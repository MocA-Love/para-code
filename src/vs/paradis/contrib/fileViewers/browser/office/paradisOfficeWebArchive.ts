/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import { type IParadisOfficeArchive, type ParadisOfficeArchiveEntry, type ParadisOfficeXmlDocument, ParadisOfficePackageError, throwIfParadisOfficeCancelled } from '../../common/office/paradisOfficeArchive.js';
import { parseParadisOfficeXml, type ParadisOfficeXmlLimits } from '../../common/office/paradisOfficeCanonicalXml.js';

/** Browser/Worker ZIP primitive. Its stream is decompressed lazily and supports iterator return. */
export interface IParadisOfficeWebZipPrimitive {
	entries(): AsyncIterable<ParadisOfficeArchiveEntry>;
	read(entry: ParadisOfficeArchiveEntry, signal: AbortSignal): AsyncIterable<Uint8Array>;
	close(): void;
}

/** Creates a concrete browser/Worker archive from an owned JSZip input copy. */
export async function createParadisOfficeWebArchive(bytes: Uint8Array): Promise<ParadisOfficeWebArchive> {

	if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(bytes.byteLength)) {
		throw new ParadisOfficePackageError('invalid');
	}
	const owned = bytes.slice();
	return new ParadisOfficeWebArchive(new NativeZipPrimitive(owned), owned.byteLength);
}

/** Browser-safe adapter: no Node modules, DOM parsing, or raw ZIP implementation leaks. */
export class ParadisOfficeWebArchive implements IParadisOfficeArchive {

	private closed = false;

	constructor(private readonly primitive: IParadisOfficeWebZipPrimitive, readonly containerByteLength = 0) { }

	async *entries(token?: CancellationToken): AsyncIterable<ParadisOfficeArchiveEntry> {
		try {
			for await (const entry of this.primitive.entries()) {
				throwIfParadisOfficeCancelled(token);
				yield entry;
			}
		} catch (error) {
			if (error instanceof ParadisOfficePackageError) { throw error; }
			throw new ParadisOfficePackageError(token?.isCancellationRequested ? 'cancelled' : 'invalid');
		}
	}

	async *read(entry: ParadisOfficeArchiveEntry, token?: CancellationToken): AsyncIterable<Uint8Array> {
		const controller = new AbortController();
		const listener = token?.onCancellationRequested(() => controller.abort());
		try {
			for await (const chunk of this.primitive.read(entry, controller.signal)) {
				throwIfParadisOfficeCancelled(token);
				yield chunk;
			}
		} catch (error) {
			if (error instanceof ParadisOfficePackageError) { throw error; }
			throw new ParadisOfficePackageError(token?.isCancellationRequested ? 'cancelled' : 'invalid');
		} finally {
			controller.abort();
			listener?.dispose();
		}
	}

	async hash(bytes: Uint8Array): Promise<ParadisOfficeFingerprint> {
		const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
		return { algorithm: 'sha256', value: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''), byteLength: bytes.byteLength };
	}

	async parseXml(xml: string, limits: ParadisOfficeXmlLimits, token?: CancellationToken, checkpoint?: () => void): Promise<ParadisOfficeXmlDocument> {
		return parseParadisOfficeXml(xml, limits, token, checkpoint);
	}

	dispose(): void {
		if (!this.closed) { this.closed = true; this.primitive.close(); }
	}
}

class NativeZipPrimitive implements IParadisOfficeWebZipPrimitive {
	private closed = false;
	private readonly entriesByIdentity = new WeakMap<ParadisOfficeArchiveEntry, NativeZipEntry>();
	private readonly records: readonly NativeZipEntry[];

	constructor(private readonly bytes: Uint8Array) {
		this.records = parseNativeZipCentralDirectory(bytes);
	}

	async *entries(): AsyncIterable<ParadisOfficeArchiveEntry> {
		for (const object of this.records) {
			if (this.closed) { return; }
			const entry: ParadisOfficeArchiveEntry = {
				name: object.name, compressedBytes: object.compressedBytes, declaredExpandedBytes: object.expandedBytes, crc32: object.crc32,
				encrypted: (object.flags & 1) !== 0, directory: object.name.endsWith('/'),
				symlink: (object.unixMode & 0xf000) === 0xa000, unixMode: object.unixMode,
			};
			this.entriesByIdentity.set(entry, object);
			yield entry;
		}
	}

	async *read(entry: ParadisOfficeArchiveEntry, signal: AbortSignal): AsyncIterable<Uint8Array> {
		const object = this.entriesByIdentity.get(entry);
		if (!object || this.closed || signal.aborted) { throw new ParadisOfficePackageError(signal.aborted ? 'cancelled' : 'invalid'); }
		const compressed = localZipData(this.bytes, object);
		if (object.method === 0) {
			for (let offset = 0; offset < compressed.byteLength; offset += 64 * 1024) {
				if (signal.aborted) { throw new ParadisOfficePackageError('cancelled'); }
				yield compressed.slice(offset, Math.min(compressed.byteLength, offset + 64 * 1024));
			}
			return;
		}
		if (object.method !== 8 || typeof DecompressionStream === 'undefined') { throw new ParadisOfficePackageError('invalid'); }
		const ownedCompressed = new Uint8Array(compressed);
		const reader = new Blob([ownedCompressed.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
		try {
			while (true) {
				if (signal.aborted) { throw new ParadisOfficePackageError('cancelled'); }
				const next = await reader.read();
				if (next.done) { return; }
				yield next.value;
			}
		} catch (error) { if (error instanceof ParadisOfficePackageError) { throw error; } throw new ParadisOfficePackageError('invalid'); }
		finally { await reader.cancel(); }
	}

	close(): void { this.closed = true; }
}

interface NativeZipEntry {
	readonly name: string;
	readonly flags: number;
	readonly method: number;
	readonly compressedBytes: number;
	readonly expandedBytes: number;
	readonly crc32: number;
	readonly unixMode: number;
	readonly localOffset: number;
}

function parseNativeZipCentralDirectory(bytes: Uint8Array): readonly NativeZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let offset = Math.max(0, bytes.byteLength - 65_557); offset <= bytes.byteLength - 22; offset++) { if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; } }
	if (eocd < 0 || view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) { throw new ParadisOfficePackageError('invalid'); }
	if (eocd + 22 + view.getUint16(eocd + 20, true) !== bytes.byteLength || view.getUint16(eocd + 8, true) !== view.getUint16(eocd + 10, true)) { throw new ParadisOfficePackageError('invalid'); }
	const count = view.getUint16(eocd + 10, true); const centralSize = view.getUint32(eocd + 12, true); const centralOffset = view.getUint32(eocd + 16, true); let offset = centralOffset;
	if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize > eocd) { throw new ParadisOfficePackageError('invalid'); }
	const decoder = new TextDecoder('utf-8', { fatal: true }); const entries: NativeZipEntry[] = [];
	for (let index = 0; index < count; index++) {
		if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) { throw new ParadisOfficePackageError('invalid'); }
		if (view.getUint16(offset + 34, true) === 0xffff || view.getUint32(offset + 20, true) === 0xffffffff || view.getUint32(offset + 24, true) === 0xffffffff || view.getUint32(offset + 42, true) === 0xffffffff) { throw new ParadisOfficePackageError('invalid'); }
		const nameLength = view.getUint16(offset + 28, true); const extraLength = view.getUint16(offset + 30, true); const commentLength = view.getUint16(offset + 32, true);
		const end = offset + 46 + nameLength + extraLength + commentLength; if (end > bytes.byteLength) { throw new ParadisOfficePackageError('invalid'); }
		entries.push({ name: decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength)), flags: view.getUint16(offset + 8, true), method: view.getUint16(offset + 10, true), crc32: view.getUint32(offset + 16, true), compressedBytes: view.getUint32(offset + 20, true), expandedBytes: view.getUint32(offset + 24, true), unixMode: view.getUint32(offset + 38, true) >>> 16, localOffset: view.getUint32(offset + 42, true) }); offset = end;
	}
	if (offset !== centralOffset + centralSize) { throw new ParadisOfficePackageError('invalid'); }
	return entries;
}

function localZipData(bytes: Uint8Array, entry: NativeZipEntry): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const offset = entry.localOffset;
	if (offset + 30 > bytes.byteLength || view.getUint32(offset, true) !== 0x04034b50) { throw new ParadisOfficePackageError('invalid'); }
	const flags = view.getUint16(offset + 6, true); const method = view.getUint16(offset + 8, true); const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true);
	if (flags !== entry.flags || method !== entry.method || new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(offset + 30, offset + 30 + nameLength)) !== entry.name) { throw new ParadisOfficePackageError('invalid'); }
	const localCrc = view.getUint32(offset + 14, true); const localCompressed = view.getUint32(offset + 18, true); const localExpanded = view.getUint32(offset + 22, true);
	if ((flags & 8) === 0 && (localCrc !== entry.crc32 || localCompressed !== entry.compressedBytes || localExpanded !== entry.expandedBytes)) { throw new ParadisOfficePackageError('invalid'); }
	if ((flags & 8) !== 0 && !((localCrc === 0 || localCrc === 0xffffffff) && (localCompressed === 0 || localCompressed === 0xffffffff) && (localExpanded === 0 || localExpanded === 0xffffffff))) { throw new ParadisOfficePackageError('invalid'); }
	const start = offset + 30 + nameLength + extraLength; const end = start + entry.compressedBytes;
	if (!Number.isSafeInteger(end) || end > bytes.byteLength) { throw new ParadisOfficePackageError('invalid'); }
	if ((flags & 8) !== 0) { validateDataDescriptor(view, end, entry); }
	return bytes.slice(start, end);
}

function validateDataDescriptor(view: DataView, offset: number, entry: NativeZipEntry): void {
	const signature = view.getUint32(offset, true); const start = signature === 0x08074b50 ? offset + 4 : offset;
	if (start + 12 > view.byteLength || view.getUint32(start, true) !== entry.crc32 || view.getUint32(start + 4, true) !== entry.compressedBytes || view.getUint32(start + 8, true) !== entry.expandedBytes) { throw new ParadisOfficePackageError('invalid'); }
}
