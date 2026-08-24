/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeBudgetProfile, ParadisOfficeBudgetUsage } from '../paradisOfficeProtocol.js';
import { ParadisOfficePackageError } from './paradisOfficeArchive.js';

export type ParadisOfficeBudgetKind = 'entryCount' | 'expandedBytes' | 'partBytes' | 'mediaBytes' | 'entryRatio' | 'containerRatio';

/** Incremental accounting over observed decompressed bytes. */
export class ParadisOfficeBudget {
	private entryCount = 0;
	private expandedBytes = 0;
	private largestPartBytes = 0;
	private totalMediaBytes = 0;
	private totalCompressedBytes = 0;
	private readonly warnings = new Set<ParadisOfficeBudgetKind>();

	constructor(readonly profile: ParadisOfficeBudgetProfile, private readonly startedAt = Date.now()) { }

	validateContainerInput(bytes: number): void {
		this.requireSafe(bytes);
		this.limit('containerRatio', bytes, this.profile.compressedInputBytes, 'limitExceeded');
	}

	beginEntry(compressedBytes: number): void {
		this.requireSafe(compressedBytes);
		this.entryCount++;
		this.limit('entryCount', this.entryCount, this.profile.entryCount, 'limitExceeded');
		this.totalCompressedBytes = this.add(this.totalCompressedBytes, compressedBytes);
	}

	consumeEntry(bytes: number, entryCompressedBytes: number, isBinary: boolean, isMedia: boolean, entryBytes: number): void {
		this.requireSafe(bytes);
		const nextPart = this.add(entryBytes, bytes);
		this.expandedBytes = this.add(this.expandedBytes, bytes);
		this.largestPartBytes = Math.max(this.largestPartBytes, nextPart);
		if (isMedia) {
			this.totalMediaBytes = this.add(this.totalMediaBytes, bytes);
			this.limit('mediaBytes', this.totalMediaBytes, this.profile.totalMediaBytes, 'limitExceeded');
		}
		this.limit('expandedBytes', this.expandedBytes, this.profile.expandedBytes, 'limitExceeded');
		this.limit('partBytes', nextPart, isBinary ? this.profile.binaryPartBytes : this.profile.xmlPartBytes, 'limitExceeded');
		if (entryCompressedBytes <= 0 ? nextPart > 0 : nextPart > entryCompressedBytes * this.profile.compressionRatio) {
			throw new ParadisOfficePackageError('zipBomb');
		}
		if (this.totalCompressedBytes <= 0 ? this.expandedBytes > 0 : this.expandedBytes > this.totalCompressedBytes * this.profile.compressionRatio) {
			throw new ParadisOfficePackageError('zipBomb');
		}
	}

	usage(): ParadisOfficeBudgetUsage {
		return {
			compressedInputBytes: this.totalCompressedBytes,
			expandedBytes: this.expandedBytes,
			entryCount: this.entryCount,
			largestPartBytes: this.largestPartBytes,
			totalMediaBytes: this.totalMediaBytes,
			elapsedMilliseconds: Math.max(0, Date.now() - this.startedAt),
		};
	}

	warningKinds(): readonly ParadisOfficeBudgetKind[] {
		return [...this.warnings];
	}

	checkDeadline(now: number): void {
		this.requireSafe(now);
		if (now - this.startedAt > this.profile.inspectMilliseconds) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		if (now - this.startedAt >= Math.floor(this.profile.inspectMilliseconds * 0.8)) {
			this.warnings.add('expandedBytes');
		}
	}

	private limit(kind: ParadisOfficeBudgetKind, value: number, maximum: number, error: 'limitExceeded' | 'zipBomb'): void {
		this.requireSafe(value);
		this.requireSafe(maximum);
		if (value > maximum) {
			throw new ParadisOfficePackageError(error);
		}
		if (value >= Math.floor(maximum * 0.8)) {
			this.warnings.add(kind);
		}
	}

	private add(left: number, right: number): number {
		const value = left + right;
		this.requireSafe(value);
		return value;
	}

	private requireSafe(value: number): void {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new ParadisOfficePackageError('invalid');
		}
	}
}
