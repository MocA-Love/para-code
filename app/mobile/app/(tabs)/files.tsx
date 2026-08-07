// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { HeaderActionButton, HeaderActionPill } from '../../src/components/screenHeader.js';
import { WsHeader, useOpenDrawerPan } from '../../src/components/wsDrawer.js';
import { FilesPanel } from '../../src/components/filesPanel.js';
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
 */
export default function FilesScreen() {
	const [headerHeight, setHeaderHeight] = useState(0);
	const [searchOpen, setSearchOpen] = useState(false);
	const openDrawerPan = useOpenDrawerPan();
	return (
		<ConnectionGate>
		<GestureDetector gesture={openDrawerPan}>
		<View style={styles.screen}>
			<FilesPanel contentInsetTop={headerHeight} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} />
			<WsHeader
				onHeightChange={setHeaderHeight}
				right={
					<HeaderActionPill>
						<HeaderActionButton
							icon="search-outline"
							label="ファイルを検索"
							color={searchOpen ? colors.accent : colors.text}
							expanded={searchOpen}
							onPress={() => { hapticImpact('light'); setSearchOpen(open => !open); }}
						/>
					</HeaderActionPill>
				}
			/>
		</View>
		</GestureDetector>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
});
