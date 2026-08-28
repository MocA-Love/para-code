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
	const primitive = new NativeZipPrimitive(owned);
	const archive = new ParadisOfficeWebArchive(primitive, owned.byteLength);
	nativeZipPrimitivesForTest.set(archive, primitive);
	return archive;
}

/** Test-only visibility for verifying that package budgets stop lazy central-directory decoding. */
export function getParadisOfficeWebArchiveEntryDecodeCountForTest(archive: ParadisOfficeWebArchive): number {
	const primitive = nativeZipPrimitivesForTest.get(archive);
	if (!primitive) { throw new Error('not a native web archive'); }
	return primitive.entryDecodeCount;
}

const nativeZipPrimitivesForTest = new WeakMap<ParadisOfficeWebArchive, NativeZipPrimitive>();

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
	private decodedEntryCount = 0;
	private readonly entriesByIdentity = new WeakMap<ParadisOfficeArchiveEntry, NativeZipEntry>();
	private readonly centralOffset: number;
	private readonly centralSize: number;
	private readonly entryCount: number;

	constructor(private readonly bytes: Uint8Array) {
		const central = parseNativeZipCentralDirectory(bytes);
		this.centralOffset = central.offset;
		this.centralSize = central.size;
		this.entryCount = central.count;
	}

	get entryDecodeCount(): number { return this.decodedEntryCount; }

	async *entries(): AsyncIterable<ParadisOfficeArchiveEntry> {
		const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
		const decoder = new TextDecoder('utf-8', { fatal: true });
		const centralEnd = this.centralOffset + this.centralSize;
		let offset = this.centralOffset;
		for (let index = 0; index < this.entryCount; index++) {
			if (this.closed) { return; }
			const record = parseNativeZipCentralRecord(this.bytes, view, offset, centralEnd, decoder);
			this.decodedEntryCount++;
			const object = record.entry;
			const entry: ParadisOfficeArchiveEntry = {
				name: object.name, compressedBytes: object.compressedBytes, declaredExpandedBytes: object.expandedBytes, crc32: object.crc32,
				encrypted: (object.flags & 1) !== 0, directory: object.name.endsWith('/'),
				symlink: (object.unixMode & 0xf000) === 0xa000, unixMode: object.unixMode,
			};
			this.entriesByIdentity.set(entry, object);
			yield entry;
			offset = record.end;
		}
		if (offset !== centralEnd) { throw new ParadisOfficePackageError('invalid'); }
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

interface NativeZipCentralDirectory {
	readonly offset: number;
	readonly size: number;
	readonly count: number;
}

function parseNativeZipCentralDirectory(bytes: Uint8Array): NativeZipCentralDirectory {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let offset = Math.max(0, bytes.byteLength - 65_557); offset <= bytes.byteLength - 22; offset++) {
		if (view.getUint32(offset, true) !== 0x06054b50) { continue; }
		const candidate = parseNativeZipEocdCandidate(bytes, view, offset);
		if (candidate) { return candidate; }
	}
	throw new ParadisOfficePackageError('invalid');
}

function parseNativeZipEocdCandidate(bytes: Uint8Array, view: DataView, offset: number): NativeZipCentralDirectory | undefined {
	if (view.getUint16(offset + 4, true) !== 0 || view.getUint16(offset + 6, true) !== 0 || view.getUint16(offset + 8, true) !== view.getUint16(offset + 10, true)) { return undefined; }
	if (offset + 22 + view.getUint16(offset + 20, true) !== bytes.byteLength) { return undefined; }
	const count = view.getUint16(offset + 10, true);
	const size = view.getUint32(offset + 12, true);
	const centralOffset = view.getUint32(offset + 16, true);
	if (count === 0xffff || size === 0xffffffff || centralOffset === 0xffffffff || centralOffset + size !== offset) { return undefined; }
	if (!hasConsistentNativeZipCentralRecords(view, centralOffset, size, count)) { return undefined; }
	return { offset: centralOffset, size, count };
}

function hasConsistentNativeZipCentralRecords(view: DataView, offset: number, size: number, count: number): boolean {
	const centralEnd = offset + size;
	let cursor = offset;
	for (let index = 0; index < count; index++) {
		if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== 0x02014b50) { return false; }
		if (view.getUint16(cursor + 34, true) === 0xffff || view.getUint32(cursor + 20, true) === 0xffffffff || view.getUint32(cursor + 24, true) === 0xffffffff || view.getUint32(cursor + 42, true) === 0xffffffff) { return false; }
		const end = cursor + 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
		if (end > centralEnd) { return false; }
		cursor = end;
	}
	return cursor === centralEnd;
}

function parseNativeZipCentralRecord(bytes: Uint8Array, view: DataView, offset: number, centralEnd: number, decoder: TextDecoder): { readonly entry: NativeZipEntry; readonly end: number } {
	if (offset + 46 > centralEnd || view.getUint32(offset, true) !== 0x02014b50) { throw new ParadisOfficePackageError('invalid'); }
	if (view.getUint16(offset + 34, true) === 0xffff || view.getUint32(offset + 20, true) === 0xffffffff || view.getUint32(offset + 24, true) === 0xffffffff || view.getUint32(offset + 42, true) === 0xffffffff) { throw new ParadisOfficePackageError('invalid'); }
	const nameLength = view.getUint16(offset + 28, true); const extraLength = view.getUint16(offset + 30, true); const commentLength = view.getUint16(offset + 32, true);
	const end = offset + 46 + nameLength + extraLength + commentLength;
	if (end > centralEnd) { throw new ParadisOfficePackageError('invalid'); }
	return {
		entry: { name: decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength)), flags: view.getUint16(offset + 8, true), method: view.getUint16(offset + 10, true), crc32: view.getUint32(offset + 16, true), compressedBytes: view.getUint32(offset + 20, true), expandedBytes: view.getUint32(offset + 24, true), unixMode: view.getUint32(offset + 38, true) >>> 16, localOffset: view.getUint32(offset + 42, true) },
		end,
	};
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
