/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isHTMLElement } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeOutcome } from '../../common/paradisOfficeProtocol.js';
import type { ParadisWordDocument } from '../../common/word/paradisWordSemantic.js';
import {
	completeParadisDocxRenderOutcomes,
	createParadisDocxRenderAnchorPlan,
	resolveParadisDocxRenderAnchors,
	type IDocxPreviewAstDocument,
	type ParadisDocxNodeRenderOutcome,
} from './paradisDocxRenderAnchor.js';

export type { IDocxPreviewAstDocument, IDocxPreviewAstNode } from './paradisDocxRenderAnchor.js';

/** Supported docx-preview options. Raw fonts and altChunk HTML stay on the typed Platform path. */
export interface IDocxPreview037RenderOptions {
	readonly className?: string;
	readonly inWrapper?: boolean;
	readonly ignoreWidth?: boolean;
	readonly ignoreHeight?: boolean;
	readonly breakPages?: boolean;
	readonly ignoreLastRenderedPageBreak?: boolean;
	readonly experimental?: boolean;
	readonly renderHeaders?: boolean;
	readonly renderFooters?: boolean;
	readonly renderFootnotes?: boolean;
	readonly renderEndnotes?: boolean;
	readonly renderChanges?: boolean;
	readonly renderComments?: boolean;
	readonly useBase64URL?: boolean;
}

/** Narrow versioned surface of the vendored docx-preview 0.3.7 bundle. */
export interface IDocxPreview037Api {
	parseAsync(data: ArrayBuffer, options: Readonly<Record<string, boolean | string>>): Promise<IDocxPreviewAstDocument>;
	renderDocument(document: IDocxPreviewAstDocument, body: HTMLElement, styles: HTMLElement | undefined, options: Readonly<Record<string, boolean | string>>): Promise<unknown>;
}

export interface IDocxRenderOptions {
	readonly bodyContainer: HTMLElement;
	readonly styleContainer: HTMLElement;
	readonly sourceRevision: string;
	readonly cancellationToken?: CancellationToken;
	readonly isRevisionCurrent?: (sourceRevision: string) => boolean;
	readonly previewOptions?: IDocxPreview037RenderOptions;
}

export interface RenderResult {
	readonly outcome: Extract<ParadisOfficeOutcome, 'complete' | 'degraded' | 'cancelled' | 'stale'>;
	readonly sourceRevision: string;
	readonly anchors: ReadonlyMap<string, Element>;
	readonly outcomes: readonly ParadisDocxNodeRenderOutcome[];
}

export interface IDocxRenderAdapter {
	render(bytes: Uint8Array, semantic: ParadisWordDocument, options: IDocxRenderOptions): Promise<RenderResult>;
}

const emptyAnchors: ReadonlyMap<string, Element> = new Map();
const emptyOutcomes: readonly ParadisDocxNodeRenderOutcome[] = Object.freeze([]);

const symbolGlyphs: Readonly<Record<string, string>> = Object.freeze({
	'\uF0B7': '\u2022',
	'\uF0A7': '\u25AA',
	'\uF0E0': '\u2192',
	'\uF0FC': '\u2713',
	'\uF06C': '\u25CF',
});
const symbolGlyphPattern = new RegExp(`[${Object.keys(symbolGlyphs).join('')}]`, 'g');
const symbolFontValuePattern = /\b(?:symbol|wingdings|webdings)\b/i;
const symbolFontRulePattern = /font-family\s*:\s*[^;}]*(?:symbol|wingdings|webdings)/i;
const cssRulePattern = /[^{}]+\{[^{}]*\}/g;
const cssContentPattern = /(content\s*:\s*)(["'])([^"']*)(["'])/gi;

/** docx-preview 0.3.7 adapter. Input bytes must already have passed Platform sanitization. */
export class DocxPreview037RenderAdapter implements IDocxRenderAdapter {
	constructor(private readonly preview: IDocxPreview037Api) { }

	async render(bytes: Uint8Array, semantic: ParadisWordDocument, options: IDocxRenderOptions): Promise<RenderResult> {
		const token = options.cancellationToken ?? CancellationToken.None;
		const isCurrent = options.isRevisionCurrent ?? (() => true);
		const terminalBeforeWork = terminalOutcome(token, isCurrent, options.sourceRevision);
		if (terminalBeforeWork) {
			return terminalResult(terminalBeforeWork, options.sourceRevision);
		}

		const bodyStage = createRenderStage(options.bodyContainer);
		const styleStage = createRenderStage(options.styleContainer);
		try {
			const data = copyToArrayBuffer(bytes);
			const renderOptions = docxPreviewOptions(options.previewOptions);
			const parsed = await this.preview.parseAsync(data, renderOptions);
			const terminalAfterParse = terminalOutcome(token, isCurrent, options.sourceRevision);
			if (terminalAfterParse) {
				return terminalResult(terminalAfterParse, options.sourceRevision);
			}

			const anchorPlan = createParadisDocxRenderAnchorPlan(semantic, parsed);
			await this.preview.renderDocument(parsed, bodyStage, styleStage, renderOptions);
			const terminalAfterRender = terminalOutcome(token, isCurrent, options.sourceRevision);
			if (terminalAfterRender) {
				return terminalResult(terminalAfterRender, options.sourceRevision);
			}

			patchSymbolFontStyles(bodyStage, styleStage);
			containWidePages(bodyStage);
			const resolved = completeParadisDocxRenderOutcomes(
				semantic,
				resolveParadisDocxRenderAnchors(anchorPlan, bodyStage, options.bodyContainer),
			);
			const terminalBeforeCommit = terminalOutcome(token, isCurrent, options.sourceRevision);
			if (terminalBeforeCommit) {
				return terminalResult(terminalBeforeCommit, options.sourceRevision);
			}

			publishStage(options.bodyContainer, bodyStage);
			publishStage(options.styleContainer, styleStage);
			const outcome = resolved.outcomes.some(value => value.destination === 'inspector') ? 'degraded' : 'complete';
			return Object.freeze({ outcome, sourceRevision: options.sourceRevision, anchors: resolved.anchors, outcomes: resolved.outcomes });
		} finally {
			bodyStage.remove();
			styleStage.remove();
		}
	}
}

function terminalOutcome(token: CancellationToken, isCurrent: (sourceRevision: string) => boolean, sourceRevision: string): 'cancelled' | 'stale' | undefined {
	if (token.isCancellationRequested) {
		return 'cancelled';
	}
	return isCurrent(sourceRevision) ? undefined : 'stale';
}

function terminalResult(outcome: 'cancelled' | 'stale', sourceRevision: string): RenderResult {
	return Object.freeze({ outcome, sourceRevision, anchors: emptyAnchors, outcomes: emptyOutcomes });
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function createRenderStage(container: HTMLElement): HTMLDivElement {
	const stage = container.ownerDocument.createElement('div');
	stage.style.position = 'absolute';
	stage.style.visibility = 'hidden';
	stage.style.pointerEvents = 'none';
	stage.style.inset = '0';
	container.appendChild(stage);
	return stage;
}

function publishStage(container: HTMLElement, stage: HTMLElement): void {
	const children = [...stage.childNodes];
	container.replaceChildren(...children);
}

function docxPreviewOptions(overrides: IDocxPreview037RenderOptions | undefined): Readonly<Record<string, boolean | string>> {
	return Object.freeze({
		className: 'docx',
		inWrapper: true,
		ignoreWidth: false,
		ignoreHeight: false,
		breakPages: true,
		ignoreLastRenderedPageBreak: false,
		experimental: true,
		renderHeaders: true,
		renderFooters: true,
		renderFootnotes: true,
		renderEndnotes: true,
		renderChanges: true,
		renderComments: true,
		useBase64URL: true,
		...overrides,
		ignoreFonts: true,
		renderAltChunks: false,
	});
}

function patchSymbolFontStyles(...roots: readonly HTMLElement[]): void {
	const seen = new Set<Element>();
	for (const root of roots) {
		const elements = elementsBelow(root);
		for (const element of elements) {
			if (!isHTMLElement(element) || !element.hasAttribute('style') || !symbolFontValuePattern.test(element.style.fontFamily)) {
				continue;
			}
			for (const child of element.childNodes) {
				if (child.nodeType === Node.TEXT_NODE && child.textContent) {
					child.textContent = child.textContent.replace(symbolGlyphPattern, glyph => symbolGlyphs[glyph] ?? glyph);
				}
			}
		}
		for (const style of elements) {
			if (style.tagName !== 'STYLE' || seen.has(style)) {
				continue;
			}
			seen.add(style);
			const css = style.textContent;
			if (!css || !symbolGlyphPattern.test(css)) {
				symbolGlyphPattern.lastIndex = 0;
				continue;
			}
			symbolGlyphPattern.lastIndex = 0;
			const patched = css.replace(cssRulePattern, rule => {
				if (!symbolFontRulePattern.test(rule)) {
					return rule;
				}
				return rule.replace(cssContentPattern, (match, prefix: string, quote: string, content: string, closingQuote: string) => {
					if (quote !== closingQuote) {
						return match;
					}
					return `${prefix}${quote}${content.replace(symbolGlyphPattern, glyph => symbolGlyphs[glyph] ?? glyph)}${closingQuote}`;
				});
			});
			if (patched !== css) {
				style.textContent = patched;
			}
		}
	}
}

function containWidePages(root: HTMLElement): void {
	for (const candidate of elementsBelow(root)) {
		if (!isHTMLElement(candidate) || candidate.tagName !== 'SECTION' || !candidate.classList.contains('docx')
			|| !isHTMLElement(candidate.parentElement) || !candidate.parentElement.classList.contains('docx-wrapper')) {
			continue;
		}
		const neededWidth = candidate.scrollWidth;
		if (Number.isFinite(neededWidth) && neededWidth > candidate.clientWidth) {
			candidate.style.width = `${neededWidth}px`;
		}
	}
}

function elementsBelow(root: HTMLElement): readonly Element[] {
	const elements: Element[] = [];
	const visit = (parent: Node): void => {
		for (const child of parent.childNodes) {
			if (child.nodeType === 1) {
				elements.push(child as Element);
				visit(child);
			}
		}
	};
	visit(root);
	return elements;
}
