// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { useWsHeader, useOpenDrawerPan } from '../../src/components/wsDrawer.js';
import { FilesPanel } from '../../src/components/filesPanel.js';
import { FilesSearchField } from '../../src/components/filesSearchField.js';
import { useFilesSearch } from '../../src/filesSearch.js';
import { useIsRegularWidth } from '../../src/hooks/useSizeClass.js';
import { CONTENT_MAX_WIDTH } from '../../src/ipad/ipadLayout.js';
import { type ParaHeaderIcon } from '../../src/paraHeader.js';
import { colors } from '../../src/theme.js';
import { hapticImpact } from '../../src/haptics.js';

/**
 * ファイルタブ。エージェントタブのホーム統合で下部タブに空きができたため、
 * 旧「その他」タブのセグメント（ファイル/ブラウザ）をそれぞれ独立タブに昇格した。
 * 実体は旧files.tsx由来の filesPanel.tsx をそのまま使う。
 *
 * **検索欄はこの画面が描く。** 以前は常設のヘッダー層が「帯」として描いていたが、
 * ヘッダーをOS標準のナビゲーションバーへ移したときに層を伏せたため、押しても何も
 * 出ない状態になっていた（実機で確認済み）。ネイティブのバーに欄や帯は入らないので、
 * ホームの絞り込みチップと同じく**本文の上に張り付く形**で置く。
 * 開閉の状態をストアに置いたままなのは、バーのボタンの色と欄の表示を同じ状態から
 * 決めるため——詳しい理由は `src/filesSearch.ts` の説明を読むこと。
 *
 * この画面は ScrollView を持たず FilesPanel が自前でリストを描くため、一覧の頭の
 * 空きは paddingTop ではなく `contentInsetTop` として渡す。
 */
export default function FilesScreen() {
	const openDrawerPan = useOpenDrawerPan();
	const regular = useIsRegularWidth();
	const searchOpen = useFilesSearch(state => state.visible);
	// 検索欄の実測高さ。一覧の頭をこのぶんだけ空ける（欄の高さは端末の幅で変わる）。
	const [bandHeight, setBandHeight] = useState(0);
	const actions = useMemo<ParaHeaderIcon[]>(() => [{
		key: 'search',
		icon: 'search-outline',
		label: 'ファイルを検索',
		color: searchOpen ? colors.accent : colors.text,
		onPress: () => {
			hapticImpact('light');
			useFilesSearch.getState().toggle();
		},
	}], [searchOpen]);
	useWsHeader({ actions });

	return (
		<ConnectionGate>
		<GestureDetector gesture={openDrawerPan}>
		<View style={styles.screen}>
			<FilesPanel contentInsetTop={searchOpen ? bandHeight : 0} searchOpen={searchOpen} />
			{/* 上に張り付いた検索欄。`FilesPanel` より後に置いて前面に出す。 */}
			{searchOpen ? (
				<View
					style={[styles.searchBand, regular && styles.searchBandWide]}
					pointerEvents="box-none"
					onLayout={event => setBandHeight(Math.round(event.nativeEvent.layout.height))}
				>
					<FilesSearchField onClose={() => useFilesSearch.getState().close()} />
				</View>
			) : null}
		</View>
		</GestureDetector>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	// バーのすぐ下に固定する（本文はOSがバーの下から始めるので top は0でよい）。
	searchBand: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16, paddingBottom: 10 },
	// iPad: 本文カラムと左端を揃える（一覧が広がっても欄だけ画面幅にならないように）。
	searchBandWide: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
});
