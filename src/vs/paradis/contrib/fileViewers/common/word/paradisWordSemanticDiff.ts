/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import {
	canReportNoChanges,
	validateOfficeChange,
	type ParadisOfficeChange,
	type ParadisOfficeChangeCategory,
	type ParadisOfficeChangeValue,
	type ParadisOfficeCompletenessManifest,
	type ParadisOfficeFingerprint,
	type ParadisOfficeOutcome,
} from '../paradisOfficeProtocol.js';
import { ParadisOfficePackageError, throwIfParadisOfficeCancelled } from '../office/paradisOfficeArchive.js';
import type { ParadisWordFieldModel } from './paradisWordFields.js';
import type { ParadisWordNumberingModel } from './paradisWordNumbering.js';
import type { ParadisWordObjectModel } from './paradisWordObjects.js';
import type { ParadisWordSecurityModel } from './paradisWordSecurity.js';
import type { ParadisWordDocument, ParadisWordNode, ParadisWordStory } from './paradisWordSemantic.js';
import type { ParadisWordStyleModel } from './paradisWordStyles.js';
import {
	alignParadisWordDocuments,
	type ParadisWordDocumentAlignment,
	type ParadisWordTreeAlignLimits,
} from './paradisWordTreeAlign.js';

export type ParadisWordPackageFactKind = 'style' | 'theme' | 'numbering' | 'relationship' | 'metadata' | 'security' | 'unknown';

/** One all-byte-authorized package fact. IDs are semantic identities, never relationship IDs alone. */
export interface ParadisWordPackageFact {
	readonly kind: ParadisWordPackageFactKind;
	readonly id: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly sourceParts: readonly string[];
}

/** Optional direct/effective format identity attached after the Task 2 resolver. */
export interface ParadisWordNodeFormatFact {
	readonly nodeId: string;
	readonly fingerprint: string | ParadisOfficeFingerprint;
	readonly sourceParts: readonly string[];
}

/** Complete Word semantic and package inputs accepted by the diff. */
export interface ParadisWordSemanticSnapshot {
	readonly document: ParadisWordDocument;
	readonly styles?: ParadisWordStyleModel;
	readonly numbering?: ParadisWordNumberingModel;
	readonly objectModel?: ParadisWordObjectModel;
	readonly fieldModel?: ParadisWordFieldModel;
	readonly securityModel?: ParadisWordSecurityModel;
	readonly packageFacts?: readonly ParadisWordPackageFact[];
	readonly nodeFormats?: readonly ParadisWordNodeFormatFact[];
	readonly packageCompleteness?: ParadisOfficeCompletenessManifest;
}

export interface ParadisWordSemanticDiffLimits {
	readonly changes: number;
	readonly pageSize: number;
	readonly sourceParts: number;
	readonly valueCharacters: number;
	readonly valueNodes: number;
	readonly tree: ParadisWordTreeAlignLimits;
}

export interface ParadisWordSemanticDiffOptions {
	readonly categories?: readonly ParadisOfficeChangeCategory[];
	readonly cursor?: string;
	readonly pageSize?: number;
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<Omit<ParadisWordSemanticDiffLimits, 'tree'>> & { readonly tree?: Partial<ParadisWordTreeAlignLimits> };
}

export interface ParadisWordSemanticDiffPage {
	readonly changes: readonly ParadisOfficeChange[];
	readonly alignments: ParadisWordDocumentAlignment;
	readonly completeness: ParadisOfficeCompletenessManifest;
	readonly outcome: ParadisOfficeOutcome;
	readonly noChanges: boolean;
	readonly terminal: boolean;
	readonly nextCursor?: string;
	readonly warnings: readonly { readonly code: string; readonly detail: string }[];
}

const categories = new Set<ParadisOfficeChangeCategory>(['content', 'formatting', 'structure', 'annotation', 'revision', 'object', 'security']);
const packageFactKinds = new Set<ParadisWordPackageFactKind>(['style', 'theme', 'numbering', 'relationship', 'metadata', 'security', 'unknown']);
const maximumDeadlineMilliseconds = 60_000;
const maximumLimits: ParadisWordSemanticDiffLimits = Object.freeze({
	changes: 100_000,
	pageSize: 1_000,
	sourceParts: 100_000,
	valueCharacters: 16 * 1024 * 1024,
	valueNodes: 1_000_000,
	tree: Object.freeze({ stories: 10_000, nodes: 1_000_000, storyBlockCandidates: 250_000, alignmentRegionPairs: 50_000, paragraphGraphemes: 100_000, graphemeDiffCells: 4_000_000 }),
});
const scalarLimit = 4_096;
const limitKeys = new Set<Exclude<keyof ParadisWordSemanticDiffLimits, 'tree'>>(['changes', 'pageSize', 'sourceParts', 'valueCharacters', 'valueNodes']);
const treeLimitKeys = new Set<keyof ParadisWordTreeAlignLimits>(['stories', 'nodes', 'storyBlockCandidates', 'alignmentRegionPairs', 'paragraphGraphemes', 'graphemeDiffCells']);

interface OwnedOptions {
	readonly categories?: ReadonlySet<ParadisOfficeChangeCategory>;
	readonly cursor?: string;
	readonly pageSize: number;
	readonly cancellationToken?: CancellationToken;
	readonly now: () => number;
	readonly deadlineMilliseconds: number;
	readonly limits: ParadisWordSemanticDiffLimits;
}

interface OwnedSnapshot {
	readonly document: ParadisWordDocument;
	readonly styles?: ParadisWordStyleModel;
	readonly numbering?: ParadisWordNumberingModel;
	readonly objectModel?: ParadisWordObjectModel;
	readonly fieldModel?: ParadisWordFieldModel;
	readonly securityModel?: ParadisWordSecurityModel;
	readonly packageFacts: readonly ParadisWordPackageFact[];
	readonly nodeFormats: readonly ParadisWordNodeFormatFact[];
	readonly packageCompleteness: ParadisOfficeCompletenessManifest;
}

interface Runtime {
	readonly options: OwnedOptions;
	readonly started: number;
	readonly hardDeadline: StopWatch;
	checks: number;
	valueCharacters: number;
	valueNodes: number;
	readonly changes: ParadisOfficeChange[];
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

interface NodeIndex {
	readonly nodes: ReadonlyMap<string, ParadisWordNode>;
	readonly storyByNode: ReadonlyMap<string, ParadisWordStory>;
}

interface TypedNodeCoverage {
	readonly fields: ReadonlySet<string>;
	readonly math: ReadonlySet<string>;
	readonly revisions: ReadonlySet<string>;
	readonly lines: ReadonlySet<string>;
}

interface SemanticFact {
	readonly category: ParadisOfficeChangeCategory;
	readonly subjectKind: string;
	readonly id: string;
	readonly value: string | ParadisOfficeFingerprint;
	readonly sourceParts: readonly string[];
	readonly certainty?: ParadisOfficeChange['certainty'];
}

/** Computes one deterministic page of Story/tree/package changes. */
export function compareWordSemantics(
	originalInput: ParadisWordDocument | ParadisWordSemanticSnapshot,
	modifiedInput: ParadisWordDocument | ParadisWordSemanticSnapshot,
	options: ParadisWordSemanticDiffOptions = {},
): ParadisWordSemanticDiffPage {
	try {
		const ownedOptions = ownOptions(options);
		const runtime: Runtime = { options: ownedOptions, started: readClock(ownedOptions.now), hardDeadline: StopWatch.create(true), checks: 0, valueCharacters: 0, valueNodes: 0, changes: [] };
		checkpoint(runtime, true);
		const original = ownSnapshot(originalInput, runtime);
		const modified = ownSnapshot(modifiedInput, runtime);
		const alignments = alignParadisWordDocuments(original.document, modified.document, {
			cancellationToken: ownedOptions.cancellationToken,
			now: ownedOptions.now,
			deadlineMilliseconds: ownedOptions.deadlineMilliseconds,
			limits: ownedOptions.limits.tree,
		});
		const originalIndex = indexNodes(original.document, runtime);
		const modifiedIndex = indexNodes(modified.document, runtime);
		const typedCoverage = buildTypedNodeCoverage(original, modified, runtime);

		compareStories(original.document, modified.document, alignments, originalIndex, modifiedIndex, typedCoverage, runtime);
		compareStoryReferences(original.document, modified.document, runtime);
		compareNodeFormats(original.nodeFormats, modified.nodeFormats, alignments, originalIndex, modifiedIndex, runtime);
		comparePackageFacts(collectPackageFacts(original, runtime), collectPackageFacts(modified, runtime), runtime);
		compareObjectModels(original.objectModel, modified.objectModel, runtime);
		compareFieldModels(original.fieldModel, modified.fieldModel, runtime);
		compareSecurityModels(original.securityModel, modified.securityModel, runtime);

		if (runtime.changes.length > ownedOptions.limits.changes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		checkpoint(runtime, true);
		runtime.changes.sort(compareChanges);
		checkpoint(runtime, true);
		const sortedChanges: ParadisOfficeChange[] = [];
		for (let index = 0; index < runtime.changes.length; index++) {
			checkpoint(runtime);
			sortedChanges.push(Object.freeze({ ...runtime.changes[index], id: `word-change:${String(index + 1).padStart(6, '0')}` }));
		}
		const allChangeCount = sortedChanges.length;
		const filtered: ParadisOfficeChange[] = [];
		for (const change of sortedChanges) {
			checkpoint(runtime);
			if (!ownedOptions.categories || ownedOptions.categories.has(change.category)) {
				filtered.push(change);
			}
		}
		const revision = cursorRevision(original, modified, filtered, ownedOptions, runtime);
		const offset = parseCursor(ownedOptions.cursor, revision, filtered.length);
		const end = Math.min(filtered.length, offset + ownedOptions.pageSize);
		const sourcesTerminal = original.packageCompleteness.terminal && modified.packageCompleteness.terminal;
		const terminal = end === filtered.length && sourcesTerminal;
		const outcome = deriveOutcome(original.packageCompleteness, modified.packageCompleteness, alignments.outcome);
		const completeness = buildCompleteness(original.packageCompleteness, modified.packageCompleteness, allChangeCount, terminal ? allChangeCount : Math.min(allChangeCount, end), terminal);
		const noChanges = canReportNoChanges(completeness, outcome, allChangeCount);
		const warnings = alignments.warnings.map(warning => Object.freeze({ code: warning.code, detail: `${warning.storyId}${warning.parentNodeId ? `/${warning.parentNodeId}` : ''}` }));
		checkpoint(runtime, true);
		return Object.freeze({
			changes: Object.freeze(filtered.slice(offset, end)), alignments, completeness, outcome, noChanges, terminal,
			...(!terminal && end < filtered.length ? { nextCursor: `word:${end}:${revision}` } : {}),
			warnings: Object.freeze(warnings),
		});
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('unsafe');
	}
}

/** Compatibility alias matching the common semantic-diff naming convention. */
export const diffParadisWordSemantics = compareWordSemantics;

function compareStories(
	original: ParadisWordDocument, modified: ParadisWordDocument, alignments: ParadisWordDocumentAlignment,
	originalIndex: NodeIndex, modifiedIndex: NodeIndex, typedCoverage: TypedNodeCoverage, runtime: Runtime,
): void {
	const originalStories = new Map(original.stories.map(story => [story.id, story]));
	const modifiedStories = new Map(modified.stories.map(story => [story.id, story]));
	for (const storyAlignment of alignments.stories) {
		checkpoint(runtime);
		const originalStory = storyAlignment.originalStoryId ? originalStories.get(storyAlignment.originalStoryId) : undefined;
		const modifiedStory = storyAlignment.modifiedStoryId ? modifiedStories.get(storyAlignment.modifiedStoryId) : undefined;
		const story = originalStory ?? modifiedStory!;
		const storyLocator = locatorForStory(story);
		if (!originalStory || !modifiedStory) {
			emit(runtime, 'structure', originalStory ? 'story.removed' : 'story.added', storyLocator,
				originalStory ? originalStory.text : undefined, modifiedStory ? modifiedStory.text : undefined,
				storyAlignment.certainty, [story.source.partUri], story.id);
			continue;
		}
		for (const alignment of storyAlignment.nodes) {
			checkpoint(runtime);
			const oldNode = alignment.originalNodeId ? originalIndex.nodes.get(alignment.originalNodeId) : undefined;
			const newNode = alignment.modifiedNodeId ? modifiedIndex.nodes.get(alignment.modifiedNodeId) : undefined;
			const node = oldNode ?? newNode;
			if (!node) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const oldStory = oldNode ? originalIndex.storyByNode.get(oldNode.id) : undefined;
			const newStory = newNode ? modifiedIndex.storyByNode.get(newNode.id) : undefined;
			const locator = `${locatorForStory(newStory ?? oldStory ?? story)}/node:${newNode?.id ?? oldNode?.id}`;
			if (!oldNode || !newNode) {
				if (hasUnmatchedAncestor(alignment, storyAlignment.nodes)) {
					continue;
				}
				emit(runtime, categoryForNode(node, newStory ?? oldStory), oldNode ? 'node.removed' : 'node.added', locator,
					oldNode ? nodeSummary(oldNode, runtime) : undefined, newNode ? nodeSummary(newNode, runtime) : undefined,
					alignment.certainty, [node.source.partUri], node.id);
				continue;
			}
			if (alignment.status === 'moved') {
				emit(runtime, 'structure', 'node.moved', locator, oldNode.id, newNode.id, alignment.certainty, [oldNode.source.partUri, newNode.source.partUri], newNode.id);
			}
			compareMatchedNode(oldNode, newNode, oldStory ?? originalStory, newStory ?? modifiedStory, locator, typedCoverage, runtime);
		}
	}
}

function compareMatchedNode(
	original: ParadisWordNode, modified: ParadisWordNode, originalStory: ParadisWordStory, modifiedStory: ParadisWordStory,
	locator: string, typedCoverage: TypedNodeCoverage, runtime: Runtime,
): void {
	if (original.kind !== modified.kind) {
		emit(runtime, 'structure', 'node.kind', locator, original.kind, modified.kind, 'heuristic', [original.source.partUri, modified.source.partUri], modified.id);
		return;
	}
	switch (original.kind) {
		case 'paragraph': {
			const newParagraph = modified as Extract<ParadisWordNode, { readonly kind: 'paragraph' }>;
			const oldText = nodeText(original, runtime);
			const newText = nodeText(newParagraph, runtime);
			const comment = originalStory.address.kind === 'comment' || modifiedStory.address.kind === 'comment';
			compareValue(runtime, comment ? 'annotation' : 'content', comment ? 'comment.text' : 'paragraph.text', locator, oldText, newText, 'exact', [original.source.partUri, newParagraph.source.partUri], newParagraph.id);
			if (oldText === newText && childSemanticSignature(original, runtime) === childSemanticSignature(newParagraph, runtime)
				&& original.source.fingerprint !== newParagraph.source.fingerprint) {
				compareValue(runtime, 'formatting', 'paragraph.formatting', locator, original.source.fingerprint, newParagraph.source.fingerprint, 'exact', [original.source.partUri, newParagraph.source.partUri], newParagraph.id);
			}
			break;
		}
		case 'field': {
			if (isTypedNodeCovered(typedCoverage.fields, original, modified)) { break; }
			const field = modified as Extract<ParadisWordNode, { readonly kind: 'field' }>;
			compareValue(runtime, 'content', 'field.instruction', locator, original.instruction, field.instruction, 'exact', [original.source.partUri, field.source.partUri], field.id);
			compareValue(runtime, 'content', 'field.savedResult', locator, original.savedResult, field.savedResult, 'exact', [original.source.partUri, field.source.partUri], field.id);
			compareValue(runtime, 'formatting', 'field.flags', locator, `${original.dirty ?? ''}|${original.locked ?? ''}`, `${field.dirty ?? ''}|${field.locked ?? ''}`, 'exact', [original.source.partUri, field.source.partUri], field.id);
			break;
		}
		case 'omml': {
			if (isTypedNodeCovered(typedCoverage.math, original, modified)) { break; }
			const math = modified as Extract<ParadisWordNode, { readonly kind: 'omml' }>;
			compareValue(runtime, 'object', 'object.omml', locator, `${original.source.fingerprint}|${original.text}`, `${math.source.fingerprint}|${math.text}`, 'exact', [original.source.partUri, math.source.partUri], math.id);
			break;
		}
		case 'revision': {
			if (isTypedNodeCovered(typedCoverage.revisions, original, modified)) { break; }
			const revision = modified as Extract<ParadisWordNode, { readonly kind: 'revision' }>;
			compareValue(runtime, 'revision', 'revision.properties', locator,
				`${original.revisionKind}|${original.revisionId ?? ''}|${original.author ?? ''}|${original.date ?? ''}|${nodeText(original, runtime)}`,
				`${revision.revisionKind}|${revision.revisionId ?? ''}|${revision.author ?? ''}|${revision.date ?? ''}|${nodeText(revision, runtime)}`,
				'exact', [original.source.partUri, revision.source.partUri], revision.id);
			break;
		}
		case 'drawing': {
			if (isTypedNodeCovered(typedCoverage.lines, original, modified)) { break; }
			const drawing = modified as Extract<ParadisWordNode, { readonly kind: 'drawing' }>;
			compareValue(runtime, 'object', 'object.lineGeometry', locator, drawingGeometryValue(original, runtime), drawingGeometryValue(drawing, runtime), 'exact', [original.source.partUri, drawing.source.partUri], drawing.id);
			break;
		}
		case 'table': {
			const table = modified as Extract<ParadisWordNode, { readonly kind: 'table' }>;
			compareValue(runtime, 'formatting', 'table.diagonalBorder', locator, tableDiagonalValue(original, runtime), tableDiagonalValue(table, runtime), 'exact', [original.source.partUri, table.source.partUri], table.id);
			break;
		}
		case 'image': {
			const image = modified as Extract<ParadisWordNode, { readonly kind: 'image' }>;
			compareValue(runtime, 'object', 'object.imageReference', locator, `${original.external}|${original.targetPartUri ?? ''}`, `${image.external}|${image.targetPartUri ?? ''}`, 'exact', [original.source.partUri, image.source.partUri], image.id);
			break;
		}
		case 'commentReference': {
			const reference = modified as Extract<ParadisWordNode, { readonly kind: 'commentReference' }>;
			compareValue(runtime, 'annotation', 'comment.reference', locator, `${original.boundary}|${original.commentId}`, `${reference.boundary}|${reference.commentId}`, 'exact', [original.source.partUri, reference.source.partUri], reference.id);
			break;
		}
	}
}

function compareStoryReferences(original: ParadisWordDocument, modified: ParadisWordDocument, runtime: Runtime): void {
	const originalStories = new Map(original.stories.map(story => [story.id, story]));
	const modifiedStories = new Map(modified.stories.map(story => [story.id, story]));
	const key = (reference: ParadisWordDocument['storyReferences'][number]): string => `${reference.sectionOrdinal}|${reference.kind}|${reference.role}`;
	const oldReferences = uniqueMap(original.storyReferences, key);
	const newReferences = uniqueMap(modified.storyReferences, key);
	for (const referenceKey of [...new Set([...oldReferences.keys(), ...newReferences.keys()])].sort()) {
		checkpoint(runtime);
		const oldReference = oldReferences.get(referenceKey);
		const newReference = newReferences.get(referenceKey);
		const oldTarget = oldReference ? originalStories.get(oldReference.storyId)?.address.partUri : undefined;
		const newTarget = newReference ? modifiedStories.get(newReference.storyId)?.address.partUri : undefined;
		compareValue(runtime, 'structure', 'storyReference.target', `section:${referenceKey}`, oldTarget, newTarget, 'exact', [oldReference?.source.partUri, newReference?.source.partUri].filter(isString), newReference?.anchor.fingerprint ?? oldReference?.anchor.fingerprint);
	}
}

function compareNodeFormats(
	original: readonly ParadisWordNodeFormatFact[], modified: readonly ParadisWordNodeFormatFact[],
	alignments: ParadisWordDocumentAlignment, originalIndex: NodeIndex, modifiedIndex: NodeIndex, runtime: Runtime,
): void {
	const oldFormats = uniqueMap(original, value => value.nodeId);
	const newFormats = uniqueMap(modified, value => value.nodeId);
	const consumedOriginal = new Set<string>();
	const consumedModified = new Set<string>();
	for (const story of alignments.stories) {
		for (const alignment of story.nodes) {
			checkpoint(runtime);
			if (!alignment.originalNodeId || !alignment.modifiedNodeId) { continue; }
			const oldFormat = oldFormats.get(alignment.originalNodeId);
			const newFormat = newFormats.get(alignment.modifiedNodeId);
			if (!oldFormat && !newFormat) { continue; }
			consumedOriginal.add(alignment.originalNodeId);
			consumedModified.add(alignment.modifiedNodeId);
			compareValue(runtime, 'formatting', 'node.format', `node:${alignment.modifiedNodeId}`, oldFormat?.fingerprint, newFormat?.fingerprint, alignment.certainty,
				[...(oldFormat?.sourceParts ?? []), ...(newFormat?.sourceParts ?? [])], alignment.modifiedNodeId);
		}
	}
	const remainingIds = [...new Set([
		...[...oldFormats.keys()].filter(nodeId => !consumedOriginal.has(nodeId)),
		...[...newFormats.keys()].filter(nodeId => !consumedModified.has(nodeId)),
	])].sort();
	for (const nodeId of remainingIds) {
		checkpoint(runtime);
		const oldFormat = consumedOriginal.has(nodeId) ? undefined : oldFormats.get(nodeId);
		const newFormat = consumedModified.has(nodeId) ? undefined : newFormats.get(nodeId);
		const node = modifiedIndex.nodes.get(newFormat?.nodeId ?? '') ?? originalIndex.nodes.get(oldFormat?.nodeId ?? '');
		if (!node) {
			throw new ParadisOfficePackageError('unsafe');
		}
		compareValue(runtime, 'formatting', 'node.format', `node:${newFormat?.nodeId ?? oldFormat?.nodeId}`, oldFormat?.fingerprint, newFormat?.fingerprint, 'exact', [...(oldFormat?.sourceParts ?? []), ...(newFormat?.sourceParts ?? [])], newFormat?.nodeId ?? oldFormat?.nodeId);
	}
}

function buildTypedNodeCoverage(original: OwnedSnapshot, modified: OwnedSnapshot, runtime: Runtime): TypedNodeCoverage {
	const fields = new Set<string>();
	const math = new Set<string>();
	const revisions = new Set<string>();
	const lines = new Set<string>();
	for (const snapshot of [original, modified]) {
		for (const value of snapshot.fieldModel?.fields ?? []) { checkpoint(runtime); fields.add(modelSourceKey(value.source)); }
		for (const value of snapshot.objectModel?.math ?? []) { checkpoint(runtime); math.add(modelSourceKey(value.source)); }
		for (const value of snapshot.fieldModel?.revisions ?? []) { checkpoint(runtime); revisions.add(modelSourceKey(value.source)); }
		for (const value of snapshot.objectModel?.lines ?? []) { checkpoint(runtime); lines.add(modelSourceKey(value.source)); }
	}
	return { fields, math, revisions, lines };
}

function isTypedNodeCovered(coverage: ReadonlySet<string>, original: ParadisWordNode, modified: ParadisWordNode): boolean {
	return coverage.has(modelSourceKey(original.source)) || coverage.has(modelSourceKey(modified.source));
}

function modelSourceKey(source: { readonly partUri: string; readonly semanticPath: readonly number[] }): string {
	return `${source.partUri}\u001F${source.semanticPath.join('.')}`;
}

function collectPackageFacts(snapshot: OwnedSnapshot, runtime: Runtime): readonly SemanticFact[] {
	const result: SemanticFact[] = snapshot.packageFacts.map(value => ({
		category: categoryForPackageFact(value.kind), subjectKind: `package.${value.kind}`, id: value.id,
		value: value.fingerprint, sourceParts: value.sourceParts, ...(value.kind === 'unknown' ? { certainty: 'opaque' as const } : {}),
	}));
	if (snapshot.styles) {
		for (const [styleId, definition] of snapshot.styles.styles) {
			checkpoint(runtime);
			result.push({ category: 'formatting', subjectKind: 'package.style', id: styleId, value: definition.definitionFingerprint, sourceParts: styleSources(definition) });
		}
		result.push({ category: 'formatting', subjectKind: 'package.theme', id: 'resolved-theme', value: hashText(canonicalMap(snapshot.styles.themeColors, runtime) + canonicalMap(snapshot.styles.themeFonts, runtime), runtime), sourceParts: [] });
	}
	if (snapshot.numbering) {
		for (const [numberingId, definition] of snapshot.numbering.numbers) {
			checkpoint(runtime);
			result.push({ category: 'formatting', subjectKind: 'package.numbering', id: numberingId, value: definition.definitionFingerprint, sourceParts: [] });
		}
	}
	return result;
}

function comparePackageFacts(original: readonly SemanticFact[], modified: readonly SemanticFact[], runtime: Runtime): void {
	const oldFacts = uniqueMap(original, value => `${value.subjectKind}\u001F${value.id}`);
	const newFacts = uniqueMap(modified, value => `${value.subjectKind}\u001F${value.id}`);
	for (const key of [...new Set([...oldFacts.keys(), ...newFacts.keys()])].sort()) {
		checkpoint(runtime);
		const oldFact = oldFacts.get(key);
		const newFact = newFacts.get(key);
		const fact = oldFact ?? newFact!;
		compareValue(runtime, fact.category, fact.subjectKind, `package:${fact.id}`, oldFact?.value, newFact?.value,
			newFact?.certainty ?? oldFact?.certainty ?? 'exact', [...(oldFact?.sourceParts ?? []), ...(newFact?.sourceParts ?? [])]);
	}
}

function compareObjectModels(original: ParadisWordObjectModel | undefined, modified: ParadisWordObjectModel | undefined, runtime: Runtime): void {
	compareModelItems(original?.images ?? [], modified?.images ?? [], 'object.image', runtime, (oldImage, newImage, locator) => {
		compareValue(runtime, 'object', 'object.imageContent', locator, oldImage?.content ? canonicalValue(oldImage.content, runtime) : undefined, newImage?.content ? canonicalValue(newImage.content, runtime) : undefined, 'exact', imageSources(oldImage, newImage));
		compareValue(runtime, 'object', 'object.imagePlacement', locator, oldImage?.placement.fingerprint, newImage?.placement.fingerprint, 'exact', imageSources(oldImage, newImage));
		compareValue(runtime, 'object', 'object.imagePresentation', locator, oldImage?.presentation.fingerprint, newImage?.presentation.fingerprint, 'exact', imageSources(oldImage, newImage));
	});
	compareModelItems(original?.lines ?? [], modified?.lines ?? [], 'object.line', runtime, (oldLine, newLine, locator) => {
		compareValue(runtime, 'object', 'object.lineGeometry', locator, oldLine ? canonicalValue(oldLine.geometry, runtime) : undefined, newLine ? canonicalValue(newLine.geometry, runtime) : undefined, 'exact', modelSources(oldLine, newLine));
	});
	compareModelItems(original?.math ?? [], modified?.math ?? [], 'object.math', runtime, (oldMath, newMath, locator) => {
		compareValue(runtime, 'object', 'object.omml', locator, oldMath?.canonicalFingerprint, newMath?.canonicalFingerprint, 'exact', modelSources(oldMath, newMath));
	});
}

function compareFieldModels(original: ParadisWordFieldModel | undefined, modified: ParadisWordFieldModel | undefined, runtime: Runtime): void {
	compareModelItems(original?.fields ?? [], modified?.fields ?? [], 'field', runtime, (oldField, newField, locator) => {
		compareValue(runtime, 'content', 'field.instruction', locator, oldField?.instruction, newField?.instruction, 'exact', modelSources(oldField, newField));
		compareValue(runtime, 'content', 'field.savedResult', locator, oldField?.savedResult, newField?.savedResult, 'exact', modelSources(oldField, newField));
	});
	compareModelItems(original?.sections ?? [], modified?.sections ?? [], 'section', runtime, (oldSection, newSection, locator) => {
		compareValue(runtime, 'structure', 'section.properties', locator, oldSection?.fingerprint, newSection?.fingerprint, 'exact', modelSources(oldSection, newSection));
	});
	compareModelItems(original?.revisions ?? [], modified?.revisions ?? [], 'revision', runtime, (oldRevision, newRevision, locator) => {
		compareValue(runtime, 'revision', 'revision.properties', locator, oldRevision?.fingerprint, newRevision?.fingerprint, 'exact', modelSources(oldRevision, newRevision));
	});
}

function compareSecurityModels(original: ParadisWordSecurityModel | undefined, modified: ParadisWordSecurityModel | undefined, runtime: Runtime): void {
	compareModelItems(original?.unsafeNodes ?? [], modified?.unsafeNodes ?? [], 'security', runtime, (oldNode, newNode, locator) => {
		compareValue(runtime, 'security', 'package.security', locator, oldNode ? canonicalValue(oldNode, runtime) : undefined, newNode ? canonicalValue(newNode, runtime) : undefined, 'exact', []);
	});
}

function compareModelItems<T extends { readonly id: string }>(
	original: readonly T[], modified: readonly T[], locatorPrefix: string, runtime: Runtime,
	compare: (original: T | undefined, modified: T | undefined, locator: string) => void,
): void {
	const oldItems = uniqueMap(original, value => value.id);
	const newItems = uniqueMap(modified, value => value.id);
	for (const id of [...new Set([...oldItems.keys(), ...newItems.keys()])].sort()) {
		checkpoint(runtime);
		compare(oldItems.get(id), newItems.get(id), `${locatorPrefix}:${id}`);
	}
}

function compareValue(
	runtime: Runtime, category: ParadisOfficeChangeCategory, subjectKind: string, locator: string,
	original: string | boolean | null | ParadisOfficeFingerprint | undefined,
	modified: string | boolean | null | ParadisOfficeFingerprint | undefined,
	certainty: ParadisOfficeChange['certainty'], sourceParts: readonly string[], anchor?: string,
): void {
	if (equalRawChangeValue(original, modified)) {
		return;
	}
	emit(runtime, category, subjectKind, locator, original, modified, certainty, sourceParts, anchor);
}

function emit(
	runtime: Runtime, category: ParadisOfficeChangeCategory, subjectKind: string, locator: string,
	original: string | boolean | null | ParadisOfficeFingerprint | undefined,
	modified: string | boolean | null | ParadisOfficeFingerprint | undefined,
	certainty: ParadisOfficeChange['certainty'], sourceParts: readonly string[], anchor?: string,
): void {
	checkpoint(runtime);
	if (runtime.changes.length >= runtime.options.limits.changes) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	if (typeof locator !== 'string' || !locator || locator.length > scalarLimit || !categories.has(category)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const parts = Object.freeze([...new Set(sourceParts.filter(isString))].sort());
	if (parts.length > runtime.options.limits.sourceParts) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const before = changeValue(original, runtime);
	const after = changeValue(modified, runtime);
	const id = `word-pending:${String(runtime.changes.length + 1).padStart(6, '0')}`;
	const change: ParadisOfficeChange = Object.freeze({
		id, category, subject: Object.freeze({ kind: subjectKind, locator }), before, after, certainty, sourceParts: parts,
		...(anchor ? { navigableAnchor: String(anchor) } : {}),
	});
	const validation = validateOfficeChange(change);
	if (!validation.valid) {
		throw new ParadisOfficePackageError('unsafe');
	}
	runtime.changes.push(change);
}

function changeValue(value: string | boolean | null | ParadisOfficeFingerprint | undefined, runtime: Runtime): ParadisOfficeChangeValue {
	runtime.valueNodes++;
	if (runtime.valueNodes > runtime.options.limits.valueNodes) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	if (value === undefined) {
		return Object.freeze({ kind: 'none' });
	}
	if (isFingerprint(value)) {
		return Object.freeze({ kind: 'fingerprint', algorithm: 'sha256', value: String(value.value), byteLength: value.byteLength });
	}
	if (typeof value === 'string') {
		runtime.valueCharacters += value.length;
		if (value.length > scalarLimit || runtime.valueCharacters > runtime.options.limits.valueCharacters) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		return Object.freeze({ kind: 'scalar', valueType: 'text', value: String(value) });
	}
	if (typeof value === 'boolean') {
		return Object.freeze({ kind: 'scalar', valueType: 'boolean', value });
	}
	return Object.freeze({ kind: 'scalar', valueType: 'null', value: null });
}

function ownSnapshot(input: ParadisWordDocument | ParadisWordSemanticSnapshot, runtime: Runtime): OwnedSnapshot {
	const snapshot = isDocument(input) ? { document: input } : input;
	if (!snapshot || !isDocument(snapshot.document)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const packageFacts = snapshot.packageFacts ?? [];
	const nodeFormats = snapshot.nodeFormats ?? [];
	if (!Array.isArray(packageFacts) || !Array.isArray(nodeFormats)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const ownedFacts = packageFacts.map(value => ownPackageFact(value, runtime));
	const ownedFormats = nodeFormats.map(value => ownNodeFormat(value, runtime));
	const packageCompleteness = snapshot.packageCompleteness ? ownCompleteness(snapshot.packageCompleteness) : defaultCompleteness(snapshot.document);
	return {
		document: snapshot.document,
		...(snapshot.styles ? { styles: snapshot.styles } : {}),
		...(snapshot.numbering ? { numbering: snapshot.numbering } : {}),
		...(snapshot.objectModel ? { objectModel: snapshot.objectModel } : {}),
		...(snapshot.fieldModel ? { fieldModel: snapshot.fieldModel } : {}),
		...(snapshot.securityModel ? { securityModel: snapshot.securityModel } : {}),
		packageFacts: Object.freeze(ownedFacts), nodeFormats: Object.freeze(ownedFormats), packageCompleteness,
	};
}

function ownPackageFact(value: ParadisWordPackageFact, runtime: Runtime): ParadisWordPackageFact {
	checkpoint(runtime);
	if (!value || !packageFactKinds.has(value.kind) || typeof value.id !== 'string' || !value.id || value.id.length > scalarLimit
		|| !isFingerprint(value.fingerprint) || !Array.isArray(value.sourceParts) || value.sourceParts.length > runtime.options.limits.sourceParts
		|| value.sourceParts.some(part => typeof part !== 'string' || !part || part.length > scalarLimit)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return Object.freeze({ kind: value.kind, id: String(value.id), fingerprint: Object.freeze({ ...value.fingerprint }), sourceParts: Object.freeze(value.sourceParts.map(String)) });
}

function ownNodeFormat(value: ParadisWordNodeFormatFact, runtime: Runtime): ParadisWordNodeFormatFact {
	checkpoint(runtime);
	if (!value || typeof value.nodeId !== 'string' || !value.nodeId || (!isFingerprint(value.fingerprint) && typeof value.fingerprint !== 'string')
		|| !Array.isArray(value.sourceParts) || value.sourceParts.some(part => typeof part !== 'string')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return Object.freeze({ nodeId: String(value.nodeId), fingerprint: isFingerprint(value.fingerprint) ? Object.freeze({ ...value.fingerprint }) : String(value.fingerprint), sourceParts: Object.freeze(value.sourceParts.map(String)) });
}

function ownCompleteness(value: ParadisOfficeCompletenessManifest): ParadisOfficeCompletenessManifest {
	const counters = [value.expectedParts, value.visitedParts, value.parsedParts, value.opaqueParts, value.failedParts, value.omittedParts, value.expectedSemanticUnits, value.visitedSemanticUnits];
	if (counters.some(counter => !Number.isSafeInteger(counter) || counter < 0) || typeof value.terminal !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return Object.freeze({
		expectedParts: value.expectedParts, visitedParts: value.visitedParts, parsedParts: value.parsedParts,
		opaqueParts: value.opaqueParts, failedParts: value.failedParts, omittedParts: value.omittedParts,
		expectedSemanticUnits: value.expectedSemanticUnits, visitedSemanticUnits: value.visitedSemanticUnits, terminal: value.terminal,
	});
}

function defaultCompleteness(document: ParadisWordDocument): ParadisOfficeCompletenessManifest {
	const value = document.completeness;
	return Object.freeze({
		expectedParts: value.expectedParts, visitedParts: value.visitedParts, parsedParts: value.parsedParts,
		opaqueParts: 0, failedParts: 0, omittedParts: Math.max(0, value.expectedParts - value.visitedParts),
		expectedSemanticUnits: value.nodes + value.stories, visitedSemanticUnits: value.nodes + value.stories,
		// A semantic document alone cannot prove that styles, relationships, metadata, security, and unknown Parts were compared.
		terminal: false,
	});
}

function buildCompleteness(
	original: ParadisOfficeCompletenessManifest, modified: ParadisOfficeCompletenessManifest,
	expectedSemanticUnits: number, visitedSemanticUnits: number, terminal: boolean,
): ParadisOfficeCompletenessManifest {
	return Object.freeze({
		expectedParts: safeAdd(original.expectedParts, modified.expectedParts),
		visitedParts: safeAdd(original.visitedParts, modified.visitedParts),
		parsedParts: safeAdd(original.parsedParts, modified.parsedParts),
		opaqueParts: safeAdd(original.opaqueParts, modified.opaqueParts),
		failedParts: safeAdd(original.failedParts, modified.failedParts),
		omittedParts: safeAdd(original.omittedParts, modified.omittedParts),
		expectedSemanticUnits, visitedSemanticUnits, terminal,
	});
}

function deriveOutcome(original: ParadisOfficeCompletenessManifest, modified: ParadisOfficeCompletenessManifest, alignment: ParadisWordDocumentAlignment['outcome']): ParadisOfficeOutcome {
	if (alignment === 'degraded' || !completeManifest(original) || !completeManifest(modified)) {
		return 'degraded';
	}
	return 'complete';
}

function completeManifest(value: ParadisOfficeCompletenessManifest): boolean {
	return value.terminal && value.expectedParts === value.visitedParts && value.visitedParts === value.parsedParts + value.opaqueParts
		&& value.failedParts === 0 && value.omittedParts === 0 && value.expectedSemanticUnits === value.visitedSemanticUnits;
}

function ownOptions(options: ParadisWordSemanticDiffOptions): OwnedOptions {
	const now = options.now ?? Date.now;
	const deadlineMilliseconds = options.deadlineMilliseconds ?? maximumDeadlineMilliseconds;
	if (typeof now !== 'function' || !Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds < 0 || deadlineMilliseconds > maximumDeadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const limits: Mutable<Omit<ParadisWordSemanticDiffLimits, 'tree'>> & { tree: Mutable<ParadisWordTreeAlignLimits> } = { ...maximumLimits, tree: { ...maximumLimits.tree } };
	if (options.limits) {
		for (const key of Object.keys(options.limits)) {
			if (key === 'tree') {
				continue;
			}
			if (!limitKeys.has(key as Exclude<keyof ParadisWordSemanticDiffLimits, 'tree'>)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const name = key as Exclude<keyof ParadisWordSemanticDiffLimits, 'tree'>;
			const value = options.limits[name];
			if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximumLimits[name]) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			limits[name] = value as number;
		}
		if (options.limits.tree) {
			for (const key of Object.keys(options.limits.tree)) {
				if (!treeLimitKeys.has(key as keyof ParadisWordTreeAlignLimits)) {
					throw new ParadisOfficePackageError('unsafe');
				}
				const name = key as keyof ParadisWordTreeAlignLimits;
				const value = options.limits.tree[name];
				if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximumLimits.tree[name]) {
					throw new ParadisOfficePackageError('limitExceeded');
				}
				limits.tree[name] = value as number;
			}
		}
	}
	const pageSize = options.pageSize ?? limits.pageSize;
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > limits.pageSize) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	let categoryFilter: ReadonlySet<ParadisOfficeChangeCategory> | undefined;
	if (options.categories) {
		if (!Array.isArray(options.categories) || options.categories.some(category => !categories.has(category))) {
			throw new ParadisOfficePackageError('unsafe');
		}
		categoryFilter = new Set(options.categories);
	}
	if (options.cursor !== undefined && (typeof options.cursor !== 'string' || options.cursor.length > 256)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { ...(categoryFilter ? { categories: categoryFilter } : {}), ...(options.cursor ? { cursor: String(options.cursor) } : {}), pageSize, cancellationToken: options.cancellationToken, now, deadlineMilliseconds, limits };
}

function indexNodes(document: ParadisWordDocument, runtime: Runtime): NodeIndex {
	const nodes = new Map<string, ParadisWordNode>();
	const storyByNode = new Map<string, ParadisWordStory>();
	for (const story of document.stories) {
		const stack = [...story.nodes];
		while (stack.length > 0) {
			checkpoint(runtime);
			const node = stack.pop()!;
			if (nodes.has(node.id)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			nodes.set(node.id, node);
			storyByNode.set(node.id, story);
			if (node.children) {
				stack.push(...node.children);
			}
		}
	}
	return { nodes, storyByNode };
}

function canonicalValue(value: object, runtime: Runtime): string {
	const active = new Set<object>();
	const visit = (candidate: unknown, depth: number): string => {
		checkpoint(runtime);
		if (depth > 64 || ++runtime.valueNodes > runtime.options.limits.valueNodes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		if (candidate === null) { return 'null'; }
		if (typeof candidate === 'string') { chargeCharacters(candidate.length, runtime); return JSON.stringify(candidate); }
		if (typeof candidate === 'number' || typeof candidate === 'boolean') { return JSON.stringify(candidate); }
		if (candidate === undefined) { return 'undefined'; }
		if (typeof candidate !== 'object' || active.has(candidate)) { throw new ParadisOfficePackageError('unsafe'); }
		active.add(candidate);
		let result: string;
		if (Array.isArray(candidate)) {
			result = `[${candidate.map(value => visit(value, depth + 1)).join(',')}]`;
		} else if (candidate instanceof Map) {
			const entries = [...candidate.entries()].map(([key, mapValue]) => [visit(key, depth + 1), visit(mapValue, depth + 1)] as const).sort((left, right) => left[0].localeCompare(right[0]));
			result = `{${entries.map(([key, mapValue]) => `${key}:${mapValue}`).join(',')}}`;
		} else {
			const descriptors = Object.getOwnPropertyDescriptors(candidate);
			const keys = Object.keys(descriptors).sort();
			const values: string[] = [];
			for (const key of keys) {
				const descriptor = descriptors[key];
				if (descriptor.get !== undefined || descriptor.set !== undefined) { throw new ParadisOfficePackageError('unsafe'); }
				values.push(`${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`);
			}
			result = `{${values.join(',')}}`;
		}
		active.delete(candidate);
		chargeCharacters(result.length, runtime);
		return result;
	};
	const result = visit(value, 0);
	if (result.length > scalarLimit) {
		return `sha256-surrogate:${hashText(result, runtime)}`;
	}
	return result;
}

function equalRawChangeValue(
	left: string | boolean | null | ParadisOfficeFingerprint | undefined,
	right: string | boolean | null | ParadisOfficeFingerprint | undefined,
): boolean {
	if (isFingerprint(left) && isFingerprint(right)) {
		return left.algorithm === right.algorithm && left.value === right.value && left.byteLength === right.byteLength;
	}
	return left === right;
}

function categoryForNode(node: ParadisWordNode, story: ParadisWordStory | undefined): ParadisOfficeChangeCategory {
	if (story?.address.kind === 'comment' || node.kind === 'commentReference') { return 'annotation'; }
	if (node.kind === 'revision') { return 'revision'; }
	if (node.kind === 'image' || node.kind === 'drawing' || node.kind === 'omml') { return 'object'; }
	return node.children ? 'structure' : 'content';
}

function categoryForPackageFact(kind: ParadisWordPackageFactKind): ParadisOfficeChangeCategory {
	if (kind === 'style' || kind === 'theme' || kind === 'numbering') { return 'formatting'; }
	if (kind === 'security') { return 'security'; }
	return 'structure';
}

function hasUnmatchedAncestor(alignment: ParadisWordDocumentAlignment['stories'][number]['nodes'][number], entries: readonly ParadisWordDocumentAlignment['stories'][number]['nodes'][number][]): boolean {
	const parentId = alignment.originalParentNodeId ?? alignment.modifiedParentNodeId;
	if (!parentId) {
		return false;
	}
	return entries.some(entry => (entry.originalNodeId === parentId || entry.modifiedNodeId === parentId) && (entry.status === 'added' || entry.status === 'removed'));
}

function nodeSummary(node: ParadisWordNode, runtime: Runtime): string {
	const text = nodeText(node, runtime);
	return text ? `${node.kind}:${text}` : node.kind;
}

function nodeText(node: ParadisWordNode, runtime: Runtime): string {
	const result: string[] = [];
	const stack = [node];
	while (stack.length > 0) {
		checkpoint(runtime);
		const current = stack.pop()!;
		switch (current.kind) {
			case 'text': result.push(current.text); break;
			case 'tab': result.push('\t'); break;
			case 'break': result.push('\n'); break;
			case 'symbol': result.push(current.character ?? ''); break;
			case 'field': result.push(current.savedResult); break;
			case 'omml': result.push(current.text); break;
			default:
				if (current.children) {
					for (let index = current.children.length - 1; index >= 0; index--) {
						stack.push(current.children[index]);
					}
				}
		}
	}
	return result.join('');
}

function childSemanticSignature(node: Extract<ParadisWordNode, { readonly kind: 'paragraph' }>, runtime: Runtime): string {
	return node.children.map(child => {
		checkpoint(runtime);
		switch (child.kind) {
			case 'field': return `field:${child.fieldKind}:${child.instruction}:${child.savedResult}:${child.dirty ?? ''}:${child.locked ?? ''}`;
			case 'omml': return `omml:${child.source.fingerprint}:${child.text}`;
			case 'revision': return `revision:${child.revisionKind}:${child.revisionId ?? ''}:${child.author ?? ''}:${child.date ?? ''}:${nodeText(child, runtime)}`;
			case 'image': return `image:${child.external}:${child.targetPartUri ?? ''}`;
			case 'drawing': return `drawing:${drawingGeometryValue(child, runtime)}`;
			default: return `${child.kind}:${nodeText(child, runtime)}`;
		}
	}).join('\u001F');
}

function drawingGeometryValue(node: Extract<ParadisWordNode, { readonly kind: 'drawing' }>, runtime: Runtime): string {
	const { sourcePartFingerprint: _sourcePartFingerprint, ...geometry } = node.geometry;
	return canonicalValue(geometry, runtime);
}

function tableDiagonalValue(node: Extract<ParadisWordNode, { readonly kind: 'table' }>, runtime: Runtime): string {
	const values = node.diagonalBorders.map(border => {
		const { sourcePartFingerprint: _sourcePartFingerprint, sourceSemanticPath: _sourceSemanticPath, ...lexical } = border;
		return lexical;
	});
	return canonicalValue(values, runtime);
}

function locatorForStory(story: ParadisWordStory): string {
	return `story:${story.address.kind}:${story.address.partUri}:${story.address.noteId ?? story.address.commentId ?? story.address.ordinal}`;
}

function styleSources(definition: ParadisWordStyleModel['styles'] extends ReadonlyMap<string, infer T> ? T : never): string[] {
	const result = new Set<string>();
	for (const scope of [definition.paragraph, definition.run, definition.table, definition.numbering]) {
		for (const property of Object.values(scope)) {
			result.add(property.provenance.partUri);
		}
	}
	return [...result].sort();
}

function canonicalMap(map: ReadonlyMap<string, string>, runtime: Runtime): string {
	const entries = [...map.entries()];
	checkpoint(runtime, true);
	entries.sort((left, right) => left[0].localeCompare(right[0]));
	checkpoint(runtime, true);
	const result: string[] = [];
	for (const [key, value] of entries) {
		checkpoint(runtime);
		result.push(`${key}=${value}`);
	}
	return result.join('|');
}

function imageSources(
	original: ParadisWordObjectModel['images'][number] | undefined,
	modified: ParadisWordObjectModel['images'][number] | undefined,
): string[] {
	const parts = [...modelSources(original, modified)];
	if (original?.content.kind === 'embedded') { parts.push(original.content.source.partUri); }
	if (modified?.content.kind === 'embedded') { parts.push(modified.content.source.partUri); }
	return parts;
}

function modelSources<T extends { readonly source: { readonly partUri: string } }>(original: T | undefined, modified: T | undefined): string[] {
	return [original?.source.partUri, modified?.source.partUri].filter(isString);
}

function uniqueMap<T>(values: readonly T[], keyOf: (value: T) => string): ReadonlyMap<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		const key = keyOf(value);
		if (result.has(key)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.set(key, value);
	}
	return result;
}

function defaultComparison(left: string | undefined, right: string | undefined): number {
	return (left ?? '').localeCompare(right ?? '');
}

function compareChanges(left: ParadisOfficeChange, right: ParadisOfficeChange): number {
	return defaultComparison(left.subject.locator, right.subject.locator)
		|| defaultComparison(left.subject.kind, right.subject.kind)
		|| defaultComparison(left.category, right.category)
		|| defaultComparison(JSON.stringify(left.before), JSON.stringify(right.before))
		|| defaultComparison(JSON.stringify(left.after), JSON.stringify(right.after));
}

function cursorRevision(
	original: OwnedSnapshot, modified: OwnedSnapshot, filtered: readonly ParadisOfficeChange[], options: OwnedOptions, runtime: Runtime,
): string {
	const values = [
		`categories:${options.categories ? [...options.categories].sort().join(',') : '*'}`,
		`pageSize:${options.pageSize}`,
		`sources:${snapshotRevision(original, runtime)}:${snapshotRevision(modified, runtime)}`,
	];
	for (const change of filtered) {
		checkpoint(runtime);
		values.push(JSON.stringify({
			id: change.id,
			category: change.category,
			subject: change.subject,
			before: change.before,
			after: change.after,
			certainty: change.certainty,
			sourceParts: change.sourceParts,
			navigableAnchor: change.navigableAnchor,
		}));
	}
	return hashText(values.join('|'), runtime);
}

function snapshotRevision(snapshot: OwnedSnapshot, runtime: Runtime): string {
	const values = [
		snapshot.document.documentSource.partFingerprint.value,
		JSON.stringify(snapshot.packageCompleteness),
	];
	for (const story of snapshot.document.stories) {
		checkpoint(runtime);
		values.push(`${story.address.partUri}:${story.source.partFingerprint.value}`);
	}
	for (const fact of snapshot.packageFacts) {
		checkpoint(runtime);
		values.push(`${fact.kind}:${fact.id}:${fact.fingerprint.value}:${fact.fingerprint.byteLength}`);
	}
	return hashText(values.join('|'), runtime);
}

function parseCursor(cursor: string | undefined, revision: string, length: number): number {
	if (!cursor) {
		return 0;
	}
	const match = /^word:(\d+):([a-f\d]{16})$/.exec(cursor);
	if (!match || match[2] !== revision) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const offset = Number(match[1]);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset >= length) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return offset;
}

function hashText(value: string, runtime?: Runtime): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < value.length; index++) {
		if (runtime && index % 4_096 === 0) { checkpoint(runtime, true); }
		const code = value.charCodeAt(index);
		first ^= code;
		first = Math.imul(first, 0x01000193) >>> 0;
		second ^= code + index;
		second = Math.imul(second, 0x85ebca6b) >>> 0;
	}
	return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}

function checkpoint(runtime: Runtime, force = false): void {
	if (!force && ++runtime.checks % 64 !== 0) {
		return;
	}
	throwIfParadisOfficeCancelled(runtime.options.cancellationToken);
	const current = readClock(runtime.options.now);
	if (current < runtime.started || current - runtime.started > runtime.options.deadlineMilliseconds || runtime.hardDeadline.elapsed() > runtime.options.deadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
}

function readClock(now: () => number): number {
	let value: number;
	try {
		value = now();
	} catch {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (!Number.isFinite(value) || value < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

function chargeCharacters(characters: number, runtime: Runtime): void {
	runtime.valueCharacters = safeAdd(runtime.valueCharacters, characters);
	if (runtime.valueCharacters > runtime.options.limits.valueCharacters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
}

function safeAdd(left: number, right: number): number {
	const value = left + right;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return value;
}

function isDocument(value: ParadisWordDocument | ParadisWordSemanticSnapshot): value is ParadisWordDocument {
	return Array.isArray((value as ParadisWordDocument)?.stories);
}

function isFingerprint(value: string | boolean | null | ParadisOfficeFingerprint | object | undefined): value is ParadisOfficeFingerprint {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Partial<ParadisOfficeFingerprint>;
	return candidate.algorithm === 'sha256' && typeof candidate.value === 'string' && /^[a-f\d]{64}$/i.test(candidate.value)
		&& typeof candidate.byteLength === 'number' && Number.isSafeInteger(candidate.byteLength) && candidate.byteLength >= 0;
}

function isString(value: string | undefined): value is string {
	return typeof value === 'string' && value.length > 0;
}
