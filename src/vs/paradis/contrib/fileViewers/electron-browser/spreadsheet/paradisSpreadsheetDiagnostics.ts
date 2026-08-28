/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as dom from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import {
	canReportNoChanges,
	type ParadisOfficeCompletenessManifest,
	type ParadisOfficeOutcome,
	type ParadisOfficePrintModel,
	type ParadisOfficeRenderCoverage,
} from '../../common/paradisOfficeProtocol.js';

/** Theme variables retain a visible boundary when normal colors collapse in high-contrast themes. */
export const PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS = Object.freeze({
	border: 'var(--vscode-contrastBorder, var(--vscode-editorWidget-border, currentColor))',
	focus: 'var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, currentColor))',
	foreground: 'var(--vscode-foreground, currentColor)',
	warning: 'var(--vscode-editorWarning-foreground, var(--vscode-foreground, currentColor))',
});

export interface ParadisSpreadsheetDiagnosticsInput {
	readonly outcome: ParadisOfficeOutcome;
	readonly coverages: readonly ParadisOfficeRenderCoverage[];
	readonly warnings?: readonly { readonly code: string; readonly message: string }[];
}

export interface ParadisSpreadsheetDiagnosticsSummary {
	readonly faithful: number;
	readonly approximate: number;
	readonly alternatives: number;
	readonly incomplete: boolean;
}

export function summarizeSpreadsheetDiagnostics(input: ParadisSpreadsheetDiagnosticsInput): ParadisSpreadsheetDiagnosticsSummary {
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

/** The shared protocol gate is the single authority for presenting an empty comparison as No Changes. */
export function canShowSpreadsheetNoChanges(manifest: ParadisOfficeCompletenessManifest, outcome: ParadisOfficeOutcome, changeCount: number): boolean {
	return canReportNoChanges(manifest, outcome, changeCount);
}

function appendRibbonItem(parent: HTMLElement, text: string, kind: string): void {
	const item = dom.append(parent, dom.$('span.paradis-spreadsheet-diagnostic-item'));
	item.dataset.kind = kind;
	item.style.display = 'inline-flex';
	item.style.alignItems = 'center';
	item.style.padding = '1px 6px';
	item.style.border = `1px solid ${PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.border}`;
	item.style.borderRadius = '2px';
	item.textContent = text;
}

/** Renders only text nodes and typed attributes; workbook strings never enter HTML parsing. */
export function renderSpreadsheetDiagnosticsRibbon(container: HTMLElement, input: ParadisSpreadsheetDiagnosticsInput): HTMLElement {
	dom.clearNode(container);
	const summary = summarizeSpreadsheetDiagnostics(input);
	const ribbon = dom.append(container, dom.$('.paradis-spreadsheet-diagnostics'));
	ribbon.setAttribute('role', 'status');
	ribbon.setAttribute('aria-live', 'polite');
	ribbon.setAttribute('aria-atomic', 'true');
	ribbon.style.display = 'flex';
	ribbon.style.flexWrap = 'wrap';
	ribbon.style.alignItems = 'center';
	ribbon.style.gap = '4px';
	ribbon.style.color = PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.foreground;
	appendRibbonItem(ribbon, localize('paradis.spreadsheet.diagnostics.faithful', "完全再現 {0}", summary.faithful), 'faithful');
	appendRibbonItem(ribbon, localize('paradis.spreadsheet.diagnostics.approximate', "近似 {0}", summary.approximate), 'approximate');
	appendRibbonItem(ribbon, localize('paradis.spreadsheet.diagnostics.alternatives', "代替表示 {0}", summary.alternatives), 'alternatives');
	if (summary.incomplete) {
		const incomplete = dom.append(ribbon, dom.$('span.paradis-spreadsheet-diagnostic-incomplete'));
		incomplete.style.color = PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.warning;
		incomplete.style.borderBottom = `1px solid ${PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.border}`;
		incomplete.textContent = localize('paradis.spreadsheet.diagnostics.incomplete', "解析未完了");
	}
	for (const warning of input.warnings ?? []) {
		const warningElement = dom.append(ribbon, dom.$('span.paradis-spreadsheet-diagnostic-warning'));
		warningElement.dataset.code = warning.code;
		warningElement.textContent = warning.message;
	}
	return ribbon;
}

export function spreadsheetPrintWarning(model: ParadisOfficePrintModel): string | undefined {
	const messages = model.approximationWarnings.map(warning => warning.message.trim()).filter(message => message.length > 0);
	return messages.length > 0 ? messages.join(' ') : undefined;
}
