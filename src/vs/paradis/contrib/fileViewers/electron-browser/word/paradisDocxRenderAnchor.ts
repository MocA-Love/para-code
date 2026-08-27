/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeRenderCoverage } from '../../common/paradisOfficeProtocol.js';
import type { ParadisWordDocument, ParadisWordNode } from '../../common/word/paradisWordSemantic.js';

/** Fixed attribute name; semantic IDs never become selectors or attribute values. */
export const PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE = 'data-paradis-word-anchor';

/** Small subset of the mutable docx-preview 0.3.7 AST used for anchor injection. */
export interface IDocxPreviewAstNode {
	readonly type: string;
	readonly children?: readonly IDocxPreviewAstNode[];
	cssStyle?: Record<string, string>;
	readonly text?: string;
}

/** Small subset of the parsed docx-preview 0.3.7 document used by this adapter. */
export interface IDocxPreviewAstDocument {
	readonly documentPart?: { readonly body?: IDocxPreviewAstNode };
}

export type ParadisDocxRenderAnchorReason = 'omitted' | 'collision' | 'noAnchor';

/** Per-node result consumed by document navigation and the Inspector fallback. */
export interface ParadisDocxNodeRenderOutcome {
	readonly nodeId: string;
	readonly coverage: ParadisOfficeRenderCoverage;
	readonly destination: 'document' | 'inspector';
	readonly anchorNodeId?: string;
	readonly reason?: ParadisDocxRenderAnchorReason;
}

interface MutableAnchorBinding {
	readonly nodeId: string;
	marker?: string;
	readonly root: boolean;
	readonly coverage: 'rendered' | 'approximated';
	readonly anchorNodeId: string;
	readonly reason?: 'omitted';
}

export interface ParadisDocxRenderAnchorPlan {
	readonly bindings: readonly MutableAnchorBinding[];
}

export interface ParadisDocxResolvedRenderAnchors {
	readonly anchors: ReadonlyMap<string, Element>;
	readonly outcomes: readonly ParadisDocxNodeRenderOutcome[];
}

interface PreviewNodeEntry {
	readonly node: IDocxPreviewAstNode;
	readonly markerTarget?: IDocxPreviewAstNode;
}

interface SemanticAnchorContext {
	readonly binding?: MutableAnchorBinding;
	readonly directAncestorNodeId?: string;
}

/**
 * Projects typed semantic nodes onto the parsed docx-preview tree and injects opaque markers.
 * Drawing and table geometry are deliberately not inspected or changed here.
 */
export function createParadisDocxRenderAnchorPlan(semantic: ParadisWordDocument, preview: IDocxPreviewAstDocument): ParadisDocxRenderAnchorPlan {
	const body = preview.documentPart?.body;
	const previewByKind = indexPreviewNodes(body);
	const previewOffsets = new Map<string, number>();
	const markerByTarget = new Map<IDocxPreviewAstNode, string>();
	const bindings: MutableAnchorBinding[] = [];
	let nextMarker = 0;

	const markerFor = (target: IDocxPreviewAstNode): string => {
		const existing = markerByTarget.get(target);
		if (existing !== undefined) {
			return existing;
		}
		const marker = `a${nextMarker++}`;
		markerByTarget.set(target, marker);
		const cssStyle = target.cssStyle ?? (target.cssStyle = {});
		cssStyle[`$${PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE}`] = marker;
		return marker;
	};

	const visitNode = (node: ParadisWordNode, parent: SemanticAnchorContext, usePreview: boolean): void => {
		const previewType = previewTypeForSemanticNode(node);
		const candidates = usePreview && previewType ? previewByKind.get(previewType) : undefined;
		const offset = previewType ? (previewOffsets.get(previewType) ?? 0) : 0;
		const matched = candidates?.[offset];
		if (matched && previewType) {
			previewOffsets.set(previewType, offset + 1);
		}

		let binding: MutableAnchorBinding | undefined;
		let directAncestorNodeId = parent.directAncestorNodeId;
		if (matched?.markerTarget) {
			const direct = matched.markerTarget === matched.node;
			if (direct) {
				directAncestorNodeId = node.id;
			}
			binding = {
				nodeId: node.id,
				marker: markerFor(matched.markerTarget),
				root: false,
				coverage: direct ? 'rendered' : 'approximated',
				anchorNodeId: direct ? node.id : (parent.directAncestorNodeId ?? node.id),
			};
		} else if (parent.binding) {
			binding = {
				nodeId: node.id,
				...(parent.binding.marker !== undefined ? { marker: parent.binding.marker } : {}),
				root: parent.binding.root,
				coverage: 'approximated',
				anchorNodeId: parent.directAncestorNodeId ?? parent.binding.anchorNodeId,
				reason: 'omitted',
			};
		}
		if (binding) {
			bindings.push(binding);
		}
		const context = { binding, ...(directAncestorNodeId !== undefined ? { directAncestorNodeId } : {}) };
		for (const child of node.children ?? []) {
			visitNode(child, context, usePreview);
		}
	};

	for (const story of semantic.stories) {
		const usePreview = story.address.kind === 'body' && story.address.ordinal === 0 && story.address.partUri === semantic.documentSource.partUri && body !== undefined;
		const storyBinding: MutableAnchorBinding | undefined = usePreview ? {
			nodeId: story.id,
			root: true,
			coverage: 'rendered',
			anchorNodeId: story.id,
		} : undefined;
		if (storyBinding) {
			bindings.push(storyBinding);
		}
		const context: SemanticAnchorContext = storyBinding ? { binding: storyBinding, directAncestorNodeId: story.id } : {};
		for (const node of story.nodes) {
			visitNode(node, context, usePreview);
		}
	}

	return { bindings };
}

/** Resolves only known opaque markers and rejects markers that rendered more than once. */
export function resolveParadisDocxRenderAnchors(plan: ParadisDocxRenderAnchorPlan, renderedRoot: Element, publishedRoot: Element): ParadisDocxResolvedRenderAnchors {
	const elementsByMarker = new Map<string, Element[]>();
	for (const element of descendantElements(renderedRoot)) {
		const marker = element.getAttribute(PARADIS_DOCX_RENDER_ANCHOR_ATTRIBUTE);
		if (marker !== null) {
			const elements = elementsByMarker.get(marker) ?? [];
			elements.push(element);
			elementsByMarker.set(marker, elements);
		}
	}

	const anchors = new Map<string, Element>();
	const outcomes: ParadisDocxNodeRenderOutcome[] = [];
	for (const binding of plan.bindings) {
		const candidates = binding.root ? [publishedRoot] : binding.marker ? (elementsByMarker.get(binding.marker) ?? []) : [];
		if (candidates.length === 1) {
			anchors.set(binding.nodeId, candidates[0]);
			outcomes.push(Object.freeze({
				nodeId: binding.nodeId,
				coverage: binding.coverage,
				destination: 'document',
				anchorNodeId: binding.anchorNodeId,
				...(binding.reason ? { reason: binding.reason } : {}),
			}));
		} else {
			outcomes.push(Object.freeze({
				nodeId: binding.nodeId,
				coverage: 'noAnchor',
				destination: 'inspector',
				reason: candidates.length > 1 ? 'collision' : 'noAnchor',
			}));
		}
	}

	return { anchors, outcomes: Object.freeze(outcomes) };
}

function descendantElements(root: Element): readonly Element[] {
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

/** Adds explicit Inspector results for semantic nodes not represented in a render plan. */
export function completeParadisDocxRenderOutcomes(semantic: ParadisWordDocument, resolved: ParadisDocxResolvedRenderAnchors): ParadisDocxResolvedRenderAnchors {
	const represented = new Set(resolved.outcomes.map(outcome => outcome.nodeId));
	const outcomes = [...resolved.outcomes];
	const appendMissing = (nodeId: string): void => {
		if (!represented.has(nodeId)) {
			represented.add(nodeId);
			outcomes.push(Object.freeze({ nodeId, coverage: 'noAnchor', destination: 'inspector', reason: 'noAnchor' }));
		}
	};
	const visit = (nodes: readonly ParadisWordNode[]): void => {
		for (const node of nodes) {
			appendMissing(node.id);
			visit(node.children ?? []);
		}
	};
	for (const story of semantic.stories) {
		appendMissing(story.id);
		visit(story.nodes);
	}
	return { anchors: resolved.anchors, outcomes: Object.freeze(outcomes) };
}

function indexPreviewNodes(root: IDocxPreviewAstNode | undefined): ReadonlyMap<string, readonly PreviewNodeEntry[]> {
	const byKind = new Map<string, PreviewNodeEntry[]>();
	const visit = (node: IDocxPreviewAstNode, markerTarget: IDocxPreviewAstNode | undefined): void => {
		const target = supportsInjectedAttribute(node.type) ? node : markerTarget;
		const entries = byKind.get(node.type) ?? [];
		entries.push({ node, ...(target ? { markerTarget: target } : {}) });
		byKind.set(node.type, entries);
		for (const child of node.children ?? []) {
			visit(child, target);
		}
	};
	if (root) {
		for (const child of root.children ?? []) {
			visit(child, undefined);
		}
	}
	return byKind;
}

function supportsInjectedAttribute(type: string): boolean {
	return type === 'paragraph' || type === 'run' || type === 'table' || type === 'row' || type === 'cell'
		|| type === 'hyperlink' || type === 'drawing' || type === 'image' || type === 'mmlMath'
		|| type === 'mmlMathParagraph' || type === 'mmlRun' || type === 'inserted' || type === 'deleted';
}

function previewTypeForSemanticNode(node: ParadisWordNode): string | undefined {
	switch (node.kind) {
		case 'paragraph':
		case 'table':
		case 'row':
		case 'cell':
		case 'text':
		case 'tab':
		case 'break':
		case 'symbol':
		case 'hyperlink':
		case 'drawing':
		case 'image':
		case 'altChunk':
			return node.kind;
		case 'bookmark':
			return node.boundary === 'start' ? 'bookmarkStart' : 'bookmarkEnd';
		case 'field':
			return node.fieldKind === 'simple' ? 'simpleField' : 'complexField';
		case 'omml':
			return 'mmlMath';
		case 'revision':
			return node.revisionKind === 'deleted' || node.revisionKind === 'moveFrom' ? 'deleted' : 'inserted';
		case 'noteReference':
			return node.noteKind === 'footnote' ? 'footnoteReference' : 'endnoteReference';
		case 'commentReference':
			return node.boundary === 'start' ? 'commentRangeStart' : node.boundary === 'end' ? 'commentRangeEnd' : 'commentReference';
		case 'section':
		case 'contentControl':
		case 'unknownBlock':
			return undefined;
	}
}
