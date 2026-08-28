/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeFormat, ParadisOfficeOutcome } from './paradisOfficeProtocol.js';

export const PARADIS_OFFICE_TELEMETRY_MAX_MILLISECONDS = 120_000;

export type ParadisOfficeTelemetryScheme = 'file' | 'vscode-remote' | 'git' | 'untitled' | 'mixed' | 'none' | 'unknown';
export type ParadisOfficeTelemetryBackend = 'local' | 'remote' | 'mobileHost' | 'webWorker' | 'unknown';
export type ParadisOfficeTelemetryCountBucket = '0' | '1' | '2-9' | '10-99' | '100-999' | '1000+';

export interface ParadisOfficeTelemetryInput {
	readonly format: ParadisOfficeFormat;
	readonly scheme: ParadisOfficeTelemetryScheme;
	readonly backend: ParadisOfficeTelemetryBackend;
	readonly version: 0 | 1;
	readonly counts: {
		readonly parts: number;
		readonly semanticUnits: number;
		readonly warnings: number;
	};
	readonly timings: {
		readonly totalMilliseconds: number;
	};
	readonly outcome: ParadisOfficeOutcome;
}

/** Privacy-bounded Office event. It deliberately contains no operation, identity, content, or geometry. */
export interface ParadisOfficeTelemetryEvent {
	readonly format: ParadisOfficeFormat;
	readonly scheme: ParadisOfficeTelemetryScheme;
	readonly backend: ParadisOfficeTelemetryBackend;
	readonly version: 0 | 1;
	readonly countBuckets: {
		readonly parts: ParadisOfficeTelemetryCountBucket;
		readonly semanticUnits: ParadisOfficeTelemetryCountBucket;
		readonly warnings: ParadisOfficeTelemetryCountBucket;
	};
	readonly timings: {
		readonly totalMilliseconds: number;
	};
	readonly outcome: ParadisOfficeOutcome;
}

export interface ParadisOfficeTelemetryOptions {
	readonly backend: ParadisOfficeTelemetryBackend;
	readonly emit: (event: ParadisOfficeTelemetryEvent) => void;
}

interface OwnDataRecord {
	readonly values: ReadonlyMap<string, unknown>;
}

const formats: readonly ParadisOfficeFormat[] = ['xlsx', 'xlsm', 'xltx', 'xltm', 'docx', 'docm', 'dotx', 'dotm', 'zip', 'cfbEncrypted', 'unknown'];
const schemes: readonly ParadisOfficeTelemetryScheme[] = ['file', 'vscode-remote', 'git', 'untitled', 'mixed', 'none', 'unknown'];
const backends: readonly ParadisOfficeTelemetryBackend[] = ['local', 'remote', 'mobileHost', 'webWorker', 'unknown'];
const outcomes: readonly ParadisOfficeOutcome[] = ['complete', 'degraded', 'blocked', 'sideMissing', 'cancelled', 'stale', 'failed'];

function sameOwnDataDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined): left is PropertyDescriptor & { readonly value: unknown } {
	return !!left && !!right
		&& left.enumerable === true && right.enumerable === true
		&& Object.prototype.hasOwnProperty.call(left, 'value') && Object.prototype.hasOwnProperty.call(right, 'value')
		&& left.configurable === right.configurable && left.writable === right.writable
		&& Object.is(left.value, right.value);
}

function ownDataRecord(value: unknown, expectedKeys: readonly string[]): OwnDataRecord | undefined {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) { return undefined; }
		const firstKeys = Reflect.ownKeys(value);
		if (firstKeys.length !== expectedKeys.length || firstKeys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) { return undefined; }
		const values = new Map<string, unknown>();
		for (const key of expectedKeys) {
			const first = Object.getOwnPropertyDescriptor(value, key);
			const second = Object.getOwnPropertyDescriptor(value, key);
			if (!sameOwnDataDescriptor(first, second)) { return undefined; }
			values.set(key, first.value);
		}
		const secondKeys = Reflect.ownKeys(value);
		if (secondKeys.length !== firstKeys.length || secondKeys.some((key, index) => key !== firstKeys[index])) { return undefined; }
		return { values };
	} catch {
		return undefined;
	}
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === 'string' && allowed.includes(value as T);
}

function countBucket(value: number): ParadisOfficeTelemetryCountBucket {
	if (value === 0) { return '0'; }
	if (value === 1) { return '1'; }
	if (value < 10) { return '2-9'; }
	if (value < 100) { return '10-99'; }
	if (value < 1000) { return '100-999'; }
	return '1000+';
}

/** Converts an exact own-data record into the only Office fields approved for telemetry. */
export function buildParadisOfficeTelemetryEvent(value: unknown): ParadisOfficeTelemetryEvent | undefined {
	const input = ownDataRecord(value, ['format', 'scheme', 'backend', 'version', 'counts', 'timings', 'outcome']);
	if (!input) { return undefined; }
	const format = input.values.get('format');
	const scheme = input.values.get('scheme');
	const backend = input.values.get('backend');
	const version = input.values.get('version');
	const outcome = input.values.get('outcome');
	const counts = ownDataRecord(input.values.get('counts'), ['parts', 'semanticUnits', 'warnings']);
	const timings = ownDataRecord(input.values.get('timings'), ['totalMilliseconds']);
	if (!oneOf(format, formats) || !oneOf(scheme, schemes) || !oneOf(backend, backends) || version !== 0 && version !== 1 || !oneOf(outcome, outcomes) || !counts || !timings) { return undefined; }
	const parts = counts.values.get('parts');
	const semanticUnits = counts.values.get('semanticUnits');
	const warnings = counts.values.get('warnings');
	const totalMilliseconds = timings.values.get('totalMilliseconds');
	if (!Number.isSafeInteger(parts) || (parts as number) < 0
		|| !Number.isSafeInteger(semanticUnits) || (semanticUnits as number) < 0
		|| !Number.isSafeInteger(warnings) || (warnings as number) < 0
		|| typeof totalMilliseconds !== 'number' || !Number.isFinite(totalMilliseconds)) {
		return undefined;
	}
	return {
		format,
		scheme,
		backend,
		version,
		countBuckets: {
			parts: countBucket(parts as number),
			semanticUnits: countBucket(semanticUnits as number),
			warnings: countBucket(warnings as number),
		},
		timings: { totalMilliseconds: Math.min(PARADIS_OFFICE_TELEMETRY_MAX_MILLISECONDS, Math.max(0, Math.round(totalMilliseconds))) },
		outcome,
	};
}

/** Emits only successfully sanitized events and isolates optional observability from request handling. */
export function emitParadisOfficeTelemetry(options: ParadisOfficeTelemetryOptions | undefined, value: unknown): void {
	try {
		if (!options) { return; }
		const event = buildParadisOfficeTelemetryEvent(value);
		if (event) { options.emit(event); }
	} catch { }
}
