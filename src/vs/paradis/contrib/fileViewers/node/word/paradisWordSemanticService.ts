/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で動く Word の詳しい解析。renderer（sandbox）では yauzl も Node の crypto も使えないので、
// Excel（paradisSpreadsheetService.ts）と同じく shared process で解析し、要約だけを返す。
// 表示（docx-preview）はこの結果を待たない。renderer は表示を出してから、この口を裏で呼ぶ。

import { createHash } from 'crypto';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { canonicalizeParadisOfficeArchiveName, ParadisOfficePackageError, throwIfParadisOfficeCancelled, type IParadisOfficeArchive } from '../../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage, type ParadisOfficePackageInventory } from '../../common/office/paradisOfficePackageCore.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { compareWordSemantics } from '../../common/word/paradisWordSemanticDiff.js';
import type { ParadisWordDocument } from '../../common/word/paradisWordSemantic.js';
import { indexParadisWordParagraphs } from '../../common/word/paradisWordRenderOutline.js';
import { buildParadisWordSemanticSnapshot } from '../../common/word/paradisWordSemanticSnapshot.js';
import {
	resolveParadisWordInventory,
	summarizeParadisWordDocument,
	type IParadisWordAnalysisResult,
	type IParadisWordChangeTarget,
	type IParadisWordComparisonResult,
	type IParadisWordSemanticFailure,
	type ParadisWordSemanticFailureCode,
	type ParadisWordSemanticFormat,
} from '../../common/word/paradisWordSemanticSummary.js';
import { createParadisOfficeNodeArchive } from '../office/paradisOfficeNodeArchive.js';
import { parseWordSemanticNode } from './paradisWordNodeAdapter.js';

const profile = PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal;

/** 開く・比べる操作で扱う上限。Word ビューアが読む上限（PARADIS_DOCX_MAX_BYTES）より少し広い。 */
export const PARADIS_WORD_SEMANTIC_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 比較の変更一覧の上限（比較の 1 ページの上限と同じ）。続きのページは比較を最初から計算し直すので取りに行かず、
 * これを超えたら「途中まで」と伝える。変更点パネルは 100 件ずつ表示する。
 */
const COMPARISON_CHANGE_LIMIT = 1_000;
/** 比較の締め切り。比較器が受け付ける上限（60 秒）に合わせる。 */
const COMPARISON_DEADLINE_MS = 60_000;
/** 覚えておく解析結果の数。開いた文書と、その比較の相手の 2 つで足りる（解析の木は大きいので増やさない）。 */
const CACHE_ENTRIES = 2;

/** ZIP としては読めたが、Word の本文が無い（Excel や PowerPoint など）。 */
class ParadisWordUnsupportedPackageError extends Error { }

interface ParsedWord {
	readonly inventory: ParadisOfficePackageInventory & { readonly format: ParadisWordSemanticFormat };
	readonly document: ParadisWordDocument;
	readonly inspectMs: number;
	readonly parseMs: number;
}

function failureCode(error: unknown): ParadisWordSemanticFailureCode {
	if (error instanceof ParadisWordUnsupportedPackageError) {
		return 'unsupported';
	}
	if (error instanceof ParadisOfficePackageError) {
		return error.code;
	}
	return 'failed';
}

function failure(code: ParadisWordSemanticFailureCode): IParadisWordSemanticFailure {
	return { ok: false, code };
}

async function readAllParts(archive: IParadisOfficeArchive, token: CancellationToken, checkpoint: () => void): Promise<Map<string, Uint8Array>> {
	const parts = new Map<string, Uint8Array>();
	let total = 0;
	try {
		for await (const entry of archive.entries(token)) {
			if (entry.directory || entry.symlink || entry.encrypted) {
				continue;
			}
			let name: string;
			try {
				name = canonicalizeParadisOfficeArchiveName(entry.name);
			} catch {
				continue;
			}
			checkpoint();
			const chunks: Uint8Array[] = [];
			let length = 0;
			for await (const chunk of archive.read(entry, token)) {
				length += chunk.byteLength;
				total += chunk.byteLength;
				if (length > profile.xmlPartBytes || total > profile.expandedBytes) {
					throw new ParadisOfficePackageError('limitExceeded');
				}
				chunks.push(chunk.slice());
			}
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			parts.set(name, bytes);
		}
	} finally {
		archive.dispose();
	}
	return parts;
}

/**
 * Word の解析を受け持つ。同じ中身の解析結果を少しだけ覚えておき（中身の SHA-256 で引く）、
 * 開いた文書をそのまま比較に回したときに読み直さない。
 */
export class ParadisWordSemanticService {
	private readonly cache = new Map<string, Promise<ParsedWord>>();

	async analyze(bytes: Uint8Array, token: CancellationToken = CancellationToken.None): Promise<IParadisWordAnalysisResult> {
		if (!(bytes instanceof Uint8Array)) {
			return failure('invalid');
		}
		if (bytes.byteLength > PARADIS_WORD_SEMANTIC_MAX_BYTES) {
			return failure('tooLarge');
		}
		if (token.isCancellationRequested) {
			return failure('cancelled');
		}
		return (async () => {
			try {
				const parsed = await this.parse(bytes, token);
				const summarizeWatch = StopWatch.create(true);
				const summary = summarizeParadisWordDocument(parsed.document, parsed.inventory, { checkpoint: () => throwIfParadisOfficeCancelled(token) });
				return {
					...summary,
					timings: { inspectMs: Math.round(parsed.inspectMs), parseMs: Math.round(parsed.parseMs), summarizeMs: Math.round(summarizeWatch.elapsed()) },
				};
			} catch (error) {
				return failure(failureCode(error));
			}
		})();
	}

	async compare(original: Uint8Array, modified: Uint8Array, token: CancellationToken = CancellationToken.None): Promise<IParadisWordComparisonResult> {
		if (!(original instanceof Uint8Array) || !(modified instanceof Uint8Array)) {
			return failure('invalid');
		}
		if (original.byteLength > PARADIS_WORD_SEMANTIC_MAX_BYTES || modified.byteLength > PARADIS_WORD_SEMANTIC_MAX_BYTES) {
			return failure('tooLarge');
		}
		if (token.isCancellationRequested) {
			return failure('cancelled');
		}
		return (async () => {
			try {
				// 比較全体で締め切りを 1 つにする。読み直し・補助モデル・比較のそれぞれに、残り時間だけを渡す。
				const total = StopWatch.create(true);
				const remaining = (): number => {
					const value = Math.floor(COMPARISON_DEADLINE_MS - total.elapsed());
					if (value <= 0) {
						throw new ParadisOfficePackageError('limitExceeded');
					}
					return value;
				};
				const checkpoint = () => {
					throwIfParadisOfficeCancelled(token);
					remaining();
				};
				const left = await this.parse(original, token, remaining());
				const right = await this.parse(modified, token, remaining());
				const xmlLimits = { depth: profile.xmlDepth, nodes: profile.xmlNodesPerPart, attributeLength: profile.attributeLength, characters: profile.xmlPartBytes };
				const leftParts = await readAllParts(await createParadisOfficeNodeArchive(original), token, checkpoint);
				const rightParts = await readAllParts(await createParadisOfficeNodeArchive(modified), token, checkpoint);
				const leftSnapshot = buildParadisWordSemanticSnapshot(left.document, leftParts, { token, xmlLimits, deadlineMilliseconds: remaining() });
				const rightSnapshot = buildParadisWordSemanticSnapshot(right.document, rightParts, { token, xmlLimits, deadlineMilliseconds: remaining() });
				const parseMs = total.elapsed();
				const compareWatch = StopWatch.create(true);
				const page = compareWordSemantics(leftSnapshot.snapshot, rightSnapshot.snapshot, {
					cancellationToken: token,
					deadlineMilliseconds: remaining(),
					pageSize: COMPARISON_CHANGE_LIMIT,
				});
				const summary = (parsed: ParsedWord) => summarizeParadisWordDocument(parsed.document, parsed.inventory, {
					limits: { changes: 0, changeTextCharacters: 0, searchItems: 0, searchCharacters: 0 },
					checkpoint: () => throwIfParadisOfficeCancelled(token),
				});
				const [leftSummary, rightSummary] = [summary(left), summary(right)];
				const navigation: Record<string, IParadisWordChangeTarget> = {};
				const leftParagraphs = indexParadisWordParagraphs(left.document);
				const rightParagraphs = indexParadisWordParagraphs(right.document);
				for (const change of page.changes) {
					const nodeId = change.navigableAnchor ?? /\/node:([^/]+)$/.exec(change.subject.locator)?.[1];
					if (!nodeId) {
						continue;
					}
					const removed = change.after.kind === 'none';
					const modifiedParagraph = removed ? undefined : rightParagraphs.get(nodeId);
					const originalParagraph = leftParagraphs.get(nodeId);
					if (modifiedParagraph) {
						navigation[change.id] = { side: 'modified', paragraph: modifiedParagraph };
					} else if (originalParagraph) {
						navigation[change.id] = { side: 'original', paragraph: originalParagraph };
					} else if (rightParagraphs.has(nodeId)) {
						navigation[change.id] = { side: 'modified', paragraph: rightParagraphs.get(nodeId)! };
					}
				}
				return {
					ok: true,
					changes: page.changes,
					completeness: page.completeness,
					outcome: page.outcome,
					noChanges: page.noChanges,
					truncated: page.nextCursor !== undefined,
					original: leftSummary.counts,
					modified: rightSummary.counts,
					omittedModels: [...new Set([...leftSnapshot.omittedModels, ...rightSnapshot.omittedModels])].sort(),
					securityUnreadable: leftSnapshot.securityUnreadable || rightSnapshot.securityUnreadable,
					originalOutline: leftSummary.outline,
					modifiedOutline: rightSummary.outline,
					navigation,
					truncatedValueChangeIds: page.truncatedValueChangeIds,
					timings: { parseMs: Math.round(parseMs), compareMs: Math.round(compareWatch.elapsed()) },
				};
			} catch (error) {
				return failure(failureCode(error));
			}
		})();
	}

	private parse(bytes: Uint8Array, token: CancellationToken, deadlineMilliseconds = profile.semanticParseMilliseconds): Promise<ParsedWord> {
		const key = createHash('sha256').update(bytes).digest('hex');
		const cached = this.cache.get(key);
		if (cached) {
			// 新しく使ったものを後ろへ回す（古いものから捨てる）。
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}
		const parsed = this.parseUncached(bytes, token, deadlineMilliseconds);
		this.cache.set(key, parsed);
		// 失敗・取り消しは覚えない（次に開いたときにもう一度試す）。
		parsed.catch(() => {
			if (this.cache.get(key) === parsed) {
				this.cache.delete(key);
			}
		});
		while (this.cache.size > CACHE_ENTRIES) {
			this.cache.delete(this.cache.keys().next().value!);
		}
		return parsed;
	}

	private async parseUncached(bytes: Uint8Array, token: CancellationToken, deadlineMilliseconds: number): Promise<ParsedWord> {
		const inspectWatch = StopWatch.create(true);
		const inspected = await inspectOfficePackage(await createParadisOfficeNodeArchive(bytes.slice()), profile, token);
		const inventory = resolveParadisWordInventory(inspected);
		if (!inventory) {
			throw new ParadisWordUnsupportedPackageError();
		}
		const inspectMs = inspectWatch.elapsed();
		const parseWatch = StopWatch.create(true);
		const document = await parseWordSemanticNode(bytes, inventory, token, { deadlineMilliseconds: Math.min(deadlineMilliseconds, profile.semanticParseMilliseconds) }, 'desktopLocal');
		return { inventory, document, inspectMs, parseMs: parseWatch.elapsed() };
	}
}
