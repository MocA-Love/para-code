// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { monoFamily } from '../monoFont.js';
import { colors, HIT_SIZE, radius, squircle, type } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import { useThemeColors } from '../ui/themeColorsStore.js';
import { TERMINAL_KEY_REPEAT_DELAY_MS, TERMINAL_KEY_REPEAT_INTERVAL_MS, TERMINAL_KEY_REPEAT_MAX } from '../terminalKeys.js';
import { BROWSER_ACCESSORY_KEYS, browserEmptyBackspaceInput, browserKeyInput, browserSubmitInput, type BrowserInput, type BrowserKeyDef } from '../browserKeys.js';

/** キーの見た目の高さ。当たり判定は上下の hitSlop で 44pt にする（ターミナルのキー行と同じ）。 */
const KEY_HEIGHT = 36;
const KEY_SLOP = { top: (HIT_SIZE - KEY_HEIGHT) / 2, bottom: (HIT_SIZE - KEY_HEIGHT) / 2 };

/**
 * ブラウザ画面の下に出す文字入力（ツールバーのキーボードのボタンで開く）。
 *
 * - 上の段: 特殊キー（Esc・Tab・⇧Tab・矢印・⌫・⏎）。PC が `browser.keys.v1` を持たなければ代わりに案内を出す
 * - 下の段: 閉じる・入力欄・送信。確定した文字を PC のページのフォーカス先へ入れる（日本語は変換を確定してから）
 * - 入力欄が空のときの Return は Enter、⌫ はページの側の 1 文字を消す
 *
 * キーボードに隠れないのは、セッションの画面がキーボードの被覆ぶん下を空けているため（`useKeyboardCoverage`）。
 */
export function BrowserKeyInput({ live, keysSupported, bottomPadding, onInput, onClose }: {
	live: boolean;
	/** PC が特殊キー（`browser.keys.v1`）を受けるか。 */
	keysSupported: boolean;
	bottomPadding: number;
	onInput: (input: BrowserInput) => void;
	onClose: () => void;
}) {
	const theme = useThemeColors();
	const [text, setText] = useState('');
	// onKeyPress は onChangeText より先に来るので、押した時点の中身は ref で読む。
	const textRef = useRef('');
	textRef.current = text;
	const onInputRef = useRef(onInput);
	onInputRef.current = onInput;

	const repeatTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const stopRepeat = () => {
		if (repeatTimer.current !== undefined) {
			clearInterval(repeatTimer.current);
			repeatTimer.current = undefined;
		}
	};
	// 押している最中に閉じても送り続けないよう、外れるときに必ず止める。
	useEffect(() => stopRepeat, []);

	const pressKey = (def: BrowserKeyDef) => {
		hapticImpact('light');
		onInputRef.current(browserKeyInput(def));
	};
	const startRepeat = (def: BrowserKeyDef) => {
		stopRepeat();
		pressKey(def);
		let sent = 1;
		repeatTimer.current = setInterval(() => {
			if (sent >= TERMINAL_KEY_REPEAT_MAX) {
				stopRepeat();
				return;
			}
			sent++;
			onInputRef.current(browserKeyInput(def));
		}, TERMINAL_KEY_REPEAT_INTERVAL_MS);
	};

	const sendText = () => {
		const input = browserSubmitInput(textRef.current, keysSupported);
		if (input === undefined) {
			return;
		}
		hapticImpact('light');
		onInput(input);
		setText('');
	};

	const canSend = live && text.length > 0;
	return (
		<View style={[styles.wrap, { paddingBottom: bottomPadding }]}>
			{keysSupported ? (
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.keysContent}
					keyboardShouldPersistTaps="always"
				>
					{BROWSER_ACCESSORY_KEYS.map(def => (
						<Pressable
							key={def.id}
							disabled={!live}
							style={({ pressed }) => [styles.key, pressed && styles.keyPressed, !live && styles.disabled]}
							hitSlop={KEY_SLOP}
							// 送るのは指を離したときか長押しの成立時（触れただけでは送らない。横スクロールで誤爆しない）。
							onPress={() => pressKey(def)}
							{...(def.repeat ? {
								onLongPress: () => startRepeat(def),
								onPressOut: stopRepeat,
								delayLongPress: TERMINAL_KEY_REPEAT_DELAY_MS,
							} : {})}
							accessibilityRole="button"
							accessibilityLabel={def.accessibilityLabel}
							accessibilityState={{ disabled: !live }}
						>
							<Text style={styles.keyText}>{def.label}</Text>
						</Pressable>
					))}
				</ScrollView>
			) : (
				<Text style={styles.hint}>Enter・矢印などのキーは、PC の Para Code を更新すると送れます。</Text>
			)}
			<View style={styles.inputRow}>
				<Pressable
					style={({ pressed }) => [styles.iconButton, pressed && styles.keyPressed]}
					onPress={() => { hapticSelection(); onClose(); }}
					accessibilityRole="button"
					accessibilityLabel="文字入力を閉じる"
				>
					<Ionicons name="chevron-down" size={16} color={colors.text} />
				</Pressable>
				<TextInput
					style={styles.input}
					value={text}
					onChangeText={setText}
					onSubmitEditing={sendText}
					onKeyPress={event => {
						if (event.nativeEvent.key !== 'Backspace' || textRef.current.length > 0) {
							return;
						}
						const input = browserEmptyBackspaceInput(keysSupported);
						if (input !== undefined) {
							onInput(input);
						}
					}}
					placeholder="ページに入力…"
					placeholderTextColor={colors.textDim}
					autoFocus
					autoCapitalize="none"
					autoCorrect={false}
					spellCheck={false}
					returnKeyType="send"
					// 空の Return を Enter として送るので、空でも押せるようにしておく。
					enablesReturnKeyAutomatically={false}
					submitBehavior="submit"
					editable={live}
					accessibilityLabel="ブラウザのページに送る文字"
				/>
				<Pressable
					disabled={!canSend}
					style={({ pressed }) => [styles.iconButton, pressed && styles.keyPressed, !canSend && styles.disabled]}
					onPress={sendText}
					accessibilityRole="button"
					accessibilityLabel="文字を送る"
					accessibilityState={{ disabled: !canSend }}
				>
					<Ionicons name="arrow-up-circle" size={22} color={canSend ? theme.accent : colors.textDim} />
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { paddingHorizontal: 12, gap: 6 },
	// 縦の余白は、キーの上下 hitSlop をスクロール領域の中に収めるため（はみ出した当たり判定は OS に拾われない）。
	keysContent: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingVertical: KEY_SLOP.top },
	key: {
		height: KEY_HEIGHT, minWidth: HIT_SIZE, paddingHorizontal: 10,
		alignItems: 'center', justifyContent: 'center',
		backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border,
		borderRadius: radius.key, ...squircle,
	},
	keyPressed: { backgroundColor: colors.surface2, borderColor: colors.borderStrong },
	keyText: { color: colors.text, fontSize: type.meta, fontFamily: monoFamily },
	disabled: { opacity: 0.45 },
	hint: { color: colors.textDim, fontSize: type.caption, paddingVertical: 4 },
	inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	iconButton: {
		width: HIT_SIZE, height: HIT_SIZE, alignItems: 'center', justifyContent: 'center',
		backgroundColor: colors.panel, borderRadius: radius.control, ...squircle, borderWidth: 1, borderColor: colors.border,
	},
	input: {
		flex: 1, minWidth: 0, minHeight: HIT_SIZE, color: colors.text, fontSize: type.body,
		backgroundColor: colors.panel, borderRadius: radius.input, ...squircle, borderWidth: 1, borderColor: colors.border,
		paddingHorizontal: 12, paddingVertical: 8,
	},
});
