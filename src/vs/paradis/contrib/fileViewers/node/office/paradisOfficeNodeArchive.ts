/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import { Readable } from 'stream';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import { type IParadisOfficeArchive, type ParadisOfficeArchiveEntry, type ParadisOfficeXmlDocument, ParadisOfficePackageError, throwIfParadisOfficeCancelled } from '../../common/office/paradisOfficeArchive.js';
import { parseParadisOfficeXml, type ParadisOfficeXmlLimits } from '../../common/office/paradisOfficeCanonicalXml.js';

interface NodeEntry extends ParadisOfficeArchiveEntry {
	readonly yauzlEntry: Entry;
}

/** Opens bounded in-memory source bytes with yauzl's lazy central-directory API. */
export async function createParadisOfficeNodeArchive(bytes: Uint8Array): Promise<IParadisOfficeArchive> {

	if (!(bytes instanceof Uint8Array)) {
		throw new ParadisOfficePackageError('invalid');
	}
	const zip = await new Promise<ZipFile>((resolve, reject) => {
		fromBuffer(Buffer.from(bytes), { lazyEntries: true, autoClose: false, strictFileNames: false }, (error, result) => {
			if (error || !result) { reject(new ParadisOfficePackageError('invalid')); } else { resolve(result); }
		});
	});
	return new ParadisOfficeNodeArchive(zip, bytes.byteLength);
}

class ParadisOfficeNodeArchive implements IParadisOfficeArchive {
	private readonly entriesByIdentity = new WeakMap<ParadisOfficeArchiveEntry, Entry>();
	private closed = false;

	constructor(private readonly zip: ZipFile, readonly containerByteLength: number) { }

	async *entries(token?: CancellationToken): AsyncIterable<ParadisOfficeArchiveEntry> {
		while (!this.closed) {
			throwIfParadisOfficeCancelled(token);
			const entry = await this.nextEntry();
			if (!entry) { return; }
			const result: NodeEntry = {
				name: entry.fileName,
				compressedBytes: entry.compressedSize,
				declaredExpandedBytes: entry.uncompressedSize,
				crc32: entry.crc32,
				encrypted: (entry.generalPurposeBitFlag & 1) !== 0,
				directory: entry.fileName.endsWith('/'),
				symlink: ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000,
				unixMode: entry.externalFileAttributes >>> 16,
				yauzlEntry: entry,
			};
			this.entriesByIdentity.set(result, entry);
			yield result;
		}
	}

	async *read(entry: ParadisOfficeArchiveEntry, token?: CancellationToken): AsyncIterable<Uint8Array> {
		const yauzlEntry = this.entriesByIdentity.get(entry);
		if (!yauzlEntry || this.closed) { throw new ParadisOfficePackageError('invalid'); }
		const stream = await new Promise<Readable>((resolve, reject) => {
			this.zip.openReadStream(yauzlEntry, (error, result) => {
				if (error || !result) { reject(new ParadisOfficePackageError('invalid')); } else { resolve(result); }
			});
		});
		const listener = token?.onCancellationRequested(() => stream.destroy());
		try {
			for await (const chunk of stream) {
				throwIfParadisOfficeCancelled(token);
				yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			}
		} catch (error) {
			if (token?.isCancellationRequested) { throw new ParadisOfficePackageError('cancelled'); }
			if (error instanceof ParadisOfficePackageError) { throw error; }
			throw new ParadisOfficePackageError('invalid');
		} finally {
			listener?.dispose();
			stream.destroy();
		}
	}

	async hash(bytes: Uint8Array): Promise<ParadisOfficeFingerprint> {
		const hash = createHash('sha256').update(bytes).digest('hex');
		return { algorithm: 'sha256', value: hash, byteLength: bytes.byteLength };
	}

	async parseXml(xml: string, limits: ParadisOfficeXmlLimits, token?: CancellationToken, checkpoint?: () => void): Promise<ParadisOfficeXmlDocument> {
		return parseParadisOfficeXml(xml, limits, token, checkpoint);
	}

	dispose(): void {
		if (!this.closed) {
			this.closed = true;
			this.zip.close();
		}
	}

	private nextEntry(): Promise<Entry | undefined> {
		return new Promise<Entry | undefined>((resolve, reject) => {
			const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
			const onEnd = () => { cleanup(); resolve(undefined); };
			const onError = () => { cleanup(); reject(new ParadisOfficePackageError('invalid')); };
			const cleanup = () => { this.zip.removeListener('entry', onEntry); this.zip.removeListener('end', onEnd); this.zip.removeListener('error', onError); };
			this.zip.once('entry', onEntry);
			this.zip.once('end', onEnd);
			this.zip.once('error', onError);
			this.zip.readEntry();
		});
	}
}
