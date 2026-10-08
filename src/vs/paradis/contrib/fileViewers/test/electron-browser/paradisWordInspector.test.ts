/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeRuntimeConfiguration } from '../../common/paradisOfficeCapabilities.js';
import type {
	ParadisOfficeChange,
	ParadisOfficeChangeCategory,
	ParadisOfficeCompletenessManifest,
	ParadisOfficePlaceholder,
	ParadisOfficePrintModel,
	ParadisOfficeSourceDescriptor,
} from '../../common/paradisOfficeProtocol.js';
import type { IParadisDocxDiffResult } from '../../common/paradisDocx.js';
import { PARADIS_WORD_LEGACY_CHANGE_LIMIT, adaptLegacyWordInspectorChangeSet } from '../../electron-browser/paradisDocxDiffEditor.js';
import { createParadisWordSourceDescriptor, isParadisWordV1Enabled } from '../../electron-browser/paradisDocxFileEditor.js';
import {
	PARADIS_WORD_CHANGE_CATEGORIES,
	ParadisWordBlankRetry,
	ParadisWordChangeInspector,
	ParadisWordInputRestoration,
	ParadisWordOpenGeneration,
	resolveParadisWordNavigation,
	restoreParadisWordViewState,
	searchParadisWordStories,
	paradisWordExclusionItems,
	wordChangeLabel,
} from '../../electron-browser/word/paradisWordChangeInspector.js';
import {
	PARADIS_WORD_HIGH_CONTRAST_TOKENS,
	canShowWordNoChanges,
	renderWordDiagnosticsRibbon,
	mergeParadisWordPackageExclusions,
	renderWordSemanticRibbon,
	summarizeParadisWordBlockedParts,
	wordPrintWarning,
	type ParadisWordPackageExclusions,
} from '../../electron-browser/word/paradisWordDiagnostics.js';
import type { IParadisWordAnalysisCounts } from '../../common/word/paradisWordSemanticSummary.js';

const completeManifest: ParadisOfficeCompletenessManifest = {
	expectedParts: 8,
	visitedParts: 8,
	parsedParts: 7,
	opaqueParts: 1,
	failedParts: 0,
	omittedParts: 0,
	expectedSemanticUnits: 24,
	visitedSemanticUnits: 24,
	terminal: true,
};

function change(id: string, category: ParadisOfficeChangeCategory, kind: string, locator: string, navigableAnchor?: string): ParadisOfficeChange {
	return {
		id,
		category,
		subject: { kind, locator },
		before: { kind: 'none' },
		after: { kind: 'scalar', valueType: 'text', value: 'changed' },
		certainty: 'exact',
		sourceParts: ['/word/document.xml'],
		...(navigableAnchor ? { navigableAnchor } : {}),
	};
}

suite('ParadisWordInspector', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('renders safe diagnostics and gates No Changes on Kernel completeness', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word diagnostics');
		const host = document.createElement('div');
		const ribbon = renderWordDiagnosticsRibbon(host, {
			outcome: 'degraded',
			coverages: ['rendered', 'approximated', 'placeholder', 'blockedByPolicy', 'noAnchor'],
			warnings: [{ code: 'projection', message: '<img src=x onerror=alert(1)>' }],
		});

		deepStrictEqual({
			role: ribbon.getAttribute('role'),
			live: ribbon.getAttribute('aria-live'),
			unsafeElement: ribbon.querySelector('img,script'),
			complete: canShowWordNoChanges(completeManifest, 'complete', 0),
			unterminated: canShowWordNoChanges({ ...completeManifest, terminal: false }, 'complete', 0),
			degraded: canShowWordNoChanges(completeManifest, 'degraded', 0),
		}, { role: 'status', live: 'polite', unsafeElement: null, complete: true, unterminated: false, degraded: false });
		ok(ribbon.textContent?.includes('完全再現 1'));
		ok(ribbon.textContent?.includes('近似 1'));
		ok(ribbon.textContent?.includes('代替表示 3'));
		ok(ribbon.textContent?.includes('解析未完了'));
		ok(ribbon.textContent?.includes('<img src=x onerror=alert(1)>'));
	});

	test('renders the semantic ribbon from real counts instead of fixed values', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word semantic ribbon');
		const host = document.createElement('div');
		const counts: IParadisWordAnalysisCounts = {
			format: 'docx', parts: { expected: 6, visited: 6, parsed: 6, inPackage: 14 }, nodes: 91,
			nodeKinds: { paragraph: 12, text: 40 }, storyKinds: { body: 1, footnote: 1 },
			unknownElements: [{ name: 'ptab', count: 2, disposition: 'unrendered' }, { name: 'proofErr', count: 9, disposition: 'ignorable' }],
			unknownElementsOther: { kinds: 0, count: 0, unrendered: 0 },
			unresolvedRelationships: 0, externalRelationships: 1,
		};
		const texts = (state: Parameters<typeof renderWordSemanticRibbon>[1]) => [...renderWordSemanticRibbon(host, state).children].map(item => item.textContent);
		let activated = 0;
		renderWordSemanticRibbon(host, { kind: 'analyzed', counts, alternatives: 1, ignoredParts: 7 }, () => activated++, disposables.add(new DisposableStore()));
		(host.querySelector('[data-kind="nodes"]') as HTMLElement).click();
		deepStrictEqual({
			analyzing: texts({ kind: 'analyzing', alternatives: 0, ignoredParts: 0 }),
			analyzed: texts({ kind: 'analyzed', counts, alternatives: 1, ignoredParts: 7 }),
			failed: texts({ kind: 'failed', code: 'malformed', alternatives: 0, ignoredParts: 0 }),
			compared: texts({ kind: 'compared', changes: 1000, truncated: true, outcome: 'complete', alternatives: 0, ignoredParts: 0, warnings: ['unsafe parts'] }),
			activated,
		}, {
			analyzing: ['解析中…', '表示: 従来の表示（近似）', '代替表示 0'],
			analyzed: ['解析 完了', '部品 6/6', '要素 91', '未対応の要素 2', '表示: 従来の表示（近似）', '代替表示 1', '無視した部品 7'],
			failed: ['解析できませんでした: ファイルの形式が正しくありません', '表示: 従来の表示（近似）', '代替表示 0'],
			compared: ['比較 完了', '変更 1000 以上', 'unsafe parts', '表示: 従来の表示（近似）', '代替表示 0'],
			activated: 1,
		});
	});

	test('lists the analysis breakdown and ignored parts, and labels revisions with their text and author', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word analysis');
		const host = document.createElement('div');
		const inspector = disposables.add(new ParadisWordChangeInspector(host));
		const revision: ParadisOfficeChange = {
			...change('r1', 'revision', 'revision.inserted', 'story:body:/word/document.xml:0/node:r1', 'story:body:/word/document.xml:0/node:p1'),
			after: { kind: 'record', fields: [{ name: 'text', value: { kind: 'scalar', valueType: 'text', value: 'added words' } }, { name: 'author', value: { kind: 'scalar', valueType: 'text', value: 'Clerk' } }] },
		};
		inspector.setComparison([revision], completeManifest, 'complete');
		inspector.setAnalysis({
			counts: {
				format: 'docx', parts: { expected: 2, visited: 2, parsed: 2, inPackage: 5 }, nodes: 3,
				nodeKinds: { paragraph: 1, text: 2 }, storyKinds: { body: 1 },
				unknownElements: [{ name: 'proofErr', count: 2, disposition: 'ignorable' }],
				unknownElementsOther: { kinds: 2, count: 5, unrendered: 1 },
				unresolvedRelationships: 0, externalRelationships: 0,
			},
			ignoredParts: [{ title: '/customXml/item1.xml', detail: 'customXml' }],
		});
		deepStrictEqual({
			change: host.querySelector('[data-change-id="r1"]')?.textContent,
			analysis: [...host.querySelectorAll('.paradis-word-analysis-row')].map(row => row.textContent),
			ignored: [...host.querySelectorAll('.paradis-word-ignored-part')].map(row => row.textContent),
		}, {
			change: '挿入 — added words（Clerk）',
			analysis: ['本文1', '段落1', 'テキスト2', 'proofErr2 件・表示に関係しない', '他 2 種5 件'],
			ignored: ['/customXml/item1.xml — customXml'],
		});
	});

	test('warns about macros, embeddings, and external references removed for safety, and lists ignored parts (Q313)', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word exclusions');
		const host = document.createElement('div');
		const original: ParadisWordPackageExclusions = {
			ignored: [{ partName: 'customXml/item1.xml', kind: 'customXml', reason: 'notRendered' }],
			ignoredOmitted: 0,
			blocked: [
				{ feature: 'macro', kind: 'vbaProject', partName: 'word/vbaProject.bin', count: 1 },
				{ feature: 'externalRelationship', kind: 'hyperlink', scheme: 'https', count: 3 },
			],
			blockedOmitted: 0,
		};
		const modified: ParadisWordPackageExclusions = {
			ignored: [{ partName: 'customXml/item1.xml', kind: 'customXml', reason: 'notRendered' }, { partName: 'word/people.xml', kind: 'people', reason: 'notRendered' }],
			ignoredOmitted: 2,
			blocked: [{ feature: 'embeddedObject', kind: 'oleObject', partName: 'word/embeddings/oleObject1.bin', count: 1 }],
			blockedOmitted: 0,
		};
		const merged = mergeParadisWordPackageExclusions(original, modified);
		const blocked = summarizeParadisWordBlockedParts(merged);
		const ribbon = renderWordSemanticRibbon(host, { kind: 'analyzing', alternatives: 0, ignoredParts: merged.ignored.length + merged.ignoredOmitted, ...(blocked ? { blocked } : {}) });
		const inspectorHost = document.createElement('div');
		const inspector = disposables.add(new ParadisWordChangeInspector(inspectorHost));
		inspector.setAnalysis(paradisWordExclusionItems(merged));
		deepStrictEqual({
			ribbon: [...ribbon.children].map(item => item.textContent),
			blocked: [...inspectorHost.querySelectorAll('.paradis-word-blocked-parts > *')].map(item => item.textContent),
			ignored: [...inspectorHost.querySelectorAll('.paradis-word-ignored-parts > *')].map(item => item.textContent),
			empty: summarizeParadisWordBlockedParts({ ignored: [], ignoredOmitted: 0, blocked: [], blockedOmitted: 0 }),
		}, {
			ribbon: ['解析中…', '表示: 従来の表示（近似）', '代替表示 0', '安全のために外しました: マクロ 1・外部参照 3・埋め込み 1', '無視した部品 4'],
			blocked: ['安全のために外したもの 3', 'word/vbaProject.bin — マクロ', 'hyperlink (https) — 外部参照・3 件', 'word/embeddings/oleObject1.bin — 埋め込み'],
			ignored: ['無視した部品 4', 'customXml/item1.xml — customXml: 表示に使わない', 'word/people.xml — people: 表示に使わない', '他 2 件'],
			empty: undefined,
		});
	});

	test('notes that only the later part changed when a compared value was shortened', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word truncated');
		const host = document.createElement('div');
		const inspector = disposables.add(new ParadisWordChangeInspector(host));
		inspector.setComparison([change('long', 'content', 'paragraph.text', 'story:body:/word/document.xml:0/node:p1', 'p1')], completeManifest, 'complete');
		inspector.setTruncatedChanges(['long']);
		strictEqual(host.querySelector('[data-change-id="long"]')?.textContent, '内容 — changed（後半が変わっています）');
	});

	test('counts categories and Stories while retaining visible changes without markers', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word stories');
		const host = document.createElement('div');
		const changes = [
			change('body', 'content', 'paragraph.text', 'story:body:/word/document.xml:0/node:p1', 'p1'),
			change('header', 'content', 'paragraph.text', 'story:header:/word/header1.xml:0/node:h1', 'h1'),
			change('footnote', 'annotation', 'paragraph.text', 'story:footnote:/word/footnotes.xml:7/node:f1', 'f1'),
			change('math', 'object', 'object.omml', 'story:body:/word/document.xml:0/node:m1', 'm1'),
			change('image', 'object', 'object.imageReference', 'story:body:/word/document.xml:0/node:i1', 'i1'),
			change('style', 'formatting', 'package.style', 'package:Heading1'),
		];
		const inspector = disposables.add(new ParadisWordChangeInspector(host));
		inspector.setComparison(changes, completeManifest, 'complete');

		deepStrictEqual(PARADIS_WORD_CHANGE_CATEGORIES, ['content', 'formatting', 'structure', 'annotation', 'revision', 'object', 'security']);
		strictEqual(host.querySelector('[data-category="object"]')?.getAttribute('data-count'), '2');
		strictEqual(host.querySelector('[data-story-kind="body"]')?.getAttribute('data-count'), '3');
		strictEqual(host.querySelector('[data-story-kind="header"]')?.getAttribute('data-count'), '1');
		strictEqual(host.querySelector('[data-story-kind="footnote"]')?.getAttribute('data-count'), '1');
		strictEqual(host.querySelector('[data-story-kind="package"]')?.getAttribute('data-count'), '1');
		strictEqual(host.querySelectorAll('[data-change-id]').length, 6, 'package/style changes without a render marker stay visible');
		deepStrictEqual(changes.map(wordChangeLabel), ['内容', '内容', '内容', '数式', '画像', 'スタイル']);

		inspector.setComparison([], completeManifest, 'complete');
		ok(host.textContent?.includes('変更なし'));
		inspector.setComparison([], { ...completeManifest, visitedSemanticUnits: 23 }, 'complete');
		ok(host.textContent?.includes('解析未完了'));
	});

	test('switches Final, Original, and Markup and persists bounded view state', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word modes');
		const host = document.createElement('div');
		const states: unknown[] = [];
		const inspector = disposables.add(new ParadisWordChangeInspector(host, { onDidChangeViewState: state => states.push(state) }));
		inspector.setViewState({
			zoom: 1.5,
			displayMode: 'original',
			activeStory: 'story:header:/word/header1.xml:0',
			categories: ['content', 'formatting', 'content'],
			selectedChangeId: 'header',
		});
		inspector.setComparison([change('header', 'content', 'paragraph.text', 'story:header:/word/header1.xml:0/node:h1')], completeManifest, 'complete');

		deepStrictEqual(inspector.getViewState(), {
			zoom: 1.5,
			displayMode: 'original',
			activeStory: 'story:header:/word/header1.xml:0',
			categories: ['content', 'formatting'],
			selectedChangeId: 'header',
		});
		strictEqual(host.querySelector('[data-word-mode="original"]')?.getAttribute('aria-pressed'), 'true');
		host.querySelector<HTMLButtonElement>('[data-word-mode="markup"]')?.click();
		strictEqual(inspector.getViewState().displayMode, 'markup');
		strictEqual((states.at(-1) as { readonly displayMode: string }).displayMode, 'markup');
		deepStrictEqual(restoreParadisWordViewState({ zoom: 99, displayMode: 'bad', activeStory: '', categories: ['bad'] }, inspector.getViewState()), inspector.getViewState());
	});

	test('navigates placeholders and semantic changes by logical identity with safe text', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word navigation');
		const host = document.createElement('div');
		const navigated: unknown[] = [];
		const inspector = disposables.add(new ParadisWordChangeInspector(host, { onNavigate: target => navigated.push(target) }));
		const placeholder: ParadisOfficePlaceholder = {
			nodeId: 'drawing-7', feature: 'smartArt', reason: 'unsupported', title: '<svg onload=alert(1)>', detail: 'Alternative hierarchy',
		};
		inspector.setComparison([change('drawing', 'object', 'object.lineGeometry', 'story:textbox:/word/document.xml:0/node:drawing-7', 'drawing-7')], completeManifest, 'complete');
		inspector.setPlaceholders([placeholder]);

		host.querySelector<HTMLButtonElement>('[data-change-id="drawing"]')?.click();
		host.querySelector<HTMLButtonElement>('[data-placeholder-id="drawing-7"]')?.click();
		strictEqual(host.querySelector('svg,script'), null);
		deepStrictEqual(navigated, [
			{ kind: 'change', locator: 'story:textbox:/word/document.xml:0/node:drawing-7', anchor: 'drawing-7' },
			{ kind: 'placeholder', locator: 'drawing-7' },
		]);
	});

	test('searches a non-body Story and navigates its semantic anchor', async () => {
		const stories = [
			{ id: 'body-story', kind: 'body' as const, partUri: '/word/document.xml', identity: '0', text: 'ordinary body' },
			{ id: 'header-story', kind: 'header' as const, partUri: '/word/header1.xml', identity: '0', text: 'Cafe\u0301 policy' },
		];
		const results = searchParadisWordStories(stories, 'CAFÉ');
		const document = mainWindow.document.implementation.createHTMLDocument('word search');
		const host = document.createElement('div');
		const navigated: unknown[] = [];
		const inspector = disposables.add(new ParadisWordChangeInspector(host, { search: async () => results, onNavigate: target => navigated.push(target) }));

		await inspector.search('CAFÉ');
		const button = host.querySelector<HTMLButtonElement>('[data-search-result-id="word-search:header-story:0"]');
		button?.click();
		deepStrictEqual(results.map(result => [result.locator, result.locationBadge.kind, result.locationBadge.label, result.preview.match]), [
			['story:header:/word/header1.xml:0', 'story', 'ヘッダー', 'Café'],
		]);
		deepStrictEqual(navigated, [{ kind: 'search', locator: 'story:header:/word/header1.xml:0', anchor: 'header-story' }]);
	});

	test('announces print approximation and retained placeholders', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word print');
		const host = document.createElement('div');
		const placeholder: ParadisOfficePlaceholder = { nodeId: 'ole-1', feature: 'ole', reason: 'unsupported', title: 'Embedded Object' };
		const model: ParadisOfficePrintModel = {
			title: 'Contract.docx',
			pages: [{ pageNumber: 1, widthPoints: 612, heightPoints: 792, blocks: [{ kind: 'placeholder', nodeId: 'ole-1', placeholder }], placeholders: [placeholder] }],
			approximationWarnings: [{ code: 'word.pagination.approximate', message: 'Pagination is approximate.' }],
		};
		const inspector = disposables.add(new ParadisWordChangeInspector(host, { getPrintModel: async () => model }));

		await inspector.requestPrintModel();
		strictEqual(wordPrintWarning(model), 'Pagination is approximate.');
		ok(host.querySelector('[role="alert"]')?.textContent?.includes('Pagination is approximate.'));
		ok(host.querySelector('[role="alert"]')?.textContent?.includes('代替表示 1 件'));
	});

	test('restores committed SourceDescriptor/view state and fences stale or blank opens', () => {
		const original: ParadisOfficeSourceDescriptor = { kind: 'gitCommit', uri: 'git:/repo/contract.docx?ref=HEAD', revisionHint: 'abc123', displayName: 'contract.docx' };
		const modified: ParadisOfficeSourceDescriptor = { kind: 'workingTree', uri: 'file:///repo/contract.docx', revisionHint: 'etag:2', displayName: 'contract.docx' };
		const initialViewState = { zoom: 1.25, displayMode: 'final' as const, activeStory: 'all', categories: ['content'] as const };
		const restoration = new ParadisWordInputRestoration({ source: original, viewState: initialViewState });
		restoration.begin({ source: modified, viewState: { zoom: 2, displayMode: 'markup', activeStory: 'all', categories: ['revision'] } });
		deepStrictEqual(restoration.cancel(), { source: original, viewState: initialViewState });
		strictEqual(restoration.serialize().includes('handle'), false);
		strictEqual(restoration.serialize().includes('abc123'), true);

		const opens = new ParadisWordOpenGeneration();
		const older = opens.begin();
		const newer = opens.begin();
		strictEqual(opens.isCurrent(older), false);
		strictEqual(opens.isCurrent(newer), true);
		opens.invalidate();
		strictEqual(opens.isCurrent(newer), false);

		const blank = new ParadisWordBlankRetry();
		const blankGeneration = blank.begin();
		strictEqual(blank.shouldRetry(blankGeneration, true), true);
		strictEqual(blank.shouldRetry(blankGeneration, true), false, 'one blank render gets one retry');
		const currentGeneration = blank.begin();
		strictEqual(blank.shouldRetry(blankGeneration, true), false, 'a stale render cannot consume the current retry');
		strictEqual(blank.shouldRetry(currentGeneration, false), false);
		strictEqual(blank.shouldRetry(currentGeneration, true), true);
	});

	test('uses logical Story anchors and distinct table-diagonal and Drawing-line labels', () => {
		deepStrictEqual(resolveParadisWordNavigation('story:header:/word/header1.xml:0/node:h1', 'h1'), {
			storyKind: 'header', partUri: '/word/header1.xml', storyIdentity: '0', nodeId: 'h1',
		});
		const diagonal = change('diagonal', 'formatting', 'table.diagonalBorder', 'story:body:/word/document.xml:0/node:table-1', 'table-1');
		const drawing = change('line', 'object', 'object.lineGeometry', 'story:textbox:/word/document.xml:0/node:line-1', 'line-1');
		deepStrictEqual([wordChangeLabel(diagonal), wordChangeLabel(drawing)], ['表の斜線', '図形の線']);
		strictEqual(JSON.stringify(resolveParadisWordNavigation(diagonal.subject.locator, diagonal.navigableAnchor)).includes('pixel'), false);
		strictEqual(JSON.stringify(resolveParadisWordNavigation(drawing.subject.locator, drawing.navigableAnchor)).includes('geometry'), false);
	});

	test('keeps v1 Word UI behind the per-open runtime snapshot and preserves source identity', () => {
		const legacy: ParadisOfficeRuntimeConfiguration = {
			engine: 'legacy', kernelShadow: true, semanticSpreadsheet: false, virtualizedSpreadsheet: false,
			semanticWord: false, platformBackend: false, searchPrint: false,
		};
		const v1: ParadisOfficeRuntimeConfiguration = {
			engine: 'v1', kernelShadow: false, semanticSpreadsheet: true, virtualizedSpreadsheet: true,
			semanticWord: true, platformBackend: true, searchPrint: true,
		};

		deepStrictEqual([
			isParadisWordV1Enabled(legacy),
			isParadisWordV1Enabled(v1),
			isParadisWordV1Enabled({ ...v1, semanticWord: false }),
			isParadisWordV1Enabled({ ...v1, platformBackend: false }),
		], [false, true, false, false]);
		deepStrictEqual(createParadisWordSourceDescriptor(URI.parse('vscode-remote://host/workspace/contract.docx')), {
			kind: 'remote', uri: 'vscode-remote://host/workspace/contract.docx', displayName: 'contract.docx',
		});
	});

	test('adapts bounded legacy paragraph changes without claiming complete analysis', () => {
		const legacy: IParadisDocxDiffResult = {
			changes: [
				{ id: 1, status: 'modified', originalIndex: 2, modifiedIndex: 2, excerpt: 'changed text' },
				{ id: 2, status: 'formatChanged', originalIndex: 3, modifiedIndex: 3, excerpt: 'styled text' },
				{ id: 3, status: 'moved', originalIndex: 4, modifiedIndex: 8, excerpt: 'moved text' },
			],
			annotations: [],
			fillers: [],
		};
		const result = adaptLegacyWordInspectorChangeSet(legacy);

		deepStrictEqual(result.changes.map(item => [item.category, item.subject.kind, item.navigableAnchor]), [
			['content', 'legacy.paragraph.modified', 'legacy-change:1'],
			['formatting', 'legacy.paragraph.formatChanged', 'legacy-change:2'],
			['structure', 'legacy.paragraph.moved', 'legacy-change:3'],
		]);
		strictEqual(result.completeness.terminal, false);
		strictEqual(canShowWordNoChanges(result.completeness, result.outcome, 0), false);

		const oversized: IParadisDocxDiffResult = {
			changes: Array.from({ length: PARADIS_WORD_LEGACY_CHANGE_LIMIT + 1 }, (_, index) => ({ id: index + 1, status: 'modified' as const, modifiedIndex: index, excerpt: String(index) })),
			annotations: [], fillers: [],
		};
		const bounded = adaptLegacyWordInspectorChangeSet(oversized);
		strictEqual(bounded.changes.length, PARADIS_WORD_LEGACY_CHANGE_LIMIT);
		strictEqual(bounded.truncated, true);
	});

	test('exposes ARIA live semantics, explicit unsupported capabilities, and high-contrast tokens', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('word accessibility');
		const host = document.createElement('div');
		disposables.add(new ParadisWordChangeInspector(host, {
			searchUnavailable: 'Semantic search is unavailable in compatibility mode.',
			printUnavailable: 'Print preview is unavailable in compatibility mode.',
		}));

		strictEqual(host.querySelector('[role="region"]')?.getAttribute('aria-label'), 'Word の変更インスペクター');
		strictEqual(host.querySelector('[aria-live="polite"]')?.getAttribute('aria-atomic'), 'true');
		ok(host.textContent?.includes('Semantic search is unavailable in compatibility mode.'));
		ok(host.textContent?.includes('Print preview is unavailable in compatibility mode.'));
		ok(PARADIS_WORD_HIGH_CONTRAST_TOKENS.border.includes('--vscode-contrastBorder'));
		ok(PARADIS_WORD_HIGH_CONTRAST_TOKENS.focus.includes('--vscode-contrastActiveBorder'));
	});
});
