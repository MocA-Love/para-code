/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// docx-preview はグラフ・SmartArt・OLE を描かないので、fork 側の SVG 描画部品
// (renderWordObjectOverlay) に渡す ParadisWordRenderableObject[] をここで作る。
//
// 入力は「パート URI → XML テキスト」のマップだけ。zip も fs も触らないので node/browser の
// どちらからも呼べる。リレーションシップは OPC の規約どおり `<dir>/_rels/<name>.rels` を
// 同じマップから引いて解決する。

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { throwIfParadisOfficeCancelled, type ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';
import { parseParadisOfficeXml, type ParadisOfficeXmlLimits } from '../office/paradisOfficeCanonicalXml.js';
import type { ParadisOfficeFingerprint, ParadisOfficeTextRun } from '../paradisOfficeProtocol.js';
import { fingerprintParadisWordObjectBytes } from './paradisWordObjects.js';
import type { ParadisWordDrawingGeometry } from './paradisWordSemantic.js';
import { parseDrawingGeometry } from './paradisWordSemanticParser.js';
import type {
	ParadisWordChartSeries,
	ParadisWordRenderableObject,
	ParadisWordSmartArtNode,
} from './paradisWordRenderableObjects.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const wordDrawingNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
	'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
]);
const drawingNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/main',
	'http://purl.oclc.org/ooxml/drawingml/main',
]);
const chartNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/chart',
	'http://purl.oclc.org/ooxml/drawingml/chart',
]);
const diagramNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/diagram',
	'http://purl.oclc.org/ooxml/drawingml/diagram',
]);
const shapeNamespaces = new Set([
	'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
	'http://schemas.microsoft.com/office/word/2012/wordprocessingShape',
]);
const officeVmlNamespaces = new Set(['urn:schemas-microsoft-com:office:office']);
const officeRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const packageRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/package/2006/relationships',
	'http://purl.oclc.org/ooxml/package/relationships',
]);

/** `a:graphicData/@uri` の末尾セグメントで分類する（transitional / strict の両方に効く）。 */
const graphicDataKinds = new Map<string, 'chart' | 'diagram' | 'picture' | 'shape'>([
	['chart', 'chart'],
	['diagram', 'diagram'],
	['picture', 'picture'],
	['wordprocessingShape', 'shape'],
]);

export interface ParadisWordRenderableExtractionLimits {
	/** 走査するパート数の上限。 */
	readonly parts: number;
	/** 返すオブジェクト数の上限。 */
	readonly objects: number;
	/** 1 回の抽出で訪れる XML 要素数の上限。 */
	readonly elements: number;
	/** 1 グラフあたりの系列数の上限。 */
	readonly chartSeries: number;
	/** 1 系列あたりの値の数の上限。 */
	readonly chartPoints: number;
	/** 1 SmartArt あたりのノード数の上限。 */
	readonly smartArtNodes: number;
	/** 1 テキストボックスあたりの run 数の上限。 */
	readonly textboxRuns: number;
	/** XML パーサに渡す上限。 */
	readonly xml: ParadisOfficeXmlLimits;
}

export const PARADIS_WORD_RENDERABLE_LIMITS: ParadisWordRenderableExtractionLimits = Object.freeze({
	parts: 64,
	objects: 512,
	elements: 200_000,
	chartSeries: 64,
	chartPoints: 4_096,
	smartArtNodes: 512,
	textboxRuns: 512,
	xml: Object.freeze({ depth: 96, nodes: 200_000, attributeLength: 64 * 1024, characters: 8 * 1024 * 1024 }),
});

export interface ParadisWordRenderableExtractionInput {
	/** パート URI（`/word/document.xml` のような先頭スラッシュ付き）→ XML テキスト。 */
	readonly parts: ReadonlyMap<string, string>;
	/** 既定は `/word/document.xml`。 */
	readonly documentPartUri?: string;
	/** 走査するストーリーパート。省略時は本文＋document のリレーションシップが指す header/footer。 */
	readonly storyPartUris?: readonly string[];
	readonly limits?: Partial<ParadisWordRenderableExtractionLimits>;
	readonly token?: CancellationToken;
}

interface Relationship {
	readonly id: string;
	readonly type: string;
	readonly external: boolean;
	readonly target: string;
}

/** 1 パート分の `.rels`。相対 Target を解決するために所有者 URI を一緒に持ち回る。 */
interface PartRelationships {
	readonly owner: string;
	readonly entries: ReadonlyMap<string, Relationship>;
}

/** 予算切れの内部シグナル。呼び出し元へは漏らさない。 */
class BudgetExhausted extends Error { }

class Budget {
	private elements: number;

	constructor(limit: number) {
		this.elements = limit;
	}

	get exhausted(): boolean {
		return this.elements <= 0;
	}

	consume(): void {
		if (--this.elements <= 0) {
			throw new BudgetExhausted();
		}
	}
}

/**
 * .docx の XML パート群から、docx-preview が描かない「描ける対象」を取り出す純粋関数。
 * 壊れたパートや解決できないリレーションシップは黙って落とし、残りの抽出を続ける。
 */
export function extractParadisWordRenderableObjects(input: ParadisWordRenderableExtractionInput): readonly ParadisWordRenderableObject[] {

	const limits: ParadisWordRenderableExtractionLimits = { ...PARADIS_WORD_RENDERABLE_LIMITS, ...input.limits };
	const parts = input.parts instanceof Map ? input.parts : new Map<string, string>();
	const documentPartUri = normalizePartUri(input.documentPartUri ?? '/word/document.xml');
	const budget = new Budget(limits.elements);
	const cache = new Map<string, XmlElement | undefined>();
	const readPart = (uri: string): XmlElement | undefined => {
		if (cache.has(uri)) {
			return cache.get(uri);
		}
		let root: XmlElement | undefined;
		const xml = parts.get(uri);
		if (typeof xml === 'string') {
			try {
				root = parseParadisOfficeXml(xml.startsWith('﻿') ? xml.slice(1) : xml, limits.xml, input.token).root;
			} catch {
				root = undefined;
			}
		}
		cache.set(uri, root);
		return root;
	};

	const storyUris = resolveStoryParts(documentPartUri, readPart, input.storyPartUris).slice(0, Math.max(0, limits.parts));
	const objects: ParadisWordRenderableObject[] = [];
	for (const storyUri of storyUris) {
		throwIfParadisOfficeCancelled(input.token);
		if (budget.exhausted || objects.length >= limits.objects) {
			break;
		}
		const root = readPart(storyUri);
		if (!root) {
			continue;
		}
		const fingerprint = fingerprintPart(parts.get(storyUri) ?? '');
		const relationships = readRelationships(storyUri, readPart);
		try {
			collectStoryObjects(root, storyUri, fingerprint, relationships, readPart, limits, budget, objects);
		} catch (error) {
			if (!(error instanceof BudgetExhausted)) {
				// 壊れたストーリーはここで打ち切り、他のパートの抽出は続ける。
				continue;
			}
			break;
		}
	}
	return Object.freeze(objects.slice(0, limits.objects));
}

function collectStoryObjects(
	root: XmlElement,
	storyUri: string,
	fingerprint: ParadisOfficeFingerprint,
	relationships: PartRelationships,
	readPart: (uri: string) => XmlElement | undefined,
	limits: ParadisWordRenderableExtractionLimits,
	budget: Budget,
	objects: ParadisWordRenderableObject[],
): void {

	let ordinal = 0;
	const visit = (element: XmlElement): void => {
		budget.consume();
		if (objects.length >= limits.objects) {
			throw new BudgetExhausted();
		}
		if (wordNamespaces.has(element.uri) && element.local === 'drawing') {
			for (const placement of elementChildren(element)) {
				if (!wordDrawingNamespaces.has(placement.uri) || placement.local !== 'anchor' && placement.local !== 'inline') {
					continue;
				}
				const object = createDrawingObject(placement, storyUri, ordinal++, fingerprint, relationships, readPart, limits, budget);
				if (object) {
					objects.push(object);
				}
			}
			return; // w:drawing 配下は解釈済み。VML など内側は辿らない。
		}
		if (wordNamespaces.has(element.uri) && element.local === 'object') {
			const ole = createOleObject(element, storyUri, ordinal++, fingerprint, budget);
			if (ole) {
				objects.push(ole);
			}
			return;
		}
		if (wordNamespaces.has(element.uri) && element.local === 'pict') {
			return; // VML は docx-preview が描くので対象外。
		}
		for (const child of elementChildren(element)) {
			visit(child);
		}
	};
	visit(root);
}

function createDrawingObject(
	placement: XmlElement,
	storyUri: string,
	ordinal: number,
	fingerprint: ParadisOfficeFingerprint,
	relationships: PartRelationships,
	readPart: (uri: string) => XmlElement | undefined,
	limits: ParadisWordRenderableExtractionLimits,
	budget: Budget,
): ParadisWordRenderableObject | undefined {

	try {
		const docPr = firstDescendant(placement, budget, candidate => wordDrawingNamespaces.has(candidate.uri) && candidate.local === 'docPr');
		const id = objectId(storyUri, ordinal, attribute(docPr, '', 'id'));
		const geometry = parseDrawingGeometry(placement, fingerprint);
		const graphicData = firstDescendant(placement, budget, candidate => drawingNamespaces.has(candidate.uri) && candidate.local === 'graphicData');
		if (!graphicData) {
			return undefined;
		}
		const kind = graphicDataKinds.get(lastUriSegment(attribute(graphicData, '', 'uri') ?? ''));
		if (kind === 'chart') {
			return createChartObject(id, geometry, graphicData, relationships, readPart, limits, budget);
		}
		if (kind === 'diagram') {
			return createSmartArtObject(id, geometry, graphicData, relationships, readPart, limits, budget);
		}
		if (kind === 'picture') {
			const altText = attribute(docPr, '', 'descr');
			return Object.freeze({
				kind: 'image' as const,
				id,
				geometry,
				content: Object.freeze({ behavior: 'notFetched' as const }),
				...(altText ? { altText } : {}),
			});
		}
		if (kind === 'shape') {
			const textbox = firstDescendant(graphicData, budget, candidate => shapeNamespaces.has(candidate.uri) && candidate.local === 'txbx');
			const content = textbox ? firstDescendant(textbox, budget, candidate => wordNamespaces.has(candidate.uri) && candidate.local === 'txbxContent') : undefined;
			if (content) {
				return Object.freeze({ kind: 'textbox' as const, id, geometry, runs: collectTextboxRuns(content, limits, budget) });
			}
			return Object.freeze({ kind: 'shape' as const, id, geometry });
		}
		return undefined;
	} catch (error) {
		if (error instanceof BudgetExhausted) {
			throw error;
		}
		return undefined; // 壊れた 1 個だけを落とす。
	}
}

function createChartObject(
	id: string,
	geometry: ParadisWordDrawingGeometry,
	graphicData: XmlElement,
	relationships: PartRelationships,
	readPart: (uri: string) => XmlElement | undefined,
	limits: ParadisWordRenderableExtractionLimits,
	budget: Budget,
): ParadisWordRenderableObject | undefined {

	const reference = firstDescendant(graphicData, budget, candidate => chartNamespaces.has(candidate.uri) && (candidate.local === 'chart' || candidate.local === 'chartReference'));
	const root = reference ? readRelatedPart(reference, relationships, readPart) : undefined;
	if (!root) {
		return undefined;
	}
	const chart = firstDescendant(root, budget, candidate => chartNamespaces.has(candidate.uri) && candidate.local === 'chart');
	const plot = chart ? firstDescendant(chart, budget, candidate => chartNamespaces.has(candidate.uri) && candidate.local === 'plotArea') : undefined;
	const group = plot ? elementChildren(plot).find(candidate => chartNamespaces.has(candidate.uri) && candidate.local.endsWith('Chart')) : undefined;
	if (!group) {
		return undefined;
	}
	const titleElement = chart ? elementChildren(chart).find(candidate => chartNamespaces.has(candidate.uri) && candidate.local === 'title') : undefined;
	const title = titleElement ? collectDrawingText(titleElement, budget).trim() : '';
	const series: ParadisWordChartSeries[] = [];
	for (const candidate of elementChildren(group)) {
		budget.consume();
		if (!chartNamespaces.has(candidate.uri) || candidate.local !== 'ser' || series.length >= limits.chartSeries) {
			continue;
		}
		series.push(createChartSeries(candidate, limits, budget));
	}
	return Object.freeze({
		kind: 'chart' as const,
		id,
		geometry,
		chartType: chartTypeOf(group, budget),
		...(title ? { title } : {}),
		series: Object.freeze(series),
	});
}

function createChartSeries(element: XmlElement, limits: ParadisWordRenderableExtractionLimits, budget: Budget): ParadisWordChartSeries {

	const nameSource = elementChildren(element).find(candidate => chartNamespaces.has(candidate.uri) && candidate.local === 'tx');
	const nameCell = nameSource ? firstDescendant(nameSource, budget, candidate => chartNamespaces.has(candidate.uri) && candidate.local === 'v') : undefined;
	const name = nameCell ? textOf(nameCell).trim() : '';
	const valueSource = elementChildren(element).find(candidate => chartNamespaces.has(candidate.uri) && candidate.local === 'val');
	const cache = valueSource ? firstDescendant(valueSource, budget, candidate => chartNamespaces.has(candidate.uri) && (candidate.local === 'numCache' || candidate.local === 'numLit')) : undefined;
	const values: { index: number; value: string }[] = [];
	if (cache) {
		for (const point of elementChildren(cache)) {
			budget.consume();
			if (!chartNamespaces.has(point.uri) || point.local !== 'pt' || values.length >= limits.chartPoints) {
				continue;
			}
			const index = parseIndex(attribute(point, '', 'idx'));
			const cell = elementChildren(point).find(candidate => chartNamespaces.has(candidate.uri) && candidate.local === 'v');
			if (index === undefined || !cell) {
				continue; // idx が無い / 壊れている点だけを落とす。
			}
			values.push({ index, value: textOf(cell) });
		}
	}
	// 抽出側は idx を詰め直さない。歯抜けなら描画側(chartValues)がプレースホルダーに落とす。
	return Object.freeze({ ...(name ? { name } : {}), values: Object.freeze(values) });
}

function chartTypeOf(group: XmlElement, budget: Budget): string {

	const local = group.local.slice(0, -'Chart'.length);
	if (local === 'bar' || local === 'bar3D') {
		const direction = firstDescendant(group, budget, candidate => chartNamespaces.has(candidate.uri) && candidate.local === 'barDir');
		// OOXML の既定は col。bar だけが横棒。
		return attribute(direction, '', 'val') === 'bar' ? 'bar' : 'column';
	}
	return local;
}

function createSmartArtObject(
	id: string,
	geometry: ParadisWordDrawingGeometry,
	graphicData: XmlElement,
	relationships: PartRelationships,
	readPart: (uri: string) => XmlElement | undefined,
	limits: ParadisWordRenderableExtractionLimits,
	budget: Budget,
): ParadisWordRenderableObject | undefined {

	const relIds = firstDescendant(graphicData, budget, candidate => diagramNamespaces.has(candidate.uri) && candidate.local === 'relIds');
	const root = relIds ? readRelatedPart(relIds, relationships, readPart, 'dm') : undefined;
	if (!root) {
		return undefined;
	}
	const list = firstDescendant(root, budget, candidate => diagramNamespaces.has(candidate.uri) && candidate.local === 'ptLst');
	if (!list) {
		return undefined;
	}
	const labels = new Map<string, string>();
	const order: string[] = [];
	for (const point of elementChildren(list)) {
		budget.consume();
		if (!diagramNamespaces.has(point.uri) || point.local !== 'pt' || order.length >= limits.smartArtNodes) {
			continue;
		}
		// 通常ノードは type 属性を省略できる（既定が node）ので、無い場合も node として扱う。
		const type = attribute(point, '', 'type') ?? 'node';
		const modelId = attribute(point, '', 'modelId');
		if (type !== 'node' || !modelId || labels.has(modelId)) {
			continue;
		}
		const text = elementChildren(point).find(candidate => diagramNamespaces.has(candidate.uri) && candidate.local === 't');
		labels.set(modelId, text ? collectDrawingText(text, budget).trim() : '');
		order.push(modelId);
	}
	const parents = new Map<string, string>();
	const connections = firstDescendant(root, budget, candidate => diagramNamespaces.has(candidate.uri) && candidate.local === 'cxnLst');
	if (connections) {
		for (const connection of elementChildren(connections)) {
			budget.consume();
			if (!diagramNamespaces.has(connection.uri) || connection.local !== 'cxn' || attribute(connection, '', 'type') !== 'parOf') {
				continue;
			}
			const source = attribute(connection, '', 'srcId');
			const destination = attribute(connection, '', 'destId');
			if (source && destination && source !== destination && labels.has(source) && labels.has(destination) && !parents.has(destination)) {
				parents.set(destination, source);
			}
		}
	}
	const nodes: ParadisWordSmartArtNode[] = order.map(modelId => Object.freeze({
		id: modelId,
		label: labels.get(modelId) ?? '',
		...(parents.has(modelId) ? { parentId: parents.get(modelId) } : {}),
	}));
	return Object.freeze({
		kind: 'smartArt' as const,
		id,
		geometry,
		layout: parents.size > 0 ? 'hierarchy' as const : 'flow' as const,
		nodes: Object.freeze(nodes),
	});
}

function createOleObject(
	element: XmlElement,
	storyUri: string,
	ordinal: number,
	fingerprint: ParadisOfficeFingerprint,
	budget: Budget,
): ParadisWordRenderableObject | undefined {

	try {
		const ole = firstDescendant(element, budget, candidate => officeVmlNamespaces.has(candidate.uri) && candidate.local === 'OLEObject');
		if (!ole) {
			return undefined;
		}
		// w:object は DrawingML の配置を持たないことが多い。その場合は w:object 自身を配置として読み、
		// 位置の分からないジオメトリになる（描画側がプレースホルダーにする）。
		const placement = firstDescendant(element, budget, candidate => wordDrawingNamespaces.has(candidate.uri) && (candidate.local === 'anchor' || candidate.local === 'inline')) ?? element;
		return Object.freeze({ kind: 'ole' as const, id: objectId(storyUri, ordinal, attribute(ole, '', 'ShapeID')), geometry: parseDrawingGeometry(placement, fingerprint) });
	} catch (error) {
		if (error instanceof BudgetExhausted) {
			throw error;
		}
		return undefined;
	}
}

function collectTextboxRuns(content: XmlElement, limits: ParadisWordRenderableExtractionLimits, budget: Budget): readonly ParadisOfficeTextRun[] {

	const runs: ParadisOfficeTextRun[] = [];
	const visit = (element: XmlElement): void => {
		budget.consume();
		if (runs.length >= limits.textboxRuns) {
			return;
		}
		if (wordNamespaces.has(element.uri) && element.local === 't') {
			runs.push(Object.freeze({ text: textOf(element) }));
			return;
		}
		for (const child of elementChildren(element)) {
			visit(child);
		}
	};
	visit(content);
	return Object.freeze(runs);
}

// ---- パート / リレーションシップ -------------------------------------------------

function resolveStoryParts(documentPartUri: string, readPart: (uri: string) => XmlElement | undefined, explicit: readonly string[] | undefined): string[] {

	if (explicit) {
		return [...new Set(explicit.map(normalizePartUri))];
	}
	const uris = [documentPartUri];
	for (const relationship of readRelationships(documentPartUri, readPart).entries.values()) {
		const kind = lastUriSegment(relationship.type);
		if (relationship.external || kind !== 'header' && kind !== 'footer') {
			continue;
		}
		const target = resolvePartUri(documentPartUri, relationship.target);
		if (target && !uris.includes(target)) {
			uris.push(target);
		}
	}
	return uris;
}

function readRelationships(partUri: string, readPart: (uri: string) => XmlElement | undefined): PartRelationships {

	const root = readPart(relationshipPartUri(partUri));
	const relationships = new Map<string, Relationship>();
	if (!root || !packageRelationshipNamespaces.has(root.uri) || root.local !== 'Relationships') {
		return { owner: partUri, entries: relationships };
	}
	for (const child of elementChildren(root)) {
		if (!packageRelationshipNamespaces.has(child.uri) || child.local !== 'Relationship') {
			continue;
		}
		const id = attribute(child, '', 'Id');
		const type = attribute(child, '', 'Type');
		const target = attribute(child, '', 'Target');
		if (!id || !type || target === undefined || relationships.has(id)) {
			continue;
		}
		relationships.set(id, { id, type, target, external: (attribute(child, '', 'TargetMode') ?? 'Internal').toLowerCase() === 'external' });
	}
	return { owner: partUri, entries: relationships };
}

/** `r:id` / `r:dm` などの関係参照を辿り、指し先パートの根要素を返す。解決できなければ undefined。 */
function readRelatedPart(element: XmlElement, relationships: PartRelationships, readPart: (uri: string) => XmlElement | undefined, local = 'id'): XmlElement | undefined {

	const reference = element.attributes.find(candidate => officeRelationshipNamespaces.has(candidate.uri) && candidate.local === local)?.value;
	const relationship = reference ? relationships.entries.get(reference) : undefined;
	if (!relationship || relationship.external) {
		return undefined;
	}
	const target = resolvePartUri(relationships.owner, relationship.target);
	return target ? readPart(target) : undefined;
}

function relationshipPartUri(partUri: string): string {

	const separator = partUri.lastIndexOf('/');
	return `${partUri.slice(0, separator)}/_rels${partUri.slice(separator)}.rels`;
}

function resolvePartUri(basePartUri: string, target: string): string | undefined {

	if (!target || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//')) {
		return undefined;
	}
	const segments = target.startsWith('/') ? [] : basePartUri.slice(1).split('/').slice(0, -1);
	for (const segment of target.replace(/^\//, '').split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.pop() === undefined) {
				return undefined;
			}
			continue;
		}
		segments.push(segment);
	}
	return segments.length === 0 ? undefined : `/${segments.join('/')}`;
}

function normalizePartUri(uri: string): string {
	return uri.startsWith('/') ? uri : `/${uri}`;
}

function fingerprintPart(xml: string): ParadisOfficeFingerprint {
	return fingerprintParadisWordObjectBytes(new TextEncoder().encode(xml));
}

/** 同じ文書を何度処理しても同じになる安定 id。 */
function objectId(storyUri: string, ordinal: number, docPrId: string | undefined): string {
	return `${storyUri}#${ordinal}:${docPrId ?? ''}`;
}

// ---- XML 小道具 -------------------------------------------------------------------

function elementChildren(element: XmlElement): readonly XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

function attribute(element: XmlElement | undefined, uri: string, local: string): string | undefined {
	return element?.attributes.find(candidate => candidate.uri === uri && candidate.local === local)?.value;
}

function textOf(element: XmlElement): string {
	return element.children.filter((child): child is Extract<ParadisOfficeXmlNode, { readonly kind: 'text' }> => child.kind === 'text').map(child => child.value).join('');
}

function firstDescendant(element: XmlElement, budget: Budget, predicate: (candidate: XmlElement) => boolean): XmlElement | undefined {

	for (const child of elementChildren(element)) {
		budget.consume();
		if (predicate(child)) {
			return child;
		}
		const nested = firstDescendant(child, budget, predicate);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

/** DrawingML の `a:t` を出現順に連結する（グラフのタイトルや SmartArt のラベル用）。 */
function collectDrawingText(element: XmlElement, budget: Budget): string {

	const parts: string[] = [];
	const visit = (candidate: XmlElement): void => {
		budget.consume();
		if (drawingNamespaces.has(candidate.uri) && candidate.local === 't') {
			parts.push(textOf(candidate));
			return;
		}
		for (const child of elementChildren(candidate)) {
			visit(child);
		}
	};
	visit(element);
	return parts.join('');
}

function lastUriSegment(value: string): string {
	return value.slice(value.lastIndexOf('/') + 1);
}

function parseIndex(value: string | undefined): number | undefined {

	if (value === undefined || !/^\d+$/.test(value)) {
		return undefined;
	}
	const index = Number(value);
	return Number.isSafeInteger(index) ? index : undefined;
}
