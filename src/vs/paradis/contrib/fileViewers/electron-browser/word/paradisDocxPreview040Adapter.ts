/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisWordDocument } from '../../common/word/paradisWordSemantic.js';
import {
	completeParadisDocxRenderOutcomes,
	createParadisDocxRenderAnchorPlan,
	PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE,
	resolveParadisDocxRenderAnchors,
	type IDocxPreviewAstDocument,
	type IDocxPreviewAstNode,
} from './paradisDocxRenderAnchor.js';
import type {
	IDocxPreview037RenderOptions,
	IDocxRenderAdapter,
	IDocxRenderOptions,
	RenderResult,
} from './paradisDocxRenderAdapter.js';

export const PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE = 'data-paradis-node-id';

export interface IDocxPreview040Patch {
	readonly id: string;
	readonly before: string;
	readonly after: string;
}

/** Ordered source patch queue for the pinned npm 0.4.0 UMD artifact. */
export const docxPreview040Patches: readonly IDocxPreview040Patch[] = Object.freeze([
	{
		id: 'vml-stroke-attributes',
		before: 'case"fillcolor":r.attrs.fill=t.value;break;case"from"',
		after: 'case"fillcolor":r.attrs.fill=t.value;break;case"strokecolor":r.attrs.stroke=t.value.replace(/\\s*\\[[^\\]]*\\]\\s*$/,"");break;case"strokeweight":r.attrs["stroke-width"]=t.value;break;case"from"',
	},
	{
		id: 'vertical-writing-variants',
		before: 'tbRl:{writingMode:"vertical-rl",transform:"none"}};for(const a of w.elements(e))',
		after: 'tbRl:{writingMode:"vertical-rl",transform:"none"},tbRlV:{writingMode:"vertical-rl",transform:"none"},lrTbV:{writingMode:"vertical-lr",transform:"none"},tbLrV:{writingMode:"vertical-rl",transform:"rotate(180deg)"}};for(const a of w.elements(e))',
	},
	{
		id: 'table-layout-type-attribute',
		before: 'static valueOfTblLayout(e){return"fixed"==w.attr(e,"val")?"fixed":"auto"}',
		after: 'static valueOfTblLayout(e){return"fixed"==w.attr(e,"type")?"fixed":"auto"}',
	},
	{
		id: 'hanging-indent-tab-stop',
		before: ':[Ve],c=i[i.length-1],h=l.width*a',
		after: ':[Ve],c=(parseFloat(o.textIndent)<0&&i[0].pos>0&&i.unshift({pos:0,leader:"none",style:"left"}),i[i.length-1]),h=l.width*a',
	},
	{
		id: 'fixed-table-width',
		before: 'e.columns&&t.push(this.renderTableColumns(e.columns)),t.push(...this.renderElements(e.children))',
		after: 'e.columns&&(t.push(this.renderTableColumns(e.columns)),"auto"===e.cssStyle.width&&"fixed"===e.cssStyle["table-layout"]&&e.columns.every(e=>e.width)&&(e.cssStyle.width=e.columns.reduce((e,t)=>e+parseFloat(t.width),0)+"pt"),"auto"!==e.cssStyle.width&&!e.cssStyle["table-layout"]&&(e.cssStyle["table-layout"]="fixed")),t.push(...this.renderElements(e.children))',
	},
	{
		id: 'page-relative-vml-origin',
		before: 'renderVmlElement(e){var t=this.h({ns:Ge.svg,tagName:"svg",style:e.cssStyleText});const r=',
		after: 'renderVmlElement(e){var t=this.h({ns:Ge.svg,tagName:"svg",style:e.cssStyleText});/mso-position-horizontal-relative:page/.test(e.cssStyleText)&&(t.style.left="0");/mso-position-vertical-relative:page/.test(e.cssStyleText)&&(t.style.top="0");const r=',
	},
	{
		id: 'numbering-css-content',
		before: 'levelTextToContent(e,t,r,a){return`"${e.replace(/%\\d*/g,e=>{let t=parseInt(e.substring(1),10)-1;return`"counter(${this.numberingCounter(r,t)}, ${a})"`})}${{tab:"\\\\9",space:"\\\\a0"}[t]??""}"`}',
		after: 'levelTextToContent(e,t,r,a){const s=[];let n=0;const l=/%\\d*/g;let o;while(o=l.exec(e)){if(o.index>n)s.push(JSON.stringify(e.slice(n,o.index)));const i=parseInt(o[0].substring(1),10)-1;s.push(`counter(${this.numberingCounter(r,i)}, ${a})`),n=o.index+o[0].length}if(n<e.length)s.push(JSON.stringify(e.slice(n)));const c={tab:\'"\\\\9"\',space:\'"\\\\a0"\'}[t];return c&&s.push(c),s.join(" ")}',
	},
]);

export const docxPreview040Build = Object.freeze({
	version: '0.4.0',
	archiveUrl: 'https://registry.npmjs.org/docx-preview/-/docx-preview-0.4.0.tgz',
	archiveSha256: '94c336d6a1ea69d188bc95bfb4c6de55ea6414270477359ddda557d1a5bea447',
	sourcePath: 'package/dist/docx-preview.min.js',
	sourceSha256: '051ef503f2677d53159a388b7384e950eda41ea4e47a103e5e36f124d7faea40',
	licensePath: 'package/LICENSE',
	license: 'Apache-2.0',
	licenseSha256: '8668bf4417d161e4eb4d47d6044526e4914d9eb3c748573d9bb7e87708c1253f',
	patchedSourceSha256: 'a60958918afcc4579216ea44637736f6ad21ae41c2ae64b6c48bbb62ee89600b',
	mobileBundleSha256: '48834320a889913b60431aa369a80f83e1a0036c041511be345ed6dcfbd2aa9c',
});

/** Applies each compatibility patch once and rejects drift or accidental reapplication. */
export function applyDocxPreview040Patches(upstream: string): string {
	let result = upstream;
	for (const patch of docxPreview040Patches) {
		const first = result.indexOf(patch.before);
		if (first < 0 || result.indexOf(patch.before, first + patch.before.length) >= 0) {
			throw new Error(`docx-preview 0.4.0 patch ${patch.id} expected exactly one upstream match`);
		}
		result = result.slice(0, first) + patch.after + result.slice(first + patch.before.length);
	}
	return result;
}

export interface IDocxPreview040HElement {
	readonly ns?: string;
	readonly tagName: string;
	readonly className?: string;
	readonly style?: Readonly<Record<string, string>> | string;
	readonly children?: readonly IDocxPreview040HValue[];
	readonly [property: string]: unknown;
}

export type IDocxPreview040HValue = IDocxPreview040HElement | Node | string;
export type IDocxPreview040H = (value: IDocxPreview040HValue) => Node;

/** Options supported at the pinned docx-preview 0.4.0 boundary. */
export interface IDocxPreview040RenderOptions extends IDocxPreview037RenderOptions {
	readonly ignoreFonts: boolean;
	readonly renderAltChunks: boolean;
	readonly h: IDocxPreview040H;
}

/** Narrow versioned surface of docx-preview 0.4.0. */
export interface IDocxPreview040Api {
	parseAsync(data: ArrayBuffer, options: IDocxPreview040RenderOptions): Promise<IDocxPreviewAstDocument>;
	renderDocument(document: IDocxPreviewAstDocument, options: IDocxPreview040RenderOptions): Promise<readonly Node[]>;
}

const emptyAnchors: ReadonlyMap<string, Element> = new Map();
const emptyOutcomes = Object.freeze([]);

/**
 * docx-preview 0.4.0 adapter. Input bytes must already have passed Platform sanitization.
 * Geometry is owned by the pinned renderer; this bridge adds logical IDs and publishes its nodes.
 */
export class DocxPreview040RenderAdapter implements IDocxRenderAdapter {
	constructor(private readonly preview: IDocxPreview040Api) { }

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
			const h = createNodeIdH(options.bodyContainer.ownerDocument);
			const renderOptions = docxPreviewOptions(options.previewOptions, h);
			const parsed = await this.preview.parseAsync(copyToArrayBuffer(bytes), renderOptions);
			const terminalAfterParse = terminalOutcome(token, isCurrent, options.sourceRevision);
			if (terminalAfterParse) {
				return terminalResult(terminalAfterParse, options.sourceRevision);
			}

			const anchorPlan = createParadisDocxRenderAnchorPlan(semantic, parsed);
			const nodes = await this.preview.renderDocument(parsed, renderOptions);
			const terminalAfterRender = terminalOutcome(token, isCurrent, options.sourceRevision);
			if (terminalAfterRender) {
				return terminalResult(terminalAfterRender, options.sourceRevision);
			}
			for (const node of nodes) {
				(node.nodeName === 'STYLE' ? styleStage : bodyStage).appendChild(node);
			}
			bridgeMmlMathAnchorMarkers(parsed, bodyStage);

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

function createNodeIdH(ownerDocument: Document): IDocxPreview040H {
	let nextNodeId = 0;
	const h: IDocxPreview040H = value => {
		if (typeof value === 'string') {
			return ownerDocument.createTextNode(value);
		}
		if (value instanceof Node) {
			return value;
		}
		const { ns, tagName, className, style, children, ...properties } = value;
		if (tagName === '#fragment') {
			const fragment = ownerDocument.createDocumentFragment();
			for (const child of children ?? []) {
				fragment.appendChild(h(child));
			}
			return fragment;
		}
		if (tagName === '#comment') {
			return ownerDocument.createComment(String(children?.[0] ?? ''));
		}

		const element = ns ? ownerDocument.createElementNS(ns, tagName) : ownerDocument.createElement(tagName);
		if (className) {
			element.setAttribute('class', className);
		}
		if (typeof style === 'string') {
			element.setAttribute('style', style);
		} else if (style) {
			const cssStyle: Record<string, string> = {};
			for (const [name, raw] of Object.entries(style)) {
				if (name.startsWith('$')) {
					element.setAttribute(name.slice(1), raw);
				} else {
					cssStyle[name] = raw;
				}
			}
			// Keep 0.4's h() semantics, including camelCase HTML/SVG/MathML properties.
			Object.assign((element as Element & { readonly style: CSSStyleDeclaration }).style, cssStyle);
		}
		for (const [name, raw] of Object.entries(properties)) {
			if (raw !== undefined) {
				(element as unknown as Record<string, unknown>)[name] = raw;
			}
		}
		element.setAttribute(PARADIS_DOCX_PREVIEW_040_NODE_ID_ATTRIBUTE, `h${nextNodeId++}`);
		for (const child of children ?? []) {
			element.appendChild(h(child));
		}
		return element;
	};
	return h;
}

function docxPreviewOptions(overrides: IDocxPreview037RenderOptions | undefined, h: IDocxPreview040H): IDocxPreview040RenderOptions {
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
		h,
	});
}

/** 0.4's mmlMath container omits cssStyle; restore only its logical marker by document order. */
function bridgeMmlMathAnchorMarkers(parsed: IDocxPreviewAstDocument, renderedRoot: Element): void {
	const markers: (string | undefined)[] = [];
	const visitPreview = (node: IDocxPreviewAstNode): void => {
		if (node.type === 'mmlMath') {
			markers.push(node.cssStyle?.[`$${PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE}`]);
		}
		for (const child of node.children ?? []) {
			visitPreview(child);
		}
	};
	const body = parsed.documentPart?.body;
	if (body) {
		visitPreview(body);
	}

	let mathIndex = 0;
	const visitRendered = (parent: Node): void => {
		for (const child of parent.childNodes) {
			if (child.nodeType !== Node.ELEMENT_NODE) {
				continue;
			}
			const element = child as Element;
			if (element.namespaceURI === 'http://www.w3.org/1998/Math/MathML' && element.localName === 'math') {
				const marker = markers[mathIndex++];
				if (marker !== undefined && !element.hasAttribute(PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE)) {
					element.setAttribute(PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE, marker);
				}
			}
			visitRendered(element);
		}
	};
	visitRendered(renderedRoot);
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
	container.replaceChildren(...stage.childNodes);
}
