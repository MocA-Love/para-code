// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useId, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useNavigation, useRoute } from 'expo-router';
import { useAppStore } from '../../../src/appState.js';
import { PcRouteContext } from '../../../src/features/pc/pcRouteContext.js';
import { PcScreen } from '../../../src/features/pc/pcScreen.js';
import { stackWithoutRoute } from '../../../src/features/pc/pcStackAnchor.js';
import { hapticSelection } from '../../../src/haptics.js';
import { useIsRegularWidth } from '../../../src/hooks/useSizeClass.js';
import { ColumnResizeHandle } from '../../../src/ipad/columnResizeHandle.js';
import { DetailColumnKeyContext, useDetailColumn, useDetailColumnOpen } from '../../../src/ipad/detailColumn.js';
import { sidebarWidthFor } from '../../../src/ipad/ipadLayout.js';
import { useIpadLayout } from '../../../src/ipad/ipadLayoutStore.js';
import { useShortcutSlot } from '../../../src/ipad/shortcutRegistry.js';
import { WindowLeadingEdge } from '../../../src/ipad/windowControls.js';
import { firstParam } from '../../../src/routes.js';
import { colors } from '../../../src/theme.js';

/**
 * 深いルート（通知から開いたセッションなど）をいきなり開いたときも、詳細の列の根を下に敷く。
 * 1列では戻ると PC の画面へ、2列では「エージェントが開かれていません」へ戻れるように。
 */
export const unstable_settings = { initialRouteName: 'index' };

/**
 * PC の中の画面（`/pc/[pcId]/…`）の器。iPad を広い幅（`useIsRegularWidth()`。700pt 以上、2列から縮めた
 * なら 660pt まで）で使っているときは、左の列に PC の画面、右の列（詳細の列）にセッション・ソース管理などの
 * Stack を並べる（Orca モバイルの iPad と同じ master-detail）。狭いときは左の列を幅 0 にして、詳細の列の根に
 * PC の画面を出す（iPhone と同じ押し進む形）。
 *
 * **1列 ⇄ 2列 の切り替えで木の形を変えない。** 詳細の列の Stack は常に同じ位置に置き、左の列は幅だけで
 * 出し入れする。形を変えると Stack が作り直され、セッションのターミナルの WebView や入力途中の文字が消える。
 *
 *  - 左の列の幅は 280〜560pt。境界をドラッグして変え、離すと保存する（`ipadLayoutStore.ts`）
 *  - 詳細にセッションなどが開いているときだけ、左の列を隠せる（見出しのボタン・⌘\。セッションの見出しに
 *    戻すボタンが出る）。隠した状態は既存の `sidebarCollapsed`（ブラウザのタブの「広く見る」と共有）
 */
export default function PcLayout() {
	const regular = useIsRegularWidth();
	const focused = useIsFocused();
	const pcId = firstParam(useLocalSearchParams<{ pcId?: string | string[] }>().pcId);
	const navigation = useNavigation();
	const routeKey = useRoute().key;
	// `withAnchor` で器を積む Stack（`app/pc/_layout.tsx`）の下に敷かれた、PC の無い器なら自分を取り除く
	// （`pcStackAnchor.ts`）。ルートの引数は後から変わらないので、PC の無い器が本物になることは無い。
	useEffect(() => {
		if (pcId !== undefined) {
			return;
		}
		const state = navigation.getState();
		const next = state !== undefined ? stackWithoutRoute(state, routeKey) : undefined;
		if (next !== undefined) {
			navigation.dispatch({ type: 'RESET', payload: next });
		}
	}, [pcId, navigation, routeKey]);
	// 自分の詳細の列の印。PC の画面が2枚積まれても、それぞれ自分の列の様子だけを読む（`detailColumn.ts`）。
	const columnKey = useId();
	const detailOpen = useDetailColumnOpen(columnKey);
	// 前面に来たら自分の詳細の列を前面とみなさせる。器が作り直されずに前面へ戻った場合、根（`index.tsx`）の
	// attach は走り直さない（`detailColumn.ts`）。
	// 初めて置かれたとき・1列から2列に戻ったときは、子の根の attach が先に走ってから、ここで前面に移す。
	useEffect(() => {
		if (focused && regular) {
			useDetailColumn.getState().bringToFront(columnKey);
		}
	}, [focused, regular, columnKey]);
	const collapsed = useAppStore(s => s.sidebarCollapsed);
	const setCollapsed = useAppStore(s => s.setSidebarCollapsed);
	const savedSidebarWidth = useIpadLayout(s => s.sidebarWidth);
	// 器の幅（縦向き・Split View で狭いときは、詳細の列に 320pt 残るよう左の列を縮めて使う）。
	const [containerWidth, setContainerWidth] = useState(0);
	const sidebarWidth = sidebarWidthFor(savedSidebarWidth, containerWidth);
	const setSidebarWidth = useIpadLayout(s => s.setSidebarWidth);
	const commitWidths = useIpadLayout(s => s.commit);
	const dragStart = useRef(sidebarWidth);

	// 何も開いていないときは隠さない（隠すと右の「エージェントが開かれていません」だけになる）。
	const canCollapse = regular && detailOpen;
	const showSidebar = regular && (!collapsed || !detailOpen);
	const toggle = () => {
		hapticSelection();
		setCollapsed(!collapsed);
	};
	useShortcutSlot('sidebar', focused && canCollapse ? { toggle } : undefined);

	if (pcId === undefined) {
		// 上の片付けで消える器。PC の画面・詳細の列を作らない。
		return null;
	}
	return (
		<PcRouteContext.Provider value={pcId}>
		<DetailColumnKeyContext.Provider value={columnKey}>
		<View style={styles.root} onLayout={event => setContainerWidth(event.nativeEvent.layout.width)}>
			{/* 隠している間（幅 0）は、中の PC の画面を VoiceOver からも外す（見えない行を読み上げない・選べない）。 */}
			<View
				style={[styles.sidebar, { width: showSidebar ? sidebarWidth : 0 }, showSidebar ? styles.sidebarBorder : undefined]}
				accessibilityElementsHidden={!showSidebar}
				importantForAccessibility={showSidebar ? 'auto' : 'no-hide-descendants'}
			>
				{/* 中身の幅は常に保存した幅にしておく（隠している間に行が折り返して組み直されないように）。 */}
				<View style={[styles.sidebarInner, { width: sidebarWidth }]}>
					{regular ? <PcScreen placement="column" {...(canCollapse && !collapsed ? { onCollapse: toggle } : {})} /> : null}
				</View>
			</View>
			<View style={styles.detail}>
				{/* 左の列が出ている間、ウィンドウの左上の隅（iPad のウィンドウ操作ボタン）に来るのは左の列の見出し。 */}
				<WindowLeadingEdge value={!showSidebar}>
					<Stack
						screenOptions={({ route }) => ({
							headerShown: false,
							contentStyle: { backgroundColor: colors.bg },
							// 2列では左の列の行を押すと右の中身が入れ替わる（押し進む動きは付けない。Orca と同じ）。
							animation: regular && route.name === 'session/[spaceId]' ? 'none' : 'default',
						})}
					/>
				</WindowLeadingEdge>
			</View>
			{showSidebar ? (
				<ColumnResizeHandle
					x={sidebarWidth}
					label="サイドバーの幅"
					onStart={() => { dragStart.current = sidebarWidth; }}
					onMove={dx => setSidebarWidth(dragStart.current + dx)}
					onEnd={commitWidths}
					onStep={delta => { setSidebarWidth(sidebarWidth + delta); commitWidths(); }}
				/>
			) : null}
		</View>
		</DetailColumnKeyContext.Provider>
		</PcRouteContext.Provider>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		flexDirection: 'row',
		backgroundColor: colors.bg,
	},
	sidebar: {
		overflow: 'hidden',
	},
	sidebarBorder: {
		borderRightWidth: 1,
		borderRightColor: colors.border,
	},
	sidebarInner: {
		flex: 1,
	},
	detail: {
		flex: 1,
		minWidth: 0,
	},
});
