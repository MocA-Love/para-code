/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ParadisOfficePackageError } from '../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage, type ParadisOfficePackageInventory } from '../common/office/paradisOfficePackageCore.js';
import {
	PARADIS_OFFICE_BUDGET_PROFILES,
	isOfficeSerializableData,
	type ParadisOfficeChangeCategory,
	type ParadisOfficeFingerprint,
} from '../common/paradisOfficeProtocol.js';
import type {
	ParadisSemanticBorderEdge,
	ParadisSemanticCell,
	ParadisSpreadsheetColor,
	ParadisSpreadsheetSnapshot,
} from '../common/spreadsheet/paradisSpreadsheetSemantic.js';
import { compareSpreadsheetSemantics } from '../common/spreadsheet/paradisSpreadsheetSemanticDiff.js';
import type {
	ParadisWordDrawingGeometry,
	ParadisWordDrawingNode,
	ParadisWordNode,
	ParadisWordTableDiagonalBorder,
} from '../common/word/paradisWordSemantic.js';
import { compareWordSemantics } from '../common/word/paradisWordSemanticDiff.js';
import { findParadisOfficeMainDocumentPart } from '../common/word/paradisWordSemanticSummary.js';
import { createParadisOfficeWebArchive } from './office/paradisOfficeWebArchive.js';
import { parseSpreadsheetSemanticWeb } from './spreadsheet/paradisSpreadsheetWebAdapter.js';
import { parseWordSemanticWeb } from './word/paradisWordWebAdapter.js';
import type { ParadisOfficeSemanticFormat } from './paradisFileViewers.js';
import type {
	ParadisOfficeBrowserDiffSummary,
	ParadisOfficeBrowserSemanticSummary,
	ParadisOfficeBrowserSpreadsheetCell,
	ParadisOfficeBrowserSpreadsheetDiagonal,
	ParadisOfficeBrowserSpreadsheetSummary,
	ParadisOfficeBrowserWordSummary,
	ParadisOfficeWebWorkerMessage,
	ParadisOfficeWebWorkerRunMessage,
} from './paradisOfficeWebWorkerClient.js';

// 使う側（主スレッド）の型・接続口・クライアントは paradisOfficeWebWorkerClient.ts にある。エディタが解析本体を
// 静的に読まないよう分けてあり、ここからは同じ名前で出し直すだけ。
export * from './paradisOfficeWebWorkerClient.js';

const maximumSpreadsheetSummaryCells = 10_000;
const maximumWordSummaryStories = 256;
const maximumWordStoryCharacters = 200_000;
const maximumWordSummaryDrawings = 512;
const maximumWordSummaryDiagonals = 1_024;
const mainContentTypes: Readonly<Record<ParadisOfficeSemanticFormat, ReadonlySet<string>>> = {
	xlsx: new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.main+xml']),
	xlsm: new Set(['application/vnd.ms-excel.sheet.macroEnabled.main+xml']),
	xltx: new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml', 'application/vnd.ms-excel.template.main+xml']),
	xltm: new Set(['application/vnd.ms-excel.template.macroEnabled.main+xml']),
	docx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']),
	docm: new Set(['application/vnd.ms-word.document.macroEnabled.main+xml']),
	dotx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml']),
	dotm: new Set(['application/vnd.ms-word.template.macroEnabledTemplate.main+xml']),
};

function ownedWorkerBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	const source = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
	if (!source || !(source.buffer instanceof ArrayBuffer) || source.buffer.resizable || source.buffer.byteLength !== source.byteLength) {
		throw new ParadisOfficePackageError('invalid');
	}
	const copy = new Uint8Array(source.byteLength);
	copy.set(source);
	return copy;
}

function isSpreadsheetFormat(format: ParadisOfficeSemanticFormat): format is 'xlsx' | 'xlsm' | 'xltx' | 'xltm' {
	return format === 'xlsx' || format === 'xlsm' || format === 'xltx' || format === 'xltm';
}

function inventoryForRequestedFormat(inventory: ParadisOfficePackageInventory, requested: ParadisOfficeSemanticFormat): ParadisOfficePackageInventory | undefined {
	const mainPart = findParadisOfficeMainDocumentPart(inventory);
	if (!mainPart || !mainContentTypes[requested].has(mainPart.contentType)) {
		return undefined;
	}
	return { ...inventory, format: requested };
}

export async function executeParadisOfficeWebWorkerRequest(
	request: ParadisOfficeWebWorkerRunMessage,
	token: CancellationToken,
): Promise<Extract<ParadisOfficeWebWorkerMessage, { readonly kind: 'result' | 'cancelled' | 'failure' }>> {
	if (token.isCancellationRequested) {
		return { kind: 'cancelled', requestId: request.requestId };
	}
	try {
		const originalBytes = ownedWorkerBytes(request.originalBytes);
		if (originalBytes.byteLength > PARADIS_OFFICE_BUDGET_PROFILES.browser.compressedInputBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const inspectedOriginal = await inspectOfficePackage(
			await createParadisOfficeWebArchive(originalBytes),
			PARADIS_OFFICE_BUDGET_PROFILES.browser,
			token,
		);
		const originalInventory = inventoryForRequestedFormat(inspectedOriginal, request.format);
		if (!originalInventory) {
			return { kind: 'failure', requestId: request.requestId, reason: 'unsupported' };
		}

		if (request.operation === 'view') {
			const value = isSpreadsheetFormat(request.format)
				? projectSpreadsheetSummary(
					await parseSpreadsheetSemanticWeb(originalBytes, originalInventory, token, { deadlineMilliseconds: PARADIS_OFFICE_BUDGET_PROFILES.browser.semanticParseMilliseconds }),
					request.format,
					originalInventory.relationships.filter(relationship => relationship.targetMode === 'external').length,
				)
				: projectWordSummary(
					await parseWordSemanticWeb(originalBytes, originalInventory, token, { deadlineMilliseconds: PARADIS_OFFICE_BUDGET_PROFILES.browser.semanticParseMilliseconds }),
					request.format,
					originalInventory.relationships.filter(relationship => relationship.targetMode === 'external').length,
				);
			return boundedWorkerResult(request.requestId, value);
		}

		if (!request.modifiedBytes) {
			return { kind: 'failure', requestId: request.requestId, reason: 'unsupported' };
		}
		const modifiedBytes = ownedWorkerBytes(request.modifiedBytes);
		const inspectedModified = await inspectOfficePackage(
			await createParadisOfficeWebArchive(modifiedBytes),
			PARADIS_OFFICE_BUDGET_PROFILES.browser,
			token,
		);
		const modifiedInventory = inventoryForRequestedFormat(inspectedModified, request.format);
		if (!modifiedInventory) {
			return { kind: 'failure', requestId: request.requestId, reason: 'unsupported' };
		}
		const value = isSpreadsheetFormat(request.format)
			? projectDiffSummary(request.format, compareSpreadsheetSemantics(
				await parseSpreadsheetSemanticWeb(originalBytes, originalInventory, token),
				await parseSpreadsheetSemanticWeb(modifiedBytes, modifiedInventory, token),
				{ cancellationToken: token, deadlineMilliseconds: PARADIS_OFFICE_BUDGET_PROFILES.browser.diffMilliseconds },
			))
			// Web 版の Word の比較は本文の木だけを比べる（スタイル・セキュリティなどの補助モデルは作らない）。
			: projectDiffSummary(request.format, compareWordSemantics(
				await parseWordSemanticWeb(originalBytes, originalInventory, token),
				await parseWordSemanticWeb(modifiedBytes, modifiedInventory, token),
				{ cancellationToken: token, deadlineMilliseconds: PARADIS_OFFICE_BUDGET_PROFILES.browser.diffMilliseconds },
			));
		return boundedWorkerResult(request.requestId, value);
	} catch (error) {
		if (token.isCancellationRequested || error instanceof ParadisOfficePackageError && error.code === 'cancelled') {
			return { kind: 'cancelled', requestId: request.requestId };
		}
		return {
			kind: 'failure',
			requestId: request.requestId,
			reason: error instanceof ParadisOfficePackageError && (error.code === 'limitExceeded' || error.code === 'zipBomb') ? 'limitExceeded' : 'workerFailed',
		};
	}
}

function boundedWorkerResult(requestId: string, value: ParadisOfficeBrowserSemanticSummary): Extract<ParadisOfficeWebWorkerMessage, { readonly kind: 'result' | 'failure' }> {
	const result = { kind: 'result', requestId, value } as const;
	return isOfficeSerializableData(result) ? result : { kind: 'failure', requestId, reason: 'limitExceeded' };
}

function projectSpreadsheetSummary(
	snapshot: ParadisSpreadsheetSnapshot,
	format: 'xlsx' | 'xlsm' | 'xltx' | 'xltm',
	externalRelationshipCount: number,
): ParadisOfficeBrowserSpreadsheetSummary {
	let remaining = maximumSpreadsheetSummaryCells;
	const sheets = snapshot.sheets.map(sheet => {
		const cells: ParadisOfficeBrowserSpreadsheetCell[] = [];
		const entries = [...sheet.cells.entries()].map(([address, cell]) => ({ address, cell, position: spreadsheetAddress(address) }))
			.filter(entry => entry.position !== undefined)
			.sort((left, right) => left.position!.row - right.position!.row || left.position!.column - right.position!.column);
		for (const entry of entries) {
			if (remaining-- <= 0) {
				break;
			}
			const formatRecord = entry.cell.effectiveStyleRef === undefined ? undefined : snapshot.styles.cellFormats[entry.cell.effectiveStyleRef];
			const border = formatRecord?.borderRef === undefined ? undefined : snapshot.styles.borders[formatRecord.borderRef];
			const diagonal = border && (border.diagonalUp || border.diagonalDown)
				? copySpreadsheetDiagonal(border.diagonalUp === true, border.diagonalDown === true, border.diagonal)
				: undefined;
			cells.push({
				address: entry.address,
				row: entry.position!.row,
				column: entry.position!.column,
				text: spreadsheetCellText(entry.cell),
				storedType: entry.cell.storedType,
				...(diagonal ? { diagonal } : {}),
			});
		}
		return { name: sheet.name, cells, truncated: cells.length < entries.length };
	});
	return { kind: 'spreadsheet', format, budgetProfile: 'browser', sheets, externalRelationshipCount };
}

function copySpreadsheetDiagonal(up: boolean, down: boolean, edge: ParadisSemanticBorderEdge | undefined): ParadisOfficeBrowserSpreadsheetDiagonal {
	return {
		up,
		down,
		...(edge?.style ? { style: edge.style } : {}),
		...(edge?.color ? { color: copySpreadsheetColor(edge.color) } : {}),
	};
}

function copySpreadsheetColor(color: ParadisSpreadsheetColor): ParadisSpreadsheetColor {
	return { ...color };
}

function spreadsheetCellText(cell: ParadisSemanticCell): string {
	if (cell.text !== undefined) {
		return cell.text;
	}
	if (cell.rawValue?.present) {
		return cell.rawValue.text;
	}
	if (cell.cachedResult?.present) {
		return cell.cachedResult.rawValue;
	}
	return '';
}

function spreadsheetAddress(address: string): { readonly row: number; readonly column: number } | undefined {
	const match = /^(?<column>[A-Z]{1,4})(?<row>[1-9]\d{0,6})$/.exec(address);
	if (!match?.groups) {
		return undefined;
	}
	let column = 0;
	for (const character of match.groups.column) {
		column = column * 26 + character.charCodeAt(0) - 64;
	}
	return { row: Number(match.groups.row), column };
}

function projectWordSummary(
	document: Awaited<ReturnType<typeof parseWordSemanticWeb>>,
	format: 'docx' | 'docm' | 'dotx' | 'dotm',
	externalRelationshipCount: number,
): ParadisOfficeBrowserWordSummary {
	const drawings: { nodeId: string; geometry: ParadisWordDrawingGeometry }[] = [];
	const tableDiagonals: ParadisWordTableDiagonalBorder[] = [];
	const observed = { drawings: 0, tableDiagonals: 0 };
	for (const story of document.stories) {
		collectWordGeometry(story.nodes, drawings, tableDiagonals, observed);
	}
	return {
		kind: 'word',
		format,
		budgetProfile: 'browser',
		stories: document.stories.slice(0, maximumWordSummaryStories).map(story => ({
			kind: story.address.kind,
			text: story.text.slice(0, maximumWordStoryCharacters),
			truncated: story.text.length > maximumWordStoryCharacters,
		})),
		truncated: document.stories.length > maximumWordSummaryStories
			|| document.stories.some(story => story.text.length > maximumWordStoryCharacters)
			|| observed.drawings > maximumWordSummaryDrawings
			|| observed.tableDiagonals > maximumWordSummaryDiagonals,
		drawings,
		tableDiagonals,
		externalRelationshipCount,
	};
}

function collectWordGeometry(
	nodes: readonly ParadisWordNode[],
	drawings: { nodeId: string; geometry: ParadisWordDrawingGeometry }[],
	tableDiagonals: ParadisWordTableDiagonalBorder[],
	observed: { drawings: number; tableDiagonals: number },
): void {
	for (const node of nodes) {
		if (node.kind === 'drawing') {
			observed.drawings++;
			if (drawings.length < maximumWordSummaryDrawings) {
				drawings.push({ nodeId: node.id, geometry: copyWordGeometry(node) });
			}
		}
		if (node.kind === 'table') {
			observed.tableDiagonals += node.diagonalBorders.length;
			if (tableDiagonals.length < maximumWordSummaryDiagonals) {
				for (const diagonal of node.diagonalBorders.slice(0, maximumWordSummaryDiagonals - tableDiagonals.length)) {
					tableDiagonals.push(copyWordDiagonal(diagonal));
				}
			}
		}
		if (node.children) {
			collectWordGeometry(node.children, drawings, tableDiagonals, observed);
		}
	}
}

function copyWordGeometry(node: ParadisWordDrawingNode): ParadisWordDrawingGeometry {
	const geometry = node.geometry;
	return {
		placement: geometry.placement,
		distances: { ...geometry.distances },
		...(geometry.simplePosition ? { simplePosition: { ...geometry.simplePosition } } : {}),
		...(geometry.horizontalPosition ? { horizontalPosition: { ...geometry.horizontalPosition } } : {}),
		...(geometry.verticalPosition ? { verticalPosition: { ...geometry.verticalPosition } } : {}),
		...(geometry.extent ? { extent: { ...geometry.extent } } : {}),
		...(geometry.effectExtent ? { effectExtent: { ...geometry.effectExtent } } : {}),
		...(geometry.wrap ? { wrap: { ...geometry.wrap, distances: { ...geometry.wrap.distances } } } : {}),
		...(geometry.transform ? {
			transform: {
				...geometry.transform,
				...(geometry.transform.offset ? { offset: { ...geometry.transform.offset } } : {}),
				...(geometry.transform.extent ? { extent: { ...geometry.transform.extent } } : {}),
			},
		} : {}),
		...(geometry.presetGeometry ? { presetGeometry: geometry.presetGeometry } : {}),
		...(geometry.line ? {
			line: {
				...geometry.line,
				...(geometry.line.headEnd ? { headEnd: { ...geometry.line.headEnd } } : {}),
				...(geometry.line.tailEnd ? { tailEnd: { ...geometry.line.tailEnd } } : {}),
			},
		} : {}),
		...(geometry.anchorProperties ? { anchorProperties: { ...geometry.anchorProperties } } : {}),
		sourcePartFingerprint: copyFingerprint(geometry.sourcePartFingerprint),
	};
}

function copyWordDiagonal(diagonal: ParadisWordTableDiagonalBorder): ParadisWordTableDiagonalBorder {
	return {
		...diagonal,
		sourceSemanticPath: [...diagonal.sourceSemanticPath],
		sourcePartFingerprint: copyFingerprint(diagonal.sourcePartFingerprint),
	};
}

function copyFingerprint(fingerprint: ParadisOfficeFingerprint): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: fingerprint.value, byteLength: fingerprint.byteLength };
}

function projectDiffSummary(
	format: ParadisOfficeSemanticFormat,
	page: { readonly changes: readonly { readonly id: string; readonly category: ParadisOfficeChangeCategory; readonly subject: { readonly kind: string; readonly locator: string }; readonly certainty: string }[]; readonly terminal: boolean },
): ParadisOfficeBrowserDiffSummary {
	return {
		kind: 'diff',
		format,
		budgetProfile: 'browser',
		changes: page.changes.map(change => ({ id: change.id, category: change.category, subjectKind: change.subject.kind, locator: change.subject.locator, certainty: change.certainty })),
		terminal: page.terminal,
	};
}

interface WorkerGlobalScopeLike {
	readonly constructor?: { readonly name?: string };
	postMessage(message: ParadisOfficeWebWorkerMessage): void;
	addEventListener(type: 'message', listener: (event: MessageEvent<ParadisOfficeWebWorkerMessage>) => void): void;
}

function installWorkerHandler(scope: WorkerGlobalScopeLike): void {
	let active: { readonly requestId: string; readonly cancellation: CancellationTokenSource } | undefined;
	scope.addEventListener('message', event => {
		const message = event.data;
		if (message.kind === 'cancel') {
			if (active?.requestId === message.requestId) {
				active.cancellation.cancel();
			}
			return;
		}
		if (message.kind !== 'run' || active) {
			return;
		}
		const cancellation = new CancellationTokenSource();
		active = { requestId: message.requestId, cancellation };
		void executeParadisOfficeWebWorkerRequest(message, cancellation.token).then(result => {
			scope.postMessage(isOfficeSerializableData(result)
				? result
				: { kind: 'failure', requestId: message.requestId, reason: 'limitExceeded' });
		}).finally(() => {
			cancellation.dispose();
			if (active?.requestId === message.requestId) {
				active = undefined;
			}
		});
	});
}

const possibleWorkerScope = globalThis as typeof globalThis & Partial<WorkerGlobalScopeLike>;
if (possibleWorkerScope.constructor?.name === 'DedicatedWorkerGlobalScope'
	&& typeof possibleWorkerScope.postMessage === 'function'
	&& typeof possibleWorkerScope.addEventListener === 'function') {
	installWorkerHandler(possibleWorkerScope as WorkerGlobalScopeLike);
}
