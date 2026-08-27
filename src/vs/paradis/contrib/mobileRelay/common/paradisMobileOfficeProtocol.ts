/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	PARADIS_OFFICE_ALL_FEATURES,
	PARADIS_OFFICE_FEATURE_EXCEL_DIFF,
	PARADIS_OFFICE_FEATURE_EXCEL_VIEW,
	PARADIS_OFFICE_FEATURE_WORD_DIFF,
	PARADIS_OFFICE_FEATURE_WORD_VIEW,
} from '../../fileViewers/common/paradisOfficeCapabilities.js';
import { validateParadisOfficeSourceDescriptor } from '../../fileViewers/common/paradisOfficeSourceBroker.js';
import type { ParadisOfficeOutcome, ParadisOfficeSourceDescriptor } from '../../fileViewers/common/paradisOfficeProtocol.js';

export const PARADIS_MOBILE_OFFICE_PROTOCOL_VERSION = 1 as const;
export const PARADIS_MOBILE_OFFICE_FEATURE_EXCEL_VIEW = PARADIS_OFFICE_FEATURE_EXCEL_VIEW;
export const PARADIS_MOBILE_OFFICE_FEATURE_EXCEL_DIFF = PARADIS_OFFICE_FEATURE_EXCEL_DIFF;
export const PARADIS_MOBILE_OFFICE_FEATURE_WORD_VIEW = PARADIS_OFFICE_FEATURE_WORD_VIEW;
export const PARADIS_MOBILE_OFFICE_FEATURE_WORD_DIFF = PARADIS_OFFICE_FEATURE_WORD_DIFF;
export const PARADIS_MOBILE_OFFICE_ALL_FEATURES = PARADIS_OFFICE_ALL_FEATURES;

export type ParadisMobileOfficeRequest =
	| {
		readonly t: 'office/hello';
		readonly id: string;
		readonly version: typeof PARADIS_MOBILE_OFFICE_PROTOCOL_VERSION;
		readonly featureBits: number;
	}
	| {
		readonly t: 'office/wordDiff';
		readonly id: string;
		readonly version: typeof PARADIS_MOBILE_OFFICE_PROTOCOL_VERSION;
		readonly generation: number;
		readonly ws: string;
		readonly original: ParadisOfficeSourceDescriptor;
		readonly modified: ParadisOfficeSourceDescriptor;
	}
	| {
		readonly t: 'office/cancel';
		readonly id: string;
		readonly version: typeof PARADIS_MOBILE_OFFICE_PROTOCOL_VERSION;
		readonly targetId: string;
		readonly generation: number;
	};

export type ParadisMobileOfficeResponse =
	| {
		readonly t: 'office/capabilities';
		readonly version: 0 | typeof PARADIS_MOBILE_OFFICE_PROTOCOL_VERSION;
		readonly featureBits: number;
		readonly warnings: readonly string[];
	}
	| {
		readonly t: 'office/wordDiff';
		readonly version: typeof PARADIS_MOBILE_OFFICE_PROTOCOL_VERSION;
		readonly generation: number;
		readonly html: string;
		readonly outcome: ParadisOfficeOutcome;
		readonly warnings: readonly string[];
	}
	| {
		readonly t: 'office/cancelled';
		readonly version: typeof PARADIS_MOBILE_OFFICE_PROTOCOL_VERSION;
		readonly targetId: string;
		readonly generation: number;
	};

interface DataRecord {
	readonly keys: readonly string[];
	readonly values: ReadonlyMap<string, unknown>;
}

function dataRecord(value: unknown, required: readonly string[]): DataRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	try {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			return undefined;
		}
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length !== required.length || ownKeys.some(key => typeof key !== 'string' || !required.includes(key))) {
			return undefined;
		}
		const values = new Map<string, unknown>();
		for (const key of required) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return undefined;
			}
			values.set(key, descriptor.value);
		}
		return { keys: ownKeys as string[], values };
	} catch {
		return undefined;
	}
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z\d][A-Za-z\d._:-]{0,127}$/.test(value);
}

function generation(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function featureBits(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && (value & ~PARADIS_MOBILE_OFFICE_ALL_FEATURES) === 0;
}

/** Snapshots a strict v1 Office message. Unknown fields (including backend handles) are rejected. */
export function decodeParadisMobileOfficeRequest(value: unknown): ParadisMobileOfficeRequest | undefined {
	const typeRecord = dataRecord(value, ['t', 'id', 'version', 'featureBits'])
		?? dataRecord(value, ['t', 'id', 'version', 'generation', 'ws', 'original', 'modified'])
		?? dataRecord(value, ['t', 'id', 'version', 'targetId', 'generation']);
	if (!typeRecord) {
		return undefined;
	}
	const type = typeRecord.values.get('t');
	const id = typeRecord.values.get('id');
	const version = typeRecord.values.get('version');
	if (!identifier(id) || version !== PARADIS_MOBILE_OFFICE_PROTOCOL_VERSION) {
		return undefined;
	}
	if (type === 'office/hello' && typeRecord.keys.length === 4) {
		const bits = typeRecord.values.get('featureBits');
		return featureBits(bits) ? { t: type, id, version, featureBits: bits } : undefined;
	}
	if (type === 'office/cancel' && typeRecord.keys.length === 5) {
		const targetId = typeRecord.values.get('targetId');
		const requestGeneration = typeRecord.values.get('generation');
		return identifier(targetId) && generation(requestGeneration)
			? { t: type, id, version, targetId, generation: requestGeneration }
			: undefined;
	}
	if (type !== 'office/wordDiff' || typeRecord.keys.length !== 7) {
		return undefined;
	}
	const requestGeneration = typeRecord.values.get('generation');
	const ws = typeRecord.values.get('ws');
	if (!generation(requestGeneration) || typeof ws !== 'string' || ws.length < 1 || ws.length > 4_096) {
		return undefined;
	}
	try {
		const original = validateParadisOfficeSourceDescriptor(typeRecord.values.get('original'));
		const modified = validateParadisOfficeSourceDescriptor(typeRecord.values.get('modified'));
		return { t: type, id, version, generation: requestGeneration, ws, original, modified };
	} catch {
		return undefined;
	}
}
