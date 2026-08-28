/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('React', React);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
	const scmDiff = vi.fn(async () => ({ diff: 'generic binary diff' }));
	const scmXlsxDiff = vi.fn(async () => ({ html: '<html><body>spreadsheet diff</body></html>' }));
	const state = {
		scmDiff,
		scmXlsxDiff,
		fsRead: vi.fn(async () => ({ content: '', truncated: false })),
		fsXlsx: vi.fn(async () => ({ html: '<html></html>' })),
		connection: 'online',
		pcOnline: true,
		sessionProtocolReady: true,
		workspace: {
			desktopEpoch: 1,
			workspaces: [{ id: 'workspace-1', windowId: 7 }],
			renderers: [{ windowId: 7, rendererGeneration: 2, ready: true }],
		},
	};
	return { scmDiff, scmXlsxDiff, state };
});

vi.mock('react-native', () => ({
	Modal: 'Modal',
	Platform: { OS: 'ios' },
	Pressable: 'Pressable',
	ScrollView: 'ScrollView',
	StyleSheet: { hairlineWidth: 1, create: <T>(value: T) => value },
	Text: 'Text',
	View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(selector: T) => selector }));
vi.mock('../appState.js', () => {
	const useAppStore = Object.assign(
		(selector: (state: typeof harness.state) => unknown) => selector(harness.state),
		{ getState: () => harness.state },
	);
	return { useAppStore };
});
vi.mock('./fileViewer.js', () => ({ buildMarkdownHtml: () => '<html></html>' }));
vi.mock('../theme.js', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('../haptics.js', () => ({ hapticImpact: () => undefined, hapticSelection: () => undefined }));
vi.mock('./webViewScriptPolicy.js', () => ({ isDiffViewerJavaScriptEnabled: () => false }));
vi.mock('./webViewLinkGuard.js', () => ({ guardWebViewNavigation: () => false }));
vi.mock('./diffParser.js', () => ({ parseUnifiedDiff: () => [] }));
vi.mock('../hooks/useSizeClass.js', () => ({ useIsRegularWidth: () => false }));

import { DiffView } from './diffView.js';

async function renderDiff(path: string): Promise<ReactTestRenderer> {
	let renderer: ReactTestRenderer | undefined;
	await act(async () => {
		renderer = create(createElement(DiffView, { ws: 'workspace-1', path, staged: false, onClose: () => undefined }));
		await Promise.resolve();
		await Promise.resolve();
	});
	return renderer!;
}

describe('DiffView Office routing', () => {
	beforeEach(() => {
		harness.scmDiff.mockClear();
		harness.scmXlsxDiff.mockClear();
	});

	it.each([
		['book.xlsx', 'spreadsheet'],
		['book.xlsm', 'spreadsheet'],
		['book.xltx', 'unavailable'],
		['book.xltm', 'unavailable'],
		['letter.docx', 'unavailable'],
		['letter.docm', 'unavailable'],
		['letter.dotx', 'unavailable'],
		['letter.dotm', 'unavailable'],
	] as const)('routes %s through an Office-specific SCM Diff outcome', async (path, expected) => {
		const renderer = await renderDiff(path);
		try {
			expect(harness.scmDiff).not.toHaveBeenCalled();
			if (expected === 'spreadsheet') {
				expect(harness.scmXlsxDiff).toHaveBeenCalledWith('workspace-1', path);
				expect(JSON.stringify(renderer.toJSON())).not.toContain('このOffice形式のDiffは利用できません');
			} else {
				expect(harness.scmXlsxDiff).not.toHaveBeenCalled();
				expect(JSON.stringify(renderer.toJSON())).toContain('このOffice形式のDiffは利用できません');
			}
		} finally {
			await act(async () => renderer.unmount());
		}
	});
});
