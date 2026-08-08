// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { useWsHeader, useOpenDrawerPan } from '../../src/components/wsDrawer.js';
import { FilesPanel, FilesSearchField, useFilesLive } from '../../src/components/filesPanel.js';
import { useFilesSearch } from '../../src/filesSearch.js';
import { useParaHeaderHeight, type ParaHeaderIcon } from '../../src/paraHeader.js';
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
	const headerHeight = useParaHeaderHeight();
	const [searchOpen, setSearchOpen] = useState(false);
	const openDrawerPan = useOpenDrawerPan();
	// 切断中は欄を編集させない（打ち替えても検索は走らないので、古い結果に新しい条件が
	// 付いているように見えてしまう）。判定は一覧側と**同じもの**を使う。
	const live = useFilesLive();

	// **開閉は条件のストアとまとめて扱う。** 帯はタブを移るだけでもアンマウントされるので、
	// 「閉じた」の後始末を欄のアンマウントに紐づけてはいけない（行き来で入力が消える）。
	const close = useCallback(() => {
		setSearchOpen(false);
		useFilesSearch.getState().close();
	}, []);
	// **ストアへの書き込みを `setState` の updater の中でやらない。** updater は React が
	// レンダーフェーズで再実行することがあり（同一バッチの eager 評価失敗・開発時の
	// StrictMode の二重呼び出し）、レンダー中に外部ストアを触る形になる。
	const toggle = useCallback(() => {
		hapticImpact('light');
		if (searchOpen) {
			setSearchOpen(false);
			useFilesSearch.getState().close();
			return;
		}
		setSearchOpen(true);
		useFilesSearch.getState().open();
	}, [searchOpen]);

	// 検索欄は**ヘッダーの帯**に置く（ホームの絞り込みチップ・ターミナルのタブ列と同じ場所）。
	// 以前は本文の先頭に出していたので、ぱっと現れるうえ下まで読むと画面外へ行っていた。
	const searchBand = useMemo(() => (searchOpen
		? <FilesSearchField onClose={close} live={live} />
		: undefined), [searchOpen, close, live]);
	const actions = useMemo<ParaHeaderIcon[]>(() => [{
		key: 'search',
		icon: 'search-outline',
		label: 'ファイルを検索',
		color: searchOpen ? colors.accent : colors.text,
		onPress: toggle,
	}], [searchOpen, toggle]);
	useWsHeader({ actions, below: searchBand });

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
