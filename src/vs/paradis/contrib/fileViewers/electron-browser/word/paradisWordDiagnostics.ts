/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as dom from '../../../../../base/browser/dom.js';
import type { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import {
	canReportNoChanges,
	type ParadisOfficeCompletenessManifest,
	type ParadisOfficeOutcome,
	type ParadisOfficePrintModel,
	type ParadisOfficeRenderCoverage,
} from '../../common/paradisOfficeProtocol.js';
import type { IParadisWordAnalysisCounts, ParadisWordSemanticFailureCode } from '../../common/word/paradisWordSemanticSummary.js';
import { PARADIS_OFFICE_LISTED_PARTS_LIMIT, type ParadisOfficeBlockedPart, type ParadisOfficeIgnoredPart, type ParadisOfficeRenderablePackage } from '../../common/paradisOfficeSanitizer.js';

/** Theme variables keep diagnostics legible when ordinary colors collapse in high-contrast themes. */
export const PARADIS_WORD_HIGH_CONTRAST_TOKENS = Object.freeze({
	border: 'var(--vscode-contrastBorder, var(--vscode-editorWidget-border, currentColor))',
	focus: 'var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, currentColor))',
	foreground: 'var(--vscode-foreground, currentColor)',
	warning: 'var(--vscode-editorWarning-foreground, var(--vscode-foreground, currentColor))',
});

export interface ParadisWordDiagnosticsInput {
	readonly outcome: ParadisOfficeOutcome;
	readonly coverages: readonly ParadisOfficeRenderCoverage[];
	readonly warnings?: readonly { readonly code: string; readonly message: string }[];
}

export interface ParadisWordDiagnosticsSummary {
	readonly faithful: number;
	readonly approximate: number;
	readonly alternatives: number;
	readonly incomplete: boolean;
}

export function summarizeWordDiagnostics(input: ParadisWordDiagnosticsInput): ParadisWordDiagnosticsSummary {
	let faithful = 0;
	let approximate = 0;
	let alternatives = 0;
	for (const coverage of input.coverages) {
		if (coverage === 'rendered') {
			faithful++;
		} else if (coverage === 'approximated') {
			approximate++;
		} else {
			alternatives++;
		}
	}
	return { faithful, approximate, alternatives, incomplete: input.outcome !== 'complete' };
}

/** The Kernel completeness gate is the only authority for presenting an empty comparison as No Changes. */
export function canShowWordNoChanges(manifest: ParadisOfficeCompletenessManifest, outcome: ParadisOfficeOutcome, changeCount: number): boolean {
	return canReportNoChanges(manifest, outcome, changeCount);
}

function appendRibbonItem(parent: HTMLElement, text: string, kind: string): void {
	const item = dom.append(parent, dom.$('span.paradis-word-diagnostic-item'));
	item.dataset.kind = kind;
	item.style.display = 'inline-flex';
	item.style.alignItems = 'center';
	item.style.padding = '1px 6px';
	item.style.border = `1px solid ${PARADIS_WORD_HIGH_CONTRAST_TOKENS.border}`;
	item.style.borderRadius = '2px';
	item.textContent = text;
}

/** Renders fixed elements and text nodes only; document strings are never parsed as markup. */
export function renderWordDiagnosticsRibbon(container: HTMLElement, input: ParadisWordDiagnosticsInput): HTMLElement {
	dom.clearNode(container);
	const summary = summarizeWordDiagnostics(input);
	const ribbon = dom.append(container, dom.$('.paradis-word-diagnostics'));
	ribbon.setAttribute('role', 'status');
	ribbon.setAttribute('aria-live', 'polite');
	ribbon.setAttribute('aria-atomic', 'true');
	ribbon.style.display = 'flex';
	ribbon.style.flexWrap = 'wrap';
	ribbon.style.alignItems = 'center';
	ribbon.style.gap = '4px';
	ribbon.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.foreground;
	appendRibbonItem(ribbon, localize('paradis.word.diagnostics.faithful', "完全再現 {0}", summary.faithful), 'faithful');
	appendRibbonItem(ribbon, localize('paradis.word.diagnostics.approximate', "近似 {0}", summary.approximate), 'approximate');
	appendRibbonItem(ribbon, localize('paradis.word.diagnostics.alternatives', "代替表示 {0}", summary.alternatives), 'alternatives');
	if (summary.incomplete) {
		const incomplete = dom.append(ribbon, dom.$('span.paradis-word-diagnostic-incomplete'));
		incomplete.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.warning;
		incomplete.style.borderBottom = `1px solid ${PARADIS_WORD_HIGH_CONTRAST_TOKENS.border}`;
		incomplete.textContent = localize('paradis.word.diagnostics.incomplete', "解析未完了");
	}
	for (const warning of input.warnings ?? []) {
		const warningElement = dom.append(ribbon, dom.$('span.paradis-word-diagnostic-warning'));
		warningElement.dataset.code = warning.code;
		warningElement.textContent = warning.message;
	}
	return ribbon;
}

/** 描画用のパッケージから外した部品（Q313 A）。表示に関係しないので黙って外したものと、安全のために外したもの。 */
export interface ParadisWordPackageExclusions {
	readonly ignored: readonly ParadisOfficeIgnoredPart[];
	readonly ignoredOmitted: number;
	readonly blocked: readonly ParadisOfficeBlockedPart[];
	readonly blockedOmitted: number;
}

export const EMPTY_PARADIS_WORD_PACKAGE_EXCLUSIONS: ParadisWordPackageExclusions = Object.freeze({ ignored: [], ignoredOmitted: 0, blocked: [], blockedOmitted: 0 });

export function paradisWordPackageExclusions(sanitized: Pick<ParadisOfficeRenderablePackage, 'ignoredParts' | 'ignoredPartsOmitted' | 'blockedParts' | 'blockedPartsOmitted'>): ParadisWordPackageExclusions {
	return { ignored: sanitized.ignoredParts, ignoredOmitted: sanitized.ignoredPartsOmitted, blocked: sanitized.blockedParts, blockedOmitted: sanitized.blockedPartsOmitted };
}

/** 比較の両側を 1 つにまとめる。同じ部品は 1 つにし、一覧は上限の件数までにする。 */
export function mergeParadisWordPackageExclusions(left: ParadisWordPackageExclusions, right: ParadisWordPackageExclusions): ParadisWordPackageExclusions {
	const merge = <T>(values: readonly T[], key: (value: T) => string): { readonly list: T[]; readonly overflow: number } => {
		const seen = new Map<string, T>();
		for (const value of values) {
			if (!seen.has(key(value))) {
				seen.set(key(value), value);
			}
		}
		const list = [...seen.values()];
		return { list: list.slice(0, PARADIS_OFFICE_LISTED_PARTS_LIMIT), overflow: Math.max(0, list.length - PARADIS_OFFICE_LISTED_PARTS_LIMIT) };
	};
	const ignored = merge([...left.ignored, ...right.ignored], part => `${part.reason}|${part.kind}|${part.partName}`);
	const blocked = merge([...left.blocked, ...right.blocked], part => `${part.feature}|${part.kind}|${part.partName ?? ''}|${part.scheme ?? ''}`);
	return {
		ignored: ignored.list, ignoredOmitted: left.ignoredOmitted + right.ignoredOmitted + ignored.overflow,
		blocked: blocked.list, blockedOmitted: left.blockedOmitted + right.blockedOmitted + blocked.overflow,
	};
}

/** 安全のために外したものの種類の表示名。 */
export function paradisWordBlockedFeatureLabel(feature: string): string {
	switch (feature) {
		case 'macro': return localize('paradis.word.blocked.macro', "マクロ");
		case 'embeddedObject': return localize('paradis.word.blocked.embeddedObject', "埋め込み");
		case 'altChunk': return localize('paradis.word.blocked.altChunk', "埋め込み文書");
		case 'externalRelationship': return localize('paradis.word.blocked.external', "外部参照");
		case 'unknownRelationship': return localize('paradis.word.blocked.unknownRelationship', "知らない関係");
		case 'unsafeRelationship': return localize('paradis.word.blocked.unsafeRelationship', "安全でない関係");
		default: return localize('paradis.word.blocked.unsafeContent', "安全でない部品");
	}
}

/** 黙って外した部品の理由の表示名。 */
export function paradisWordIgnoredReasonLabel(reason: ParadisOfficeIgnoredPart['reason']): string {
	switch (reason) {
		case 'notRendered': return localize('paradis.word.ignored.notRendered', "表示に使わない");
		case 'unreferenced': return localize('paradis.word.ignored.unreferenced', "どこからも参照されない");
		case 'missingTarget': return localize('paradis.word.ignored.missingTarget', "関係の先の部品が無い");
	}
}

/**
 * 安全のために外したもの（マクロ・埋め込み・外部参照など）の要約。リボンに必ず警告として出す。
 * 一覧に載らなかった分（上限を超えた分）は種類が分からないので、件数だけ足す。
 */
export function summarizeParadisWordBlockedParts(exclusions: ParadisWordPackageExclusions): string | undefined {
	const counts = new Map<string, number>();
	for (const part of exclusions.blocked) {
		const label = paradisWordBlockedFeatureLabel(part.feature);
		counts.set(label, (counts.get(label) ?? 0) + Math.max(1, part.count));
	}
	const items = [...counts].map(([label, count]) => localize('paradis.word.blocked.item', "{0} {1}", label, count));
	if (exclusions.blockedOmitted > 0) {
		items.push(localize('paradis.word.blocked.more', "ほか {0}", exclusions.blockedOmitted));
	}
	return items.length > 0 ? localize('paradis.word.blocked.summary', "安全のために外しました: {0}", items.join('・')) : undefined;
}

/**
 * 詳しい解析の状態。リボンは固定の値ではなく、この状態から作る。
 * `alternatives` は画面で箱に置き換えた数、`ignoredParts` は表示に関係しないので黙って外した部品の数。
 */
export type ParadisWordSemanticRibbonState =
	| { readonly kind: 'analyzing'; readonly alternatives: number; readonly ignoredParts: number; readonly blocked?: string }
	| { readonly kind: 'failed'; readonly code: ParadisWordSemanticFailureCode; readonly alternatives: number; readonly ignoredParts: number; readonly blocked?: string; /** `busy` のとき、まだ頼み直す予定があるか。 */ readonly retrying?: boolean }
	| { readonly kind: 'analyzed'; readonly counts: IParadisWordAnalysisCounts; readonly alternatives: number; readonly ignoredParts: number; readonly blocked?: string }
	| { readonly kind: 'comparing'; readonly alternatives: number; readonly ignoredParts: number; readonly blocked?: string }
	| { readonly kind: 'compared'; readonly changes: number; readonly truncated: boolean; readonly outcome: ParadisOfficeOutcome; readonly alternatives: number; readonly ignoredParts: number; readonly warnings?: readonly string[]; readonly blocked?: string };

/**
 * 解析できなかった理由を利用者向けの短い文にする。中身やパスは含めない。
 * `busy` は、まだ頼み直すなら（`retrying`）そう伝え、頼み直しを使い切ったら「混雑」とだけ書く。
 */
export function wordSemanticFailureMessage(code: ParadisWordSemanticFailureCode, retrying = false): string {
	switch (code) {
		case 'encrypted': return localize('paradis.word.semantic.failure.encrypted', "暗号化されています");
		case 'zipBomb':
		case 'limitExceeded':
		case 'tooLarge': return localize('paradis.word.semantic.failure.limit', "大きすぎるか時間がかかりすぎます");
		case 'cancelled': return localize('paradis.word.semantic.failure.cancelled', "取り消しました");
		case 'unsafe': return localize('paradis.word.semantic.failure.unsafe', "安全に読めない部品があります");
		case 'unsupported': return localize('paradis.word.semantic.failure.unsupported', "Word 文書の本文が見つかりません");
		case 'invalid':
		case 'malformed': return localize('paradis.word.semantic.failure.malformed', "ファイルの形式が正しくありません");
		case 'failed': return localize('paradis.word.semantic.failure.failed', "内部エラーが起きました");
		case 'busy': return retrying
			? localize('paradis.word.semantic.failure.busyRetrying', "混み合っています。少し後でもう一度試します")
			: localize('paradis.word.semantic.failure.busy', "混雑");
	}
}

/** 描くべきなのに描けていない未知の要素の数。 */
export function countUnrenderedWordElements(counts: IParadisWordAnalysisCounts): number {
	return counts.unknownElements.reduce((total, element) => element.disposition === 'unrendered' ? total + element.count : total, counts.unknownElementsOther.unrendered);
}

function appendRibbonAction(parent: HTMLElement, text: string, kind: string, onActivate: (() => void) | undefined, disposables?: DisposableStore): HTMLElement {
	if (!onActivate || !disposables) {
		const item = dom.append(parent, dom.$('span.paradis-word-diagnostic-item'));
		styleRibbonItem(item, kind, text);
		return item;
	}
	const button = dom.append(parent, dom.$('button.paradis-word-diagnostic-item')) as HTMLButtonElement;
	button.type = 'button';
	styleRibbonItem(button, kind, text);
	button.style.background = 'transparent';
	button.style.color = 'inherit';
	button.style.font = 'inherit';
	button.style.cursor = 'pointer';
	disposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, onActivate));
	return button;
}

function styleRibbonItem(item: HTMLElement, kind: string, text: string): void {
	item.dataset.kind = kind;
	item.style.display = 'inline-flex';
	item.style.alignItems = 'center';
	item.style.padding = '1px 6px';
	item.style.border = `1px solid ${PARADIS_WORD_HIGH_CONTRAST_TOKENS.border}`;
	item.style.borderRadius = '2px';
	item.textContent = text;
}

/**
 * 詳しい解析の結果をリボンに出す。数はすべて解析の実数で、固定の値は出さない。
 * 表示は従来どおり docx-preview なので「表示: 従来の表示（近似）」と正直に添える。
 */
export function renderWordSemanticRibbon(container: HTMLElement, state: ParadisWordSemanticRibbonState, onActivate?: () => void, disposables?: DisposableStore): HTMLElement {
	disposables?.clear();
	dom.clearNode(container);
	const action = (parent: HTMLElement, text: string, kind: string, activate: (() => void) | undefined) => appendRibbonAction(parent, text, kind, activate, disposables);
	const ribbon = dom.append(container, dom.$('.paradis-word-diagnostics'));
	ribbon.setAttribute('role', 'status');
	ribbon.setAttribute('aria-live', 'polite');
	ribbon.setAttribute('aria-atomic', 'true');
	ribbon.style.display = 'flex';
	ribbon.style.flexWrap = 'wrap';
	ribbon.style.alignItems = 'center';
	ribbon.style.gap = '4px';
	ribbon.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.foreground;
	ribbon.dataset.state = state.kind;
	switch (state.kind) {
		case 'analyzing':
			action(ribbon, localize('paradis.word.semantic.analyzing', "解析中…"), 'analysis', undefined);
			break;
		case 'comparing':
			action(ribbon, localize('paradis.word.semantic.comparing', "比較中…"), 'analysis', undefined);
			break;
		case 'failed': {
			const item = action(ribbon, state.code !== 'busy'
				? localize('paradis.word.semantic.failed', "解析できませんでした: {0}", wordSemanticFailureMessage(state.code))
				: state.retrying
					? localize('paradis.word.semantic.busyRetrying', "混み合っています。少し後でもう一度解析します")
					: localize('paradis.word.semantic.busy', "解析できませんでした（混雑）"), 'analysis', onActivate);
			item.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.warning;
			item.dataset.code = state.code;
			break;
		}
		case 'analyzed': {
			action(ribbon, localize('paradis.word.semantic.complete', "解析 完了"), 'analysis', onActivate);
			action(ribbon, localize('paradis.word.semantic.parts', "部品 {0}/{1}", state.counts.parts.parsed, state.counts.parts.expected), 'parts', onActivate);
			action(ribbon, localize('paradis.word.semantic.nodes', "要素 {0}", state.counts.nodes), 'nodes', onActivate);
			const unrendered = countUnrenderedWordElements(state.counts);
			if (unrendered > 0) {
				const item = action(ribbon, localize('paradis.word.semantic.unrendered', "未対応の要素 {0}", unrendered), 'unrendered', onActivate);
				item.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.warning;
			}
			break;
		}
		case 'compared': {
			action(ribbon, state.outcome === 'complete'
				? localize('paradis.word.semantic.compareComplete', "比較 完了")
				: localize('paradis.word.semantic.compareDegraded', "比較 一部のみ"), 'analysis', onActivate);
			action(ribbon, state.truncated
				? localize('paradis.word.semantic.changesTruncated', "変更 {0} 以上", state.changes)
				: localize('paradis.word.semantic.changes', "変更 {0}", state.changes), 'changes', onActivate);
			for (const warning of state.warnings ?? []) {
				const item = action(ribbon, warning, 'warning', onActivate);
				item.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.warning;
			}
			break;
		}
	}
	action(ribbon, localize('paradis.word.semantic.legacyView', "表示: 従来の表示（近似）"), 'view', undefined);
	action(ribbon, localize('paradis.word.diagnostics.alternatives', "代替表示 {0}", state.alternatives), 'alternatives', onActivate);
	if (state.blocked) {
		const item = action(ribbon, state.blocked, 'blocked', onActivate);
		item.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.warning;
	}
	if (state.ignoredParts > 0) {
		action(ribbon, localize('paradis.word.semantic.ignoredParts', "無視した部品 {0}", state.ignoredParts), 'ignored', onActivate);
	}
	return ribbon;
}

export function wordPrintWarning(model: ParadisOfficePrintModel): string | undefined {
	const messages = model.approximationWarnings.map(warning => warning.message.trim()).filter(message => message.length > 0);
	return messages.length > 0 ? messages.join(' ') : undefined;
}
