/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import {
	PARADIS_OFFICE_LIMITS,
	type ParadisOfficeChange,
	type ParadisOfficeChangeValue,
	type ParadisOfficeOutcome,
	type ParadisOfficeRenderBlock,
	type ParadisOfficeRenderTile,
	type ParadisOfficeRequest,
	type ParadisOfficeResponse,
	type ParadisOfficeRevision,
	type ParadisOfficeSourceDescriptor,
} from '../../fileViewers/common/paradisOfficeProtocol.js';

export const PARADIS_MOBILE_WORD_DIFF_HTML_MAX_BYTES = 6_000_000;
export const PARADIS_MOBILE_WORD_DIFF_BUNDLE_MAX_BYTES = 4_000_000;
const PARADIS_MOBILE_WORD_DIFF_ASSET_MAX_BYTES = 4_000_000;
const PARADIS_MOBILE_WORD_DIFF_MAX_CHANGES = 10_000;
const PARADIS_MOBILE_WORD_DIFF_MAX_LOCATORS = 256;
const PARADIS_MOBILE_WORD_DIFF_MAX_PAGES = 256;

export interface IParadisMobileOfficeChannelClient {
	request(request: ParadisOfficeRequest, token: CancellationToken): Promise<ParadisOfficeResponse>;
}

export interface ParadisMobileWordDiffLoadOptions {
	readonly original: ParadisOfficeSourceDescriptor;
	readonly modified: ParadisOfficeSourceDescriptor;
	readonly generation: number;
	readonly requestIdPrefix: string;
}

export interface ParadisMobileWordDiffAsset {
	readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';
	readonly bytes: VSBuffer;
}

export interface ParadisMobileWordDiffBundle {
	readonly generation: number;
	readonly revision: Extract<ParadisOfficeRevision, { readonly kind: 'comparison' }>;
	readonly outcome: ParadisOfficeOutcome;
	readonly warnings: readonly string[];
	readonly changes: readonly ParadisOfficeChange[];
	readonly tiles: readonly ParadisOfficeRenderTile[];
	readonly assets: ReadonlyMap<string, ParadisMobileWordDiffAsset>;
}

export class ParadisMobileWordDiffError extends Error {
	override readonly name = 'ParadisMobileWordDiffError';

	constructor(readonly code: 'invalidResponse' | 'stale' | 'budget' | 'unsupported') {
		super('The mobile Word comparison could not be rendered safely.');
		Object.defineProperty(this, 'stack', { configurable: true, value: '' });
	}
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

function sameRevision(left: ParadisOfficeRevision, right: ParadisOfficeRevision): boolean {
	return left.kind === 'comparison' && right.kind === 'comparison'
		&& left.originalRevision === right.originalRevision
		&& left.modifiedRevision === right.modifiedRevision
		&& left.comparisonRevision === right.comparisonRevision;
}

function combineOutcome(current: ParadisOfficeOutcome, next: ParadisOfficeOutcome): ParadisOfficeOutcome {
	const rank: Readonly<Record<ParadisOfficeOutcome, number>> = { complete: 0, degraded: 1, sideMissing: 2, stale: 3, cancelled: 4, blocked: 5, failed: 6 };
	return rank[next] > rank[current] ? next : current;
}

function requestId(prefix: string, sequence: number): string {
	const safePrefix = prefix.replace(/[^A-Za-z\d._:-]/g, '-').slice(0, 96) || 'mobile-word';
	return `${safePrefix}:${sequence}`;
}

function responseFailure(response: Extract<ParadisOfficeResponse, { readonly ok: false }>): never {
	if (response.outcome === 'cancelled') {
		throw new CancellationError();
	}
	throw new ParadisMobileWordDiffError(response.outcome === 'stale' ? 'stale' : response.error.stage === 'format' ? 'unsupported' : 'invalidResponse');
}

function assetMime(bytes: VSBuffer): ParadisMobileWordDiffAsset['mime'] | undefined {
	const value = bytes.buffer;
	if (value.length >= 4 && value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47) { return 'image/png'; }
	if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) { return 'image/jpeg'; }
	if (value.length >= 6 && (String.fromCharCode(...value.subarray(0, 6)) === 'GIF89a' || String.fromCharCode(...value.subarray(0, 6)) === 'GIF87a')) { return 'image/gif'; }
	if (value.length >= 12 && String.fromCharCode(...value.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...value.subarray(8, 12)) === 'WEBP') { return 'image/webp'; }
	const prefix = new TextDecoder().decode(value.subarray(0, Math.min(value.length, 256))).trimStart();
	return prefix.startsWith('<svg') || (prefix.startsWith('<?xml') && prefix.includes('<svg')) ? 'image/svg+xml' : undefined;
}

function collectAssetIds(tiles: readonly ParadisOfficeRenderTile[]): readonly string[] {
	const ids = new Set<string>();
	for (const tile of tiles) {
		for (const object of tile.objects) {
			if (object.assetId) { ids.add(object.assetId); }
		}
	}
	return [...ids];
}

/**
 * Requests the v1 comparison in pages and obtains only assets referenced by logical viewport
 * results. Backend handles stay inside this call and are always closed before the bundle crosses
 * the mobile relay boundary.
 */
export async function loadParadisMobileWordDiffBundle(
	client: IParadisMobileOfficeChannelClient,
	options: ParadisMobileWordDiffLoadOptions,
	token: CancellationToken,
): Promise<ParadisMobileWordDiffBundle> {
	let sequence = 0;
	let activeRequestId: string | undefined;
	let comparisonHandle: Extract<ParadisOfficeResponse, { readonly operation: 'compare'; readonly ok: true }>['handle'] | undefined;
	let revision: Extract<ParadisOfficeRevision, { readonly kind: 'comparison' }> | undefined;
	let outcome: ParadisOfficeOutcome = 'complete';
	const warnings = new Set<string>();
	const changes: ParadisOfficeChange[] = [];
	const tiles: ParadisOfficeRenderTile[] = [];
	const assets = new Map<string, ParadisMobileWordDiffAsset>();
	let retainedBundleBytes = 0;
	const retainStructured = (value: ParadisOfficeChange | ParadisOfficeRenderTile): void => {
		const next = retainedBundleBytes + VSBuffer.fromString(JSON.stringify(value)).byteLength;
		if (!Number.isSafeInteger(next) || next > PARADIS_MOBILE_WORD_DIFF_BUNDLE_MAX_BYTES) {
			throw new ParadisMobileWordDiffError('budget');
		}
		retainedBundleBytes = next;
	};
	const call = async (request: ParadisOfficeRequest): Promise<ParadisOfficeResponse> => {
		throwIfCancelled(token);
		activeRequestId = request.requestId;
		const response = await client.request(request, token);
		throwIfCancelled(token);
		if (response.requestId !== request.requestId || response.operation !== request.operation) {
			throw new ParadisMobileWordDiffError('invalidResponse');
		}
		return response;
	};
	try {
		let cursor: string | undefined;
		for (let page = 0; page < PARADIS_MOBILE_WORD_DIFF_MAX_PAGES; page++) {
			const response = await call({
				version: 1,
				requestId: requestId(options.requestIdPrefix, sequence++),
				operation: 'compare',
				original: options.original,
				modified: options.modified,
				...(cursor ? { cursor } : {}),
			});
			if (!response.ok) { responseFailure(response); }
			if (response.operation !== 'compare') { throw new ParadisMobileWordDiffError('invalidResponse'); }
			if (!comparisonHandle) {
				comparisonHandle = response.handle;
				revision = response.revision;
			} else if (comparisonHandle.id !== response.handle.id || !revision || !sameRevision(revision, response.revision)) {
				throw new ParadisMobileWordDiffError('stale');
			}
			outcome = combineOutcome(outcome, response.outcome);
			for (const warning of response.warnings) { warnings.add(warning.code); }
			if (changes.length + response.changes.length > PARADIS_MOBILE_WORD_DIFF_MAX_CHANGES) {
				throw new ParadisMobileWordDiffError('budget');
			}
			for (const change of response.changes) {
				retainStructured(change);
				changes.push(change);
			}
			if (response.terminal) {
				cursor = undefined;
				break;
			}
			if (!response.nextCursor || response.nextCursor === cursor) {
				throw new ParadisMobileWordDiffError('invalidResponse');
			}
			cursor = response.nextCursor;
			if (page === PARADIS_MOBILE_WORD_DIFF_MAX_PAGES - 1) {
				throw new ParadisMobileWordDiffError('budget');
			}
		}
		if (!comparisonHandle || !revision) {
			throw new ParadisMobileWordDiffError('invalidResponse');
		}

		const locators = [...new Set(changes.map(change => change.subject.locator))];
		if (locators.length > PARADIS_MOBILE_WORD_DIFF_MAX_LOCATORS) {
			locators.length = PARADIS_MOBILE_WORD_DIFF_MAX_LOCATORS;
			warnings.add('office.mobile.wordDiff.locatorsTruncated');
			outcome = combineOutcome(outcome, 'degraded');
		}
		for (const locator of locators) {
			const response = await call({ version: 1, requestId: requestId(options.requestIdPrefix, sequence++), operation: 'getViewport', handle: comparisonHandle, locator, range: [0, 0, 1, 1] });
			if (!response.ok) {
				warnings.add(`office.mobile.wordDiff.viewport.${response.error.code}`);
				outcome = combineOutcome(outcome, 'degraded');
				continue;
			}
			if (response.operation !== 'getViewport' || !sameRevision(revision, response.revision)) {
				throw new ParadisMobileWordDiffError('stale');
			}
			retainStructured(response.tile);
			tiles.push(response.tile);
			outcome = combineOutcome(outcome, response.outcome);
			for (const warning of response.warnings) { warnings.add(warning.code); }
		}

		let retainedAssetBytes = 0;
		for (const assetId of collectAssetIds(tiles)) {
			let offset = 0;
			let totalLength: number | undefined;
			const chunks: VSBuffer[] = [];
			while (totalLength === undefined || offset < totalLength) {
				const remainingBudget = Math.min(
					PARADIS_MOBILE_WORD_DIFF_ASSET_MAX_BYTES - retainedAssetBytes - offset,
					PARADIS_MOBILE_WORD_DIFF_BUNDLE_MAX_BYTES - retainedBundleBytes - retainedAssetBytes - offset,
				);
				if (remainingBudget <= 0) {
					warnings.add('office.mobile.wordDiff.assetsTruncated');
					outcome = combineOutcome(outcome, 'degraded');
					break;
				}
				const length = Math.min(PARADIS_OFFICE_LIMITS.maxAssetRequestBytes, remainingBudget, totalLength === undefined ? Number.MAX_SAFE_INTEGER : totalLength - offset);
				const response = await call({ version: 1, requestId: requestId(options.requestIdPrefix, sequence++), operation: 'getRenderableAsset', handle: comparisonHandle, assetId, offset, length });
				if (!response.ok) {
					warnings.add(`office.mobile.wordDiff.asset.${response.error.code}`);
					outcome = combineOutcome(outcome, 'degraded');
					break;
				}
				if (response.operation !== 'getRenderableAsset' || response.assetId !== assetId || response.offset !== offset || !sameRevision(revision, response.revision)
					|| totalLength !== undefined && response.totalLength !== totalLength || response.bytes.byteLength === 0 && offset < response.totalLength) {
					throw new ParadisMobileWordDiffError('stale');
				}
				totalLength = response.totalLength;
				if (totalLength > PARADIS_MOBILE_WORD_DIFF_ASSET_MAX_BYTES - retainedAssetBytes) {
					warnings.add('office.mobile.wordDiff.assetsTruncated');
					outcome = combineOutcome(outcome, 'degraded');
					break;
				}
				chunks.push(response.bytes.clone());
				offset += response.bytes.byteLength;
			}
			if (totalLength !== undefined && offset === totalLength) {
				const bytes = VSBuffer.concat(chunks, totalLength);
				const mime = assetMime(bytes);
				if (mime) {
					assets.set(assetId, { mime, bytes });
					retainedAssetBytes += totalLength;
				} else {
					warnings.add('office.mobile.wordDiff.assetUnsupported');
					outcome = combineOutcome(outcome, 'degraded');
				}
			}
		}
		return { generation: options.generation, revision, outcome, warnings: [...warnings], changes, tiles, assets };
	} catch (error) {
		if ((token.isCancellationRequested || error instanceof ParadisMobileWordDiffError && error.code === 'budget') && activeRequestId) {
			await client.request({ version: 1, requestId: requestId(options.requestIdPrefix, sequence++), operation: 'cancel', ...(comparisonHandle ? { handle: comparisonHandle } : {}), targetRequestId: activeRequestId }, CancellationToken.None).catch(() => undefined);
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		throw error;
	} finally {
		if (comparisonHandle) {
			await client.request({ version: 1, requestId: requestId(options.requestIdPrefix, sequence++), operation: 'close', handle: comparisonHandle }, CancellationToken.None).catch(() => undefined);
		}
	}
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function changeValueText(value: ParadisOfficeChangeValue, depth = 0): string {
	if (depth > PARADIS_OFFICE_LIMITS.maxChangeValueDepth) { return '…'; }
	switch (value.kind) {
		case 'none': return '—';
		case 'scalar': return value.value === null ? 'null' : String(value.value);
		case 'fingerprint': return `${value.algorithm}:${value.value}`;
		case 'list': return value.items.map(item => changeValueText(item, depth + 1)).join(', ');
		case 'record': return value.fields.map(field => `${field.name}: ${changeValueText(field.value, depth + 1)}`).join('; ');
	}
}

function renderRuns(block: ParadisOfficeRenderBlock): string {
	return (block.runs ?? []).map(run => {
		let value = escapeHtml(run.text);
		if (run.format?.bold) { value = `<strong>${value}</strong>`; }
		if (run.format?.italic) { value = `<em>${value}</em>`; }
		return value;
	}).join('');
}

function renderBlock(block: ParadisOfficeRenderBlock): string {
	const children = (block.children ?? []).map(renderBlock).join('');
	const anchor = block.anchor ? ` data-paradis-node="${escapeHtml(block.nodeId)}"` : '';
	return `<div class="pm-block pm-${escapeHtml(block.kind)}"${anchor}>${renderRuns(block)}${children}</div>`;
}

function mobileWordCsp(nonce: string): string {
	if (!/^[A-Za-z\d_-]{16,128}$/.test(nonce)) { throw new TypeError('Invalid mobile Word CSP nonce'); }
	return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none';`;
}

/** Serializes one already-owned semantic/render bundle without evaluating document-provided HTML. */
export function renderParadisMobileWordDiffHtml(bundle: ParadisMobileWordDiffBundle, nonce: string): string {
	const csp = mobileWordCsp(nonce);
	const tileByLocator = new Map(bundle.tiles.map(tile => [tile.locator, tile]));
	const renderedChanges: string[] = [];
	let renderedChangeBytes = 0;
	for (const change of bundle.changes) {
		const tile = tileByLocator.get(change.subject.locator);
		const blocks = tile?.blocks.map(renderBlock).join('') ?? '';
		const objects = (tile?.objects ?? []).map(object => {
			const asset = object.assetId ? bundle.assets.get(object.assetId) : undefined;
			const label = escapeHtml(object.altText || object.kind);
			return asset
				? `<figure class="pm-object"><img src="data:${asset.mime};base64,${encodeBase64(asset.bytes)}" alt="${label}"><figcaption>${label}</figcaption></figure>`
				: `<div class="pm-placeholder">${label}</div>`;
		}).join('');
		const anchor = change.navigableAnchor ? ` data-paradis-anchor="${escapeHtml(change.navigableAnchor)}"` : '';
		const rendered = `<article class="pm-change"${anchor}><header><span class="pm-category">${escapeHtml(change.category)}</span><span>${escapeHtml(change.subject.kind)} · ${escapeHtml(change.subject.locator)}</span></header><div class="pm-values"><del>${escapeHtml(changeValueText(change.before))}</del><ins>${escapeHtml(changeValueText(change.after))}</ins></div>${blocks}${objects}</article>`;
		renderedChangeBytes += VSBuffer.fromString(rendered).byteLength;
		if (!Number.isSafeInteger(renderedChangeBytes) || renderedChangeBytes > PARADIS_MOBILE_WORD_DIFF_HTML_MAX_BYTES) {
			throw new ParadisMobileWordDiffError('budget');
		}
		renderedChanges.push(rendered);
	}
	const warnings = bundle.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('');
	const summary = localize('paradis.mobile.wordDiff.summary', "{0} changes · {1}", bundle.changes.length, bundle.outcome);
	const noChanges = localize('paradis.mobile.wordDiff.noChanges', "No semantic changes.");
	const incomplete = localize('paradis.mobile.wordDiff.incomplete', "Comparison is incomplete.");
	const prefix = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><style>
html { color-scheme: light dark; } body { margin: 0; padding: 12px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; background: #fff; color: #1f2328; }
.pm-summary, .pm-warning { margin: 0 0 12px; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 6px; }
.pm-warning { background: #fff8c5; color: #4d2d00; } .pm-warning:empty { display: none; }
.pm-change { margin-bottom: 12px; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
.pm-change > header { display: flex; gap: 8px; padding: 8px 10px; background: #f6f8fa; font-weight: 600; }
.pm-category { color: #57606a; } .pm-values { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.pm-values del, .pm-values ins { padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; text-decoration: none; }
.pm-values del { background: #ffebe9; } .pm-values ins { background: #dafbe1; }
.pm-block, .pm-object, .pm-placeholder { margin: 8px 10px; } .pm-object img { display: block; max-width: 100%; height: auto; }
.pm-placeholder { padding: 8px; border: 1px dashed #8c959f; } @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } .pm-summary, .pm-change { border-color: #30363d; } .pm-change > header { background: #161b22; } .pm-values del { background: #3f1d1d; } .pm-values ins { background: #12391f; } }
</style></head><body><div class="pm-summary">${escapeHtml(summary)}</div><ul class="pm-warning">${warnings}</ul>`;
	const fallback = renderedChanges.length === 0
		? `<p>${escapeHtml(bundle.outcome === 'complete' && bundle.warnings.length === 0 ? noChanges : incomplete)}</p>`
		: '';
	const suffix = `${fallback}</body></html>`;
	if (VSBuffer.fromString(prefix).byteLength + renderedChangeBytes + VSBuffer.fromString(suffix).byteLength > PARADIS_MOBILE_WORD_DIFF_HTML_MAX_BYTES) {
		throw new ParadisMobileWordDiffError('budget');
	}
	return `${prefix}${renderedChanges.join('')}${suffix}`;
}
