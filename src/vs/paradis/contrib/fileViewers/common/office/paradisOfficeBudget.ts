/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeBudgetProfile, ParadisOfficeBudgetUsage } from '../paradisOfficeProtocol.js';
import { ParadisOfficePackageError } from './paradisOfficeArchive.js';

export type ParadisOfficeBudgetKind = 'inputBytes' | 'entryCount' | 'expandedBytes' | 'partBytes' | 'mediaBytes' | 'entryRatio' | 'containerRatio' | 'inspectTime';

type ParadisOfficeBudgetScope = 'container' | 'part';

const budgetErrorDetails = new WeakMap<object, { readonly scope: ParadisOfficeBudgetScope; readonly metric: ParadisOfficeBudgetKind }>();

export class ParadisOfficeBudgetError extends ParadisOfficePackageError {
	constructor(readonly scope: ParadisOfficeBudgetScope, readonly metric: ParadisOfficeBudgetKind) {
		super(metric === 'entryRatio' || metric === 'containerRatio' ? 'zipBomb' : 'limitExceeded');
		budgetErrorDetails.set(this, { scope, metric });
	}
}

/** Narrows only errors constructed by this module; archive-supplied lookalikes are never omittable. */
export function isParadisOfficePartBudgetError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	return budgetErrorDetails.get(error)?.scope === 'part';
}

/** Incremental accounting over observed decompressed bytes. */
export class ParadisOfficeBudget {
	private entryCount = 0;
	private expandedBytes = 0;
	private largestPartBytes = 0;
	private totalMediaBytes = 0;
	private totalCompressedBytes = 0;
	private containerInputBytes: number | undefined;
	private readonly warnings = new Set<ParadisOfficeBudgetKind>();

	constructor(readonly profile: ParadisOfficeBudgetProfile, private readonly startedAt = Date.now()) { }

	validateContainerInput(bytes: number): void {
		this.requireSafe(bytes);
		this.containerInputBytes = bytes;
		this.limit('container', 'inputBytes', bytes, this.profile.compressedInputBytes);
	}

	beginEntry(compressedBytes: number): void {
		this.requireSafe(compressedBytes);
		this.entryCount++;
		this.limit('container', 'entryCount', this.entryCount, this.profile.entryCount);
		this.totalCompressedBytes = this.add(this.totalCompressedBytes, compressedBytes);
	}

	consumeEntry(bytes: number, entryCompressedBytes: number, isBinary: boolean, isMedia: boolean, entryBytes: number): void {
		this.requireSafe(bytes);
		const nextPart = this.add(entryBytes, bytes);
		this.expandedBytes = this.add(this.expandedBytes, bytes);
		this.largestPartBytes = Math.max(this.largestPartBytes, nextPart);
		if (isMedia) {
			this.totalMediaBytes = this.add(this.totalMediaBytes, bytes);
			this.limit('part', 'mediaBytes', this.totalMediaBytes, this.profile.totalMediaBytes);
		}
		this.limit('container', 'expandedBytes', this.expandedBytes, this.profile.expandedBytes);
		this.limit('part', 'partBytes', nextPart, isBinary ? this.profile.binaryPartBytes : this.profile.xmlPartBytes);
		if (entryCompressedBytes <= 0 ? nextPart > 0 : nextPart > entryCompressedBytes * this.profile.compressionRatio) {
			throw new ParadisOfficeBudgetError('container', 'entryRatio');
		}
		const containerCompressedBytes = this.containerInputBytes ?? this.totalCompressedBytes;
		if (containerCompressedBytes <= 0 ? this.expandedBytes > 0 : this.expandedBytes > containerCompressedBytes * this.profile.compressionRatio) {
			throw new ParadisOfficeBudgetError('container', 'containerRatio');
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
			throw new ParadisOfficeBudgetError('container', 'inspectTime');
		}
		if (now - this.startedAt >= Math.floor(this.profile.inspectMilliseconds * 0.8)) {
			this.warnings.add('inspectTime');
		}
	}

	private limit(scope: ParadisOfficeBudgetScope, kind: ParadisOfficeBudgetKind, value: number, maximum: number): void {
		this.requireSafe(value);
		this.requireSafe(maximum);
		if (value > maximum) {
			throw new ParadisOfficeBudgetError(scope, kind);
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
