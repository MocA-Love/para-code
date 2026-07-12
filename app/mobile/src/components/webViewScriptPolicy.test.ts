// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { isDiffViewerJavaScriptEnabled, isFileViewerJavaScriptEnabled } from './webViewScriptPolicy.js';

describe('WebView script policy', () => {
	it('enables workspace HTML rendering scripts in the file viewer', () => {
		expect(isFileViewerJavaScriptEnabled('html', 'render')).toBe(true);
		expect(isFileViewerJavaScriptEnabled('html', 'code')).toBe(false);
	});

	it('preserves the file viewer script policy for other content', () => {
		expect(isFileViewerJavaScriptEnabled('spreadsheet', 'render')).toBe(true);
		expect(isFileViewerJavaScriptEnabled('docx', 'render')).toBe(true);
		expect(isFileViewerJavaScriptEnabled('markdown', 'render')).toBe(false);
		expect(isFileViewerJavaScriptEnabled('other', 'code')).toBe(false);
		expect(isFileViewerJavaScriptEnabled('other', 'code', 1)).toBe(true);
	});

	it('enables scripts for rendered HTML and spreadsheets in the diff viewer only', () => {
		expect(isDiffViewerJavaScriptEnabled('html')).toBe(true);
		expect(isDiffViewerJavaScriptEnabled('spreadsheet')).toBe(true);
		expect(isDiffViewerJavaScriptEnabled('markdown')).toBe(false);
		expect(isDiffViewerJavaScriptEnabled('other')).toBe(false);
	});
});
