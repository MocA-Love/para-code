/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeRequest, ParadisOfficeResponse, ParadisOfficeSourceDescriptor } from '../../../fileViewers/common/paradisOfficeProtocol.js';
import {
	PARADIS_MOBILE_WORD_DIFF_HTML_MAX_BYTES,
	ParadisMobileWordDiffError,
	loadParadisMobileWordDiffBundle,
	renderParadisMobileWordDiffHtml,
	type IParadisMobileOfficeChannelClient,
} from '../../electron-browser/paradisMobileWordDiffHtml.js';
import {
	PARADIS_MOBILE_OFFICE_ALL_FEATURES,
	decodeParadisMobileOfficeRequest,
} from '../../common/paradisMobileOfficeProtocol.js';

const handle = { kind: 'comparison' as const, id: 'a'.repeat(48) };
const revision = { kind: 'comparison' as const, originalRevision: 'original-1', modifiedRevision: 'modified-1', comparisonRevision: 'comparison-1' };
const completeness = { expectedParts: 2, visitedParts: 2, parsedParts: 2, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 2, visitedSemanticUnits: 2, terminal: true };
const meta = { version: 1 as const, ok: true as const, outcome: 'complete' as const, warnings: [], budgetUsage: {}, timings: {}, revision, completeness };
const original: ParadisOfficeSourceDescriptor = { kind: 'file', uri: 'file:///workspace/old.docx', displayName: 'old.docx', side: 'original' };
const modified: ParadisOfficeSourceDescriptor = { kind: 'file', uri: 'file:///workspace/new.docx', displayName: 'new.docx', side: 'modified' };

function scalar(value: string) {
	return { kind: 'scalar' as const, valueType: 'text' as const, value };
}

suite('ParadisMobileWordDiffHtml', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pages semantic changes, requests logical view assets in bounded chunks, and closes the comparison handle', async () => {
		const requests: ParadisOfficeRequest[] = [];
		const png = VSBuffer.wrap(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
		const client: IParadisMobileOfficeChannelClient = {
			async request(request): Promise<ParadisOfficeResponse> {
				requests.push(request);
				if (request.operation === 'compare') {
					const first = request.cursor === undefined;
					return {
						...meta,
						requestId: request.requestId,
						operation: 'compare',
						handle,
						changes: [{
							id: first ? 'change-1' : 'change-2',
							category: first ? 'content' : 'formatting',
							subject: { kind: 'paragraph', locator: first ? 'story:main:p:1' : 'story:main:p:2' },
							before: scalar(first ? '<old>' : 'plain'),
							after: scalar(first ? '<new>' : 'bold'),
							certainty: 'exact', sourceParts: ['/word/document.xml'], navigableAnchor: first ? 'anchor:1' : 'anchor:2',
						}],
						...(first ? { nextCursor: 'cursor-2' } : {}),
						terminal: !first,
					};
				}
				if (request.operation === 'getViewport') {
					return {
						...meta, requestId: request.requestId, operation: 'getViewport',
						tile: {
							locator: request.locator, range: request.range, side: 'combined', cells: [], placeholders: [],
							blocks: [{ nodeId: `block:${request.locator}`, coverage: 'rendered', kind: 'paragraph', runs: [{ text: `Preview ${request.locator}` }] }],
							objects: request.locator.endsWith(':1') ? [{ nodeId: 'object-1', coverage: 'rendered', kind: 'rasterImage', assetId: 'asset:preview', altText: 'Preview image', bounds: { x: 500, y: 600, width: 700, height: 800 } }] : [],
						},
					};
				}
				if (request.operation === 'getRenderableAsset') {
					return { ...meta, requestId: request.requestId, operation: 'getRenderableAsset', assetId: request.assetId, offset: request.offset, totalLength: png.byteLength, bytes: png.slice(request.offset, Math.min(request.offset + request.length, png.byteLength)) };
				}
				if (request.operation === 'close') {
					return { version: 1, requestId: request.requestId, operation: 'close', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true };
				}
				throw new Error(`unexpected ${request.operation}`);
			},
		};

		const bundle = await loadParadisMobileWordDiffBundle(client, { original, modified, generation: 7, requestIdPrefix: 'mobile-word' }, CancellationToken.None);
		assert.deepStrictEqual(bundle.changes.map(change => change.id), ['change-1', 'change-2']);
		assert.strictEqual(bundle.assets.get('asset:preview')?.mime, 'image/png');
		assert.deepStrictEqual(requests.filter(request => request.operation === 'compare').map(request => request.operation === 'compare' ? request.cursor : undefined), [undefined, 'cursor-2']);
		assert.ok(requests.filter(request => request.operation === 'getRenderableAsset').every(request => request.operation !== 'getRenderableAsset' || request.length <= 2 * 1024 * 1024));
		assert.strictEqual(requests.at(-1)?.operation, 'close');

		const html = renderParadisMobileWordDiffHtml(bundle, 'abcdefghijklmnop');
		assert.ok(html.includes('&lt;old&gt;'));
		assert.ok(html.includes('data-paradis-anchor="anchor:1"'));
		assert.ok(html.includes('data:image/png;base64,'));
		assert.ok(!html.includes('transform:'));
		assert.ok(!html.includes('translate('));
		assert.ok(!html.includes('x="500"'));
		assert.ok(VSBuffer.fromString(html).byteLength <= PARADIS_MOBILE_WORD_DIFF_HTML_MAX_BYTES);
	});

	test('rejects handle-bearing mobile source messages and accepts the v1 descriptor-only handshake/diff contract', () => {
		assert.deepStrictEqual(decodeParadisMobileOfficeRequest({ t: 'office/hello', id: 'hello-1', version: 1, featureBits: PARADIS_MOBILE_OFFICE_ALL_FEATURES }), {
			t: 'office/hello', id: 'hello-1', version: 1, featureBits: PARADIS_MOBILE_OFFICE_ALL_FEATURES,
		});
		assert.deepStrictEqual(decodeParadisMobileOfficeRequest({
			t: 'office/wordDiff', id: 'diff-1', version: 1, generation: 4, ws: 'workspace-1', original, modified,
		}), { t: 'office/wordDiff', id: 'diff-1', version: 1, generation: 4, ws: 'workspace-1', original, modified });
		assert.strictEqual(decodeParadisMobileOfficeRequest({
			t: 'office/wordDiff', id: 'diff-1', version: 1, generation: 4, ws: 'workspace-1', original, modified, handle,
		}), undefined);
		assert.deepStrictEqual(decodeParadisMobileOfficeRequest({ t: 'office/cancel', id: 'cancel-1', version: 1, targetId: 'diff-1', generation: 4 }), {
			t: 'office/cancel', id: 'cancel-1', version: 1, targetId: 'diff-1', generation: 4,
		});
	});

	test('rejects a cursor page from another comparison revision and still closes the original handle', async () => {
		const operations: string[] = [];
		const client: IParadisMobileOfficeChannelClient = {
			async request(request): Promise<ParadisOfficeResponse> {
				operations.push(request.operation);
				if (request.operation === 'compare') {
					return {
						...meta, requestId: request.requestId, operation: 'compare', handle, changes: [],
						revision: request.cursor ? { ...revision, comparisonRevision: 'comparison-2' } : revision,
						...(request.cursor ? {} : { nextCursor: 'cursor-2' }), terminal: request.cursor !== undefined,
					};
				}
				if (request.operation === 'close') {
					return { version: 1, requestId: request.requestId, operation: 'close', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true };
				}
				throw new Error(`unexpected ${request.operation}`);
			},
		};
		await assert.rejects(
			loadParadisMobileWordDiffBundle(client, { original, modified, generation: 2, requestIdPrefix: 'stale-word' }, CancellationToken.None),
			error => error instanceof ParadisMobileWordDiffError && error.code === 'stale',
		);
		assert.strictEqual(operations.at(-1), 'close');
	});

	test('sends bounded cancel and close controls when the active generation is cancelled', async () => {
		const cancellation = new CancellationTokenSource();
		const operations: ParadisOfficeRequest[] = [];
		const client: IParadisMobileOfficeChannelClient = {
			async request(request): Promise<ParadisOfficeResponse> {
				operations.push(request);
				if (request.operation === 'compare') {
					return {
						...meta, requestId: request.requestId, operation: 'compare', handle, terminal: true,
						changes: [{ id: 'change-1', category: 'content', subject: { kind: 'paragraph', locator: 'story:main' }, before: scalar('old'), after: scalar('new'), certainty: 'exact', sourceParts: ['/word/document.xml'] }],
					};
				}
				if (request.operation === 'getViewport') {
					cancellation.cancel();
					return { ...meta, requestId: request.requestId, operation: 'getViewport', tile: { locator: request.locator, range: request.range, cells: [], blocks: [], objects: [], placeholders: [] } };
				}
				if (request.operation === 'cancel' || request.operation === 'close') {
					return { version: 1, requestId: request.requestId, operation: request.operation, ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true };
				}
				throw new Error(`unexpected ${request.operation}`);
			},
		};
		try {
			await assert.rejects(loadParadisMobileWordDiffBundle(client, { original, modified, generation: 3, requestIdPrefix: 'cancel-word' }, cancellation.token));
			assert.deepStrictEqual(operations.slice(-2).map(request => request.operation), ['cancel', 'close']);
			const cancel = operations.find(request => request.operation === 'cancel');
			assert.strictEqual(cancel?.operation === 'cancel' ? cancel.handle?.id : undefined, handle.id);
		} finally {
			cancellation.dispose();
		}
	});

	test('stops paged comparison accumulation at the bundle byte budget before requesting viewports', async () => {
		const operations: ParadisOfficeRequest['operation'][] = [];
		let page = 0;
		const client: IParadisMobileOfficeChannelClient = {
			async request(request): Promise<ParadisOfficeResponse> {
				operations.push(request.operation);
				if (request.operation === 'compare') {
					page++;
					const changes = Array.from({ length: 200 }, (_, index) => ({
						id: `change-${page}-${index}`, category: 'content' as const, subject: { kind: 'paragraph', locator: 'story:main' },
						before: scalar('x'.repeat(4_096)), after: scalar('y'.repeat(4_096)), certainty: 'exact' as const, sourceParts: ['/word/document.xml'],
					}));
					return { ...meta, requestId: request.requestId, operation: 'compare', handle, changes, terminal: page === 4, ...(page === 4 ? {} : { nextCursor: `cursor-${page + 1}` }) };
				}
				if (request.operation === 'getViewport') {
					return { ...meta, requestId: request.requestId, operation: 'getViewport', tile: { locator: request.locator, range: request.range, cells: [], blocks: [], objects: [], placeholders: [] } };
				}
				if (request.operation === 'cancel' || request.operation === 'close') {
					return { version: 1, requestId: request.requestId, operation: request.operation, ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true };
				}
				throw new Error(`unexpected ${request.operation}`);
			},
		};
		await assert.rejects(
			loadParadisMobileWordDiffBundle(client, { original, modified, generation: 5, requestIdPrefix: 'budget-word' }, CancellationToken.None),
			error => error instanceof ParadisMobileWordDiffError && error.code === 'budget',
		);
		assert.ok(!operations.includes('getViewport'));
		assert.deepStrictEqual(operations.slice(-2), ['cancel', 'close']);
	});

	test('renders hostile semantic text as text and enforces the final HTML budget', () => {
		const bundle = {
			generation: 1,
			revision,
			outcome: 'complete' as const,
			warnings: [],
			changes: [{ id: 'x', category: 'content' as const, subject: { kind: 'paragraph', locator: 'story:main' }, before: scalar('</script><img src=x onerror=alert(1)>'), after: scalar('safe'), certainty: 'exact' as const, sourceParts: ['/word/document.xml'] }],
			tiles: [],
			assets: new Map(),
		};
		const html = renderParadisMobileWordDiffHtml(bundle, 'abcdefghijklmnop');
		assert.ok(html.includes('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;'));
		assert.ok(!html.includes('</script><img'));
		assert.throws(() => renderParadisMobileWordDiffHtml({ ...bundle, changes: [{ ...bundle.changes[0], after: scalar('x'.repeat(PARADIS_MOBILE_WORD_DIFF_HTML_MAX_BYTES)) }] }, 'abcdefghijklmnop'));
	});

	test('never presents an incomplete empty comparison as no changes', () => {
		const html = renderParadisMobileWordDiffHtml({
			generation: 1,
			revision,
			outcome: 'degraded',
			warnings: ['semanticComparisonPending'],
			changes: [],
			tiles: [],
			assets: new Map(),
		}, 'abcdefghijklmnop');
		assert.ok(!html.includes('No semantic changes.'));
		assert.ok(html.includes('Comparison is incomplete.'));
	});
});
