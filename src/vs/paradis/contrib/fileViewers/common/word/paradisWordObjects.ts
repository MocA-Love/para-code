/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ParadisOfficePackageError, resolveParadisOfficeRelationshipTarget, throwIfParadisOfficeCancelled, type ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';
import { parseParadisOfficeXml, sha256ParadisOfficeBytes } from '../office/paradisOfficeCanonicalXml.js';
import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';
import { ParadisWordModelGuard, sanitizeModelError, validateAuthority, type ParadisWordModelOptions, type ParadisWordPartAuthority } from './paradisWordStyles.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const relationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const packageRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/package/2006/relationships',
	'http://purl.oclc.org/ooxml/package/relationships',
]);
const drawingWordprocessingNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
	'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
]);
const drawingNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/main',
	'http://purl.oclc.org/ooxml/drawingml/main',
]);
const pictureNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/picture',
	'http://purl.oclc.org/ooxml/drawingml/picture',
]);
const mathNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/math',
	'http://purl.oclc.org/ooxml/officeDocument/math',
]);
const imageRelationshipTypes = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
	'http://purl.oclc.org/ooxml/officeDocument/relationships/image',
]);
const relationshipContentTypes = new Set(['application/vnd.openxmlformats-package.relationships+xml']);
const xmlLimits = { depth: 128, nodes: 500_000, attributeLength: 1024 * 1024, characters: 64 * 1024 * 1024 } as const;
const maximumPartBytes = 64 * 1024 * 1024;
const maximumTotalBytes = 256 * 1024 * 1024;
const maximumParts = 2_048;

/** Raw, all-byte-authorized Part input. The parser snapshots bytes before inspecting them. */
export interface ParadisWordObjectPartInput {
	readonly bytes: Uint8Array;
	readonly source: ParadisWordPartAuthority;
	readonly contentType?: string;
}

export interface ParadisWordObjectParseInput {
	readonly document: ParadisWordObjectPartInput;
	readonly relationshipPart?: ParadisWordObjectPartInput;
	readonly relatedParts?: readonly ParadisWordObjectPartInput[];
	readonly token?: CancellationToken;
}

export interface ParadisWordObjectParseOptions extends ParadisWordModelOptions {
	readonly maximumObjects?: number;
}

export interface ParadisWordObjectSource extends ParadisWordPartAuthority {
	readonly semanticPath: readonly number[];
}

export interface ParadisWordDrawingPosition {
	readonly relativeFrom?: string;
	readonly offset?: string;
	readonly align?: string;
}

export interface ParadisWordObjectTransform {
	readonly rotation?: string;
	readonly flipHorizontal?: string;
	readonly flipVertical?: string;
	readonly offset?: { readonly x?: string; readonly y?: string };
	readonly extent?: { readonly cx?: string; readonly cy?: string };
}

export interface ParadisWordImagePlacement {
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly kind: 'anchor' | 'inline';
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
		readonly polygon?: {
			readonly edited?: string;
			readonly start?: { readonly x?: string; readonly y?: string };
			readonly lines: readonly { readonly x?: string; readonly y?: string }[];
		};
	};
	readonly anchorProperties?: {
		readonly simplePosition?: string;
		readonly relativeHeight?: string;
		readonly behindDocument?: string;
		readonly locked?: string;
		readonly layoutInCell?: string;
		readonly allowOverlap?: string;
	};
}

export interface ParadisWordImagePresentation {
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly name?: string;
	readonly alternativeText?: string;
	readonly title?: string;
	readonly crop?: { readonly left?: string; readonly top?: string; readonly right?: string; readonly bottom?: string };
	readonly transform?: ParadisWordObjectTransform;
	readonly effectsFingerprint?: ParadisOfficeFingerprint;
	readonly blipEffectsFingerprint?: ParadisOfficeFingerprint;
}

export type ParadisWordImageContent =
	| {
		readonly kind: 'embedded';
		readonly contentType: string;
		readonly fingerprint: ParadisOfficeFingerprint;
		readonly source: ParadisWordPartAuthority;
	}
	| {
		readonly kind: 'external';
		readonly targetScheme?: string;
		readonly targetFingerprint: ParadisOfficeFingerprint;
		readonly behavior: 'notFetched';
	};

export interface ParadisWordImageObject {
	readonly id: string;
	readonly kind: 'image';
	readonly source: ParadisWordObjectSource;
	readonly content: ParadisWordImageContent;
	readonly placement: ParadisWordImagePlacement;
	readonly presentation: ParadisWordImagePresentation;
}

export interface ParadisWordDrawingLineStyle {
	readonly width?: string;
	readonly presetDash?: string;
	readonly cap?: string;
	readonly compound?: string;
	readonly alignment?: string;
	readonly headEnd?: { readonly type?: string; readonly width?: string; readonly length?: string };
	readonly tailEnd?: { readonly type?: string; readonly width?: string; readonly length?: string };
}

export interface ParadisWordLineObject {
	readonly id: string;
	readonly kind: 'line';
	readonly source: ParadisWordObjectSource;
	readonly placement: ParadisWordImagePlacement;
	readonly geometry: {
		readonly preset: 'line' | 'straightConnector1';
		readonly transform?: ParadisWordObjectTransform;
		readonly line?: ParadisWordDrawingLineStyle;
	};
}

export interface ParadisWordMathObject {
	readonly id: string;
	readonly kind: 'math';
	readonly source: ParadisWordObjectSource;
	readonly canonicalFingerprint: ParadisOfficeFingerprint;
	readonly projection: { readonly kind: 'plainText'; readonly text: string };
}

export interface ParadisWordObjectModel {
	readonly images: readonly ParadisWordImageObject[];
	readonly lines: readonly ParadisWordLineObject[];
	readonly math: readonly ParadisWordMathObject[];
}

export interface ParadisWordOwnedObjectPart {
	readonly bytes: Uint8Array;
	readonly source: ParadisWordPartAuthority;
	readonly contentType?: string;
}

export interface ParadisWordParsedRelationship {
	readonly id: string;
	readonly type: string;
	readonly targetMode: 'internal' | 'external';
	readonly targetPartUri?: string;
	readonly targetScheme?: string;
	readonly targetFingerprint?: ParadisOfficeFingerprint;
}

/** Computes the all-byte SHA-256 identity used by object and field Part inputs. */
export function fingerprintParadisWordObjectBytes(bytes: Uint8Array): ParadisOfficeFingerprint {
	try {
		if (!(bytes instanceof Uint8Array)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (bytes.byteLength > maximumPartBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		return sha256Bytes(bytes);
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

/** Parses pictures, drawing lines, and OMML without decoding, fetching, or rendering assets. */
export function parseParadisWordObjects(input: ParadisWordObjectParseInput, options: ParadisWordObjectParseOptions = {}): ParadisWordObjectModel {
	try {
		throwIfParadisOfficeCancelled(input?.token ?? options.token);
		const maximumObjects = boundedMaximum(options.maximumObjects, 1_000_000);
		const guard = new ParadisWordModelGuard({ ...options, maximumDefinitions: maximumObjects, token: input.token ?? options.token });
		const document = ownPart(input.document, uri => isWordXmlPart(uri));
		const relatedParts = ownRelatedParts(input.relatedParts ?? [], guard);
		const relationshipPart = input.relationshipPart
			? ownPart(input.relationshipPart, uri => uri === relationshipPartUri(document.source.partUri))
			: undefined;
		if (relationshipPart?.contentType && !relationshipContentTypes.has(relationshipPart.contentType.toLocaleLowerCase('en-US'))) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const relationships = relationshipPart ? parseParadisWordRelationships(relationshipPart, document.source.partUri, guard) : new Map<string, ParadisWordParsedRelationship>();
		const root = parseXml(document, guard).root;
		if (!isWordStoryRoot(root)) {
			throw new ParadisOfficePackageError('malformed');
		}
		const images: ParadisWordImageObject[] = [];
		const lines: ParadisWordLineObject[] = [];
		const maths: ParadisWordMathObject[] = [];
		walkElements(root, [], (element, path, mathAncestor) => {
			guard.checkpoint();
			if (drawingWordprocessingNamespaces.has(element.uri) && (element.local === 'anchor' || element.local === 'inline')) {
				parseDrawingPlacement(element, path, document.source, relationships, relatedParts, guard, images, lines);
			}
			if (mathNamespaces.has(element.uri) && (element.local === 'oMath' || element.local === 'oMathPara') && !mathAncestor) {
				guard.definition();
				const canonical = canonicalXml(element);
				const source = objectSource(document.source, path);
				maths.push({
					id: stableId('math', source), kind: 'math', source,
					canonicalFingerprint: fingerprintText(canonical),
					projection: { kind: 'plainText', text: mathProjection(element) },
				});
			}
		});
		return deepFreeze({ images, lines, math: maths });
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

export function ownParadisWordObjectPart(part: ParadisWordObjectPartInput, acceptsUri: (uri: string) => boolean): ParadisWordOwnedObjectPart {
	return ownPart(part, acceptsUri);
}

export function parseParadisWordObjectXml(part: ParadisWordOwnedObjectPart, guard: ParadisWordModelGuard): ReturnType<typeof parseParadisOfficeXml> {
	return parseXml(part, guard);
}

export function parseParadisWordRelationships(part: ParadisWordOwnedObjectPart, ownerPartUri: string, guard: ParadisWordModelGuard): ReadonlyMap<string, ParadisWordParsedRelationship> {
	const root = parseXml(part, guard).root;
	if (!packageRelationshipNamespaces.has(root.uri) || root.local !== 'Relationships') {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = new Map<string, ParadisWordParsedRelationship>();
	for (const element of elementChildren(root)) {
		guard.checkpoint();
		if (element.uri !== root.uri || element.local !== 'Relationship') {
			throw new ParadisOfficePackageError('malformed');
		}
		const id = requiredAttribute(element, '', 'Id');
		const type = requiredAttribute(element, '', 'Type');
		const target = requiredAttribute(element, '', 'Target');
		if (result.has(id) || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+$/.test(type)) {
			throw new ParadisOfficePackageError('malformed');
		}
		const mode = optionalAttribute(element, '', 'TargetMode');
		if (mode !== undefined && mode !== 'External') {
			throw new ParadisOfficePackageError('malformed');
		}
		if (mode === 'External') {
			const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(target)?.[1]?.toLocaleLowerCase('en-US');
			result.set(id, {
				id, type, targetMode: 'external', ...(scheme ? { targetScheme: scheme } : {}), targetFingerprint: fingerprintText(target),
			});
		} else {
			// 本文の外（customXml など）を指す関係は、図形や画像の参照先にはならない。読み飛ばすだけで、
			// 文書全体を読めない扱いにはしない（customXml は Word で保存した文書の多くにある）。
			const targetPartUri = resolveRelationshipTarget(ownerPartUri, target);
			result.set(id, { id, type, targetMode: 'internal', ...(targetPartUri ? { targetPartUri } : {}) });
		}
	}
	return result;
}

function parseDrawingPlacement(
	placementElement: XmlElement,
	path: readonly number[],
	documentSource: ParadisWordPartAuthority,
	relationships: ReadonlyMap<string, ParadisWordParsedRelationship>,
	relatedParts: ReadonlyMap<string, ParadisWordOwnedObjectPart>,
	guard: ParadisWordModelGuard,
	images: ParadisWordImageObject[],
	lines: ParadisWordLineObject[],
): void {
	const placement = parsePlacement(placementElement);
	const blips = descendantsWithPath(placementElement, path).filter(candidate => drawingNamespaces.has(candidate.element.uri) && candidate.element.local === 'blip');
	for (const candidate of blips) {
		guard.definition();
		const embedded = relationshipAttribute(candidate.element, 'embed');
		const linked = relationshipAttribute(candidate.element, 'link');
		if (Boolean(embedded) === Boolean(linked)) {
			throw new ParadisOfficePackageError('malformed');
		}
		const relationship = relationships.get(embedded ?? linked!);
		if (!relationship || !imageRelationshipTypes.has(relationship.type)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		let content: ParadisWordImageContent;
		if (linked) {
			if (relationship.targetMode !== 'external' || !relationship.targetFingerprint) {
				throw new ParadisOfficePackageError('unsafe');
			}
			content = {
				kind: 'external', ...(relationship.targetScheme ? { targetScheme: relationship.targetScheme } : {}),
				targetFingerprint: relationship.targetFingerprint, behavior: 'notFetched',
			};
		} else {
			const media = relationship.targetMode === 'internal' && relationship.targetPartUri ? relatedParts.get(relationship.targetPartUri) : undefined;
			if (!media?.contentType || !media.contentType.toLocaleLowerCase('en-US').startsWith('image/')) {
				throw new ParadisOfficePackageError('unsafe');
			}
			content = { kind: 'embedded', contentType: media.contentType, fingerprint: media.source.partFingerprint, source: media.source };
		}
		const picture = descendantsWithPath(placementElement, path)
			.find(value => pictureNamespaces.has(value.element.uri) && value.element.local === 'pic' && containsElement(value.element, candidate.element))?.element;
		const source = objectSource(documentSource, candidate.path);
		images.push({ id: stableId('image', source), kind: 'image', source, content, placement, presentation: parseImagePresentation(placementElement, picture, candidate.element) });
	}
	const presets = descendantsWithPath(placementElement, path).filter(candidate => {
		if (!drawingNamespaces.has(candidate.element.uri) || candidate.element.local !== 'prstGeom') {
			return false;
		}
		const preset = optionalAttribute(candidate.element, '', 'prst');
		return preset === 'line' || preset === 'straightConnector1';
	});
	for (const candidate of presets) {
		guard.definition();
		const source = objectSource(documentSource, candidate.path);
		const preset = requiredAttribute(candidate.element, '', 'prst') as 'line' | 'straightConnector1';
		const shapeProperties = descendantsWithPath(placementElement, path)
			.filter(value => drawingNamespaces.has(value.element.uri) && value.element.local === 'spPr' && containsElement(value.element, candidate.element))
			.at(-1)?.element ?? placementElement;
		const transform = firstDescendant(shapeProperties, drawingNamespaces, 'xfrm');
		const line = firstDescendant(shapeProperties, drawingNamespaces, 'ln');
		lines.push({
			id: stableId('line', source), kind: 'line', source, placement,
			geometry: {
				preset,
				...(transform ? { transform: parseTransform(transform) } : {}),
				...(line ? { line: parseLine(line) } : {}),
			},
		});
	}
}

function parsePlacement(element: XmlElement): ParadisWordImagePlacement {
	const simple = child(element, drawingWordprocessingNamespaces, 'simplePos');
	const horizontal = child(element, drawingWordprocessingNamespaces, 'positionH');
	const vertical = child(element, drawingWordprocessingNamespaces, 'positionV');
	const extent = child(element, drawingWordprocessingNamespaces, 'extent');
	const effectExtent = child(element, drawingWordprocessingNamespaces, 'effectExtent');
	const wrap = elementChildren(element).find(candidate => drawingWordprocessingNamespaces.has(candidate.uri) && candidate.local.startsWith('wrap'));
	const wrapPolygon = wrap && child(wrap, drawingWordprocessingNamespaces, 'wrapPolygon');
	const polygonStart = wrapPolygon && child(wrapPolygon, drawingWordprocessingNamespaces, 'start');
	const value = compact({
		kind: element.local as 'anchor' | 'inline',
		distances: distances(element),
		simplePosition: simple ? compact({ x: optionalAttribute(simple, '', 'x'), y: optionalAttribute(simple, '', 'y') }) : undefined,
		horizontalPosition: horizontal ? parsePosition(horizontal) : undefined,
		verticalPosition: vertical ? parsePosition(vertical) : undefined,
		extent: extent ? compact({ cx: optionalAttribute(extent, '', 'cx'), cy: optionalAttribute(extent, '', 'cy') }) : undefined,
		effectExtent: effectExtent ? compact({
			left: optionalAttribute(effectExtent, '', 'l'), top: optionalAttribute(effectExtent, '', 't'),
			right: optionalAttribute(effectExtent, '', 'r'), bottom: optionalAttribute(effectExtent, '', 'b'),
		}) : undefined,
		wrap: wrap ? compact({
			kind: wrap.local.slice(4).replace(/^./, value => value.toLocaleLowerCase('en-US')),
			wrapText: optionalAttribute(wrap, '', 'wrapText'), distances: distances(wrap),
			polygon: wrapPolygon ? compact({
				edited: optionalAttribute(wrapPolygon, '', 'edited'),
				start: polygonStart ? point(polygonStart) : undefined,
				lines: elementChildren(wrapPolygon).filter(candidate => drawingWordprocessingNamespaces.has(candidate.uri) && candidate.local === 'lineTo').map(point),
			}) : undefined,
		}) : undefined,
		anchorProperties: element.local === 'anchor' ? compact({
			simplePosition: optionalAttribute(element, '', 'simplePos'), relativeHeight: optionalAttribute(element, '', 'relativeHeight'),
			behindDocument: optionalAttribute(element, '', 'behindDoc'), locked: optionalAttribute(element, '', 'locked'),
			layoutInCell: optionalAttribute(element, '', 'layoutInCell'), allowOverlap: optionalAttribute(element, '', 'allowOverlap'),
		}) : undefined,
	});
	return { fingerprint: fingerprintText(JSON.stringify(value)), ...value };
}

function parseImagePresentation(placement: XmlElement, picture: XmlElement | undefined, blip: XmlElement): ParadisWordImagePresentation {
	const nonVisual = child(placement, drawingWordprocessingNamespaces, 'docPr');
	const sourceRect = picture && firstDescendant(picture, drawingNamespaces, 'srcRect');
	const shapeProperties = picture && child(picture, pictureNamespaces, 'spPr');
	const transform = shapeProperties && firstDescendant(shapeProperties, drawingNamespaces, 'xfrm');
	const effects = shapeProperties && (firstDescendant(shapeProperties, drawingNamespaces, 'effectLst') ?? firstDescendant(shapeProperties, drawingNamespaces, 'effectDag'));
	const blipEffects = elementChildren(blip);
	const value = compact({
		name: nonVisual && optionalAttribute(nonVisual, '', 'name'),
		alternativeText: nonVisual && optionalAttribute(nonVisual, '', 'descr'),
		title: nonVisual && optionalAttribute(nonVisual, '', 'title'),
		crop: sourceRect ? compact({
			left: optionalAttribute(sourceRect, '', 'l'), top: optionalAttribute(sourceRect, '', 't'),
			right: optionalAttribute(sourceRect, '', 'r'), bottom: optionalAttribute(sourceRect, '', 'b'),
		}) : undefined,
		transform: transform ? parseTransform(transform) : undefined,
		effectsFingerprint: effects ? fingerprintText(canonicalXml(effects)) : undefined,
		blipEffectsFingerprint: blipEffects.length > 0 ? fingerprintText(blipEffects.map(canonicalXml).join('')) : undefined,
	});
	return { fingerprint: fingerprintText(JSON.stringify(value)), ...value };
}

function parsePosition(element: XmlElement): ParadisWordDrawingPosition {
	const offset = child(element, drawingWordprocessingNamespaces, 'posOffset');
	const align = child(element, drawingWordprocessingNamespaces, 'align');
	return compact({
		relativeFrom: optionalAttribute(element, '', 'relativeFrom'), offset: offset ? elementText(offset) : undefined, align: align ? elementText(align) : undefined,
	});
}

function parseTransform(element: XmlElement): ParadisWordObjectTransform {
	const offset = child(element, drawingNamespaces, 'off');
	const extent = child(element, drawingNamespaces, 'ext');
	return compact({
		rotation: optionalAttribute(element, '', 'rot'), flipHorizontal: optionalAttribute(element, '', 'flipH'), flipVertical: optionalAttribute(element, '', 'flipV'),
		offset: offset ? compact({ x: optionalAttribute(offset, '', 'x'), y: optionalAttribute(offset, '', 'y') }) : undefined,
		extent: extent ? compact({ cx: optionalAttribute(extent, '', 'cx'), cy: optionalAttribute(extent, '', 'cy') }) : undefined,
	});
}

function parseLine(element: XmlElement): ParadisWordDrawingLineStyle {
	const dash = child(element, drawingNamespaces, 'prstDash');
	const head = child(element, drawingNamespaces, 'headEnd');
	const tail = child(element, drawingNamespaces, 'tailEnd');
	return compact({
		width: optionalAttribute(element, '', 'w'), presetDash: dash && optionalAttribute(dash, '', 'val'), cap: optionalAttribute(element, '', 'cap'),
		compound: optionalAttribute(element, '', 'cmpd'), alignment: optionalAttribute(element, '', 'algn'),
		headEnd: head ? lineEnd(head) : undefined, tailEnd: tail ? lineEnd(tail) : undefined,
	});
}

function lineEnd(element: XmlElement): { readonly type?: string; readonly width?: string; readonly length?: string } {
	return compact({ type: optionalAttribute(element, '', 'type'), width: optionalAttribute(element, '', 'w'), length: optionalAttribute(element, '', 'len') });
}

function point(element: XmlElement): { readonly x?: string; readonly y?: string } {
	return compact({ x: optionalAttribute(element, '', 'x'), y: optionalAttribute(element, '', 'y') });
}

function distances(element: XmlElement): { readonly top?: string; readonly bottom?: string; readonly left?: string; readonly right?: string } {
	return compact({
		top: optionalAttribute(element, '', 'distT'), bottom: optionalAttribute(element, '', 'distB'),
		left: optionalAttribute(element, '', 'distL'), right: optionalAttribute(element, '', 'distR'),
	});
}

function mathProjection(element: XmlElement): string {
	const result: string[] = [];
	walkElements(element, [], candidate => {
		if (!mathNamespaces.has(candidate.uri)) {
			return;
		}
		if (candidate.local === 't') {
			result.push(elementText(candidate));
		} else if (candidate.local === 'chr' || candidate.local === 'begChr' || candidate.local === 'endChr' || candidate.local === 'sepChr') {
			const value = optionalAttribute(candidate, candidate.uri, 'val');
			if (value !== undefined) {
				result.push(value);
			}
		}
	});
	return result.join('').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\uFFFD').slice(0, xmlLimits.characters);
}

function ownRelatedParts(parts: readonly ParadisWordObjectPartInput[], guard: ParadisWordModelGuard): ReadonlyMap<string, ParadisWordOwnedObjectPart> {
	if (!Array.isArray(parts) || parts.length > maximumParts) {
		throw new ParadisOfficePackageError(parts?.length > maximumParts ? 'limitExceeded' : 'unsafe');
	}
	const result = new Map<string, ParadisWordOwnedObjectPart>();
	let total = 0;
	for (const candidate of parts) {
		guard.checkpoint();
		const owned = ownPart(candidate, uri => isCanonicalWordPartUri(uri));
		if (result.has(owned.source.partUri)) {
			throw new ParadisOfficePackageError('malformed');
		}
		total += owned.bytes.byteLength;
		if (!Number.isSafeInteger(total) || total > maximumTotalBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		result.set(owned.source.partUri, owned);
	}
	return result;
}

function ownPart(part: ParadisWordObjectPartInput, acceptsUri: (uri: string) => boolean): ParadisWordOwnedObjectPart {
	if (!part || typeof part !== 'object' || !(part.bytes instanceof Uint8Array)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	validateAuthority(part.source, uri => isCanonicalWordPartUri(uri) && acceptsUri(uri));
	if (part.bytes.byteLength > maximumPartBytes) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const bytes = Uint8Array.from(part.bytes);
	const actual = sha256Bytes(bytes);
	if (!sameFingerprint(actual, part.source.partFingerprint)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const contentType = part.contentType;
	if (contentType !== undefined && (typeof contentType !== 'string' || !/^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+(?:;[^\r\n]*)?$/i.test(contentType))) {
		throw new ParadisOfficePackageError('malformed');
	}
	return {
		bytes,
		source: { partUri: part.source.partUri, partFingerprint: actual },
		...(contentType ? { contentType } : {}),
	};
}

function parseXml(part: ParadisWordOwnedObjectPart, guard: ParadisWordModelGuard): ReturnType<typeof parseParadisOfficeXml> {
	let xml: string;
	try {
		xml = new TextDecoder('utf-8', { fatal: true }).decode(part.bytes);
	} catch {
		throw new ParadisOfficePackageError('malformed');
	}
	return parseParadisOfficeXml(xml, xmlLimits, undefined, () => guard.checkpoint());
}

function objectSource(authority: ParadisWordPartAuthority, path: readonly number[]): ParadisWordObjectSource {
	return { ...authority, semanticPath: Object.freeze([...path]) };
}

function stableId(kind: string, source: ParadisWordObjectSource): string {
	return `wordObject:${encodeURIComponent(source.partUri)}:${source.semanticPath.join('.')}:${kind}`;
}

function isWordStoryRoot(element: XmlElement): boolean {
	return wordNamespaces.has(element.uri) && ['document', 'hdr', 'ftr', 'footnotes', 'endnotes', 'comments', 'glossaryDocument'].includes(element.local);
}

function isWordXmlPart(partUri: string): boolean {
	return partUri === '/word/document.xml' || /^\/word\/(?:header|footer)\d+\.xml$/.test(partUri)
		|| ['/word/footnotes.xml', '/word/endnotes.xml', '/word/comments.xml', '/word/glossary/document.xml'].includes(partUri);
}

function isCanonicalWordPartUri(partUri: string): boolean {
	if (!partUri.startsWith('/word/') || partUri.includes('\\') || partUri.includes('%') || partUri.includes('\0') || partUri.includes('?') || partUri.includes('#')) {
		return false;
	}
	const segments = partUri.slice(1).split('/');
	return segments.every(segment => Boolean(segment) && segment !== '.' && segment !== '..');
}

function relationshipPartUri(ownerPartUri: string): string {
	const separator = ownerPartUri.lastIndexOf('/');
	return `${ownerPartUri.slice(0, separator)}/_rels/${ownerPartUri.slice(separator + 1)}.rels`;
}

/** 関係の参照先を正規化する。package の外へ出るものは拒否し、`/word/` の外を指すものは undefined を返す。 */
function resolveRelationshipTarget(ownerPartUri: string, target: string): string | undefined {
	const result = resolveSharedRelationshipTarget(ownerPartUri, target);
	if (!result.startsWith('/word/')) {
		return undefined;
	}
	if (!isCanonicalWordPartUri(result)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return result;
}

function canonicalXml(element: XmlElement): string {
	const attributes = [...element.attributes]
		.map(attribute => `{${attribute.uri}}${attribute.local}=${JSON.stringify(attribute.value)}`)
		.sort()
		.join(',');
	const textIsSemantic = mathNamespaces.has(element.uri) && element.local === 't'
		|| wordNamespaces.has(element.uri) && ['t', 'delText', 'instrText'].includes(element.local);
	const children = element.children.map(child => {
		if (child.kind === 'element') {
			return canonicalXml(child);
		}
		return !textIsSemantic && /^\s*$/.test(child.value) ? '' : `#${JSON.stringify(child.value)}`;
	}).join('');
	return `<{${element.uri}}${element.local} ${attributes}>${children}</{${element.uri}}${element.local}>`;
}

function walkElements(element: XmlElement, path: readonly number[], visit: (element: XmlElement, path: readonly number[], mathAncestor: boolean) => void, mathAncestor = false): void {
	visit(element, path, mathAncestor);
	const nextMathAncestor = mathAncestor || mathNamespaces.has(element.uri) && (element.local === 'oMath' || element.local === 'oMathPara');
	let ordinal = 0;
	for (const childNode of element.children) {
		if (childNode.kind === 'element') {
			walkElements(childNode, [...path, ordinal++], visit, nextMathAncestor);
		}
	}
}

function descendantsWithPath(element: XmlElement, path: readonly number[]): readonly { readonly element: XmlElement; readonly path: readonly number[] }[] {
	const result: { readonly element: XmlElement; readonly path: readonly number[] }[] = [];
	walkElements(element, path, (candidate, candidatePath) => {
		if (candidate !== element) {
			result.push({ element: candidate, path: candidatePath });
		}
	});
	return result;
}

function containsElement(parent: XmlElement, target: XmlElement): boolean {
	if (parent === target) {
		return true;
	}
	return elementChildren(parent).some(childElement => containsElement(childElement, target));
}

function firstDescendant(element: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement | undefined {
	return descendantsWithPath(element, []).find(candidate => namespaces.has(candidate.element.uri) && candidate.element.local === local)?.element;
}

function child(element: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement | undefined {
	return elementChildren(element).find(candidate => namespaces.has(candidate.uri) && candidate.local === local);
}

function elementChildren(element: XmlElement): XmlElement[] {
	return element.children.filter((childNode): childNode is XmlElement => childNode.kind === 'element');
}

function elementText(element: XmlElement): string {
	return element.children.map(childNode => childNode.kind === 'text' ? childNode.value : elementText(childNode)).join('');
}

function relationshipAttribute(element: XmlElement, local: string): string | undefined {
	return element.attributes.find(candidate => relationshipNamespaces.has(candidate.uri) && candidate.local === local)?.value;
}

function requiredAttribute(element: XmlElement, uri: string, local: string): string {
	const value = optionalAttribute(element, uri, local);
	if (value === undefined || value.length === 0) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function optionalAttribute(element: XmlElement, uri: string, local: string): string | undefined {
	return element.attributes.find(candidate => candidate.uri === uri && candidate.local === local)?.value;
}

function compact<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) {
			result[key] = item;
		}
	}
	return result as T;
}

function boundedMaximum(value: number | undefined, hardMaximum: number): number {
	if (value === undefined) {
		return hardMaximum;
	}
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return Math.min(value, hardMaximum);
}

function sameFingerprint(left: ParadisOfficeFingerprint, right: ParadisOfficeFingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value.toLocaleLowerCase('en-US') && left.byteLength === right.byteLength;
}

function fingerprintText(value: string): ParadisOfficeFingerprint {
	return sha256Bytes(new TextEncoder().encode(value));
}

function deepFreeze<T>(value: T): T {
	const seen = new WeakSet<object>();
	const stack: object[] = [];
	if (value && typeof value === 'object') {
		stack.push(value);
	}
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (seen.has(current)) {
			continue;
		}
		seen.add(current);
		for (const key of Reflect.ownKeys(current)) {
			const candidate = Object.getOwnPropertyDescriptor(current, key)?.value;
			if (candidate && typeof candidate === 'object') {
				stack.push(candidate);
			}
		}
		Object.freeze(current);
	}
	return value;
}

function sha256Bytes(bytes: Uint8Array): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: sha256ParadisOfficeBytes(bytes), byteLength: bytes.length };
}

/**
 * 関係の Target を、サニタイザ・部品一覧と同じ規則（resolveParadisOfficeRelationshipTarget）で解決する。
 * スキーム付き・クエリ・断片は Word の部品を指さないので拒む。拒むときの理由はこのファイルの他の拒否と同じ unsafe にする。
 */
function resolveSharedRelationshipTarget(ownerPartUri: string, target: string): string {
	if (!target || target.includes('?') || target.includes('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	try {
		return resolveParadisOfficeRelationshipTarget(ownerPartUri, target);
	} catch {
		throw new ParadisOfficePackageError('unsafe');
	}
}
