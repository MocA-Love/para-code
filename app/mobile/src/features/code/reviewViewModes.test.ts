// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { effectiveReviewMode, reviewContentKindOf, reviewRenderSide, reviewSidesOf, reviewViewPlan, type ReviewViewCaps } from './reviewViewModes.js';

const NEW_PC: ReviewViewCaps = { fileAt: true, wordDiff: true, renderedDiff: true, renderedDiffHtml: true };
const OLD_PC: ReviewViewCaps = { fileAt: false, wordDiff: false, renderedDiff: false, renderedDiffHtml: false };
const modified = reviewSidesOf({ staged: false, kind: 'modified' });

describe('reviewViewModes', () => {
	it('decides the modes and the default per kind on a new PC', () => {
		expect(['README.md', 'index.html', 'a.png', 'book.xlsx', 'report.docx', 'main.ts'].map(path => reviewViewPlan(reviewContentKindOf(path), modified, NEW_PC, path))).toEqual([
			{ modes: ['render', 'diff', 'raw'], initial: 'diff' },
			{ modes: ['render', 'diff', 'raw'], initial: 'raw' },
			{ modes: ['render', 'diff'], initial: 'render' },
			{ modes: ['render', 'diff', 'raw'], initial: 'diff' },
			{ modes: ['render', 'diff', 'raw'], initial: 'diff' },
			{ modes: ['raw'], initial: 'raw' },
		]);
	});

	it('drops the modes an old PC cannot serve', () => {
		const staged = reviewSidesOf({ staged: true, kind: 'modified' });
		const deleted = reviewSidesOf({ staged: false, kind: 'deleted' });
		expect({
			image: reviewViewPlan('image', modified, OLD_PC),
			stagedMarkdown: reviewViewPlan('markdown', staged, OLD_PC),
			deletedImage: reviewViewPlan('image', deleted, OLD_PC),
			docx: reviewViewPlan('docx', modified, OLD_PC),
			xlsx: reviewViewPlan('spreadsheet', modified, OLD_PC, 'a.xlsx'),
			xltx: reviewViewPlan('spreadsheet', modified, NEW_PC, 'a.xltx'),
			// xlsxDiff は HEAD ↔ 作業ツリーなので、ステージ済みの行では「差分」を出さない
			stagedXlsx: reviewViewPlan('spreadsheet', staged, NEW_PC, 'a.xlsx'),
		}).toEqual({
			image: { modes: ['render'], initial: 'render' },
			stagedMarkdown: { modes: ['raw'], initial: 'raw' },
			deletedImage: { modes: ['raw'], initial: 'raw' },
			docx: { modes: ['render'], initial: 'render' },
			xlsx: { modes: ['render', 'diff'], initial: 'diff' },
			xltx: { modes: ['render', 'raw'], initial: 'raw' },
			stagedXlsx: { modes: ['raw'], initial: 'raw' },
		});
	});

	it('reads the same sides as the PC source control diff and renders a deleted file from before', () => {
		const sides = [
			reviewSidesOf({ staged: false, kind: 'modified' }),
			reviewSidesOf({ staged: true, kind: 'modified' }),
			reviewSidesOf({ staged: false, kind: 'untracked' }),
			reviewSidesOf({ staged: true, kind: 'deleted' }),
		];
		expect({ sides, render: sides.map(reviewRenderSide), addedImage: reviewViewPlan('image', sides[2]!, NEW_PC).modes }).toEqual({
			sides: [
				{ before: 'index', after: 'worktree' },
				{ before: 'head', after: 'index' },
				{ before: 'missing', after: 'worktree' },
				{ before: 'head', after: 'missing' },
			],
			render: ['worktree', 'index', 'worktree', 'head'],
			addedImage: ['render'],
		});
	});

	it('offers the rendered diff of Markdown and HTML only when the PC can make it and both sides exist', () => {
		const added = reviewSidesOf({ staged: false, kind: 'untracked' });
		const staged = reviewSidesOf({ staged: true, kind: 'modified' });
		// scm.rendered-diff.v1 だけの PC（HTML を扱えない）
		const markdownOnlyPc = { ...NEW_PC, renderedDiffHtml: false };
		expect({
			oldPc: reviewViewPlan('markdown', modified, { ...NEW_PC, renderedDiff: false }),
			added: reviewViewPlan('markdown', added, NEW_PC),
			staged: reviewViewPlan('markdown', staged, NEW_PC),
			stagedWithoutFileAt: reviewViewPlan('markdown', staged, { ...OLD_PC, renderedDiff: true }),
			htmlOnMarkdownOnlyPc: reviewViewPlan('html', modified, markdownOnlyPc),
			markdownOnMarkdownOnlyPc: reviewViewPlan('markdown', modified, markdownOnlyPc),
			addedHtml: reviewViewPlan('html', added, NEW_PC),
			stagedHtml: reviewViewPlan('html', staged, NEW_PC),
		}).toEqual({
			oldPc: { modes: ['render', 'raw'], initial: 'render' },
			added: { modes: ['render', 'raw'], initial: 'render' },
			staged: { modes: ['render', 'diff', 'raw'], initial: 'diff' },
			stagedWithoutFileAt: { modes: ['diff', 'raw'], initial: 'diff' },
			htmlOnMarkdownOnlyPc: { modes: ['render', 'raw'], initial: 'raw' },
			markdownOnMarkdownOnlyPc: { modes: ['render', 'diff', 'raw'], initial: 'diff' },
			addedHtml: { modes: ['render', 'raw'], initial: 'raw' },
			stagedHtml: { modes: ['render', 'diff', 'raw'], initial: 'raw' },
		});
	});

	it('keeps a chosen mode only while the file offers it', () => {
		const docx = reviewViewPlan('docx', modified, NEW_PC);
		const markdown = reviewViewPlan('markdown', modified, NEW_PC);
		const html = reviewViewPlan('html', modified, { ...NEW_PC, renderedDiffHtml: false });
		expect([effectiveReviewMode(docx, 'raw'), effectiveReviewMode(markdown, 'render'), effectiveReviewMode(html, 'diff'), effectiveReviewMode(markdown, undefined)]).toEqual(['raw', 'render', 'raw', 'diff']);
	});
});
