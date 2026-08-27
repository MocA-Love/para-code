/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import type { ParadisWordFieldModel } from '../../common/word/paradisWordFields.js';
import type { ParadisWordObjectModel } from '../../common/word/paradisWordObjects.js';
import type {
	ParadisWordDocument,
	ParadisWordNode,
	ParadisWordParagraphNode,
	ParadisWordSectionNode,
	ParadisWordStory,
	ParadisWordStoryKind,
	ParadisWordTableNode,
} from '../../common/word/paradisWordSemantic.js';
import {
	compareWordSemantics,
	type ParadisWordPackageFact,
	type ParadisWordSemanticSnapshot,
} from '../../common/word/paradisWordSemanticDiff.js';
import { alignParadisWordDocuments, diffParadisWordGraphemes } from '../../common/word/paradisWordTreeAlign.js';

function fingerprint(seed: string, byteLength = 1): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: seed.repeat(64).slice(0, 64), byteLength };
}

function base(kind: ParadisWordNode['kind'], id: string, path: readonly number[], seed = id) {
	const partUri = '/word/document.xml';
	return {
		id,
		kind,
		source: { partUri, semanticPath: path, kind, ordinal: path.at(-1) ?? 0, fingerprint: `semantic:${seed}`, partFingerprint: fingerprint('a') },
		anchor: { partUri, semanticPath: path, kind, ordinal: path.at(-1) ?? 0, fingerprint: `semantic:${seed}` },
	};
}

function text(id: string, value: string, path: readonly number[]): ParadisWordNode {
	return { ...base('text', id, path, value), kind: 'text', text: value };
}

function field(id: string, instruction: string, result: string, path: readonly number[]): ParadisWordNode {
	return { ...base('field', id, path, `${instruction}|${result}`), kind: 'field', fieldKind: 'simple', instruction, savedResult: result, children: [] };
}

function omml(id: string, value: string, path: readonly number[], canonical: string): ParadisWordNode {
	return { ...base('omml', id, path, canonical), kind: 'omml', text: value };
}

function revision(id: string, value: string, path: readonly number[], author: string): ParadisWordNode {
	return { ...base('revision', id, path, `${author}|${value}`), kind: 'revision', revisionKind: 'inserted', revisionId: '1', author, children: [text(`${id}-text`, value, [...path, 0])] };
}

function paragraph(id: string, children: readonly ParadisWordNode[], path: readonly number[], formatSeed = id): ParadisWordParagraphNode {
	return { ...base('paragraph', id, path, formatSeed), kind: 'paragraph', children };
}

function paragraphText(id: string, value: string, path: readonly number[], formatSeed = id): ParadisWordParagraphNode {
	return paragraph(id, [text(`${id}-text`, value, [...path, 0])], path, formatSeed);
}

function table(id: string, paragraphs: readonly ParadisWordParagraphNode[], path: readonly number[], diagonalSeed = 'a'): ParadisWordTableNode {
	const cellPath = [...path, 0, 0];
	return {
		...base('table', id, path, id), kind: 'table',
		diagonalBorders: [{
			direction: 'topLeftToBottomRight', value: 'single', color: diagonalSeed,
			sourceSemanticPath: path, sourcePartFingerprint: fingerprint(diagonalSeed),
		}],
		children: [{
			...base('row', `${id}-row`, [...path, 0]), kind: 'row', children: [{
				...base('cell', `${id}-cell`, cellPath), kind: 'cell', children: paragraphs,
			}],
		}],
	};
}

function section(id: string, children: readonly ParadisWordNode[], ordinal = 0): ParadisWordSectionNode {
	return { ...base('section', id, [ordinal], id), kind: 'section', sectionOrdinal: ordinal, children };
}

interface StoryOptions {
	readonly kind?: ParadisWordStoryKind;
	readonly partUri?: string;
	readonly role?: 'default' | 'first' | 'even';
	readonly noteId?: string;
	readonly commentId?: string;
}

function story(id: string, nodes: readonly ParadisWordNode[], options: StoryOptions = {}): ParadisWordStory {
	const kind = options.kind ?? 'body';
	const partUri = options.partUri ?? '/word/document.xml';
	const storyText = nodes.map(nodeText).join('');
	return {
		id,
		address: {
			kind, partUri, ordinal: 0,
			...(options.role ? { roles: [options.role] } : {}),
			...(options.noteId ? { noteId: options.noteId } : {}),
			...(options.commentId ? { commentId: options.commentId } : {}),
		},
		source: { partUri, semanticPath: [], kind: 'story', ordinal: 0, fingerprint: `story:${storyText}`, partFingerprint: fingerprint('a') },
		anchor: { partUri, semanticPath: [], kind: 'story', ordinal: 0, fingerprint: `story:${storyText}` },
		nodes,
		text: storyText,
	};
}

function nodeText(node: ParadisWordNode): string {
	if (node.kind === 'text' || node.kind === 'omml') {
		return node.text;
	}
	if (node.kind === 'field') {
		return node.savedResult;
	}
	return node.children?.map(nodeText).join('') ?? '';
}

function document(stories: readonly ParadisWordStory[], references: ParadisWordDocument['storyReferences'] = []): ParadisWordDocument {
	const source = { partUri: '/word/document.xml', semanticPath: [], kind: 'story' as const, ordinal: 0, fingerprint: 'document', partFingerprint: fingerprint('a') };
	return {
		documentSource: source,
		contentTypesSource: { ...source, partUri: '/[Content_Types].xml' },
		rootRelationshipsSource: { ...source, partUri: '/_rels/.rels' },
		documentRelationshipsSource: { ...source, partUri: '/word/_rels/document.xml.rels' },
		stories,
		storyReferences: references,
		completeness: { expectedParts: 4, visitedParts: 4, parsedParts: 4, stories: stories.length, nodes: countNodes(stories), unknownBlocks: 0, unresolvedRelationships: 0, terminal: true },
	};
}

function countNodes(stories: readonly ParadisWordStory[]): number {
	const visit = (nodes: readonly ParadisWordNode[]): number => nodes.reduce((total, node) => total + 1 + visit(node.children ?? []), 0);
	return stories.reduce((total, value) => total + visit(value.nodes), 0);
}

function fact(kind: ParadisWordPackageFact['kind'], id: string, seed: string): ParadisWordPackageFact {
	return { kind, id, fingerprint: fingerprint(seed), sourceParts: [`/word/${kind}-${id}`] };
}

function completeSnapshot(value: ParadisWordDocument, extra: Omit<ParadisWordSemanticSnapshot, 'document' | 'packageCompleteness'> = {}): ParadisWordSemanticSnapshot {
	return {
		document: value,
		...extra,
		packageCompleteness: {
			expectedParts: value.completeness.expectedParts,
			visitedParts: value.completeness.visitedParts,
			parsedParts: value.completeness.parsedParts,
			opaqueParts: 0,
			failedParts: 0,
			omittedParts: 0,
			expectedSemanticUnits: value.completeness.nodes + value.completeness.stories,
			visitedSemanticUnits: value.completeness.nodes + value.completeness.stories,
			terminal: true,
		},
	};
}

function changesOf(result: ReturnType<typeof compareWordSemantics>, kind: string) {
	return result.changes.filter(change => change.subject.kind === kind);
}

suite('Paradis Word Semantic Diff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps duplicate paragraphs ambiguous and matches a moved paragraph before comparing its field', () => {
		const duplicateOriginal = document([story('body', [section('s0', [
			paragraphText('o0', 'same', [0, 0]), paragraphText('o1', 'same', [0, 1]),
		])])]);
		const duplicateModified = document([story('body', [section('s0-new', [
			paragraphText('m0', 'same', [0, 0]), paragraphText('m1', 'same', [0, 1]), paragraphText('m2', 'same', [0, 2]),
		])])]);
		const duplicates = alignParadisWordDocuments(duplicateOriginal, duplicateModified);
		const duplicateParagraphs = duplicates.stories.flatMap(value => value.nodes).filter(value => value.nodeKind === 'paragraph');
		strictEqual(duplicateParagraphs.some(value => value.originalNodeId && value.modifiedNodeId), false);
		strictEqual(duplicateParagraphs.every(value => value.certainty === 'ambiguous'), true);

		const original = document([story('body', [section('s0', [
			paragraph('target-o', [field('field-o', 'PAGE', '1', [0, 0, 0])], [0, 0]),
			paragraphText('anchor-a-o', 'anchor-a', [0, 1]), paragraphText('anchor-b-o', 'anchor-b', [0, 2]),
		])])]);
		const modified = document([story('body', [section('s0-new', [
			paragraphText('anchor-a-m', 'anchor-a', [0, 0]), paragraphText('anchor-b-m', 'anchor-b', [0, 1]),
			paragraph('target-m', [field('field-m', 'NUMPAGES', '1', [0, 2, 0])], [0, 2]),
		])])]);
		const moved = compareWordSemantics(
			{ document: original, nodeFormats: [{ nodeId: 'target-o', fingerprint: fingerprint('a'), sourceParts: ['/word/document.xml'] }] },
			{ document: modified, nodeFormats: [{ nodeId: 'target-m', fingerprint: fingerprint('b'), sourceParts: ['/word/document.xml'] }] },
		);
		ok(moved.alignments.stories.flatMap(value => value.nodes).some(value => value.originalNodeId === 'target-o' && value.modifiedNodeId === 'target-m' && value.status === 'moved'));
		strictEqual(changesOf(moved, 'field.instruction').length, 1);
		strictEqual(changesOf(moved, 'node.format').length, 1);
	});

	test('never aligns paragraphs across a table or between same-depth cells in different tables', () => {
		const original = document([story('body', [section('s0', [
			paragraphText('outside-o', 'outside', [0, 0]),
			table('table-a-o', [paragraphText('inside-a-o', 'crossing', [0, 1, 0, 0, 0])], [0, 1]),
			table('table-b-o', [paragraphText('inside-b-o', 'stable-b', [0, 2, 0, 0, 0])], [0, 2]),
		])])]);
		const modified = document([story('body', [section('s0-m', [
			paragraphText('outside-m', 'crossing', [0, 0]),
			table('table-a-m', [paragraphText('inside-a-m', 'outside', [0, 1, 0, 0, 0])], [0, 1]),
			table('table-b-m', [paragraphText('inside-b-m', 'crossing', [0, 2, 0, 0, 0])], [0, 2]),
		])])]);
		const entries = alignParadisWordDocuments(original, modified).stories.flatMap(value => value.nodes);
		strictEqual(entries.some(value => value.originalNodeId === 'inside-a-o' && value.modifiedNodeId === 'outside-m'), false);
		strictEqual(entries.some(value => value.originalNodeId === 'inside-a-o' && value.modifiedNodeId === 'inside-b-m'), false);
	});

	test('aligns edited duplicate-shaped tables and sections without crossing their owners', () => {
		const original = document([story('body', [
			section('section-a-o', [table('table-a-o', [paragraphText('a-o', 'old-a', [0, 0, 0, 0, 0])], [0, 0])], 0),
			section('section-b-o', [table('table-b-o', [paragraphText('b-o', 'stable-b', [1, 0, 0, 0, 0])], [1, 0])], 1),
		])]);
		const modified = document([story('body', [
			section('inserted', [paragraphText('inserted-p', 'inserted', [0, 0])], 0),
			section('section-a-m', [table('table-a-m', [paragraphText('a-m', 'new-a', [1, 0, 0, 0, 0])], [1, 0])], 1),
			section('section-b-m', [table('table-b-m', [paragraphText('b-m', 'stable-b', [2, 0, 0, 0, 0])], [2, 0])], 2),
		])]);
		const entries = alignParadisWordDocuments(original, modified).stories.flatMap(value => value.nodes);
		ok(entries.some(value => value.originalNodeId === 'section-a-o' && value.modifiedNodeId === 'section-a-m'));
		ok(entries.some(value => value.originalNodeId === 'table-a-o' && value.modifiedNodeId === 'table-a-m'));
		ok(entries.some(value => value.originalNodeId === 'table-b-o' && value.modifiedNodeId === 'table-b-m'));
		strictEqual(entries.some(value => value.originalNodeId === 'a-o' && value.modifiedNodeId === 'b-m'), false);
	});

	test('separates shared header content changes from reference switches and compares footnote text', () => {
		const originalHeader = story('header-o', [paragraphText('header-p-o', 'Old header', [0])], { kind: 'header', partUri: '/word/header1.xml', role: 'default' });
		const modifiedHeader = story('header-m', [paragraphText('header-p-m', 'New header', [0])], { kind: 'header', partUri: '/word/header1.xml', role: 'default' });
		const switchedHeader = story('header-switched', [paragraphText('header-switched-p', 'Other header', [0])], { kind: 'header', partUri: '/word/header2.xml', role: 'default' });
		const originalFootnote = story('note-o', [paragraphText('note-p-o', 'Old note', [0])], { kind: 'footnote', partUri: '/word/footnotes.xml', noteId: '1' });
		const modifiedFootnote = story('note-m', [paragraphText('note-p-m', 'New note', [0])], { kind: 'footnote', partUri: '/word/footnotes.xml', noteId: '1' });
		const reference = (id: string, storyId: string, seed: string): ParadisWordDocument['storyReferences'][number] => ({
			id, kind: 'header', role: 'default', sectionOrdinal: 0, storyId,
			source: { partUri: '/word/document.xml', semanticPath: [0], kind: 'storyReference', ordinal: 0, fingerprint: seed, partFingerprint: fingerprint(seed) },
			anchor: { partUri: '/word/document.xml', semanticPath: [0], kind: 'storyReference', ordinal: 0, fingerprint: seed },
		});
		const result = compareWordSemantics(
			document([story('body', [section('s0', [])]), originalHeader, originalFootnote], [reference('ref-o', 'header-o', 'a')]),
			document([story('body-m', [section('s0-m', [])]), modifiedHeader, switchedHeader, modifiedFootnote], [reference('ref-m', 'header-switched', 'b')]),
		);
		strictEqual(changesOf(result, 'storyReference.target').length, 1);
		strictEqual(changesOf(result, 'paragraph.text').filter(change => change.subject.locator.includes('header')).length, 1);
		strictEqual(changesOf(result, 'paragraph.text').filter(change => change.subject.locator.includes('footnote')).length, 1);
	});

	test('reports package styles theme numbering relationships metadata security and unknown parts once each', () => {
		const beforeFacts = [
			fact('style', 'Normal', 'a'), fact('theme', 'theme1', 'a'), fact('numbering', 'list1', 'a'),
			fact('relationship', 'image1', 'a'), fact('metadata', 'core', 'a'), fact('security', 'vba', 'a'), fact('unknown', 'custom1', 'a'),
		];
		const afterFacts = beforeFacts.map(value => fact(value.kind, value.id, 'b'));
		const body = document([story('body', [section('s0', [paragraphText('p', 'stable', [0, 0])])])]);
		const result = compareWordSemantics({ document: body, packageFacts: beforeFacts }, { document: body, packageFacts: afterFacts });
		deepStrictEqual(result.changes.map(change => change.subject.kind).sort(), [
			'package.metadata', 'package.numbering', 'package.relationship', 'package.security', 'package.style', 'package.theme', 'package.unknown',
		]);
		strictEqual(changesOf(result, 'package.unknown')[0].certainty, 'opaque');
	});

	test('compares image bytes OMML fields sections comments revisions and keeps raw line/diagonal changes separate', () => {
		const originalTable = table('table-o', [paragraphText('table-p-o', 'stable', [0, 0, 0, 0, 0])], [0, 0], 'a');
		const modifiedTable = table('table-m', [paragraphText('table-p-m', 'stable', [0, 0, 0, 0, 0])], [0, 0], 'b');
		const originalDrawing = {
			...base('drawing', 'drawing-o', [0, 1], 'drawing'), kind: 'drawing' as const,
			geometry: { placement: 'inline' as const, distances: {}, presetGeometry: 'line', line: { width: '1' }, sourcePartFingerprint: fingerprint('a') }, children: [],
		};
		const modifiedDrawing = {
			...base('drawing', 'drawing-m', [0, 1], 'drawing'), kind: 'drawing' as const,
			geometry: { placement: 'inline' as const, distances: {}, presetGeometry: 'line', line: { width: '2' }, sourcePartFingerprint: fingerprint('b') }, children: [],
		};
		const originalBody = story('body', [section('s0', [
			originalTable, originalDrawing,
			paragraph('semantic-o', [omml('math-o', 'x', [0, 2, 0], 'math-a'), field('field-o', 'PAGE', '1', [0, 2, 1]), revision('rev-o', 'inserted', [0, 2, 2], 'Alice')], [0, 2]),
		])]);
		const modifiedBody = story('body-m', [section('s0-m', [
			modifiedTable, modifiedDrawing,
			paragraph('semantic-m', [omml('math-m', 'y', [0, 2, 0], 'math-b'), field('field-m', 'NUMPAGES', '1', [0, 2, 1]), revision('rev-m', 'inserted', [0, 2, 2], 'Bob')], [0, 2]),
		])]);
		const commentBefore = story('comment-o', [paragraphText('comment-p-o', 'Old comment', [0])], { kind: 'comment', partUri: '/word/comments.xml', commentId: '1' });
		const commentAfter = story('comment-m', [paragraphText('comment-p-m', 'New comment', [0])], { kind: 'comment', partUri: '/word/comments.xml', commentId: '1' });
		const objects = (seed: string): ParadisWordObjectModel => ({
			images: [{
				id: 'image-1', kind: 'image', source: { partUri: '/word/document.xml', partFingerprint: fingerprint(seed), semanticPath: [0, 3] },
				content: { kind: 'embedded', contentType: 'image/png', fingerprint: fingerprint(seed), source: { partUri: '/word/media/image1.png', partFingerprint: fingerprint(seed) } },
				placement: { fingerprint: fingerprint('p'), kind: 'inline', distances: {} },
				presentation: { fingerprint: fingerprint('q') },
			}],
			lines: [{
				id: 'line-1', kind: 'line', source: { partUri: '/word/document.xml', partFingerprint: fingerprint(seed), semanticPath: [0, 1] },
				placement: { fingerprint: fingerprint('p'), kind: 'inline', distances: {} },
				geometry: { preset: 'line', line: { width: seed === 'a' ? '1' : '2' } },
			}],
			math: [{
				id: 'math-1', kind: 'math', source: { partUri: '/word/document.xml', partFingerprint: fingerprint(seed), semanticPath: [0, 2, 0] },
				canonicalFingerprint: fingerprint(seed), projection: { kind: 'plainText', text: seed === 'a' ? 'x' : 'y' },
			}],
		});
		const fields = (seed: string): ParadisWordFieldModel => ({
			fields: [{
				id: 'field-1', kind: 'field', fieldKind: 'simple', source: { partUri: '/word/document.xml', partFingerprint: fingerprint(seed), semanticPath: [0, 2, 1] },
				instruction: seed === 'a' ? 'PAGE' : 'NUMPAGES', savedResult: '1', evaluation: 'savedResultOnly', fingerprint: fingerprint(seed),
			}],
			revisions: [{
				id: 'revision-1', kind: 'revision', revisionKind: 'inserted', source: { partUri: '/word/document.xml', partFingerprint: fingerprint(seed), semanticPath: [0, 2, 2] },
				revisionId: '1', author: seed === 'a' ? 'Alice' : 'Bob', text: 'inserted', fingerprint: fingerprint(seed),
			}], sections: [{
				id: 'section-1', kind: 'section', sectionOrdinal: 0,
				source: { partUri: '/word/document.xml', partFingerprint: fingerprint(seed), semanticPath: [0] }, titlePage: false, storyReferences: [], fingerprint: fingerprint(seed),
			}]
		});
		const result = compareWordSemantics(
			{ document: document([originalBody, commentBefore]), objectModel: objects('a'), fieldModel: fields('a') },
			{ document: document([modifiedBody, commentAfter]), objectModel: objects('b'), fieldModel: fields('b') },
		);
		for (const kind of ['object.imageContent', 'object.omml', 'field.instruction', 'section.properties', 'comment.text', 'revision.properties', 'object.lineGeometry', 'table.diagonalBorder']) {
			strictEqual(changesOf(result, kind).length, 1, kind);
		}
		strictEqual(changesOf(result, 'object.lineGeometry')[0].category, 'object');
		strictEqual(changesOf(result, 'table.diagonalBorder')[0].category, 'formatting');

		const provenanceTable = {
			...originalTable,
			id: 'table-provenance',
			diagonalBorders: originalTable.diagonalBorders.map(border => ({ ...border, sourcePartFingerprint: fingerprint('b') })),
		};
		const provenanceDrawing = {
			...originalDrawing,
			id: 'drawing-provenance',
			geometry: { ...originalDrawing.geometry, sourcePartFingerprint: fingerprint('b') },
		};
		const provenanceOnly = compareWordSemantics(
			document([story('body', [section('s0', [originalTable, originalDrawing])])]),
			document([story('body-m', [section('s0-m', [provenanceTable, provenanceDrawing])])]),
		);
		strictEqual(changesOf(provenanceOnly, 'object.lineGeometry').length, 0);
		strictEqual(changesOf(provenanceOnly, 'table.diagonalBorder').length, 0);
	});

	test('diffs extended grapheme clusters without splitting their UTF-16 sequences', () => {
		const changes = diffParadisWordGraphemes('A👨‍👩‍👧‍👦e\u0301Z', 'A👩🏽‍💻éZ');
		deepStrictEqual(changes.filter(value => value.kind !== 'equal').map(value => value.text), ['👨‍👩‍👧‍👦é', '👩🏽‍💻é']);
		strictEqual(changes.some(value => /[\uD800-\uDBFF]$/.test(value.text) || /^[\uDC00-\uDFFF]/.test(value.text)), false);
	});

	test('pages deterministically and permits No Changes only at complete terminal coverage', () => {
		const original = document([story('body', [section('s0', [
			paragraphText('p-o', 'a', [0, 0]), paragraphText('q-o', 'c', [0, 1]), paragraphText('r-o', 'stable', [0, 2], 'format-a'),
		])])]);
		const modified = document([story('body-m', [section('s0-m', [
			paragraphText('p-m', 'b', [0, 0]), paragraphText('q-m', 'd', [0, 1]), paragraphText('r-m', 'stable', [0, 2], 'format-b'),
		])])]);
		const originalComplete = completeSnapshot(original);
		const modifiedComplete = completeSnapshot(modified);
		const first = compareWordSemantics(originalComplete, modifiedComplete, { pageSize: 1, categories: ['content'] });
		strictEqual(first.terminal, false);
		ok(first.nextCursor);
		strictEqual(first.noChanges, false);
		const second = compareWordSemantics(originalComplete, modifiedComplete, { pageSize: 1, categories: ['content'], cursor: first.nextCursor });
		strictEqual(second.terminal, true);
		strictEqual(second.completeness.visitedSemanticUnits, second.completeness.expectedSemanticUnits);
		throws(() => compareWordSemantics(originalComplete, modifiedComplete, { pageSize: 1, categories: ['formatting'], cursor: first.nextCursor }), /unsafe/);
		const changedAgain = completeSnapshot(document([story('body-m', [section('s0-m', [
			paragraphText('p-m', 'different', [0, 0]), paragraphText('q-m', 'd', [0, 1]), paragraphText('r-m', 'stable', [0, 2], 'format-b'),
		])])]));
		throws(() => compareWordSemantics(originalComplete, changedAgain, { pageSize: 1, categories: ['content'], cursor: first.nextCursor }), /unsafe/);
		const bareUnchanged = compareWordSemantics(original, original);
		strictEqual(bareUnchanged.noChanges, false);
		strictEqual(bareUnchanged.outcome, 'degraded');
		const unchanged = compareWordSemantics(originalComplete, originalComplete);
		strictEqual(unchanged.terminal, true);
		strictEqual(unchanged.noChanges, true);
		const incomplete: ParadisWordSemanticSnapshot = {
			document: original,
			packageCompleteness: { expectedParts: 5, visitedParts: 4, parsedParts: 4, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 0, visitedSemanticUnits: 0, terminal: false },
		};
		const partial = compareWordSemantics(incomplete, incomplete);
		strictEqual(partial.noChanges, false);
		strictEqual(partial.outcome, 'degraded');
	});

	test('returns degraded coarse entries for candidate budgets and enforces cancellation deadline and output ownership', () => {
		const originalParagraph = paragraphText('p-o', 'original', [0, 0]);
		const original = document([story('body', [section('s0', [originalParagraph])])]);
		const modified = document([story('body-m', [section('s0-m', [paragraphText('p-m', 'modified', [0, 0])])])]);
		const degraded = alignParadisWordDocuments(original, modified, { limits: { alignmentRegionPairs: 0 } });
		strictEqual(degraded.outcome, 'degraded');
		strictEqual(degraded.stories.flatMap(value => value.nodes).some(value => value.certainty === 'degraded'), true);
		strictEqual(alignParadisWordDocuments(original, original, { limits: { storyBlockCandidates: 0 } }).outcome, 'degraded');
		throws(() => compareWordSemantics(original, modified, { cancellationToken: CancellationToken.Cancelled }), /cancelled/);
		let clock = 0;
		throws(() => compareWordSemantics(original, modified, { now: () => ++clock, deadlineMilliseconds: 0 }), /limitExceeded/);
		const owned = compareWordSemantics(original, modified);
		(originalParagraph.children[0] as { text: string }).text = 'mutated';
		strictEqual(JSON.stringify(owned).includes('mutated'), false);
	});
});
