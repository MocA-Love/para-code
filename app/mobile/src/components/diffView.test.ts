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
	const push = vi.fn();
	const state = {
		scmDiff,
		scmXlsxDiff,
		fsRead: vi.fn(async () => ({ content: '', truncated: false })),
		fsXlsx: vi.fn(async () => ({ html: '<html></html>' })),
		activePcId: 'pc-1' as string | undefined,
		connection: 'online',
		pcOnline: true,
		sessionProtocolReady: true,
		workspace: {
			desktopEpoch: 1,
			workspaces: [{ id: 'workspace-1', windowId: 7 }],
			renderers: [{ windowId: 7, rendererGeneration: 2, ready: true }],
		},
	};
	return { scmDiff, scmXlsxDiff, push, state };
});

vi.mock('react-native', () => ({
	ActivityIndicator: 'ActivityIndicator',
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
vi.mock('expo-router', () => ({ useRouter: () => ({ push: harness.push }) }));
vi.mock('../features/code/fileViewerModel.js', () => ({ buildMarkdownHtml: () => '<html></html>', DIR_VIEW: 'dir', FILE_VIEW: 'file' }));
// 追加されたトークン（type / alpha など）まで列挙し続けなくて済むよう、本物を土台にして色などだけ差し替える。
vi.mock('../theme.js', async (importOriginal) => ({
	...await importOriginal<typeof import('../theme.js')>(),
	colors: new Proxy({}, { get: () => '#000' }),
}));
vi.mock('../haptics.js', () => ({ haptic: () => undefined, prepareHaptic: () => undefined, hapticImpact: () => undefined, hapticSelection: () => undefined }));
vi.mock('./webViewScriptPolicy.js', () => ({ isDiffViewerJavaScriptEnabled: () => false }));
vi.mock('./webViewLinkGuard.js', () => ({ guardWebViewNavigation: () => false }));
vi.mock('./diffParser.js', () => ({ parseUnifiedDiff: () => [] }));
vi.mock('../hooks/useSizeClass.js', () => ({ useIsRegularWidth: () => false }));

import { DiffView } from './diffView.js';
import { fileViewerHref } from '../features/code/codeRoutes.js';

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

describe('DiffView から実ファイルを開く', () => {
	const onClose = vi.fn();
	beforeEach(() => {
		harness.push.mockClear();
		onClose.mockClear();
		harness.state.activePcId = 'pc-1';
	});

	async function render(statusLetter: string | undefined): Promise<ReactTestRenderer> {
		let renderer: ReactTestRenderer | undefined;
		await act(async () => {
			renderer = create(createElement(DiffView, { ws: 'workspace-1', path: 'src/app.ts', staged: false, statusLetter, onClose }));
			await Promise.resolve();
		});
		return renderer!;
	}

	it('押すと差分を閉じ、ファイルツリーと同じビューアの画面へ進む', async () => {
		const renderer = await render('M');
		try {
			const open = renderer.root.findByProps({ accessibilityLabel: 'ファイルを開く' });
			await act(async () => { open.props.onPress(); });
			expect({ closed: onClose.mock.calls.length, pushed: harness.push.mock.calls }).toEqual({
				closed: 1,
				pushed: [[fileViewerHref('pc-1', 'workspace-1', 'src/app.ts')]],
			});
		} finally {
			await act(async () => renderer.unmount());
		}
	});

	it('PC が分からないときは開く操作を出さない', async () => {
		harness.state.activePcId = undefined;
		const renderer = await render('M');
		try {
			expect(renderer.root.findAllByProps({ accessibilityLabel: 'ファイルを開く' })).toHaveLength(0);
		} finally {
			await act(async () => renderer.unmount());
		}
	});

	it('削除されたファイルは作業ツリーに無いので開く操作を出さない', async () => {
		const renderer = await render('D');
		try {
			expect(renderer.root.findAllByProps({ accessibilityLabel: 'ファイルを開く' })).toHaveLength(0);
		} finally {
			await act(async () => renderer.unmount());
		}
	});
});
