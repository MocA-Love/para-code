// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { effectiveReviewMode, reviewContentKindOf, reviewRenderSide, reviewSidesOf, reviewViewPlan, type ReviewViewCaps } from './reviewViewModes.js';

const NEW_PC: ReviewViewCaps = { fileAt: true, wordDiff: true };
const OLD_PC: ReviewViewCaps = { fileAt: false, wordDiff: false };
const modified = reviewSidesOf({ staged: false, kind: 'modified' });

describe('reviewViewModes', () => {
	it('decides the modes and the default per kind on a new PC', () => {
		expect(['README.md', 'index.html', 'a.png', 'book.xlsx', 'report.docx', 'main.ts'].map(path => reviewViewPlan(reviewContentKindOf(path), modified, NEW_PC, path))).toEqual([
			{ modes: ['render', 'raw'], initial: 'render' },
			{ modes: ['render', 'raw'], initial: 'render' },
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

	it('keeps a chosen mode only while the file offers it', () => {
		const docx = reviewViewPlan('docx', modified, NEW_PC);
		const markdown = reviewViewPlan('markdown', modified, NEW_PC);
		expect([effectiveReviewMode(docx, 'raw'), effectiveReviewMode(markdown, 'diff'), effectiveReviewMode(markdown, undefined)]).toEqual(['raw', 'render', 'render']);
	});
});
