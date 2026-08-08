// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { useWsHeader, useOpenDrawerPan } from '../../src/components/wsDrawer.js';
import { FilesPanel } from '../../src/components/filesPanel.js';
import { useFilesSearch } from '../../src/filesSearch.js';
import { morphParaHeaderNext, useParaHeaderHeight, type ParaHeaderIcon } from '../../src/paraHeader.js';
import { colors } from '../../src/theme.js';
import { hapticImpact } from '../../src/haptics.js';

/**
 * ファイルタブ。エージェントタブのホーム統合で下部タブに空きができたため、
 * 旧「その他」タブのセグメント（ファイル/ブラウザ）をそれぞれ独立タブに昇格した。
 * 実体は旧files.tsx由来の filesPanel.tsx をそのまま使う。
 *
 * ヘッダーは浮かぶ島なので、本文の先頭にはその高さぶんの空きが要る。この画面は
 * ScrollView を持たず FilesPanel が自前でリストを描くため、paddingTop ではなく
 * `contentInsetTop` として渡す。
 *
 * 検索欄そのものは**この画面ではなく常設のヘッダー層が描く**（`paraHeaderLayer.tsx`）。
 * 開閉の状態をストアに置いてあるのは、層と画面が同じ描画で変わるようにするため——
 * 詳しい理由は `src/filesSearch.ts` の説明を読むこと。
 */
export default function FilesScreen() {
	const headerHeight = useParaHeaderHeight();
	const openDrawerPan = useOpenDrawerPan();
	const searchOpen = useFilesSearch(state => state.visible);
	const actions = useMemo<ParaHeaderIcon[]>(() => [{
		key: 'search',
		icon: 'search-outline',
		label: 'ファイルを検索',
		color: searchOpen ? colors.accent : colors.text,
		// **予約と状態変更を同じ関数の中で連続して行う。** `LayoutAnimation` の予約は中身に
		// 関係なく次の1描画に消費されるので、状態変更が別の描画へずれると効かない。
		onPress: () => {
			hapticImpact('light');
			morphParaHeaderNext();
			useFilesSearch.getState().toggle();
		},
	}], [searchOpen]);
	useWsHeader({ actions });

	return (
		<ConnectionGate>
		<GestureDetector gesture={openDrawerPan}>
		<View style={styles.screen}>
			<FilesPanel contentInsetTop={headerHeight} searchOpen={searchOpen} />
		</View>
		</GestureDetector>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
});
