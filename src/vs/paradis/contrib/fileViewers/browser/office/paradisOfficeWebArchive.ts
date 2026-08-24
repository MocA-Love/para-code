/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import { type IParadisOfficeArchive, type ParadisOfficeArchiveEntry, ParadisOfficePackageError, throwIfParadisOfficeCancelled } from '../../common/office/paradisOfficeArchive.js';

/** Browser/Worker ZIP primitive. Its stream is decompressed lazily and supports iterator return. */
export interface IParadisOfficeWebZipPrimitive {
	entries(): AsyncIterable<ParadisOfficeArchiveEntry>;
	read(entry: ParadisOfficeArchiveEntry, signal: AbortSignal): AsyncIterable<Uint8Array>;
	close(): void;
}

/** Browser-safe adapter: no Node modules, DOM parsing, or raw ZIP implementation leaks. */
export class ParadisOfficeWebArchive implements IParadisOfficeArchive {

	private closed = false;

	constructor(private readonly primitive: IParadisOfficeWebZipPrimitive) { }

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

	dispose(): void {
		if (!this.closed) { this.closed = true; this.primitive.close(); }
	}
}
