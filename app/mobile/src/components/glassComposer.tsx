// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface, liquidGlass } from './glassSurface.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import { glassComposerTextInputBehavior } from './glassComposerBehavior.js';

/**
 * Liquid Glassの2段コンポーザー（mo.html 案A2/T1）。上段にテキスト入力、
 * 下段にツール列（左: 呼び出し側が渡す任意のツール、右: 送信ボタン）。
 * 面はGlassSurface（iOS 26+は本物のLiquid Glass、それ未満はBlurViewフォールバック）で、
 * タブバーと質感を揃える。内側のボタン群はHIGに従いglass化しない（glass on glass回避）。
 * エージェントタブ（モデル/Effortピル）とターミナルタブ（特殊キー列）で共用する。
 */
export function GlassComposer({ value, onChangeText, onSubmit, placeholder, tools, sendIcon = 'arrow-up', sendDisabled = false, monospace = false }: {
	value: string;
	onChangeText: (text: string) => void;
	onSubmit: () => void;
	placeholder: string;
	/** 下段ツール列の左側（モデルピル・特殊キー列など）。横幅が余ればスペーサで送信ボタンを右端に押す。 */
	tools?: ReactNode;
	sendIcon?: 'arrow-up' | 'return-down-back';
	sendDisabled?: boolean;
	/** ターミナル入力等、等幅フォントで表示する場合。 */
	monospace?: boolean;
}) {
	const inputBehavior = glassComposerTextInputBehavior();
	return (
		// ネイティブglassは素材自体が縁の光を持つため、フォールバック時のみ枠線を描く
		<GlassSurface style={[styles.wrap, !liquidGlass && styles.wrapFallbackBorder]}>
			<ComposerTextInput value={value} onChangeText={onChangeText} placeholder={placeholder} monospace={monospace} multiline={inputBehavior.multiline} blurOnSubmit={inputBehavior.blurOnSubmit} />
			<View style={styles.tools}>
				<View style={styles.toolsLeft}>{tools}</View>
				<Pressable
					style={({ pressed }) => [styles.sendBtn, sendDisabled && styles.sendBtnDisabled, pressed && styles.sendBtnPressed]}
					onPress={() => { hapticImpact('medium'); onSubmit(); }}
					disabled={sendDisabled}
					accessibilityLabel="送信"
				>
					<Ionicons name={sendIcon} size={18} color="#fff" />
				</Pressable>
			</View>
		</GlassSurface>
	);
}

/**
 * モデル一覧・Effort・チャット本文など入力以外の状態更新から、変換中のネイティブIMEを隔離する。
 * value/onChangeText等が同一ならReact.memoがTextInputへのprops再適用を止める。
 */
const ComposerTextInput = memo(function ComposerTextInput({ value, onChangeText, placeholder, monospace, multiline, blurOnSubmit }: {
	value: string;
	onChangeText: (text: string) => void;
	placeholder: string;
	monospace: boolean;
	multiline: boolean;
	blurOnSubmit: boolean;
}) {
	return <TextInput
		style={[styles.input, monospace && styles.inputMono]}
		value={value}
		onChangeText={onChangeText}
		placeholder={placeholder}
		placeholderTextColor={colors.textDim}
		autoCapitalize="none"
		autoCorrect={false}
		multiline={multiline}
		onFocus={hapticSelection}
		blurOnSubmit={blurOnSubmit}
	/>;
});

const styles = StyleSheet.create({
	wrap: {
		borderRadius: 26,
		overflow: 'hidden', paddingTop: 12, paddingBottom: 10, paddingHorizontal: 14,
	},
	wrapFallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
	input: { color: colors.text, fontSize: 15, paddingHorizontal: 4, paddingBottom: 12, maxHeight: 120 },
	inputMono: { fontFamily: 'Menlo', fontSize: 13 },
	tools: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	// 下段ツール列（特殊キー等）に送信ボタン以外の全幅を使わせる（キーが見切れないように）
	toolsLeft: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
	sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.accent2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
	sendBtnDisabled: { backgroundColor: colors.surface3 },
	sendBtnPressed: { opacity: 0.6 },
});
