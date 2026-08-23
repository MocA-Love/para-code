/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	aggregateOfficeOutcome,
	canReportNoChanges,
	createOfficeCursor,
	isOfficeAssetRequestWithinBudget,
	isOfficeSerializableData,
	isOfficeSerializedPayloadWithinBudget,
	PARADIS_OFFICE_LIMITS,
	ParadisOfficeChange,
	ParadisOfficeChangeValue,
	ParadisOfficeCompletenessManifest,
	ParadisOfficeRequest,
	ParadisOfficeRevision,
	readOfficeCursor,
	validateOfficeChange,
	validateOfficeChangeValue,
} from '../../common/paradisOfficeProtocol.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';

function completeManifest(overrides: Partial<ParadisOfficeCompletenessManifest> = {}): ParadisOfficeCompletenessManifest {
	return {
		expectedParts: 2,
		visitedParts: 2,
		parsedParts: 1,
		opaqueParts: 1,
		failedParts: 0,
		omittedParts: 0,
		expectedSemanticUnits: 4,
		visitedSemanticUnits: 4,
		terminal: true,
		...overrides,
	};
}

function nestedValue(depth: number): ParadisOfficeChangeValue {
	let value: ParadisOfficeChangeValue = { kind: 'scalar', valueType: 'text', value: 'leaf' };
	for (let index = 1; index < depth; index++) {
		value = { kind: 'list', items: [value] };
	}
	return value;
}

function change(before: ParadisOfficeChangeValue, after: ParadisOfficeChangeValue = { kind: 'none' }): ParadisOfficeChange {
	return {
		id: 'change-1',
		category: 'content',
		subject: { kind: 'cell', locator: 'sheet:1:A1' },
		before,
		after,
		certainty: 'exact',
		sourceParts: ['/xl/worksheets/sheet1.xml'],
	};
}

suite('ParadisOfficeProtocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('aggregates completeOpaque as complete and unfinished optional coverage as degraded', () => {
		deepStrictEqual([
			aggregateOfficeOutcome([{ coverage: 'parsed', required: true }, { coverage: 'completeOpaque', required: false }]),
			aggregateOfficeOutcome([{ coverage: 'opaque', required: false }]),
			aggregateOfficeOutcome([{ coverage: 'unsafe', required: false }]),
		], ['complete', 'degraded', 'degraded']);
	});

	test('blocks required failures and omissions but degrades optional failures and partial parts', () => {
		deepStrictEqual([
			aggregateOfficeOutcome([{ coverage: 'failed', required: true }]),
			aggregateOfficeOutcome([{ coverage: 'omittedByBudget', required: true }]),
			aggregateOfficeOutcome([{ coverage: 'failed', required: false }]),
			aggregateOfficeOutcome([{ coverage: 'omittedByBudget', required: false }]),
			aggregateOfficeOutcome([{ coverage: 'partial', required: true }]),
		], ['blocked', 'blocked', 'degraded', 'degraded', 'degraded']);
	});

	test('reports No Changes only for complete terminal and fully visited analysis', () => {
		deepStrictEqual([
			canReportNoChanges(completeManifest(), 'complete', 0),
			canReportNoChanges(completeManifest({ terminal: false }), 'complete', 0),
			canReportNoChanges(completeManifest({ visitedParts: 1 }), 'complete', 0),
			canReportNoChanges(completeManifest({ visitedSemanticUnits: 3 }), 'complete', 0),
			canReportNoChanges(completeManifest({ failedParts: 1 }), 'complete', 0),
			canReportNoChanges(completeManifest({ omittedParts: 1 }), 'complete', 0),
			canReportNoChanges(completeManifest(), 'degraded', 0),
			canReportNoChanges(completeManifest(), 'complete', 1),
		], [true, false, false, false, false, false, false, false]);
	});

	test('enforces recursive change value depth, collection, and string boundaries', () => {
		const listAtLimit: ParadisOfficeChangeValue = { kind: 'list', items: new Array(PARADIS_OFFICE_LIMITS.maxChangeValueListItems).fill({ kind: 'none' }) };
		const listOverLimit: ParadisOfficeChangeValue = { kind: 'list', items: new Array(PARADIS_OFFICE_LIMITS.maxChangeValueListItems + 1).fill({ kind: 'none' }) };
		const recordAtLimit: ParadisOfficeChangeValue = {
			kind: 'record',
			fields: new Array(PARADIS_OFFICE_LIMITS.maxChangeValueRecordFields).fill(undefined).map((_, index) => ({ name: `field${index}`, value: { kind: 'none' } })),
		};
		const recordOverLimit: ParadisOfficeChangeValue = {
			kind: 'record',
			fields: [...recordAtLimit.fields, { name: 'overflow', value: { kind: 'none' } }],
		};
		const stringAtLimit: ParadisOfficeChangeValue = { kind: 'scalar', valueType: 'text', value: 'a'.repeat(PARADIS_OFFICE_LIMITS.maxChangeValueStringLength) };
		const stringOverLimit: ParadisOfficeChangeValue = { kind: 'scalar', valueType: 'text', value: 'a'.repeat(PARADIS_OFFICE_LIMITS.maxChangeValueStringLength + 1) };

		deepStrictEqual([
			validateOfficeChangeValue(nestedValue(PARADIS_OFFICE_LIMITS.maxChangeValueDepth)).valid,
			validateOfficeChangeValue(nestedValue(PARADIS_OFFICE_LIMITS.maxChangeValueDepth + 1)).violation,
			validateOfficeChangeValue(listAtLimit).valid,
			validateOfficeChangeValue(listOverLimit).violation,
			validateOfficeChangeValue(recordAtLimit).valid,
			validateOfficeChangeValue(recordOverLimit).violation,
			validateOfficeChangeValue(stringAtLimit).valid,
			validateOfficeChangeValue(stringOverLimit).violation,
		], [true, 'depth', true, 'listItems', true, 'recordFields', true, 'stringLength']);
	});

	test('requires oversized change values to be represented by a full SHA-256 fingerprint', () => {
		const repeatedStrings: ParadisOfficeChangeValue = {
			kind: 'list',
			items: new Array(20).fill(undefined).map(() => ({ kind: 'scalar', valueType: 'text', value: 'x'.repeat(4096) })),
		};
		const fingerprint: ParadisOfficeChangeValue = {
			kind: 'fingerprint',
			algorithm: 'sha256',
			value: 'a'.repeat(64),
			byteLength: 81920,
		};

		strictEqual(validateOfficeChange(change(repeatedStrings)).violation, 'serializedBytes');
		strictEqual(validateOfficeChange(change(fingerprint)).valid, true);
		strictEqual(validateOfficeChangeValue({ ...fingerprint, value: 'not-a-sha256' }).violation, 'fingerprint');
	});

	test('binds document and comparison cursors to their exact revisions', () => {
		const documentRevision: ParadisOfficeRevision = { kind: 'document', sourceRevision: 'source-a' };
		const nextDocumentRevision: ParadisOfficeRevision = { kind: 'document', sourceRevision: 'source-b' };
		const comparisonRevision: ParadisOfficeRevision = {
			kind: 'comparison',
			originalRevision: 'left-a',
			modifiedRevision: 'right-a',
			comparisonRevision: 'comparison-a',
		};
		const cursor = createOfficeCursor(documentRevision, 'page:2');
		const comparisonCursor = createOfficeCursor(comparisonRevision, 'change:200');

		deepStrictEqual([
			readOfficeCursor(cursor, documentRevision),
			readOfficeCursor(cursor, nextDocumentRevision),
			readOfficeCursor(comparisonCursor, comparisonRevision),
			readOfficeCursor(comparisonCursor.slice(0, -1), comparisonRevision),
		], ['page:2', undefined, 'change:200', undefined]);
	});

	test('keeps all public request variants serializable and rejects cycles or non-data objects', () => {
		const source = { kind: 'file', uri: 'file:///document.docx', displayName: 'document.docx' } as const;
		const documentHandle = { kind: 'document', id: 'document-handle' } as const;
		const requests: readonly ParadisOfficeRequest[] = [
			{ version: 1, requestId: '1', operation: 'inspect', source },
			{ version: 1, requestId: '2', operation: 'open', source },
			{ version: 1, requestId: '3', operation: 'getViewport', handle: documentHandle, locator: 'sheet:1', range: [1, 10, 1, 10] },
			{ version: 1, requestId: '4', operation: 'compare', original: { ...source, side: 'original' }, modified: { ...source, side: 'modified' } },
			{ version: 1, requestId: '5', operation: 'search', handle: documentHandle, query: 'needle' },
			{ version: 1, requestId: '6', operation: 'getRenderableAsset', handle: documentHandle, assetId: 'asset-1', offset: 0, length: 1024 },
			{ version: 1, requestId: '7', operation: 'getPrintModel', handle: documentHandle, options: { includePlaceholders: true } },
			{ version: 1, requestId: '8', operation: 'exportPrint', handle: documentHandle, format: 'pdf' },
			{ version: 1, requestId: '9', operation: 'close', handle: documentHandle },
			{ version: 1, requestId: '10', operation: 'cancel', targetRequestId: '5' },
		];
		const cyclic: { self?: object } = {};
		cyclic.self = cyclic;

		ok(requests.every(isOfficeSerializableData));
		strictEqual(isOfficeSerializableData({ bytes: VSBuffer.fromString('safe') }), true);
		strictEqual(isOfficeSerializableData(cyclic), false);
		strictEqual(isOfficeSerializableData(new Date(0)), false);
		strictEqual(isOfficeSerializableData({ omitted: undefined }), false);
	});

	test('enforces response and renderable asset chunks at two MiB', () => {
		deepStrictEqual([
			isOfficeSerializedPayloadWithinBudget(PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes),
			isOfficeSerializedPayloadWithinBudget(PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes + 1),
			isOfficeAssetRequestWithinBudget(0, PARADIS_OFFICE_LIMITS.maxAssetRequestBytes),
			isOfficeAssetRequestWithinBudget(0, PARADIS_OFFICE_LIMITS.maxAssetRequestBytes + 1),
			isOfficeAssetRequestWithinBudget(-1, 1),
		], [true, false, true, false, false]);
	});

	test('creates structured IPC errors without raw cause, path, secret, or stack fields', () => {
		const error = createParadisOfficeError('container', 'limitExceeded', {
			severity: 'error',
			retryable: false,
			recoverable: true,
			userAction: 'reduceDocumentSize',
			side: 'modified',
			part: { safeId: 'part-sha256:abc', contentType: 'application/xml' },
			sanitizedCauseCode: 'expandedBytes',
		});
		const serialized = JSON.stringify(error);

		deepStrictEqual(error, {
			stage: 'container',
			code: 'limitExceeded',
			safeMessage: 'The document exceeds the configured processing limit.',
			severity: 'error',
			retryable: false,
			recoverable: true,
			userAction: 'reduceDocumentSize',
			side: 'modified',
			part: { safeId: 'part-sha256:abc', contentType: 'application/xml' },
			sanitizedCauseCode: 'expandedBytes',
		});
		ok(!serialized.includes('stack'));
		ok(!serialized.includes('rawPath'));
		ok(!serialized.includes('secret'));
	});

	test('drops error metadata that is not a bounded safe identifier', () => {
		const error = createParadisOfficeError('source', 'notFound', {
			severity: 'error',
			retryable: false,
			recoverable: true,
			userAction: 'chooseAnotherFile',
			part: { safeId: '/Users/person/private-document.docx', contentType: 'secret=token' },
			sanitizedCauseCode: 'secret=token',
		});

		strictEqual(error.part, undefined);
		strictEqual(error.sanitizedCauseCode, undefined);
		ok(!JSON.stringify(error).includes('private-document'));
		ok(!JSON.stringify(error).includes('secret'));
	});
});
