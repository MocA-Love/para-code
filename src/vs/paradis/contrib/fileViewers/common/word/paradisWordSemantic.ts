/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeFingerprint, ParadisOfficeRenderAnchorKey } from '../paradisOfficeProtocol.js';

export type ParadisWordStoryKind = 'body' | 'header' | 'footer' | 'footnote' | 'endnote' | 'comment' | 'textbox' | 'glossary';
export type ParadisWordHeaderFooterRole = 'default' | 'first' | 'even';
export type ParadisWordNodeKind =
	| 'section' | 'paragraph' | 'table' | 'row' | 'cell' | 'contentControl' | 'drawing' | 'altChunk' | 'unknownBlock'
	| 'text' | 'tab' | 'break' | 'symbol' | 'hyperlink' | 'bookmark' | 'field' | 'omml' | 'revision' | 'image'
	| 'noteReference' | 'commentReference';

/** Exact package and semantic address of one Word value. Relationship IDs are not identities. */
export interface ParadisWordSourceRef {
	readonly partUri: string;
	readonly semanticPath: readonly number[];
	readonly kind: ParadisWordNodeKind | 'story' | 'storyReference';
	readonly ordinal: number;
	readonly fingerprint: string;
	readonly partFingerprint: ParadisOfficeFingerprint;
}

export interface ParadisWordNodeBase {
	readonly id: string;
	readonly kind: ParadisWordNodeKind;
	readonly source: ParadisWordSourceRef;
	readonly anchor: ParadisOfficeRenderAnchorKey;
	readonly children?: readonly ParadisWordNode[];
}

export interface ParadisWordSectionNode extends ParadisWordNodeBase {
	readonly kind: 'section';
	readonly sectionOrdinal: number;
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordParagraphNode extends ParadisWordNodeBase {
	readonly kind: 'paragraph';
	readonly children: readonly ParadisWordNode[];
}

/** Raw Word table diagonal. No CSS or render geometry is inferred at this layer. */
export interface ParadisWordTableDiagonalBorder {
	readonly direction: 'topLeftToBottomRight' | 'topRightToBottomLeft';
	readonly value?: string;
	readonly size?: string;
	readonly space?: string;
	readonly color?: string;
	readonly themeColor?: string;
	readonly themeTint?: string;
	readonly themeShade?: string;
	/** Semantic address of the table that owns this border; nested tables are distinct. */
	readonly sourceSemanticPath: readonly number[];
	readonly sourcePartFingerprint: ParadisOfficeFingerprint;
}

export interface ParadisWordTableNode extends ParadisWordNodeBase {
	readonly kind: 'table';
	readonly diagonalBorders: readonly ParadisWordTableDiagonalBorder[];
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordRowNode extends ParadisWordNodeBase {
	readonly kind: 'row';
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordCellNode extends ParadisWordNodeBase {
	readonly kind: 'cell';
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordContentControlNode extends ParadisWordNodeBase {
	readonly kind: 'contentControl';
	readonly alias?: string;
	readonly tag?: string;
	readonly lock?: string;
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordDrawingPosition {
	readonly relativeFrom?: string;
	readonly offset?: string;
	readonly align?: string;
}

export interface ParadisWordDrawingLineEnd {
	readonly type?: string;
	readonly width?: string;
	readonly length?: string;
}

export interface ParadisWordDrawingGeometry {
	readonly placement: 'anchor' | 'inline';
	readonly distances: { readonly top?: string; readonly bottom?: string; readonly left?: string; readonly right?: string };
	readonly simplePosition?: { readonly x?: string; readonly y?: string };
	readonly horizontalPosition?: ParadisWordDrawingPosition;
	readonly verticalPosition?: ParadisWordDrawingPosition;
	readonly extent?: { readonly cx?: string; readonly cy?: string };
	readonly effectExtent?: { readonly left?: string; readonly top?: string; readonly right?: string; readonly bottom?: string };
	readonly wrap?: {
		readonly kind: string;
		readonly wrapText?: string;
		readonly distances: { readonly top?: string; readonly bottom?: string; readonly left?: string; readonly right?: string };
	};
	readonly transform?: {
		readonly rotation?: string;
		readonly flipHorizontal?: string;
		readonly flipVertical?: string;
		readonly offset?: { readonly x?: string; readonly y?: string };
		readonly extent?: { readonly cx?: string; readonly cy?: string };
	};
	readonly presetGeometry?: string;
	readonly line?: {
		readonly width?: string;
		readonly presetDash?: string;
		readonly cap?: string;
		readonly compound?: string;
		readonly alignment?: string;
		readonly headEnd?: ParadisWordDrawingLineEnd;
		readonly tailEnd?: ParadisWordDrawingLineEnd;
	};
	readonly anchorProperties?: {
		readonly simplePosition?: string;
		readonly relativeHeight?: string;
		readonly behindDocument?: string;
		readonly locked?: string;
		readonly layoutInCell?: string;
		readonly allowOverlap?: string;
	};
	/** All-byte authority for the Part from which these lexical values were read. */
	readonly sourcePartFingerprint: ParadisOfficeFingerprint;
}

export interface ParadisWordDrawingNode extends ParadisWordNodeBase {
	readonly kind: 'drawing';
	readonly geometry: ParadisWordDrawingGeometry;
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordAltChunkNode extends ParadisWordNodeBase {
	readonly kind: 'altChunk';
	readonly targetPartUri?: string;
	readonly contentType?: string;
}

export interface ParadisWordUnknownBlockNode extends ParadisWordNodeBase {
	readonly kind: 'unknownBlock';
	readonly name: { readonly namespace: string; readonly local: string };
}

export interface ParadisWordTextNode extends ParadisWordNodeBase {
	readonly kind: 'text';
	readonly text: string;
	readonly deleted?: boolean;
}

export interface ParadisWordTabNode extends ParadisWordNodeBase {
	readonly kind: 'tab';
}

export interface ParadisWordBreakNode extends ParadisWordNodeBase {
	readonly kind: 'break';
	readonly breakType: string;
}

export interface ParadisWordSymbolNode extends ParadisWordNodeBase {
	readonly kind: 'symbol';
	readonly font?: string;
	readonly character?: string;
}

export interface ParadisWordHyperlinkNode extends ParadisWordNodeBase {
	readonly kind: 'hyperlink';
	readonly anchorName?: string;
	readonly external: boolean;
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordBookmarkNode extends ParadisWordNodeBase {
	readonly kind: 'bookmark';
	readonly boundary: 'start' | 'end';
	readonly bookmarkId: string;
	readonly name?: string;
}

export interface ParadisWordFieldNode extends ParadisWordNodeBase {
	readonly kind: 'field';
	readonly fieldKind: 'simple' | 'complex';
	readonly instruction: string;
	readonly savedResult: string;
	readonly dirty?: string;
	readonly locked?: string;
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordOmmlNode extends ParadisWordNodeBase {
	readonly kind: 'omml';
	readonly text: string;
}

export interface ParadisWordRevisionNode extends ParadisWordNodeBase {
	readonly kind: 'revision';
	readonly revisionKind: 'inserted' | 'deleted' | 'moveFrom' | 'moveTo' | 'propertyChange';
	readonly revisionId?: string;
	readonly author?: string;
	readonly date?: string;
	readonly children: readonly ParadisWordNode[];
}

export interface ParadisWordImageNode extends ParadisWordNodeBase {
	readonly kind: 'image';
	readonly targetPartUri?: string;
	readonly external: boolean;
}

export interface ParadisWordNoteReferenceNode extends ParadisWordNodeBase {
	readonly kind: 'noteReference';
	readonly noteKind: 'footnote' | 'endnote';
	readonly noteId: string;
}

export interface ParadisWordCommentReferenceNode extends ParadisWordNodeBase {
	readonly kind: 'commentReference';
	readonly boundary: 'start' | 'end' | 'reference';
	readonly commentId: string;
}

export type ParadisWordNode =
	| ParadisWordSectionNode | ParadisWordParagraphNode | ParadisWordTableNode | ParadisWordRowNode | ParadisWordCellNode
	| ParadisWordContentControlNode | ParadisWordDrawingNode | ParadisWordAltChunkNode | ParadisWordUnknownBlockNode
	| ParadisWordTextNode | ParadisWordTabNode | ParadisWordBreakNode | ParadisWordSymbolNode | ParadisWordHyperlinkNode
	| ParadisWordBookmarkNode | ParadisWordFieldNode | ParadisWordOmmlNode | ParadisWordRevisionNode | ParadisWordImageNode
	| ParadisWordNoteReferenceNode | ParadisWordCommentReferenceNode;

export interface ParadisWordStoryAddress {
	readonly kind: ParadisWordStoryKind;
	readonly partUri: string;
	readonly ordinal: number;
	readonly roles?: readonly ParadisWordHeaderFooterRole[];
	readonly noteId?: string;
	readonly commentId?: string;
	readonly parentStoryId?: string;
	readonly parentNodeId?: string;
	readonly textboxGeometry?: ParadisWordTextboxGeometry;
}

/** Raw textbox container identity. CSS/VML values remain lexical and are not rendered here. */
export interface ParadisWordTextboxGeometry {
	readonly container: 'vmlShape' | 'drawingML' | 'unknown';
	readonly shapeId?: string;
	readonly rawStyle?: string;
	readonly coordinateSize?: string;
	readonly coordinateOrigin?: string;
	readonly from?: string;
	readonly to?: string;
	readonly sourcePartFingerprint: ParadisOfficeFingerprint;
}

export interface ParadisWordStory {
	readonly id: string;
	readonly address: ParadisWordStoryAddress;
	readonly source: ParadisWordSourceRef;
	readonly anchor: ParadisOfficeRenderAnchorKey;
	readonly nodes: readonly ParadisWordNode[];
	readonly text: string;
	readonly author?: string;
	readonly date?: string;
}

/** A section binding is distinct from the shared header/footer Story content. */
export interface ParadisWordStoryReference {
	readonly id: string;
	readonly kind: 'header' | 'footer';
	readonly role: ParadisWordHeaderFooterRole;
	readonly sectionOrdinal: number;
	readonly storyId: string;
	readonly source: ParadisWordSourceRef;
	readonly anchor: ParadisOfficeRenderAnchorKey;
}

export interface ParadisWordCompleteness {
	readonly expectedParts: number;
	readonly visitedParts: number;
	readonly parsedParts: number;
	readonly stories: number;
	readonly nodes: number;
	readonly unknownBlocks: number;
	readonly unresolvedRelationships: number;
	readonly terminal: true;
}

export interface ParadisWordDocument {
	readonly documentSource: ParadisWordSourceRef;
	readonly contentTypesSource: ParadisWordSourceRef;
	readonly rootRelationshipsSource: ParadisWordSourceRef;
	readonly documentRelationshipsSource: ParadisWordSourceRef;
	readonly stories: readonly ParadisWordStory[];
	readonly storyReferences: readonly ParadisWordStoryReference[];
	readonly completeness: ParadisWordCompleteness;
}
