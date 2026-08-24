/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';

/** Immutable central-directory metadata. Declared output bytes are never authoritative. */
export interface ParadisOfficeArchiveEntry {
	readonly name: string;
	readonly compressedBytes: number;
	readonly declaredExpandedBytes: number;
	readonly encrypted: boolean;
	readonly directory: boolean;
}

/** Environment-provided SHA-256 boundary; common package code never imports a crypto runtime. */
export interface IParadisOfficeHash {
	hash(bytes: Uint8Array): Promise<ParadisOfficeFingerprint>;
}

/**
 * Lazy, single-entry archive adapter. Entry output is yielded decompressed and must stop when
 * the consumer returns from the iterator. Adapters must not expose ZIP internals to callers.
 */
export interface IParadisOfficeArchive extends IParadisOfficeHash {
	entries(token?: CancellationToken): AsyncIterable<ParadisOfficeArchiveEntry>;
	read(entry: ParadisOfficeArchiveEntry, token?: CancellationToken): AsyncIterable<Uint8Array>;
	dispose(): void;
}

/** Sanitized package failure. It intentionally carries neither raw archive errors nor paths. */
export class ParadisOfficePackageError extends Error {

	constructor(readonly code: 'invalid' | 'encrypted' | 'zipBomb' | 'limitExceeded' | 'malformed' | 'cancelled') {
		super(code);
	}
}

export function throwIfParadisOfficeCancelled(token: CancellationToken | undefined): void {

	if (token?.isCancellationRequested) {
		throw new ParadisOfficePackageError('cancelled');
	}
}

/** Rejects non-canonical OPC ZIP names before a stream can be opened. */
export function canonicalizeParadisOfficeArchiveName(name: string): string {

	if (!name || name.startsWith('/') || name.includes('\\') || name.includes('%') || name.includes('\0')) {
		throw new ParadisOfficePackageError('invalid');
	}
	const segments = name.split('/');
	if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
		throw new ParadisOfficePackageError('invalid');
	}
	return `/${segments.join('/')}`;
}
