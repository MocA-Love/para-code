// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useAppStore } from '../appState.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { colors } from '../theme.js';
import { IpadSidebar } from './ipadSidebar.js';
import { sidebarWidthFor } from './ipadLayout.js';

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
	// 未ペアリングの間はサイドバーに出せる中身が無い。空のサイドバーで画面を狭めるより、
	// ペアリング画面を全幅で見せるほうがよい。
	// `ready` は見ない。起動直後は false なので、`ready && !paired` で判定すると
	// 初期化が終わるまでの一瞬だけ空のサイドバーが出てから畳まれる。
	const paired = useAppStore(s => s.paired);
	const showSidebar = regular && paired;

	// **ツリーの形は常に同じに保つ**。`children` はこのアプリのナビゲーションスタック全体で、
	// 早期returnで階層を出し入れするとReactが位置の変化を別要素とみなして丸ごと
	// 作り直してしまう（ターミナルのWebView・ブラウザのミラー接続・遷移履歴・スクロール位置が
	// すべて消える）。サイドバーの有無は幅0との出し分けだけで表現する。
	// ペアリング完了直後（paired: false → true）と、ウィンドウ幅の変化で必ず通る経路なので、
	// ここは条件分岐ではなくスタイルで切り替えること。
	return (
		<View style={styles.root}>
			<View style={[styles.sidebar, showSidebar ? { width: sidebarWidthFor(width) } : styles.sidebarHidden]}>
				{showSidebar ? <IpadSidebar /> : null}
			</View>
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
});
