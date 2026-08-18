// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { hapticSelection } from '../haptics.js';
import { colors } from '../theme.js';
import { IpadSidebar } from './ipadSidebar.js';
import { sidebarWidthFor, SIDEBAR_RAIL_WIDTH } from './ipadLayout.js';

/**
 * iPadの2カラムシェル。ルートレイアウトのナビゲーションスタック全体をこれで包み、
 * 画面左にワークスペースサイドバーを常設したまま、右側でこれまで通りの遷移
 * （タブ・エージェント詳細・ブラウザ・各種モーダル）を行う。
 *
 * ナビゲーションツリー自体には手を入れない設計にしている。スタックを右カラムへ
 * 収めるだけなので、ディープリンク・通知タップ・戻る操作といった既存の動線が
 * そのまま生き、iPhone版とロジックを共有できる。
 *
 * 幅が狭いとき（iPhone、iPadのSplit View/Slide Over）はサイドバーを幅0にするだけで、
 * ラップ用のViewは残る（理由は下の実装コメント）。`content` は `flex: 1` で親いっぱいに
 * 広がるため、描画結果・レイアウト計算はiPhone版と同一になる。
 */
export function IpadShell({ children }: { children: ReactNode }) {
	const regular = useIsRegularWidth();
	const { width } = useWindowDimensions();
	const insets = useStableInsets();
	// 未ペアリングの間はサイドバーに出せる中身が無い。空のサイドバーで画面を狭めるより、
	// ペアリング画面を全幅で見せるほうがよい。
	// `ready` は見ない。起動直後は false なので、`ready && !paired` で判定すると
	// 初期化が終わるまでの一瞬だけ空のサイドバーが出てから畳まれる。
	const paired = useAppStore(s => s.paired);
	const showSidebar = regular && paired;
	const collapsed = useAppStore(s => s.sidebarCollapsed);
	const setSidebarCollapsed = useAppStore(s => s.setSidebarCollapsed);
	const sidebarWidth = collapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidthFor(width);

	// **ツリーの形は常に同じに保つ**。`children` はこのアプリのナビゲーションスタック全体で、
	// 早期returnで階層を出し入れするとReactが位置の変化を別要素とみなして丸ごと
	// 作り直してしまう（ターミナルのWebView・ブラウザのミラー接続・遷移履歴・スクロール位置が
	// すべて消える）。サイドバーの有無は幅0との出し分けだけで表現する。
	// ペアリング完了直後（paired: false → true）と、ウィンドウ幅の変化で必ず通る経路なので、
	// ここは条件分岐ではなくスタイルで切り替えること。
	return (
		<View style={styles.root}>
			<View style={[styles.sidebar, showSidebar ? { width: sidebarWidth } : styles.sidebarHidden]}>
				{showSidebar ? <IpadSidebar collapsed={collapsed} /> : null}
			</View>
			{/* 開閉ボタン。macOS/Xcode等の常設サイドバーと同じ、ボタン1つだけの控えめな操作点。
			    個々の画面ヘッダーには触れない。サイドバー幅の内側に収め、右カラム側のヘッダー
			    （ParaHeaderLayerの島やネイティブの戻るシェブロン、いずれも本文左端+16pt付近から
			    始まる）とは重ならない位置に置く。 */}
			{showSidebar ? (
				<Pressable
					style={[styles.toggle, { left: sidebarWidth - 34, top: insets.top + 8 }]}
					onPress={() => { hapticSelection(); setSidebarCollapsed(!collapsed); }}
					hitSlop={10}
					accessibilityRole="button"
					accessibilityLabel={collapsed ? 'サイドバーを開く' : 'サイドバーを畳む'}
				>
					<Ionicons name={collapsed ? 'chevron-forward' : 'chevron-back'} size={13} color={colors.textDim} />
				</Pressable>
			) : null}
			<View style={styles.content}>{children}</View>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg },
	sidebar: { flexShrink: 0 },
	// 幅0＋overflow:hidden で「無いのと同じ」にする（アンマウントはしない）。
	sidebarHidden: { width: 0, overflow: 'hidden' },
	// minWidth: 0 が無いと、右カラムの中身（長いパスやコード行）が縮まずに
	// サイドバーを画面外へ押し出してしまう。
	content: { flex: 1, minWidth: 0, backgroundColor: colors.bg },
	toggle: {
		position: 'absolute', width: 26, height: 26, borderRadius: 13,
		backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
		alignItems: 'center', justifyContent: 'center', zIndex: 10,
	},
});
