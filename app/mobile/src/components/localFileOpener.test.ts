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
	const push = vi.fn();
	const alert = vi.fn();
	const fsResolveLink = vi.fn<(ws: string, path: string) => Promise<{ path: string }>>();
	const state = {
		activePcId: 'pc-1' as string | undefined,
		selectedTerminalKey: undefined,
		selectedWs: 'workspace-1' as string | undefined,
		workspace: undefined,
		fsResolveLink,
	};
	return { push, alert, fsResolveLink, state };
});

vi.mock('expo-router', () => ({ useRouter: () => ({ push: harness.push }) }));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(selector: T) => selector }));
vi.mock('../appState.js', () => ({ useAppStore: (selector: (state: typeof harness.state) => unknown) => selector(harness.state) }));
vi.mock('../haptics.js', () => ({ haptic: () => undefined }));
vi.mock('../paraAlert.js', () => ({ paraAlert: { alert: harness.alert } }));
vi.mock('../features/code/fileViewerModel.js', () => ({ DIR_VIEW: 'dir', FILE_VIEW: 'file' }));

import { useLocalFileOpener } from './localFileOpener.js';
import { fileViewerHref } from '../features/code/codeRoutes.js';

type Opener = ReturnType<typeof useLocalFileOpener>;

async function renderOpener(): Promise<{ renderer: ReactTestRenderer; opener: () => Opener }> {
	let latest: Opener | undefined;
	function Probe() {
		latest = useLocalFileOpener();
		return null;
	}
	let renderer: ReactTestRenderer | undefined;
	await act(async () => {
		renderer = create(createElement(Probe));
	});
	return { renderer: renderer!, opener: () => latest! };
}

describe('useLocalFileOpener', () => {
	beforeEach(() => {
		harness.push.mockClear();
		harness.alert.mockClear();
		harness.fsResolveLink.mockReset();
		harness.state.activePcId = 'pc-1';
	});

	it('解決したパスでファイルツリーと同じビューアの画面へ進み、最後に押したものだけを開く', async () => {
		const resolvers: ((value: { path: string }) => void)[] = [];
		harness.fsResolveLink.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));
		const { renderer, opener } = await renderOpener();
		try {
			await act(async () => {
				opener().open({ path: 'old.ts' });
				opener().open({ path: './src/app.ts', line: 12 });
			});
			await act(async () => {
				resolvers[1]!({ path: 'src/app.ts' });
				resolvers[0]!({ path: 'old.ts' });
			});
			expect({ resolved: harness.fsResolveLink.mock.calls, pushed: harness.push.mock.calls, alerts: harness.alert.mock.calls.length }).toEqual({
				resolved: [['workspace-1', 'old.ts'], ['workspace-1', './src/app.ts']],
				pushed: [[fileViewerHref('pc-1', 'workspace-1', 'src/app.ts', 12)]],
				alerts: 0,
			});
		} finally {
			await act(async () => renderer.unmount());
		}
	});

	it('PC が分からないときは解決せずに知らせる', async () => {
		harness.state.activePcId = undefined;
		const { renderer, opener } = await renderOpener();
		try {
			await act(async () => { opener().open({ path: 'src/app.ts' }); });
			expect({ resolved: harness.fsResolveLink.mock.calls.length, pushed: harness.push.mock.calls.length, alerts: harness.alert.mock.calls.length }).toEqual({ resolved: 0, pushed: 0, alerts: 1 });
		} finally {
			await act(async () => renderer.unmount());
		}
	});
});
