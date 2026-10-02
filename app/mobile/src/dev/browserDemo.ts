// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useAppStore } from '../appState.js';
import type { BrowserInput } from '../browserKeys.js';
import type { BrowserTargetsResult } from '../store.js';
import { PcCapability } from '../pcCompat.js';
import { setDevBrowserBookmarks } from '../features/browser/useBrowserBookmarks.js';
import { legacyNavigateUrl } from '../browserAddress.js';

/**
 * 開発ビルド専用: ブラウザのタブ（案A）を、PC とつながっていないシミュレータで確かめるための見本。
 * `globalThis.__paraDev.demo()` の後に `__paraDev.browserDemo()` を呼ぶ（`src/devProbe.tsx`）。
 *
 * ストアのブラウザの操作を差し替え、スペース「para-code」に 3 枚のページ・ブックマーク・映像（見本の画像）を
 * 出す。映像のタップで検索欄にフォーカスが入ったことにし、文字入力が自動で開く。`loading` で読み込み中を出す。
 * データはすべて架空。
 */

const TARGETS: BrowserTargetsResult['targets'] = [
	{ targetId: 'demo-page-1', title: 'Para Code Docs — スペースとワークツリー', url: 'https://docs.example.dev/spaces/worktree', sharedToken: 'token-demo-auth' },
	{ targetId: 'demo-page-2', title: 'Vite + React', url: 'http://localhost:5173/' },
	{ targetId: 'demo-page-3', title: 'Pull Request #42 · example/app', url: 'https://github.com/example/app/pull/42' },
];

let focusSeq = 0;

export async function installBrowserDemo(options: { readonly loading?: boolean } = {}): Promise<void> {
	if (!__DEV__) {
		return;
	}
	// 見本の画像（34KB）は開発ビルドでだけ読む。`__DEV__` の中の require は本番の bundle から外れる
	// （Metro が本番では `if (false)` の枝を落としてから依存を集めるため）。
	const demoFrame = __DEV__ ? (require('./demoBrowserFrame.js') as typeof import('./demoBrowserFrame.js')).DEMO_BROWSER_FRAME : undefined;
	const frame = demoFrame !== undefined ? { data: demoFrame.data, w: demoFrame.w, h: demoFrame.h } : undefined;
	const state = useAppStore.getState();
	const workspace = state.workspace;
	if (workspace === undefined) {
		console.warn('[para-dev] call __paraDev.demo() first');
		return;
	}
	const page = (target: BrowserTargetsResult['targets'][number], loading = false) => ({
		t: 'page' as const, targetId: target.targetId, url: target.url, title: target.title, loading, progress: loading ? 0.6 : 1, canGoBack: true, canGoForward: false,
	});
	let current = TARGETS[0]!;
	setDevBrowserBookmarks({
		t: 'bookmarks',
		nodes: [
			{ type: 'bookmark', id: 'b1', title: 'Para Code Docs', url: 'https://docs.example.dev/spaces/worktree' },
			{ type: 'bookmark', id: 'b2', title: 'localhost:5173', url: 'http://localhost:5173/' },
			{ type: 'folder', id: 'f1', title: '仕事', icon: 'briefcase', color: '#2563eb', children: [
				{ type: 'bookmark', id: 'b4', title: 'Sentry · Issues', url: 'https://sentry.example.com/issues' },
				{ type: 'bookmark', id: 'b5', title: 'Cloudflare ダッシュボード', url: 'https://dash.example.com/' },
				{ type: 'folder', id: 'f2', title: 'リリース', icon: 'star', color: '#d97706', children: [
					{ type: 'bookmark', id: 'b6', title: 'リリースの手順', url: 'https://docs.example.dev/release' },
				] },
			] },
			{ type: 'bookmark', id: 'b3', title: 'GitHub', url: 'https://github.com/example/app' },
			{ type: 'folder', id: 'f3', title: '資料', icon: 'book', color: '#16a34a', children: [] },
		],
		favicons: {},
	});
	useAppStore.setState({
		workspace: { ...workspace, capabilities: [...(workspace.capabilities ?? []), PcCapability.BrowserKeys, PcCapability.BrowserSpace, PcCapability.BrowserPage, PcCapability.BrowserFocus, PcCapability.BrowserBookmarks] },
		browserFrame: frame,
		browserPage: page(current, options.loading === true),
		browserFocus: undefined,
		browserSelection: { targetId: current.targetId, url: current.url, desktopEpoch: workspace.desktopEpoch },
		browserTargets: async () => ({ targets: TARGETS, scoped: true }),
		browserStart: async (targetId: string) => {
			current = TARGETS.find(target => target.targetId === targetId) ?? current;
			useAppStore.setState({ browserPage: page(current), browserFocus: undefined });
		},
		browserStop: async () => { },
		browserInput: (input: BrowserInput) => {
			console.log('[para-dev] browser input', JSON.stringify(input));
			if (input.kind === 'tap') {
				// 映像の上の方（検索欄のあたり）を押したら、検索欄にフォーカスが入ったことにする。
				const onSearch = (input.ny ?? 1) < 0.12 && (input.nx ?? 0) > 0.6;
				useAppStore.setState({ browserFocus: onSearch
					? { t: 'focus', targetId: current.targetId, seq: ++focusSeq, focused: true, field: 'text', inputType: 'search', value: 'worktree', fromTap: true }
					: { t: 'focus', targetId: current.targetId, seq: ++focusSeq, focused: false } });
			} else if (input.kind === 'open' || input.kind === 'navigate') {
				const url = input.kind === 'navigate' ? input.url ?? current.url : legacyNavigateUrl(input.text ?? '') ?? current.url;
				useAppStore.setState({ browserPage: { ...page(current), url, title: url } });
			} else if (input.kind === 'replace') {
				useAppStore.setState({ browserFocus: { t: 'focus', targetId: current.targetId, seq: ++focusSeq, focused: true, field: 'text', inputType: 'search', value: input.text ?? '' } });
			}
		},
		setJpegFramesSuspended: () => { },
	});
}

/** 開発ビルド専用: 見本のページで、映像のタップと同じく検索欄にフォーカスを入れる。 */
export function focusBrowserDemo(): void {
	if (!__DEV__) {
		return;
	}
	useAppStore.getState().browserInput({ kind: 'tap', nx: 0.8, ny: 0.04 });
}
