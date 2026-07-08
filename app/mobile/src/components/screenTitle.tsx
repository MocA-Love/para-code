// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme.js';

/**
 * 画面見出し（モックアップ mock-2.html 準拠）。`NativeTabs`にはネイティブヘッダーの
 * 概念が無いため、各タブ画面の先頭でこれを表示してタイトルを出す。
 * ステータスバー（時刻・ノッチ）との重なりを避けるため、SafeAreaのtopインセットを
 * ここで一括して確保する（NativeTabsの自動コンテンツインセットは先頭のスクロール
 * ビューにしか効かず、各画面はヘッダー行が非スクロール領域にあるため手動で扱う）。
 */
export function ScreenTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
	const insets = useSafeAreaInsets();
	return (
		<View style={[styles.wrap, { paddingTop: insets.top + 4 }]}>
			<View style={styles.textCol}>
				<Text style={styles.title}>{title}</Text>
				{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
			</View>
			{right}
		</View>
	);
}

const styles = StyleSheet.create({
	// 右paddingは狭め（右上にアクセサリ（通知ベル等）を置いたとき画面端に寄るように。BeReal風）
	wrap: { paddingLeft: 20, paddingRight: 12, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
	textCol: { flex: 1, minWidth: 0 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
	subtitle: { color: colors.textDim, fontSize: 11.5, marginTop: 2 },
});
