// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowUp, CornerDownLeft, ImagePlus, Keyboard as KeyboardIcon } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { terminalSubmitIcon } from '../../terminalKeys.js';
import { colors, radius, space, type } from '../../theme.js';
import { Icon } from '../../ui/index.js';
import { HELD_PREEDIT_COMMIT_DELAY_MS, LIVE_DEL, LIVE_ENTER, LIVE_INPUT_EMPTY, liveInputStep, type LiveInputEvent, type LiveInputState } from './liveInput.js';
import { useIsFocused } from 'expo-router';
import { useShortcutSlot } from '../../ipad/shortcutRegistry.js';

/** 入力バーの部品の見た目（モックの `.tinput` / `.dict` / `.tsend`: 34）。当たり判定は 44 に広げる。 */
const CONTROL = 34;
const ROUND_SLOP = hitSlopToMinimum(CONTROL, CONTROL);
const FIELD_SLOP = hitSlopToMinimum(CONTROL);

/**
 * ターミナルの入力バー（Orca の MobileSessionCommandDock の下段。モックの `.inputbar`）。
 *  - 通常: 等幅の入力欄・画像・「Enter なし」・送信。送信の記号は Enter が押されるなら ⏎、入力欄へ
 *    置くだけなら ↑（既存の `terminalSubmitIcon`）
 *  - ライブ入力: 入力欄の代わりに「ライブ入力」の枠。押すとキーボードが出て、打った文字がそのまま
 *    PC へ届く（⌫ は 1 文字削除、改行は Enter）。日本語は変換を確定したときに届き、変換中の文字は
 *    送らない。送る分の計算は `liveInput.ts`（入力欄を PC のプロンプトへ写す）
 */
export function TerminalInputBar({ live, input, onChangeInput, onSubmit, submitting, enterless, onToggleEnterless, uploading, onAttachImage, onLiveText, onLiveKey }: {
	live: boolean;
	input: string;
	onChangeInput: (text: string) => void;
	onSubmit: () => void;
	submitting: boolean;
	enterless: boolean;
	onToggleEnterless: () => void;
	uploading: boolean;
	onAttachImage: () => void;
	/** ライブ入力で打たれた文字。 */
	onLiveText: (text: string) => void;
	/** ライブ入力で押された制御キー（⌫ は DEL、改行は CR）。 */
	onLiveKey: (data: string) => void;
}) {
	const liveRef = useRef<TextInput>(null);
	const [liveFocused, setLiveFocused] = useState(false);
	// 外付けキーボードの ⌘↩（iPad）。送信ボタンと同じ（空なら Enter を送る）。
	const focused = useIsFocused();
	useShortcutSlot('send', focused && !submitting ? { send: () => { hapticImpact('medium'); onSubmit(); } } : undefined);
	const [lastTyped, setLastTyped] = useState('');
	const onLiveSend = (data: string) => {
		if (data === LIVE_ENTER) {
			onLiveKey(data);
			setLastTyped('');
			return;
		}
		if (data.length > 0 && [...data].every(char => char === LIVE_DEL)) {
			for (let i = 0; i < data.length; i++) {
				onLiveKey(LIVE_DEL);
			}
			setLastTyped(previous => previous.slice(0, Math.max(0, previous.length - data.length)));
			return;
		}
		onLiveText(data);
		setLastTyped(previous => (previous + data).slice(-40));
	};
	const imageButton = (
		<Pressable
			onPress={() => { hapticImpact('light'); onAttachImage(); }}
			disabled={uploading}
			hitSlop={ROUND_SLOP}
			style={({ pressed }) => [styles.round, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityState={{ disabled: uploading, busy: uploading }}
			accessibilityLabel="画像を添付"
		>
			{uploading ? <ActivityIndicator size="small" color={colors.textDim} /> : <Icon icon={ImagePlus} size={17} color={colors.textDim} strokeWidth={2.4} />}
		</Pressable>
	);

	if (live) {
		return (
			<View style={styles.bar}>
				<Pressable
					onPress={() => { hapticSelection(); liveRef.current?.focus(); }}
					hitSlop={FIELD_SLOP}
					style={[styles.liveField, liveFocused ? styles.liveFieldFocused : undefined]}
					accessibilityRole="button"
					accessibilityLabel="ライブ入力。押すとキーボードが出て、打った文字がそのまま PC に届きます"
				>
					<Icon icon={KeyboardIcon} color={colors.textDim} />
					<View style={styles.liveBody}>
						<Text style={styles.liveTitle}>ライブ入力</Text>
						<Text style={styles.liveSub} numberOfLines={1}>{liveFocused ? (lastTyped.length > 0 ? lastTyped : '打った文字がそのまま届きます') : 'タップしてキーボードを表示'}</Text>
					</View>
				</Pressable>
				{imageButton}
				<LiveCapture inputRef={liveRef} onFocusChange={setLiveFocused} onSend={onLiveSend} />
			</View>
		);
	}

	const sendIcon = terminalSubmitIcon(input, enterless) === 'arrow-up' ? ArrowUp : CornerDownLeft;
	return (
		<View style={styles.bar}>
			<TextInput
				style={styles.input}
				value={input}
				onChangeText={onChangeInput}
				placeholder={enterless ? 'Enter なしで入力…' : 'コマンドを入力…'}
				placeholderTextColor={colors.textMuted}
				autoCapitalize="none"
				autoCorrect={false}
				spellCheck={false}
				keyboardAppearance="dark"
				// 旧画面と同じく、キーボードの改行は入力欄の改行（複数行は貼り付けとして送る）。送るのは送信ボタンだけ。
				multiline
				blurOnSubmit={false}
				hitSlop={FIELD_SLOP}
				accessibilityLabel="コマンドの入力"
			/>
			{imageButton}
			<Pressable
				onPress={() => { hapticSelection(); onToggleEnterless(); }}
				hitSlop={FIELD_SLOP}
				style={[styles.toggle, enterless ? styles.toggleOn : undefined]}
				accessibilityRole="switch"
				accessibilityLabel="Enter なしで入力"
				accessibilityHint="オンにすると、送信しても Enter を押さずに入力だけします"
				accessibilityState={{ checked: enterless }}
			>
				<Text style={[styles.toggleText, enterless ? styles.toggleTextOn : undefined]}>Enterなし</Text>
			</Pressable>
			<Pressable
				onPress={() => { hapticImpact('medium'); onSubmit(); }}
				disabled={submitting}
				hitSlop={ROUND_SLOP}
				style={({ pressed }) => [styles.round, pressed ? styles.pressed : undefined]}
				accessibilityRole="button"
				accessibilityState={{ disabled: submitting }}
				accessibilityLabel={input.length === 0 ? 'Enter を送る' : enterless ? '入力欄に置く' : '送信して実行'}
			>
				<Icon icon={sendIcon} size={18} color={colors.textDim} strokeWidth={2.5} />
			</Pressable>
		</View>
	);
}

/**
 * ライブ入力で打った文字を受け取るだけの見えない入力欄。入力欄を PC のプロンプトへ写す
 * （`liveInput.ts`）。入力欄は空に戻さず、Enter で送ったところまでを覚えておく（RN 0.86 の iOS は
 * `clear()` を黙って捨てることがあり、空になったかを推し量ると送り直しや取りこぼしが起きた）。
 *
 * 変換中かどうかは `onChange` の `isComposing`（RN へのパッチで iOS の marked text を渡している）で
 * 受け取る。`onChangeText` は文字列しか渡さないので使わない。
 *
 * ライブ入力を切り替えるたびに作り直されるので、状態はここに持つ（前の入力欄の文字列を引き継がない）。
 */
function LiveCapture({ inputRef, onFocusChange, onSend }: {
	inputRef: RefObject<TextInput | null>;
	onFocusChange: (focused: boolean) => void;
	onSend: (data: string) => void;
}) {
	const stateRef = useRef<LiveInputState>(LIVE_INPUT_EMPTY);
	// 変換中かどうかをネイティブが教えてくれない環境（パッチの無いビルド）で、止まった末尾を送る予約。
	const heldTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const cancelHeldTimer = () => {
		if (heldTimerRef.current !== undefined) {
			clearTimeout(heldTimerRef.current);
			heldTimerRef.current = undefined;
		}
	};
	useEffect(() => cancelHeldTimer, []);
	const dispatch = (event: LiveInputEvent) => {
		cancelHeldTimer();
		const step = liveInputStep(stateRef.current, event);
		stateRef.current = step.state;
		for (const data of step.send) {
			onSend(data);
		}
		if (event.kind === 'change' && event.composing === undefined && step.state.held.length > 0) {
			heldTimerRef.current = setTimeout(() => {
				heldTimerRef.current = undefined;
				dispatch({ kind: 'flush' });
			}, HELD_PREEDIT_COMMIT_DELAY_MS);
		}
	};
	return (
		<TextInput
			ref={inputRef}
			style={styles.liveCapture}
			// 打ったとおりに届ける: 自動修正・大文字化・スペルチェック・候補・スマート句読点の挿入を切る
			// （スマート引用符・ダッシュは RN から切れないので、送る前に ASCII へ戻す）。
			// キーボードは既定のまま（日本語・絵文字も打てる。変換中の文字は liveInput.ts が送らない）。
			autoCapitalize="none"
			autoCorrect={false}
			spellCheck={false}
			autoComplete="off"
			textContentType="none"
			smartInsertDelete={false}
			keyboardAppearance="dark"
			blurOnSubmit={false}
			onFocus={() => onFocusChange(true)}
			onBlur={() => {
				onFocusChange(false);
				dispatch({ kind: 'flush' });
			}}
			onChange={event => dispatch({ kind: 'change', text: event.nativeEvent.text, composing: readComposing(event.nativeEvent) })}
			onKeyPress={event => dispatch({ kind: 'key', key: event.nativeEvent.key })}
			onSubmitEditing={() => dispatch({ kind: 'submit' })}
			accessibilityElementsHidden
			importantForAccessibility="no-hide-descendants"
		/>
	);
}

/**
 * 変更イベントの `isComposing`（入力欄に変換中の範囲があるか）。RN の型には無い
 * （`app/patches/react-native@0.86.0.patch` で足している）。載っていなければ undefined＝分からない。
 */
function readComposing(nativeEvent: object): boolean | undefined {
	const value = (nativeEvent as { readonly isComposing?: unknown }).isComposing;
	return typeof value === 'boolean' ? value : undefined;
}

const styles = StyleSheet.create({
	bar: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 46,
		paddingHorizontal: space.md,
		paddingVertical: 6,
		borderTopWidth: 1,
		borderTopColor: colors.border,
		backgroundColor: colors.panel,
	},
	input: {
		flex: 1,
		minWidth: 0,
		minHeight: CONTROL,
		maxHeight: 100,
		paddingHorizontal: space.md,
		paddingTop: 7,
		paddingBottom: 7,
		borderRadius: radius.input,
		backgroundColor: colors.raised,
		fontFamily: monoFamily,
		fontSize: type.input,
		color: colors.text,
	},
	round: {
		width: CONTROL,
		height: CONTROL,
		borderRadius: radius.pill,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: colors.raised,
	},
	pressed: {
		opacity: 0.7,
	},
	toggle: {
		height: CONTROL,
		justifyContent: 'center',
		paddingHorizontal: space.sm,
		borderRadius: radius.key,
		borderWidth: 1,
		borderColor: colors.border,
	},
	toggleOn: {
		borderColor: colors.textDim,
		backgroundColor: colors.raised,
	},
	toggleText: {
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.textMuted,
	},
	toggleTextOn: {
		color: colors.text,
	},
	liveField: {
		flex: 1,
		minWidth: 0,
		minHeight: CONTROL,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: 10,
		borderRadius: radius.input,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.raised,
	},
	liveFieldFocused: {
		borderColor: colors.textDim,
	},
	liveBody: {
		flex: 1,
		minWidth: 0,
	},
	liveTitle: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
	liveSub: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.textDim,
	},
	liveCapture: {
		position: 'absolute',
		width: 1,
		height: 1,
		opacity: 0,
	},
});
