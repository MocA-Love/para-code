/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	aggregateOfficeOutcome,
	canReportNoChanges,
	createOfficeCursor,
	isOfficeAssetRequestWithinBudget,
	isOfficeRenderableAsset,
	isOfficeRenderCoverage,
	isOfficeSerializableData,
	isOfficeSerializedPayloadWithinBudget,
	PARADIS_OFFICE_LIMITS,
	PARADIS_OFFICE_SEARCH_NORMALIZATION,
	ParadisOfficeChange,
	ParadisOfficeChangeValue,
	ParadisOfficeCompletenessManifest,
	ParadisOfficePartStatus,
	ParadisOfficeRenderableAsset,
	ParadisOfficeRenderBlock,
	ParadisOfficeRenderCell,
	ParadisOfficeRenderObject,
	ParadisOfficeRequest,
	ParadisOfficeRevision,
	readOfficeCursor,
	validateOfficeChange,
	validateOfficeChangeValue,
} from '../../common/paradisOfficeProtocol.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';

const validFingerprint = {
	algorithm: 'sha256',
	value: 'a'.repeat(64),
	byteLength: 1024,
} as const;

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

function jsonByteLength(value: unknown): number {
	return VSBuffer.fromString(JSON.stringify(value)).byteLength;
}

function changeWithSerializedBytes(targetBytes: number): ParadisOfficeChange {
	const base = { ...change({ kind: 'none' }), navigableAnchor: '' };
	const baseBytes = jsonByteLength(base);
	ok(targetBytes >= baseBytes);
	return { ...base, navigableAnchor: 'x'.repeat(targetBytes - baseBytes) };
}

const validateRuntimeValue = validateOfficeChangeValue as unknown as (value: unknown) => ReturnType<typeof validateOfficeChangeValue>;
const createRuntimeError = createParadisOfficeError as unknown as (stage: string, code: string, details: unknown) => Readonly<Record<string, unknown>>;

suite('ParadisOfficeProtocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('aggregates completeOpaque as complete and unfinished optional coverage as degraded', () => {
		const completeOpaque = { coverage: 'completeOpaque', required: false, hashCompleteness: 'allBytes', fingerprint: validFingerprint } as const;
		deepStrictEqual([
			aggregateOfficeOutcome([{ coverage: 'parsed', required: true }, completeOpaque]),
			aggregateOfficeOutcome([{ coverage: 'opaque', required: false }]),
			aggregateOfficeOutcome([{ coverage: 'unsafe', required: false }]),
		], ['complete', 'degraded', 'degraded']);
	});

	test('degrades completeOpaque coverage without a full valid SHA-256 proof', () => {
		const statuses = [
			{ coverage: 'completeOpaque', required: false },
			{ coverage: 'completeOpaque', required: true, hashCompleteness: 'incomplete', fingerprint: validFingerprint },
			{ coverage: 'completeOpaque', required: true, hashCompleteness: 'allBytes', fingerprint: { ...validFingerprint, value: 'invalid' } },
		] as unknown as readonly ParadisOfficePartStatus[];

		deepStrictEqual(statuses.map(status => aggregateOfficeOutcome([status])), ['degraded', 'degraded', 'degraded']);
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

	test('rejects inconsistent or non-integer No Changes counters', () => {
		deepStrictEqual([
			canReportNoChanges(completeManifest({ expectedParts: -1 }), 'complete', 0),
			canReportNoChanges(completeManifest({ visitedParts: 3 }), 'complete', 0),
			canReportNoChanges(completeManifest({ parsedParts: 0 }), 'complete', 0),
			canReportNoChanges(completeManifest({ parsedParts: 1.5 }), 'complete', 0),
			canReportNoChanges(completeManifest({ visitedSemanticUnits: 5 }), 'complete', 0),
			canReportNoChanges(completeManifest({ expectedSemanticUnits: Number.MAX_SAFE_INTEGER + 1 }), 'complete', 0),
			canReportNoChanges(completeManifest(), 'complete', -1),
			canReportNoChanges(completeManifest(), 'complete', 0.5),
		], [false, false, false, false, false, false, false, false]);
	});

	test('enforces recursive change value depth, collection, and string boundaries', () => {
		const listAtLimit: ParadisOfficeChangeValue = {
			kind: 'list',
			items: new Array(PARADIS_OFFICE_LIMITS.maxChangeValueListItems).fill(undefined).map(() => ({ kind: 'none' })),
		};
		const listOverLimit: ParadisOfficeChangeValue = {
			kind: 'list',
			items: new Array(PARADIS_OFFICE_LIMITS.maxChangeValueListItems + 1).fill(undefined).map(() => ({ kind: 'none' })),
		};
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

	test('counts the 4096 character limit in Unicode code points', () => {
		strictEqual(validateOfficeChangeValue({ kind: 'scalar', valueType: 'text', value: '\u{1F600}'.repeat(2049) }).valid, true);
		strictEqual(validateOfficeChangeValue({ kind: 'scalar', valueType: 'text', value: '\u{1F600}'.repeat(4096) }).valid, true);
		strictEqual(validateOfficeChangeValue({ kind: 'scalar', valueType: 'text', value: '\u{1F600}'.repeat(4097) }).violation, 'stringLength');
	});

	test('rejects malformed change values without invoking getters or throwing', () => {
		let getterCalls = 0;
		const throwingKind: object = {};
		Object.defineProperty(throwingKind, 'kind', {
			enumerable: true,
			get: () => {
				getterCalls++;
				throw new Error('must not execute');
			},
		});
		const candidates: readonly unknown[] = [
			{ kind: 'unknown' },
			{ kind: 'scalar', valueType: 'missing', value: 'x' },
			{ kind: 'scalar', valueType: 'null', value: 'not-null' },
			{ kind: 'list' },
			{ kind: 'list', items: {}, extra: true },
			{ kind: 'record', fields: [{ name: 'x' }] },
			{ kind: 'none', extra: true },
			throwingKind,
		];

		for (const candidate of candidates) {
			let result: ReturnType<typeof validateOfficeChangeValue> | undefined;
			doesNotThrow(() => result = validateRuntimeValue(candidate));
			strictEqual(result?.valid, false);
		}
		strictEqual(getterCalls, 0);
	});

	test('rejects shared change value DAGs without repeated traversal', () => {
		const shared: ParadisOfficeChangeValue = { kind: 'record', fields: [{ name: 'leaf', value: { kind: 'none' } }] };
		const dag: ParadisOfficeChangeValue = { kind: 'list', items: [shared, shared] };

		strictEqual(validateOfficeChangeValue(dag).violation, 'nonSerializable');
	});

	test('bounds a compact DAG representing 256 to the seventh paths without invoking its getter', () => {
		let getterCalls = 0;
		const leaf: object = {};
		Object.defineProperty(leaf, 'kind', {
			enumerable: true,
			get: () => {
				getterCalls++;
				if (getterCalls > 1) {
					throw new Error('repeated traversal');
				}
				return 'none';
			},
		});
		let dag: unknown = leaf;
		for (let depth = 0; depth < 7; depth++) {
			dag = { kind: 'list', items: new Array(256).fill(dag) };
		}

		let result: ReturnType<typeof validateOfficeChangeValue> | undefined;
		doesNotThrow(() => result = validateRuntimeValue(dag));
		strictEqual(result?.violation, 'nonSerializable');
		strictEqual(getterCalls, 0);
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

	test('enforces the whole serialized change byte limit at exactly 64 KiB', () => {
		const exact = changeWithSerializedBytes(PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes);
		const over = changeWithSerializedBytes(PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes + 1);
		strictEqual(jsonByteLength(exact), PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes);
		strictEqual(jsonByteLength(over), PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes + 1);

		deepStrictEqual(validateOfficeChange(exact), {
			valid: true,
			serializedBytes: PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes,
		});
		strictEqual(validateOfficeChange(over).serializedBytes, PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes + 1);
		strictEqual(validateOfficeChange(over).violation, 'serializedBytes');
	});

	test('matches an independent JSON UTF-8 byte oracle for escaped and Unicode strings and keys', () => {
		const corpus: readonly unknown[] = [
			{ kind: 'scalar', valueType: 'text', value: 'quote"backslash\\control\u0000\b\t\n\f\r' },
			{ kind: 'scalar', valueType: 'text', value: 'BMP-漢字' },
			{ kind: 'scalar', valueType: 'text', value: 'astral-\u{1F600}' },
			{ kind: 'scalar', valueType: 'text', value: 'lone-high-\ud800' },
			{ kind: 'scalar', valueType: 'text', value: 'lone-low-\udc00' },
			{ kind: 'none', '鍵': '値' },
		];

		for (const value of corpus) {
			strictEqual(validateRuntimeValue(value).serializedBytes, jsonByteLength(value));
		}
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

	test('enforces the cursor length boundary exactly', () => {
		const revision: ParadisOfficeRevision = { kind: 'document', sourceRevision: 'source-a' };
		let continuationLength = PARADIS_OFFICE_LIMITS.maxCursorLength - 64;
		let atLimit = createOfficeCursor(revision, 'x'.repeat(continuationLength));
		continuationLength += PARADIS_OFFICE_LIMITS.maxCursorLength - atLimit.length;
		atLimit = createOfficeCursor(revision, 'x'.repeat(continuationLength));

		strictEqual(atLimit.length, PARADIS_OFFICE_LIMITS.maxCursorLength);
		strictEqual(readOfficeCursor(atLimit, revision)?.length, continuationLength);
		throws(() => createOfficeCursor(revision, 'x'.repeat(continuationLength + 1)), RangeError);
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

	test('rejects accessors, sparse and decorated arrays, shared references, and non-VSBuffer views', () => {
		let getterCalls = 0;
		const accessor: object = {};
		Object.defineProperty(accessor, 'secret', {
			enumerable: true,
			get: () => {
				getterCalls++;
				return 'secret';
			},
		});
		const sparse = new Array(2);
		sparse[1] = 'present';
		const decorated = ['value'];
		Object.assign(decorated, { extra: 'not-an-index' });
		const symbolDecorated = ['value'];
		Object.assign(symbolDecorated, { [Symbol('extra')]: 'not-serializable' });
		const shared = { value: 'shared' };

		deepStrictEqual([
			isOfficeSerializableData(accessor),
			isOfficeSerializableData(sparse),
			isOfficeSerializableData(decorated),
			isOfficeSerializableData(symbolDecorated),
			isOfficeSerializableData([shared, shared]),
			isOfficeSerializableData(new Uint8Array([1])),
			isOfficeSerializableData(new DataView(new ArrayBuffer(1))),
		], [false, false, false, false, false, false, false]);
		strictEqual(getterCalls, 0);
	});

	test('bounds serializable data by depth and UTF-8 byte size', () => {
		let deep: object = {};
		for (let depth = 0; depth < 100; depth++) {
			deep = { child: deep };
		}

		strictEqual(isOfficeSerializableData(deep), false);
		strictEqual(isOfficeSerializableData('x'.repeat(PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes + 1)), false);
	});

	test('rejects a wide pending queue before visiting its next-level sentinel', () => {
		let sentinelVisits = 0;
		let getterCalls = 0;
		const sentinelTarget: object = {};
		Object.defineProperty(sentinelTarget, 'secret', {
			enumerable: true,
			get: () => {
				getterCalls++;
				return 'must not execute';
			},
		});
		const sentinel = new Proxy(sentinelTarget, {
			getPrototypeOf: target => {
				sentinelVisits++;
				return Object.getPrototypeOf(target);
			},
		});
		const nextLevel = new Array(PARADIS_OFFICE_LIMITS.maxSerializableNodes).fill(null);
		nextLevel[0] = sentinel;
		const root = new Array(PARADIS_OFFICE_LIMITS.maxSerializableNodes).fill(null);
		root[0] = nextLevel;

		strictEqual(isOfficeSerializableData(root), false);
		strictEqual(sentinelVisits, 0);
		strictEqual(getterCalls, 0);
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

	test('freezes NFC normalization as a backend search invariant', () => {
		strictEqual(PARADIS_OFFICE_SEARCH_NORMALIZATION, 'NFC');
		const request: ParadisOfficeRequest = {
			version: 1,
			requestId: 'search-1',
			operation: 'search',
			handle: { kind: 'document', id: 'document-1' },
			query: 'cafe\u0301',
			options: { matchCase: false },
		};
		strictEqual(isOfficeSerializableData(request), true);
	});

	test('defines every render node coverage classification as required serializable data', () => {
		const cells: readonly ParadisOfficeRenderCell[] = [
			{ nodeId: 'cell-1', row: 1, column: 1, text: 'value', coverage: 'rendered' },
		];
		const blocks: readonly ParadisOfficeRenderBlock[] = [
			{ nodeId: 'block-1', kind: 'paragraph', coverage: 'approximated' },
		];
		const objects: readonly ParadisOfficeRenderObject[] = [
			{ nodeId: 'object-1', kind: 'shape', coverage: 'placeholder' },
		];

		deepStrictEqual([
			isOfficeRenderCoverage('rendered'),
			isOfficeRenderCoverage('approximated'),
			isOfficeRenderCoverage('placeholder'),
			isOfficeRenderCoverage('blockedByPolicy'),
			isOfficeRenderCoverage('noAnchor'),
			isOfficeRenderCoverage('unknown'),
		], [true, true, true, true, true, false]);
		strictEqual(isOfficeSerializableData({ cells, blocks, objects }), true);
	});

	test('accepts only the fixed renderable asset kind and MIME combinations', () => {
		const fingerprint = { algorithm: 'sha256', value: 'b'.repeat(64), byteLength: 12 } as const;
		const validAssets: readonly ParadisOfficeRenderableAsset[] = [
			{ id: 'png', kind: 'rasterImage', mime: 'image/png', byteLength: 12, fingerprint },
			{ id: 'jpeg', kind: 'rasterImage', mime: 'image/jpeg', byteLength: 12, fingerprint },
			{ id: 'gif', kind: 'rasterImage', mime: 'image/gif', byteLength: 12, fingerprint },
			{ id: 'webp', kind: 'rasterImage', mime: 'image/webp', byteLength: 12, fingerprint },
			{ id: 'svg', kind: 'sanitizedSvg', mime: 'image/svg+xml', byteLength: 12, fingerprint },
			{ id: 'font', kind: 'fontSubset', mime: 'font/woff2', byteLength: 12, fingerprint },
			{ id: 'chart-png', kind: 'chartPreview', mime: 'image/png', byteLength: 12, fingerprint },
			{ id: 'chart-svg', kind: 'chartPreview', mime: 'image/svg+xml', byteLength: 12, fingerprint },
			{ id: 'placeholder-png', kind: 'placeholderPreview', mime: 'image/png', byteLength: 12, fingerprint },
			{ id: 'placeholder-svg', kind: 'placeholderPreview', mime: 'image/svg+xml', byteLength: 12, fingerprint },
			{ id: 'pdf', kind: 'generatedPdf', mime: 'application/pdf', byteLength: 12, fingerprint },
		];
		const invalidAssets: readonly unknown[] = [
			{ id: 'font-svg', kind: 'fontSubset', mime: 'image/svg+xml', byteLength: 12, fingerprint },
			{ id: 'svg-png', kind: 'sanitizedSvg', mime: 'image/png', byteLength: 12, fingerprint },
			{ id: 'pdf-png', kind: 'generatedPdf', mime: 'image/png', byteLength: 12, fingerprint },
			{ id: 'raw', kind: 'rasterImage', mime: 'application/octet-stream', byteLength: 12, fingerprint },
			{ id: 'mismatch', kind: 'rasterImage', mime: 'image/png', byteLength: 11, fingerprint },
			{ id: 'extra', kind: 'rasterImage', mime: 'image/png', byteLength: 12, fingerprint, rawPath: '/private/file.png' },
		];

		ok(validAssets.every(isOfficeRenderableAsset));
		ok(invalidAssets.every(asset => !isOfficeRenderableAsset(asset)));
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

	test('projects error fields without invoking extra accessors and does not retain input references', () => {
		let getterCalls = 0;
		const part = { safeId: 'part-sha256:abc', contentType: 'application/xml', feature: 'worksheet' };
		const details = {
			severity: 'error' as 'error' | 'fatal',
			retryable: false,
			recoverable: true,
			userAction: 'retry' as const,
			side: 'original' as const,
			part,
			sanitizedCauseCode: 'readFailure',
			rawPath: '/private/document.docx',
			secret: 'token',
			stack: 'private stack',
			cause: { message: 'private cause' },
		};
		Object.defineProperty(details, 'extraAccessor', {
			enumerable: true,
			get: () => {
				getterCalls++;
				return 'private getter';
			},
		});
		Object.defineProperty(part, 'rawPath', {
			enumerable: true,
			get: () => {
				getterCalls++;
				return '/private/part.xml';
			},
		});
		const error = createParadisOfficeError('source', 'changed', details);
		part.safeId = 'part-sha256:mutated';
		details.severity = 'fatal';

		deepStrictEqual(error, {
			stage: 'source',
			code: 'changed',
			safeMessage: 'The document changed while it was being read.',
			severity: 'error',
			retryable: false,
			recoverable: true,
			userAction: 'retry',
			side: 'original',
			part: { safeId: 'part-sha256:abc', contentType: 'application/xml', feature: 'worksheet' },
			sanitizedCauseCode: 'readFailure',
		});
		strictEqual(getterCalls, 0);
		ok(!JSON.stringify(error).includes('private'));
	});

	test('rejects accessor-backed required error fields without invoking them', () => {
		let getterCalls = 0;
		const details = {
			retryable: false,
			recoverable: true,
			userAction: 'retry',
		};
		Object.defineProperty(details, 'severity', {
			enumerable: true,
			get: () => {
				getterCalls++;
				return 'error';
			},
		});

		throws(() => createRuntimeError('source', 'changed', details), TypeError);
		strictEqual(getterCalls, 0);
	});

	test('rejects invalid severity retryability recovery action and side values', () => {
		const base = { severity: 'error', retryable: false, recoverable: true, userAction: 'retry' };
		const invalidDetails = [
			{ ...base, severity: 'debug' },
			{ ...base, retryable: 'yes' },
			{ ...base, recoverable: 1 },
			{ ...base, userAction: 'deleteFile' },
			{ ...base, side: 'both' },
		];

		for (const details of invalidDetails) {
			throws(() => createRuntimeError('source', 'changed', details), TypeError);
		}
	});

	test('validates every wire error stage and code correlation at runtime', () => {
		const pairs = {
			source: ['notFound', 'permission', 'changed', 'sideMissing', 'unsupportedScheme'],
			container: ['invalid', 'encrypted', 'zipBomb', 'limitExceeded'],
			format: ['unsupported', 'malformed', 'featureUnsupported'],
			engine: ['libraryMissing', 'versionMismatch', 'engineCrashed'],
			transport: ['timeout', 'cancelled', 'disconnected', 'payloadTooLarge'],
			render: ['cspBlocked', 'workerFailed', 'blank', 'outOfMemory'],
			diff: ['partial', 'truncated', 'stale', 'sideUnavailable'],
			export: ['printFailed', 'unsupported'],
		} as const;
		const details = { severity: 'error', retryable: false, recoverable: true, userAction: 'retry' };

		for (const [stage, codes] of Object.entries(pairs)) {
			for (const code of codes) {
				const error = createRuntimeError(stage, code, details);
				strictEqual(error.stage, stage);
				strictEqual(error.code, code);
				strictEqual(typeof error.safeMessage, 'string');
			}
		}
		throws(() => createRuntimeError('format', 'printFailed', details), TypeError);
		throws(() => createRuntimeError('not-a-stage', 'changed', details), TypeError);
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
