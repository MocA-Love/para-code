/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { paradisWordChangeCategoryLabel, paradisWordChangeRecordText, paradisWordChangeStory, paradisWordChangeValueText, paradisWordNodeKindLabel, paradisWordStoryLabel, wordChangeLabel } from '../../fileViewers/common/word/paradisWordChangeLabels.js';
import {
	PARADIS_OFFICE_LIMITS,
	type ParadisOfficeChange,
	type ParadisOfficeChangeCategory,
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

/** 片側の値の表示。文字を持つ値は文字（コメントなら著者も）、無い側は「（無し）」、それ以外は値の中身をそのまま。 */
function sideText(change: ParadisOfficeChange, value: ParadisOfficeChangeValue): string {
	if (value.kind === 'none') {
		return localize('paradis.mobile.wordDiff.none', "（無し）");
	}
	const text = paradisWordChangeValueText(change, value);
	if (text === undefined) {
		return changeValueText(value);
	}
	const author = paradisWordChangeRecordText(value, 'author');
	return author ? localize('paradis.mobile.wordDiff.author', "{0}（{1}）", text, author) : text;
}

/**
 * 見出しの右側（「本文の段落」）。デスクトップの一覧の表示名を使うが、分類と同じ名前になる変更（段落の文字なら「内容」）は
 * 要素の名前（段落）にする。文書パーツと同じ名前なら 1 つだけ出す（コメントの「コメントのコメント」にしない）。
 */
function changeWhere(change: ParadisOfficeChange): string {
	const story = paradisWordStoryLabel(paradisWordChangeStory(change).kind);
	let kind = wordChangeLabel(change);
	if (kind === paradisWordChangeCategoryLabel(change.category)) {
		const prefix = change.subject.kind.split('.')[0];
		const node = paradisWordNodeKindLabel(prefix);
		if (node !== prefix) {
			kind = node;
		}
	}
	return kind === story ? story : localize('paradis.mobile.wordDiff.where', "{0}の{1}", story, kind);
}

/** 比較の途中で積んだ警告のコードを、利用者が読む文にする。知らないコードは一般の文にまとめる。 */
function warningText(code: string): string {
	switch (code) {
		case 'office.mobile.wordDiff.assetsTruncated': return localize('paradis.mobile.wordDiff.warning.assetsTruncated', "画像が多いため、一部の画像を表示していません。");
		case 'office.mobile.wordDiff.assetUnsupported': return localize('paradis.mobile.wordDiff.warning.assetUnsupported', "表示できない形式の画像があります。");
		case 'office.mobile.wordDiff.locatorsTruncated': return localize('paradis.mobile.wordDiff.warning.locatorsTruncated', "変更が多いため、一部の変更の本文を表示していません。");
		case 'semanticComparisonPending': return localize('paradis.mobile.wordDiff.warning.semanticPending', "この文書は内容の比較に対応していません。");
		case 'word.pagination.approximate': return localize('paradis.mobile.wordDiff.warning.pagination', "ページの区切りはおおよその位置です。");
	}
	if (code.startsWith('office.mobile.wordDiff.viewport.')) {
		return localize('paradis.mobile.wordDiff.warning.viewport', "一部の変更の本文を読み込めませんでした。");
	}
	if (code.startsWith('office.mobile.wordDiff.asset.')) {
		return localize('paradis.mobile.wordDiff.warning.asset', "一部の画像を読み込めませんでした。");
	}
	return localize('paradis.mobile.wordDiff.warning.other', "一部を比較できませんでした。");
}

/** 比較が全部終わったか（outcome）を、警告が無いときに出す文にする。 */
function outcomeText(outcome: ParadisOfficeOutcome): string {
	switch (outcome) {
		case 'complete': return localize('paradis.mobile.wordDiff.outcome.complete', "すべての変更を比較しました。");
		case 'degraded': return localize('paradis.mobile.wordDiff.outcome.degraded', "一部を省略して比較しました。");
		case 'sideMissing': return localize('paradis.mobile.wordDiff.outcome.sideMissing', "片方のファイルが無いため、比較できない部分があります。");
		case 'stale': return localize('paradis.mobile.wordDiff.outcome.stale', "比較の途中でファイルが変わりました。開き直してください。");
		case 'cancelled': return localize('paradis.mobile.wordDiff.outcome.cancelled', "比較を取り消しました。");
		case 'blocked': return localize('paradis.mobile.wordDiff.outcome.blocked', "安全のため、比較できない部分があります。");
		case 'failed': return localize('paradis.mobile.wordDiff.outcome.failed', "比較できませんでした。");
	}
}

/** 要約: 件数・比較が全部終わったかの文（警告があれば警告の文）・分類ごとの件数。 */
function renderSummary(bundle: ParadisMobileWordDiffBundle): string {
	const warnings = [...new Set(bundle.warnings.map(warningText))];
	const ok = bundle.outcome === 'complete' && warnings.length === 0;
	const state = warnings.length > 0 ? warnings.join(' ') : outcomeText(bundle.outcome);
	const counts = new Map<ParadisOfficeChangeCategory, number>();
	for (const change of bundle.changes) {
		counts.set(change.category, (counts.get(change.category) ?? 0) + 1);
	}
	const chips = [...counts].map(([category, count]) => `<span>${escapeHtml(`${paradisWordChangeCategoryLabel(category)} ${count}`)}</span>`).join('');
	const total = localize('paradis.mobile.wordDiff.summary', "{0} 件の変更", bundle.changes.length);
	return `<div class="pm-summary"><b>${escapeHtml(total)}</b><span class="pm-sum-state ${ok ? 'ok' : 'warn'}">${escapeHtml(state)}</span><div class="pm-counts">${chips}</div></div>`;
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
	// 色が見分けにくくても前後が分かるよう、各段に文字の札を付ける（狭い幅では上下に積む）
	const beforeLabel = localize('paradis.mobile.wordDiff.before', "変更前");
	const afterLabel = localize('paradis.mobile.wordDiff.after', "変更後");
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
		const rendered = `<article class="pm-change"${anchor}><header><span class="pm-category">${escapeHtml(paradisWordChangeCategoryLabel(change.category))}</span><span class="pm-where">${escapeHtml(changeWhere(change))}</span></header><div class="pm-values"><del><span class="pm-lab">${escapeHtml(beforeLabel)}</span>${escapeHtml(sideText(change, change.before))}</del><ins><span class="pm-lab">${escapeHtml(afterLabel)}</span>${escapeHtml(sideText(change, change.after))}</ins></div>${blocks}${objects}</article>`;
		renderedChangeBytes += VSBuffer.fromString(rendered).byteLength;
		if (!Number.isSafeInteger(renderedChangeBytes) || renderedChangeBytes > PARADIS_MOBILE_WORD_DIFF_HTML_MAX_BYTES) {
			throw new ParadisMobileWordDiffError('budget');
		}
		renderedChanges.push(rendered);
	}
	const noChanges = localize('paradis.mobile.wordDiff.noChanges', "内容の変更はありません。");
	const incomplete = localize('paradis.mobile.wordDiff.incomplete', "比較が完了していません。");
	// 狭い幅（iPhone の縦）では変更前・変更後を全幅で上下に積み、広い幅（iPad の詳細の列）では左右に並べる。
	// 色はライトとダークの両方を書く（WebView がアプリの外観を引き継ぐかに頼らない）。
	const prefix = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><style>
html { color-scheme: light dark; } body { margin: 0; padding: 12px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; background: #fff; color: #1f2328; }
.pm-summary { margin: 0 0 12px; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 6px; }
.pm-sum-state { display: block; margin-top: 4px; font-size: 13px; } .pm-sum-state.ok { color: #1a7f37; } .pm-sum-state.warn { color: #9a6700; }
.pm-counts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; } .pm-counts:empty { display: none; }
.pm-counts span { font-size: 12px; padding: 0 8px; line-height: 20px; border-radius: 10px; border: 1px solid #d0d7de; color: #57606a; }
.pm-change { margin-bottom: 12px; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
.pm-change > header { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 10px; background: #f6f8fa; font-weight: 600; }
.pm-category { color: #57606a; } .pm-values { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.pm-values del, .pm-values ins { display: block; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; text-decoration: none; }
.pm-values del { background: #ffebe9; } .pm-values ins { background: #dafbe1; }
.pm-lab { display: block; margin-bottom: 2px; font-size: 12px; font-weight: 600; } .pm-values del .pm-lab { color: #cf222e; } .pm-values ins .pm-lab { color: #1a7f37; }
@media (max-width: 520px) { .pm-values { grid-template-columns: minmax(0, 1fr); } }
.pm-block, .pm-object, .pm-placeholder { margin: 8px 10px; } .pm-object img { display: block; max-width: 100%; height: auto; }
.pm-placeholder { padding: 8px; border: 1px dashed #8c959f; }
@media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } .pm-summary, .pm-change, .pm-counts span { border-color: #30363d; } .pm-change > header { background: #161b22; } .pm-category, .pm-counts span { color: #8b949e; } .pm-sum-state.ok { color: #7ee787; } .pm-sum-state.warn { color: #e3b341; } .pm-values del { background: #3f1d1d; } .pm-values ins { background: #12391f; } .pm-values del .pm-lab { color: #ffa198; } .pm-values ins .pm-lab { color: #7ee787; } }
</style></head><body>${renderSummary(bundle)}`;
	const fallback = renderedChanges.length === 0
		? `<p>${escapeHtml(bundle.outcome === 'complete' && bundle.warnings.length === 0 ? noChanges : incomplete)}</p>`
		: '';
	const suffix = `${fallback}</body></html>`;
	if (VSBuffer.fromString(prefix).byteLength + renderedChangeBytes + VSBuffer.fromString(suffix).byteLength > PARADIS_MOBILE_WORD_DIFF_HTML_MAX_BYTES) {
		throw new ParadisMobileWordDiffError('budget');
	}
	return `${prefix}${renderedChanges.join('')}${suffix}`;
}
