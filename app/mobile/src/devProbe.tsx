// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { useGlobalSearchParams, useNavigationContainerRef, usePathname, useRouter } from 'expo-router';
import { useAppStore } from './appState.js';
import { installDemoData } from './dev/demoData.js';
import { installTerminalDemo } from './dev/terminalDemo.js';
import { openPcRoute } from './features/pc/openPcRoute.js';
import { usePcListView } from './features/pc/pcListViewStore.js';
import type { RouteHref } from './routes.js';
import { setDevWidthOverride } from './hooks/useSizeClass.js';
import { dispatchShortcut } from './ipad/shortcutHost.js';
import { useDetailColumn } from './ipad/detailColumn.js';
import { useIpadLayout } from './ipad/ipadLayoutStore.js';
import { devDescribeKeyCommands, devDescribeWindowControls, devFireKeyCommand, devRequestOrientation } from '../modules/para-ipad-input/index.js';

/**
 * 開発ビルド専用: いま開いている画面をデバッガ（Metro の CDP）から読めるようにする。
 *
 * - 画面が変わるたびに `[para-dev] route ...` を console に出す
 * - `globalThis.__paraDev` に現在のパスと router とストアを置く（デバッガから `router.push()` で画面を移し、
 *   `store.getState()` で実在する PC・スペースの ID を読める）
 * - ペアリングの無いシミュレータ用に、見本のデータを入れる `demo()`、ターミナルの表示に見本の出力を流す
 *   `terminalDemo()`、アプリの幅を狭めて 2列 ⇄ 1列 を確かめる `setWidth(pt | undefined)` も置く
 *
 * `__DEV__` のときだけ描画する（リリースビルドには何も残らない）。
 */
export function DevProbe() {
	const pathname = usePathname();
	const params = useGlobalSearchParams();
	const router = useRouter();
	const navigation = useNavigationContainerRef();
	// params はレンダーのたびに別オブジェクトになるので、中身の文字列で変化を判定する。
	const paramsKey = JSON.stringify(params);
	useEffect(() => {
		(globalThis as { __paraDev?: unknown }).__paraDev = {
			pathname, params: JSON.parse(paramsKey) as unknown, router, store: useAppStore, at: Date.now(),
			demo: installDemoData,
			// ターミナルの表示に見本の出力（多数の行と末尾のプロンプト）を流す。`demo()` の後に呼ぶ。
			terminalDemo: installTerminalDemo,
			setWidth: setDevWidthOverride,
			shortcut: (id: string) => dispatchShortcut(id, router),
			orientation: (landscape: boolean) => devRequestOrientation(landscape),
			keyCommands: devDescribeKeyCommands,
			// ウィンドウ操作ボタンを避ける余白の生の値（1回目で測らせ、2回目で読む）。
			windowControls: devDescribeWindowControls,
			// 左の列の幅（つまみを動かしたのと同じ値の変え方。離したときの保存も行う）。
			// PC の画面の一覧の表示条件（絞り込み・グループ・畳んだ段・検索語）。
			pcListView: usePcListView,
			sidebarWidth: (width: number) => { useIpadLayout.getState().setSidebarWidth(width); useIpadLayout.getState().commit(); return useIpadLayout.getState().sidebarWidth; },
			// 詳細の列（置いた順。最後が前面）。
			detail: () => JSON.stringify(useDetailColumn.getState().entries.map(({ key, pcId, open }) => ({ key, pcId, open }))),
			fireKey: devFireKeyCommand,
			// 画面の積み方（Stack ごとのルート名の並び）。2列で詳細の列が積み増されていないかを見る。
			stacks: () => describeStacks(navigation.getRootState()),
			// 通知のタップ（`focus`）・通知の一覧と中継の画面（`overlay`）と同じ開き方。
			openPc: (href: RouteHref, from: 'focus' | 'overlay' = 'focus') => openPcRoute(router, navigation, href, from),
			// ナビゲーションの状態そのもの（ルートの引数まで見るとき）。
			rootState: () => JSON.stringify(navigation.getRootState()),
		};
		console.log(`[para-dev] route ${pathname} ${paramsKey}`);
	}, [pathname, paramsKey, router, navigation]);
	return null;
}

interface NavStateLike {
	readonly routes: readonly { readonly name: string; readonly params?: object; readonly state?: NavStateLike }[];
}

/** Stack ごとのルート名の並び。`pcId` を持つルートは `名前(pcId)` と書く（どの PC の器かを見分けるため）。 */
function describeStacks(state: NavStateLike | undefined): string {
	if (state === undefined) {
		return '';
	}
	return `[${state.routes.map(route => {
		const pcId = (route.params as { pcId?: unknown } | undefined)?.pcId;
		const name = typeof pcId === 'string' ? `${route.name}(${pcId})` : route.name;
		return route.state !== undefined ? `${name} ${describeStacks(route.state)}` : name;
	}).join(', ')}]`;
}
