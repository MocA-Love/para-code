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
export function TerminalInputBar({ live, input, onChangeInput, onSubmit, submitting, enterless, onToggleEnterless, uploading, onAttachImage, onLiveText, onLiveKey, onLiveArrow }: {
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
	/** ライブ入力で押された制御キー（⌫ は DEL の並び、改行は CR）。1回で送る。 */
	onLiveKey: (data: string) => void;
	/** ライブ入力中に外付けキーボードで押された矢印（iPad）。PC のターミナルへ送る。 */
	onLiveArrow: (key: 'up' | 'down' | 'left' | 'right') => void;
}) {
	const liveRef = useRef<TextInput>(null);
	const [liveFocused, setLiveFocused] = useState(false);
	// 外付けキーボードの ⌘↩（iPad）。送信ボタンと同じ（空なら Enter を送る）。
	const focused = useIsFocused();
	useShortcutSlot('send', focused && !submitting ? { send: () => { hapticImpact('medium'); onSubmit(); } } : undefined);
	const [lastTyped, setLastTyped] = useState('');
	// 外付けキーボードの矢印（iPad）。ライブ入力にフォーカスがある間は、入力欄ではなく PC のターミナルへ。
	useShortcutSlot('terminalArrows', live && liveFocused && focused ? { arrow: key => onLiveArrow(key) } : undefined);
	// ライブ入力の見えない入力欄の世代。Enter で送ったら新しい世代を足してフォーカスを移し、移ったら
	// 古いものを外す（入力欄を1行ぶんに保つ。clear() は RN 0.86 の iOS で捨てられることがあるので使わない）。
	// 2つを一瞬並べるのは、フォーカスを入力欄から入力欄へ直接渡してキーボードを閉じさせないため。
	const [captures, setCaptures] = useState<readonly number[]>([0]);
	const currentCapture = captures[captures.length - 1]!;
	const onLiveSend = (data: string) => {
		if (data === LIVE_ENTER) {
			onLiveKey(data);
			setLastTyped('');
			return;
		}
		if (data.length > 0 && [...data].every(char => char === LIVE_DEL)) {
			// DEL の並びは1回で送る（1文字ずつ送ると、その数だけ別々の操作として記録される）。
			onLiveKey(data);
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
				{captures.map(generation => (
					<LiveCapture
						key={generation}
						inputRef={generation === currentCapture ? liveRef : undefined}
						autoFocus={generation === currentCapture && generation > 0}
						onFocusChange={value => {
							setLiveFocused(value);
							// 新しい入力欄にフォーカスが移ったら、古い入力欄を外す
							if (value) {
								setCaptures(list => (list.length > 1 && list[list.length - 1] === generation ? [generation] : list));
							}
						}}
						onSend={onLiveSend}
						onSubmitted={() => setCaptures(list => {
							const last = list[list.length - 1]!;
							return last === generation ? [last, last + 1] : list;
						})}
					/>
				))}
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
 * （`liveInput.ts`）。1行ぶんしか持たない: Enter で送ったら `onSubmitted` で親に新しい入力欄を
 * 作らせ、自分は外される（前の行・パスワードを入力欄に残さない。clear() は RN 0.86 の iOS で
 * 捨てられることがあり、空になったかを推し量ると送り直しや取りこぼしが起きた）。
 *
 * キャレットは常に末尾に置く（変換中を除く）。PC のカーソルは行末にあり、入力欄だけ途中へ動くと
 * どこを直しているのか画面から分からなくなる。外付けキーボードの矢印は親が PC へ回す。
 *
 * 変換中かどうかは `onChange` の `isComposing`（RN へのパッチで iOS の marked text を渡している）で
 * 受け取る。`onChangeText` は文字列しか渡さないので使わない。
 */
function LiveCapture({ inputRef, autoFocus, onFocusChange, onSend, onSubmitted }: {
	inputRef: RefObject<TextInput | null> | undefined;
	autoFocus: boolean;
	onFocusChange: (focused: boolean) => void;
	onSend: (data: string) => void;
	onSubmitted: () => void;
}) {
	const localRef = useRef<TextInput | null>(null);
	const stateRef = useRef<LiveInputState>(LIVE_INPUT_EMPTY);
	// 入力欄のいまの文字列（生のまま。キャレットを末尾へ戻す位置に使う）と、変換中か。
	const rawTextRef = useRef('');
	const composingRef = useRef<boolean | undefined>(undefined);
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
			ref={instance => {
				localRef.current = instance;
				if (inputRef !== undefined) {
					inputRef.current = instance;
				}
			}}
			style={styles.liveCapture}
			autoFocus={autoFocus}
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
			onChange={event => {
				rawTextRef.current = event.nativeEvent.text;
				composingRef.current = readComposing(event.nativeEvent);
				dispatch({ kind: 'change', text: event.nativeEvent.text, composing: composingRef.current });
			}}
			onSelectionChange={event => {
				const { start, end } = event.nativeEvent.selection;
				// 変更イベントとの前後が決まっていないので、次の描画で最新の文字列と比べる。
				requestAnimationFrame(() => {
					const length = rawTextRef.current.length;
					if (composingRef.current !== true && (start !== end || end < length)) {
						localRef.current?.setSelection(length, length);
					}
				});
			}}
			onKeyPress={event => dispatch({ kind: 'key', key: event.nativeEvent.key })}
			onSubmitEditing={() => {
				dispatch({ kind: 'submit' });
				onSubmitted();
			}}
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
