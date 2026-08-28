/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { GraphemeIterator } from '../../../../../base/common/strings.js';
import { ParadisOfficePackageError, throwIfParadisOfficeCancelled } from '../office/paradisOfficeArchive.js';
import type { ParadisWordDocument, ParadisWordNode, ParadisWordStory } from './paradisWordSemantic.js';

export type ParadisWordAlignmentCertainty = 'exact' | 'normalized' | 'heuristic' | 'ambiguous' | 'degraded';
export type ParadisWordAlignmentStatus = 'aligned' | 'moved' | 'added' | 'removed';

export interface ParadisWordTreeAlignLimits {
	readonly stories: number;
	readonly nodes: number;
	readonly storyBlockCandidates: number;
	readonly alignmentRegionPairs: number;
	readonly paragraphGraphemes: number;
	readonly graphemeDiffCells: number;
}

export interface ParadisWordTreeAlignOptions {
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<ParadisWordTreeAlignLimits>;
}

export interface ParadisWordNodeAlignment {
	readonly originalNodeId?: string;
	readonly modifiedNodeId?: string;
	readonly originalParentNodeId?: string;
	readonly modifiedParentNodeId?: string;
	readonly originalIndex?: number;
	readonly modifiedIndex?: number;
	readonly nodeKind: ParadisWordNode['kind'];
	readonly status: ParadisWordAlignmentStatus;
	readonly certainty: ParadisWordAlignmentCertainty;
}

export interface ParadisWordStoryAlignment {
	readonly originalStoryId?: string;
	readonly modifiedStoryId?: string;
	readonly originalIndex?: number;
	readonly modifiedIndex?: number;
	readonly storyKind: ParadisWordStory['address']['kind'];
	readonly status: ParadisWordAlignmentStatus;
	readonly certainty: ParadisWordAlignmentCertainty;
	readonly nodes: readonly ParadisWordNodeAlignment[];
}

export interface ParadisWordDocumentAlignment {
	readonly stories: readonly ParadisWordStoryAlignment[];
	readonly outcome: 'complete' | 'degraded';
	readonly warnings: readonly { readonly code: 'candidateBudget'; readonly storyId: string; readonly parentNodeId?: string }[];
}

export interface ParadisWordGraphemeDiffSegment {
	readonly kind: 'equal' | 'removed' | 'added';
	readonly text: string;
	readonly originalStart: number;
	readonly originalLength: number;
	readonly modifiedStart: number;
	readonly modifiedLength: number;
}

const maximumDeadlineMilliseconds = 60_000;
const maximumLimits: ParadisWordTreeAlignLimits = Object.freeze({
	stories: 10_000,
	nodes: 1_000_000,
	storyBlockCandidates: 250_000,
	alignmentRegionPairs: 50_000,
	paragraphGraphemes: 100_000,
	graphemeDiffCells: 4_000_000,
});
const limitKeys = new Set<keyof ParadisWordTreeAlignLimits>([
	'stories', 'nodes', 'storyBlockCandidates', 'alignmentRegionPairs', 'paragraphGraphemes', 'graphemeDiffCells',
]);

interface Runtime {
	readonly token?: CancellationToken;
	readonly now: () => number;
	readonly started: number;
	readonly deadlineMilliseconds: number;
	readonly hardDeadline: StopWatch;
	readonly limits: ParadisWordTreeAlignLimits;
	checks: number;
	candidates: number;
	degraded: boolean;
	readonly warnings: { code: 'candidateBudget'; storyId: string; parentNodeId?: string }[];
}

interface IndexedNode {
	readonly node: ParadisWordNode;
	readonly index: number;
	readonly stableKey: string;
	readonly normalizedText: string;
	readonly structure: string;
}

interface NodePair {
	readonly original: number;
	readonly modified: number;
	readonly certainty: ParadisWordAlignmentCertainty;
	readonly moved?: boolean;
}

interface StoryPair {
	readonly original?: number;
	readonly modified?: number;
	readonly certainty: ParadisWordAlignmentCertainty;
}

interface Region {
	readonly originalStart: number;
	readonly originalEnd: number;
	readonly modifiedStart: number;
	readonly modifiedEnd: number;
}

/** Aligns Word Stories and descendants without crossing Section or container ownership boundaries. */
export function alignParadisWordDocuments(
	original: ParadisWordDocument,
	modified: ParadisWordDocument,
	options: ParadisWordTreeAlignOptions = {},
): ParadisWordDocumentAlignment {
	try {
		const runtime = createRuntime(options);
		checkpoint(runtime, true);
		validateDocument(original, runtime);
		validateDocument(modified, runtime);
		const storyPairs = matchStories(original.stories, modified.stories, runtime);
		const stories: ParadisWordStoryAlignment[] = [];
		for (const pair of storyPairs) {
			checkpoint(runtime);
			const oldStory = pair.original === undefined ? undefined : original.stories[pair.original];
			const newStory = pair.modified === undefined ? undefined : modified.stories[pair.modified];
			const story = oldStory ?? newStory!;
			if (!oldStory || !newStory) {
				stories.push(Object.freeze({
					...(oldStory ? { originalStoryId: oldStory.id, originalIndex: pair.original } : {}),
					...(newStory ? { modifiedStoryId: newStory.id, modifiedIndex: pair.modified } : {}),
					storyKind: story.address.kind,
					status: oldStory ? 'removed' : 'added', certainty: pair.certainty, nodes: Object.freeze([]),
				}));
				continue;
			}
			const nodes: ParadisWordNodeAlignment[] = [];
			runtime.candidates = 0;
			alignChildren(oldStory.nodes, newStory.nodes, undefined, undefined, newStory.id, runtime, nodes);
			stories.push(Object.freeze({
				originalStoryId: oldStory.id, modifiedStoryId: newStory.id,
				originalIndex: pair.original, modifiedIndex: pair.modified,
				storyKind: newStory.address.kind, status: pair.original === pair.modified ? 'aligned' : 'moved',
				certainty: pair.certainty, nodes: Object.freeze(nodes),
			}));
		}
		checkpoint(runtime, true);
		return Object.freeze({
			stories: Object.freeze(stories),
			outcome: runtime.degraded ? 'degraded' : 'complete',
			warnings: Object.freeze(runtime.warnings.map(warning => Object.freeze({ ...warning }))),
		});
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('unsafe');
	}
}

/** Splits and diffs text by extended grapheme clusters. Budget overflow is explicit. */
export function diffParadisWordGraphemes(
	original: string,
	modified: string,
	options: ParadisWordTreeAlignOptions = {},
): readonly ParadisWordGraphemeDiffSegment[] {
	try {
		if (typeof original !== 'string' || typeof modified !== 'string') {
			throw new ParadisOfficePackageError('unsafe');
		}
		const runtime = createRuntime(options);
		checkpoint(runtime, true);
		const oldGraphemes = graphemes(original, runtime);
		const newGraphemes = graphemes(modified, runtime);
		if (oldGraphemes.length > runtime.limits.paragraphGraphemes || newGraphemes.length > runtime.limits.paragraphGraphemes
			|| exceedsProduct(oldGraphemes.length, newGraphemes.length, runtime.limits.graphemeDiffCells)) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const pairs = boundedMyersPairs(oldGraphemes, newGraphemes, runtime, runtime.limits.graphemeDiffCells);
		if (!pairs) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		return Object.freeze(graphemeSegments(oldGraphemes, newGraphemes, pairs));
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('unsafe');
	}
}

function matchStories(original: readonly ParadisWordStory[], modified: readonly ParadisWordStory[], runtime: Runtime): readonly StoryPair[] {
	const unmatchedOriginal = new Set(original.map((_story, index) => index));
	const unmatchedModified = new Set(modified.map((_story, index) => index));
	const pairs: StoryPair[] = [];
	matchUniqueStories(original, modified, unmatchedOriginal, unmatchedModified, storyAddressKey, 'exact', runtime, pairs);
	matchUniqueStories(original, modified, unmatchedOriginal, unmatchedModified, storyContentKey, 'normalized', runtime, pairs);
	for (const index of unmatchedOriginal) {
		pairs.push({ original: index, certainty: 'ambiguous' });
	}
	for (const index of unmatchedModified) {
		pairs.push({ modified: index, certainty: 'ambiguous' });
	}
	pairs.sort((left, right) => (left.modified ?? Number.MAX_SAFE_INTEGER) - (right.modified ?? Number.MAX_SAFE_INTEGER)
		|| (left.original ?? Number.MAX_SAFE_INTEGER) - (right.original ?? Number.MAX_SAFE_INTEGER));
	return pairs;
}

function matchUniqueStories(
	original: readonly ParadisWordStory[], modified: readonly ParadisWordStory[],
	unmatchedOriginal: Set<number>, unmatchedModified: Set<number>, keyOf: (story: ParadisWordStory) => string,
	certainty: ParadisWordAlignmentCertainty, runtime: Runtime, pairs: StoryPair[],
): void {
	const originalKeys = indexKeys(unmatchedOriginal, index => keyOf(original[index]), runtime);
	const modifiedKeys = indexKeys(unmatchedModified, index => keyOf(modified[index]), runtime);
	for (const [key, originalIndexes] of originalKeys) {
		checkpoint(runtime);
		const modifiedIndexes = modifiedKeys.get(key);
		if (originalIndexes.length !== 1 || modifiedIndexes?.length !== 1) {
			continue;
		}
		const originalIndex = originalIndexes[0];
		const modifiedIndex = modifiedIndexes[0];
		unmatchedOriginal.delete(originalIndex);
		unmatchedModified.delete(modifiedIndex);
		pairs.push({ original: originalIndex, modified: modifiedIndex, certainty });
	}
}

function storyAddressKey(story: ParadisWordStory): string {
	const address = story.address;
	return [address.kind, address.partUri, address.noteId ?? '', address.commentId ?? '', address.parentStoryId ?? '', address.parentNodeId ?? '', [...(address.roles ?? [])].sort().join(',')].join('\u001F');
}

function storyContentKey(story: ParadisWordStory): string {
	const address = story.address;
	return [address.kind, address.noteId ?? '', address.commentId ?? '', [...(address.roles ?? [])].sort().join(','), normalizeText(story.text)].join('\u001F');
}

function alignChildren(
	originalNodes: readonly ParadisWordNode[], modifiedNodes: readonly ParadisWordNode[],
	originalParentNodeId: string | undefined, modifiedParentNodeId: string | undefined,
	storyId: string, runtime: Runtime, result: ParadisWordNodeAlignment[],
): void {
	checkpoint(runtime);
	const original = originalNodes.map((node, index) => indexedNode(node, index, runtime));
	const modified = modifiedNodes.map((node, index) => indexedNode(node, index, runtime));
	const originalCounts = counts(original.map(value => value.stableKey));
	const modifiedCounts = counts(modified.map(value => value.stableKey));
	const duplicateKeys = new Set<string>();
	for (const [key, count] of originalCounts) {
		const modifiedCount = modifiedCounts.get(key) ?? 0;
		if (modifiedCount > 0 && (count > 1 || modifiedCount > 1)) {
			duplicateKeys.add(key);
		}
	}

	const uniqueModified = new Map<string, number>();
	for (let index = 0; index < modified.length; index++) {
		const key = modified[index].stableKey;
		if (modifiedCounts.get(key) === 1) {
			uniqueModified.set(key, index);
		}
	}
	const candidates: { original: number; modified: number }[] = [];
	for (let index = 0; index < original.length; index++) {
		const key = original[index].stableKey;
		if (originalCounts.get(key) === 1) {
			const modifiedIndex = uniqueModified.get(key);
			if (modifiedIndex !== undefined) {
				if (runtime.candidates >= runtime.limits.storyBlockCandidates) {
					degrade(runtime, storyId, modifiedParentNodeId);
					continue;
				}
				runtime.candidates++;
				candidates.push({ original: index, modified: modifiedIndex });
			}
		}
	}
	const anchors = patienceAnchors(candidates, runtime);
	const pairs: NodePair[] = anchors.map(anchor => ({ ...anchor, certainty: 'exact' }));
	const pairedOriginal = new Set(pairs.map(pair => pair.original));
	const pairedModified = new Set(pairs.map(pair => pair.modified));

	const regions = anchorRegions(anchors, original.length, modified.length);
	for (const region of regions) {
		alignRegion(original, modified, region, duplicateKeys, pairedOriginal, pairedModified, pairs, storyId, modifiedParentNodeId, runtime);
	}

	// A unique normalized node outside the monotonic chain is a move inside this exact parent only.
	const originalMoveKeys = counts(original.map(value => moveKey(value)));
	const modifiedMoveKeys = counts(modified.map(value => moveKey(value)));
	const modifiedMoveIndex = new Map<string, number>();
	for (let index = 0; index < modified.length; index++) {
		const key = moveKey(modified[index]);
		if (modifiedMoveKeys.get(key) === 1) {
			modifiedMoveIndex.set(key, index);
		}
	}
	for (let index = 0; index < original.length; index++) {
		if (pairedOriginal.has(index)) {
			continue;
		}
		if (original[index].node.kind !== 'paragraph') {
			continue;
		}
		const key = moveKey(original[index]);
		if (originalMoveKeys.get(key) !== 1 || modifiedMoveKeys.get(key) !== 1) {
			continue;
		}
		const modifiedIndex = modifiedMoveIndex.get(key);
		if (modifiedIndex !== undefined && !pairedModified.has(modifiedIndex)) {
			pairs.push({ original: index, modified: modifiedIndex, certainty: 'normalized', moved: true });
			pairedOriginal.add(index);
			pairedModified.add(modifiedIndex);
		}
	}

	pairs.sort((left, right) => left.modified - right.modified || left.original - right.original);
	for (const pair of pairs) {
		const oldNode = original[pair.original].node;
		const newNode = modified[pair.modified].node;
		const entry: ParadisWordNodeAlignment = Object.freeze({
			originalNodeId: oldNode.id, modifiedNodeId: newNode.id,
			...(originalParentNodeId ? { originalParentNodeId } : {}),
			...(modifiedParentNodeId ? { modifiedParentNodeId } : {}),
			originalIndex: pair.original, modifiedIndex: pair.modified, nodeKind: newNode.kind,
			status: pair.moved ? 'moved' : 'aligned', certainty: pair.certainty,
		});
		result.push(entry);
		if (oldNode.children && newNode.children) {
			alignChildren(oldNode.children, newNode.children, oldNode.id, newNode.id, storyId, runtime, result);
		}
	}
	for (let index = 0; index < original.length; index++) {
		if (!pairedOriginal.has(index)) {
			const value = original[index];
			result.push(Object.freeze({
				originalNodeId: value.node.id, ...(originalParentNodeId ? { originalParentNodeId } : {}), originalIndex: index,
				nodeKind: value.node.kind, status: 'removed', certainty: unmatchedCertainty(value, duplicateKeys, runtime),
			}));
		}
	}
	for (let index = 0; index < modified.length; index++) {
		if (!pairedModified.has(index)) {
			const value = modified[index];
			result.push(Object.freeze({
				modifiedNodeId: value.node.id, ...(modifiedParentNodeId ? { modifiedParentNodeId } : {}), modifiedIndex: index,
				nodeKind: value.node.kind, status: 'added', certainty: unmatchedCertainty(value, duplicateKeys, runtime),
			}));
		}
	}
}

function alignRegion(
	original: readonly IndexedNode[], modified: readonly IndexedNode[], region: Region, duplicateKeys: ReadonlySet<string>,
	pairedOriginal: Set<number>, pairedModified: Set<number>, pairs: NodePair[], storyId: string, parentNodeId: string | undefined, runtime: Runtime,
): void {
	const originalIndexes = indexes(region.originalStart, region.originalEnd).filter(index => !pairedOriginal.has(index));
	const modifiedIndexes = indexes(region.modifiedStart, region.modifiedEnd).filter(index => !pairedModified.has(index));
	if (originalIndexes.length === 0 || modifiedIndexes.length === 0) {
		return;
	}
	const candidatePairs = originalIndexes.length * modifiedIndexes.length;
	if (exceedsProduct(originalIndexes.length, modifiedIndexes.length, runtime.limits.alignmentRegionPairs)
		|| runtime.candidates + candidatePairs > runtime.limits.storyBlockCandidates) {
		degrade(runtime, storyId, parentNodeId);
		return;
	}
	runtime.candidates += candidatePairs;

	const originalTokens = regionTokens(original, originalIndexes, duplicateKeys, 'original');
	const modifiedTokens = regionTokens(modified, modifiedIndexes, duplicateKeys, 'modified');
	const exactPairs = boundedMyersPairs(originalTokens, modifiedTokens, runtime, runtime.limits.alignmentRegionPairs);
	for (const pair of exactPairs ?? []) {
		const originalIndex = originalIndexes[pair.original];
		const modifiedIndex = modifiedIndexes[pair.modified];
		if (!pairedOriginal.has(originalIndex) && !pairedModified.has(modifiedIndex)) {
			pairs.push({ original: originalIndex, modified: modifiedIndex, certainty: 'exact' });
			pairedOriginal.add(originalIndex);
			pairedModified.add(modifiedIndex);
		}
	}

	const remainingOriginal = originalIndexes.filter(index => !pairedOriginal.has(index)
		&& (!duplicateKeys.has(original[index].stableKey) || isStrictContainer(original[index].node)));
	const remainingModified = modifiedIndexes.filter(index => !pairedModified.has(index)
		&& (!duplicateKeys.has(modified[index].stableKey) || isStrictContainer(modified[index].node)));
	if (remainingOriginal.length === 1 && remainingModified.length === 1
		&& original[remainingOriginal[0]].node.kind === modified[remainingModified[0]].node.kind) {
		pairs.push({ original: remainingOriginal[0], modified: remainingModified[0], certainty: 'heuristic' });
		pairedOriginal.add(remainingOriginal[0]);
		pairedModified.add(remainingModified[0]);
		return;
	}

	// Mutual unique best candidate. Rank order is normative: relative distance, structure, then neighboring anchors.
	const originalBest = uniqueBest(remainingOriginal, remainingModified, (oldIndex, newIndex) => candidateRank(oldIndex, newIndex, original, modified, pairedOriginal, pairedModified));
	const modifiedBest = uniqueBest(remainingModified, remainingOriginal, (newIndex, oldIndex) => candidateRank(oldIndex, newIndex, original, modified, pairedOriginal, pairedModified));
	for (const [oldIndex, newIndex] of originalBest) {
		if (modifiedBest.get(newIndex) === oldIndex && original[oldIndex].node.kind === modified[newIndex].node.kind
			&& !pairedOriginal.has(oldIndex) && !pairedModified.has(newIndex)) {
			pairs.push({ original: oldIndex, modified: newIndex, certainty: 'heuristic' });
			pairedOriginal.add(oldIndex);
			pairedModified.add(newIndex);
		}
	}
}

function regionTokens(items: readonly IndexedNode[], itemIndexes: readonly number[], duplicateKeys: ReadonlySet<string>, side: 'original' | 'modified'): string[] {
	return itemIndexes.map(index => duplicateKeys.has(items[index].stableKey) ? `${side}:${index}` : items[index].stableKey);
}

function candidateRank(
	originalIndex: number, modifiedIndex: number, original: readonly IndexedNode[], modified: readonly IndexedNode[],
	pairedOriginal: ReadonlySet<number>, pairedModified: ReadonlySet<number>,
): readonly number[] {
	if (original[originalIndex].node.kind !== modified[modifiedIndex].node.kind) {
		return [Number.MAX_SAFE_INTEGER, 1, 0];
	}
	if (isStrictContainer(original[originalIndex].node) && original[originalIndex].structure !== modified[modifiedIndex].structure) {
		return [Number.MAX_SAFE_INTEGER, 1, 0];
	}
	const originalScale = Math.max(1, original.length - 1);
	const modifiedScale = Math.max(1, modified.length - 1);
	const relativeDistance = Math.abs(originalIndex * modifiedScale - modifiedIndex * originalScale);
	const structureMismatch = original[originalIndex].structure === modified[modifiedIndex].structure ? 0 : 1;
	let adjacentAnchors = 0;
	for (const direction of [-1, 1]) {
		const oldNeighbor = originalIndex + direction;
		const newNeighbor = modifiedIndex + direction;
		if (oldNeighbor >= 0 && oldNeighbor < original.length && newNeighbor >= 0 && newNeighbor < modified.length
			&& pairedOriginal.has(oldNeighbor) && pairedModified.has(newNeighbor)
			&& original[oldNeighbor].stableKey === modified[newNeighbor].stableKey) {
			adjacentAnchors++;
		}
	}
	return [relativeDistance, structureMismatch, -adjacentAnchors];
}

function uniqueBest(
	from: readonly number[], to: readonly number[], rank: (fromIndex: number, toIndex: number) => readonly number[],
): ReadonlyMap<number, number> {
	const result = new Map<number, number>();
	for (const fromIndex of from) {
		let best: number | undefined;
		let bestRank: readonly number[] | undefined;
		let tied = false;
		for (const toIndex of to) {
			const candidateRank = rank(fromIndex, toIndex);
			const comparison = bestRank ? compareRank(candidateRank, bestRank) : -1;
			if (comparison < 0) {
				best = toIndex;
				bestRank = candidateRank;
				tied = false;
			} else if (comparison === 0) {
				tied = true;
			}
		}
		if (best !== undefined && !tied && bestRank?.[0] !== Number.MAX_SAFE_INTEGER) {
			result.set(fromIndex, best);
		}
	}
	return result;
}

function compareRank(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) {
			return left[index] - right[index];
		}
	}
	return 0;
}

function patienceAnchors(candidates: readonly { readonly original: number; readonly modified: number }[], runtime: Runtime): readonly { readonly original: number; readonly modified: number }[] {
	if (candidates.length === 0) {
		return [];
	}
	const tails: number[] = [];
	const previous = new Int32Array(candidates.length);
	previous.fill(-1);
	for (let index = 0; index < candidates.length; index++) {
		checkpoint(runtime);
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (candidates[tails[middle]].modified < candidates[index].modified) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		if (low > 0) {
			previous[index] = tails[low - 1];
		}
		tails[low] = index;
	}
	const result: { original: number; modified: number }[] = [];
	for (let index = tails[tails.length - 1]; index >= 0; index = previous[index]) {
		result.push(candidates[index]);
	}
	return result.reverse();
}

function boundedMyersPairs(
	original: readonly string[], modified: readonly string[], runtime: Runtime, budget: number,
): readonly { readonly original: number; readonly modified: number }[] | undefined {
	const maximum = original.length + modified.length;
	if (maximum === 0) {
		return [];
	}
	const offset = maximum + 1;
	let frontier = new Int32Array(maximum * 2 + 3);
	frontier.fill(-1);
	frontier[offset + 1] = 0;
	const trace: Int32Array[] = [];
	let work = 0;
	for (let distance = 0; distance <= maximum; distance++) {
		checkpoint(runtime);
		if (work + distance * 2 + 1 > budget + maximum) {
			return undefined;
		}
		trace.push(frontier.slice());
		const next = frontier.slice();
		for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
			work++;
			const index = offset + diagonal;
			let x: number;
			if (diagonal === -distance || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])) {
				x = frontier[index + 1];
			} else {
				x = frontier[index - 1] + 1;
			}
			let y = x - diagonal;
			while (x < original.length && y < modified.length && x >= 0 && y >= 0 && original[x] === modified[y]) {
				x++;
				y++;
			}
			next[index] = x;
			if (x >= original.length && y >= modified.length) {
				return backtrackMyers(trace, original.length, modified.length, offset);
			}
		}
		frontier = next;
	}
	return undefined;
}

function backtrackMyers(trace: readonly Int32Array[], originalLength: number, modifiedLength: number, offset: number): readonly { readonly original: number; readonly modified: number }[] {
	let x = originalLength;
	let y = modifiedLength;
	const pairs: { original: number; modified: number }[] = [];
	for (let distance = trace.length - 1; distance >= 0; distance--) {
		const frontier = trace[distance];
		const diagonal = x - y;
		const previousDiagonal = diagonal === -distance || (diagonal !== distance && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])
			? diagonal + 1
			: diagonal - 1;
		const previousX = Math.max(0, frontier[offset + previousDiagonal]);
		const previousY = previousX - previousDiagonal;
		while (x > previousX && y > previousY) {
			pairs.push({ original: x - 1, modified: y - 1 });
			x--;
			y--;
		}
		x = previousX;
		y = previousY;
	}
	return pairs.reverse();
}

function graphemeSegments(
	original: readonly string[], modified: readonly string[], pairs: readonly { readonly original: number; readonly modified: number }[],
): ParadisWordGraphemeDiffSegment[] {
	const result: ParadisWordGraphemeDiffSegment[] = [];
	let originalIndex = 0;
	let modifiedIndex = 0;
	const push = (kind: ParadisWordGraphemeDiffSegment['kind'], oldStart: number, oldEnd: number, newStart: number, newEnd: number, values: readonly string[]): void => {
		if (values.length === 0) {
			return;
		}
		const previous = result[result.length - 1];
		if (previous?.kind === kind && previous.originalStart + previous.originalLength === oldStart && previous.modifiedStart + previous.modifiedLength === newStart) {
			result[result.length - 1] = Object.freeze({
				kind, text: previous.text + values.join(''), originalStart: previous.originalStart,
				originalLength: oldEnd - previous.originalStart, modifiedStart: previous.modifiedStart,
				modifiedLength: newEnd - previous.modifiedStart,
			});
			return;
		}
		result.push(Object.freeze({ kind, text: values.join(''), originalStart: oldStart, originalLength: oldEnd - oldStart, modifiedStart: newStart, modifiedLength: newEnd - newStart }));
	};
	for (const pair of pairs) {
		push('removed', originalIndex, pair.original, modifiedIndex, modifiedIndex, original.slice(originalIndex, pair.original));
		push('added', pair.original, pair.original, modifiedIndex, pair.modified, modified.slice(modifiedIndex, pair.modified));
		push('equal', pair.original, pair.original + 1, pair.modified, pair.modified + 1, [original[pair.original]]);
		originalIndex = pair.original + 1;
		modifiedIndex = pair.modified + 1;
	}
	push('removed', originalIndex, original.length, modifiedIndex, modifiedIndex, original.slice(originalIndex));
	push('added', original.length, original.length, modifiedIndex, modified.length, modified.slice(modifiedIndex));
	return result;
}

function indexedNode(node: ParadisWordNode, index: number, runtime: Runtime): IndexedNode {
	const normalizedText = node.kind === 'section' ? normalizeText(nodeText(node, runtime)) : isStrictContainer(node) ? '' : normalizeText(nodeText(node, runtime));
	const structure = structureSignature(node, runtime);
	return { node, index, normalizedText, structure, stableKey: `${node.kind}\u001F${normalizedText}\u001F${semanticIdentity(node, runtime)}\u001F${structure}` };
}

function semanticIdentity(node: ParadisWordNode, runtime: Runtime): string {
	switch (node.kind) {
		case 'section': return '';
		case 'table': return '';
		case 'row': return '';
		case 'cell': return '';
		case 'field': return `${node.fieldKind}|${normalizeText(node.savedResult)}`;
		case 'revision': return `${node.revisionKind}|${normalizeText(nodeText(node, runtime))}`;
		case 'image': return `${node.external}|${node.targetPartUri ?? ''}`;
		case 'noteReference': return `${node.noteKind}|${node.noteId}`;
		case 'commentReference': return `${node.boundary}|${node.commentId}`;
		case 'bookmark': return `${node.boundary}|${node.bookmarkId}|${node.name ?? ''}`;
		case 'hyperlink': return `${node.anchorName ?? ''}|${node.external}`;
		case 'break': return node.breakType;
		case 'symbol': return `${node.font ?? ''}|${node.character ?? ''}`;
		case 'contentControl': return `${node.alias ?? ''}|${node.tag ?? ''}|${node.lock ?? ''}`;
		case 'altChunk': return `${node.targetPartUri ?? ''}|${node.contentType ?? ''}`;
		case 'unknownBlock': return `${node.name.namespace}|${node.name.local}`;
		default: return '';
	}
}

function moveKey(value: IndexedNode): string {
	return `${value.node.kind}\u001F${value.normalizedText}\u001F${value.structure}`;
}

function isStrictContainer(node: ParadisWordNode): boolean {
	return node.kind === 'section' || node.kind === 'table' || node.kind === 'row' || node.kind === 'cell';
}

function structureSignature(node: ParadisWordNode, runtime: Runtime): string {
	const children = node.children ?? [];
	const values: string[] = [];
	for (const child of children) {
		checkpoint(runtime);
		if (node.kind === 'table' || node.kind === 'row') {
			values.push(`${child.kind}:${child.children?.length ?? 0}`);
		} else if (node.kind === 'cell' || node.kind === 'section') {
			values.push(child.kind);
		} else {
			values.push(child.kind);
		}
	}
	return `${node.kind}[${values.join(',')}]`;
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

function normalizeText(value: string): string {
	return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function validateDocument(document: ParadisWordDocument, runtime: Runtime): void {
	if (!document || !Array.isArray(document.stories) || document.stories.length > runtime.limits.stories || !Array.isArray(document.storyReferences)) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const storyIds = new Set<string>();
	const nodeIds = new Set<string>();
	let nodes = 0;
	for (const story of document.stories) {
		checkpoint(runtime);
		if (!story || typeof story.id !== 'string' || !story.id || storyIds.has(story.id) || !Array.isArray(story.nodes)
			|| typeof story.text !== 'string' || typeof story.address?.kind !== 'string' || typeof story.address.partUri !== 'string') {
			throw new ParadisOfficePackageError('unsafe');
		}
		storyIds.add(story.id);
		const stack = [...story.nodes];
		while (stack.length > 0) {
			checkpoint(runtime);
			const node = stack.pop()!;
			if (!node || typeof node.id !== 'string' || !node.id || nodeIds.has(node.id) || typeof node.kind !== 'string') {
				throw new ParadisOfficePackageError('unsafe');
			}
			nodeIds.add(node.id);
			if (++nodes > runtime.limits.nodes) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			if (node.children) {
				if (!Array.isArray(node.children)) {
					throw new ParadisOfficePackageError('unsafe');
				}
				stack.push(...node.children);
			}
		}
	}
}

function createRuntime(options: ParadisWordTreeAlignOptions): Runtime {
	const now = options.now ?? Date.now;
	const deadlineMilliseconds = options.deadlineMilliseconds ?? maximumDeadlineMilliseconds;
	if (typeof now !== 'function' || !Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds < 0 || deadlineMilliseconds > maximumDeadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const limits = { ...maximumLimits };
	if (options.limits) {
		for (const key of Object.keys(options.limits)) {
			if (!limitKeys.has(key as keyof ParadisWordTreeAlignLimits)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const name = key as keyof ParadisWordTreeAlignLimits;
			const value = options.limits[name];
			if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximumLimits[name]) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			limits[name] = value as number;
		}
	}
	const started = readClock(now);
	return { token: options.cancellationToken, now, started, deadlineMilliseconds, hardDeadline: StopWatch.create(true), limits, checks: 0, candidates: 0, degraded: false, warnings: [] };
}

function checkpoint(runtime: Runtime, force = false): void {
	if (!force && ++runtime.checks % 64 !== 0) {
		return;
	}
	throwIfParadisOfficeCancelled(runtime.token);
	const current = readClock(runtime.now);
	if (current < runtime.started || current - runtime.started > runtime.deadlineMilliseconds || runtime.hardDeadline.elapsed() > runtime.deadlineMilliseconds) {
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

function degrade(runtime: Runtime, storyId: string, parentNodeId: string | undefined): void {
	runtime.degraded = true;
	if (!runtime.warnings.some(warning => warning.storyId === storyId && warning.parentNodeId === parentNodeId)) {
		runtime.warnings.push({ code: 'candidateBudget', storyId, ...(parentNodeId ? { parentNodeId } : {}) });
	}
}

function unmatchedCertainty(value: IndexedNode, duplicateKeys: ReadonlySet<string>, runtime: Runtime): ParadisWordAlignmentCertainty {
	if (duplicateKeys.has(value.stableKey)) {
		return 'ambiguous';
	}
	return runtime.degraded ? 'degraded' : 'exact';
}

function indexKeys(indexes: ReadonlySet<number>, keyOf: (index: number) => string, runtime: Runtime): Map<string, number[]> {
	const result = new Map<string, number[]>();
	for (const index of indexes) {
		checkpoint(runtime);
		const key = keyOf(index);
		const values = result.get(key);
		if (values) {
			values.push(index);
		} else {
			result.set(key, [index]);
		}
	}
	return result;
}

function counts(values: readonly string[]): Map<string, number> {
	const result = new Map<string, number>();
	for (const value of values) {
		result.set(value, (result.get(value) ?? 0) + 1);
	}
	return result;
}

function anchorRegions(anchors: readonly { readonly original: number; readonly modified: number }[], originalLength: number, modifiedLength: number): readonly Region[] {
	const result: Region[] = [];
	let originalStart = 0;
	let modifiedStart = 0;
	for (const anchor of anchors) {
		result.push({ originalStart, originalEnd: anchor.original, modifiedStart, modifiedEnd: anchor.modified });
		originalStart = anchor.original + 1;
		modifiedStart = anchor.modified + 1;
	}
	result.push({ originalStart, originalEnd: originalLength, modifiedStart, modifiedEnd: modifiedLength });
	return result;
}

function indexes(start: number, end: number): number[] {
	const result: number[] = [];
	for (let index = start; index < end; index++) {
		result.push(index);
	}
	return result;
}

function graphemes(value: string, runtime: Runtime): string[] {
	const result: string[] = [];
	const iterator = new GraphemeIterator(value);
	let offset = 0;
	while (offset < value.length) {
		checkpoint(runtime);
		const length = iterator.nextGraphemeLength();
		if (length <= 0) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.push(value.substring(offset, offset + length));
		offset += length;
		if (result.length > runtime.limits.paragraphGraphemes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}
	return result;
}

function exceedsProduct(left: number, right: number, limit: number): boolean {
	return left !== 0 && right > Math.floor(limit / left);
}
