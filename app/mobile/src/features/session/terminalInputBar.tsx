// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowUp, CornerDownLeft, ImagePlus, Keyboard as KeyboardIcon } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { terminalSubmitIcon } from '../../terminalKeys.js';
import { colors, radius, space, type } from '../../theme.js';
import { Icon } from '../../ui/index.js';
import { HELD_PREEDIT_COMMIT_DELAY_MS, LIVE_DEL, LIVE_ENTER, LIVE_INPUT_EMPTY, liveInputStep, retireAfterControl, type LiveInputEvent, type LiveInputState } from './liveInput.js';
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
export function TerminalInputBar({ live, liveResetKey, liveConnected, input, onChangeInput, onSubmit, submitting, enterless, onToggleEnterless, uploading, onAttachImage, onLiveText, onLiveKey, onLiveArrow }: {
	live: boolean;
	/**
	 * 変わったらライブ入力の入力欄を空から作り直す（PC に届かなかった打鍵があった。Q144 A）。前の入力欄の文字は
	 * 送らない。
	 */
	liveResetKey: number;
	/** PC へ打鍵を送れる状態か。送れない間は、最後に打った文字の表示を進めない（届いたように見せない）。 */
	liveConnected: boolean;
	input: string;
	onChangeInput: (text: string) => void;
	onSubmit: () => void;
	submitting: boolean;
	enterless: boolean;
	onToggleEnterless: () => void;
	uploading: boolean;
	onAttachImage: () => void;
	/**
	 * ライブ入力で打たれた文字。Ctrl が点いていて制御文字として送った（文字としては PC に載らなかった）
	 * ときは true を返す。
	 */
	onLiveText: (text: string) => boolean;
	/** ライブ入力で押された制御キー（⌫ は DEL の並び、改行は CR）。1回で送る。 */
	onLiveKey: (data: string) => void;
	/** ライブ入力中に外付けキーボードで押された矢印（iPad）。PC のターミナルへ送る。 */
	onLiveArrow: (key: 'up' | 'down' | 'left' | 'right') => void;
}) {
	const liveRef = useRef<TextInput>(null);
	const [liveFocused, setLiveFocused] = useState(false);
	// 外付けキーボードの ⌘↩（iPad）。送信ボタンと同じ（空なら Enter を送る）。
	const focused = useIsFocused();
	// ライブ入力中は、見えない入力欄の Return と同じ（持っている末尾を送って CR、入力欄を作り直す）。
	const liveSubmitRef = useRef<(() => void) | undefined>(undefined);
	useShortcutSlot('send', focused && !submitting ? {
		send: () => {
			haptic('commit');
			if (live && liveSubmitRef.current !== undefined) {
				liveSubmitRef.current();
			} else {
				onSubmit();
			}
		},
	} : undefined);
	const [lastTyped, setLastTyped] = useState('');
	// 外付けキーボードの矢印（iPad）。ライブ入力にフォーカスがある間は、入力欄ではなく PC のターミナルへ。
	// 日本語の変換中は受け口を置かない（矢印は変換の候補や文節の移動に使うので、入力欄に任せる）。
	const [liveComposing, setLiveComposing] = useState(false);
	useShortcutSlot('terminalArrows', live && liveFocused && focused && !liveComposing ? { arrow: key => onLiveArrow(key) } : undefined);
	// ライブ入力の見えない入力欄の世代。Enter で送ったら新しい世代を足してフォーカスを移し、移ったら
	// 古いものを外す（入力欄を1行ぶんに保つ。clear() は RN 0.86 の iOS で捨てられることがあるので使わない）。
	// 2つを一瞬並べるのは、フォーカスを入力欄から入力欄へ直接渡してキーボードを閉じさせないため。
	const [captures, setCaptures] = useState<readonly number[]>([0]);
	const currentCapture = captures[captures.length - 1]!;
	// 自分からはフォーカスを取らない世代（フォーカスが外れた後に作り直したもの。`retireAfterControl`）。
	const quietCapturesRef = useRef(new Set<number>());
	// 作り直しで外した入力欄（残っている間に変換中の文字などを送らせない）
	const discardedCapturesRef = useRef(new Set<number>());
	const liveFocusedRef = useRef(liveFocused);
	liveFocusedRef.current = liveFocused;
	// ライブ入力を切り替えたら入力欄は最初の世代から（autoFocus で勝手にキーボードを出さない）。
	useEffect(() => {
		setCaptures([0]);
		quietCapturesRef.current.clear();
		discardedCapturesRef.current.clear();
		resetPendingRef.current = false;
		setLiveFocused(false);
		setLiveComposing(false);
	}, [live]);
	const seenResetKeyRef = useRef(liveResetKey);
	// 変換中に作り直すと確定前の文字が宙に浮くので、変換が終わるまで待つ
	const resetPendingRef = useRef(false);
	const rebuildCapture = () => {
		resetPendingRef.current = false;
		setLastTyped('');
		// Enter で送り終えたときと同じく新しい入力欄を足し（フォーカスがあれば新しい方へ移す）、前の入力欄は黙らせる
		setCaptures(list => {
			const last = list[list.length - 1]!;
			discardedCapturesRef.current.add(last);
			if (!liveFocusedRef.current) {
				quietCapturesRef.current.add(last + 1);
			}
			return [last, last + 1];
		});
	};
	useEffect(() => {
		if (seenResetKeyRef.current === liveResetKey) {
			return;
		}
		seenResetKeyRef.current = liveResetKey;
		if (liveComposing) {
			resetPendingRef.current = true;
			return;
		}
		rebuildCapture();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 作り直しの合図が来たときだけ
	}, [liveResetKey]);
	useEffect(() => {
		if (!liveComposing && resetPendingRef.current) {
			rebuildCapture();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 変換が終わったときだけ
	}, [liveComposing]);
	/** 送る。打った文字を制御文字として送った（PC の行に文字として載らなかった）ときは true。 */
	const onLiveSend = (data: string): boolean => {
		if (data === LIVE_ENTER) {
			onLiveKey(data);
			if (liveConnected) {
				setLastTyped('');
			}
			return false;
		}
		if (data.length > 0 && [...data].every(char => char === LIVE_DEL)) {
			// DEL の並びは1回で送る（1文字ずつ送ると、その数だけ別々の操作として記録される）。
			onLiveKey(data);
			if (liveConnected) {
				setLastTyped(previous => previous.slice(0, Math.max(0, previous.length - data.length)));
			}
			return false;
		}
		if (onLiveText(data)) {
			return true;
		}
		if (liveConnected) {
			setLastTyped(previous => (previous + data).slice(-40));
		}
		return false;
	};
	const imageButton = (
		<Pressable
			onPress={() => { onAttachImage(); }}
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
					onPress={() => { liveRef.current?.focus(); }}
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
						submitRef={generation === currentCapture ? liveSubmitRef : undefined}
						autoFocus={generation === currentCapture && generation > 0 && !quietCapturesRef.current.has(generation)}
						onComposingChange={generation === currentCapture ? setLiveComposing : undefined}
						// 引退した入力欄に打鍵が届いた（新しい入力欄がまだ・またはフォーカスを取れなかった）。
						// 打鍵は捨て、いまの入力欄へフォーカスを移し直す。
						onRetiredInput={() => liveRef.current?.focus()}
						onFocusChange={value => {
							setLiveFocused(value);
							// 新しい入力欄にフォーカスが移ったら、古い入力欄を外す
							if (value) {
								setCaptures(list => (list.length > 1 && list[list.length - 1] === generation ? [generation] : list));
							}
						}}
						onSend={data => {
							if (discardedCapturesRef.current.has(generation)) {
								// 作り直しで外した入力欄に打鍵が届いた。いまの入力欄へフォーカスを戻す（送らない）
								liveRef.current?.focus();
								return false;
							}
							return onLiveSend(data);
						}}
						onSubmitted={(focusNext = true) => setCaptures(list => {
							const last = list[list.length - 1]!;
							if (last !== generation) {
								return list;
							}
							if (!focusNext) {
								quietCapturesRef.current.add(last + 1);
							}
							return [last, last + 1];
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
				onPress={() => { haptic('tick'); onToggleEnterless(); }}
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
				onPress={() => { haptic('commit'); onSubmit(); }}
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
function LiveCapture({ inputRef, submitRef, autoFocus, onFocusChange, onComposingChange, onSend, onSubmitted, onRetiredInput }: {
	inputRef: RefObject<TextInput | null> | undefined;
	/** いまの世代だけ受け取る。⌘↩ から Return と同じ送り方をさせる。 */
	submitRef: RefObject<(() => void) | undefined> | undefined;
	autoFocus: boolean;
	onFocusChange: (focused: boolean) => void;
	/** いまの世代だけ受け取る。変換中かどうかが変わった。 */
	onComposingChange: ((composing: boolean) => void) | undefined;
	/** 送る。打った文字を制御文字として送ったときは true（`TerminalInputBar` の `onLiveText`）。 */
	onSend: (data: string) => boolean;
	/** この入力欄を引退させた。`focusNext` が false なら新しい入力欄はフォーカスを取らない（既定は取る）。 */
	onSubmitted: (focusNext?: boolean) => void;
	/** Enter で送り終えた後のこの入力欄に、まだ打鍵が届いた。 */
	onRetiredInput: () => void;
}) {
	const localRef = useRef<TextInput | null>(null);
	const stateRef = useRef<LiveInputState>(LIVE_INPUT_EMPTY);
	// 入力欄のいまの文字列（生のまま。キャレットを末尾へ戻す位置に使う）と、変換中か。
	const rawTextRef = useRef('');
	const composingRef = useRef<boolean | undefined>(undefined);
	// この入力欄にいまフォーカスがあるか（引退させたときに新しい入力欄へフォーカスを渡すかの判断）。
	const focusedRef = useRef(false);
	// 変換中かどうかをネイティブが教えてくれない環境（パッチの無いビルド）で、止まった末尾を送る予約。
	const heldTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const cancelHeldTimer = () => {
		if (heldTimerRef.current !== undefined) {
			clearTimeout(heldTimerRef.current);
			heldTimerRef.current = undefined;
		}
	};
	useEffect(() => cancelHeldTimer, []);
	// 新しい世代は変換していない状態から始まる（前の世代の「変換中」を引き継がない）。
	useEffect(() => {
		onComposingChange?.(false);
	}, [onComposingChange]);
	const dispatch = (event: LiveInputEvent) => {
		cancelHeldTimer();
		if (stateRef.current.retired === true && (event.kind === 'change' || event.kind === 'key')) {
			// 前の行を持ったままの入力欄なので写さない（liveInput.ts の retired）。
			onRetiredInput();
			return;
		}
		const step = liveInputStep(stateRef.current, event);
		stateRef.current = step.state;
		let control = false;
		for (const data of step.send) {
			control = onSend(data) || control;
		}
		if (control) {
			// Ctrl で打った文字は PC の行に載っていない。引退させて新しい空の入力欄から写し直す
			// （フォーカスが外れた後なら、新しい入力欄はフォーカスを取らない。`retireAfterControl`）。
			const retired = retireAfterControl(event, focusedRef.current);
			stateRef.current = retired.state;
			onSubmitted(retired.focusNext);
			return;
		}
		if (event.kind === 'change' && event.composing === undefined && step.state.held.length > 0) {
			heldTimerRef.current = setTimeout(() => {
				heldTimerRef.current = undefined;
				dispatch({ kind: 'flush' });
			}, HELD_PREEDIT_COMMIT_DELAY_MS);
		}
	};
	const submit = () => {
		dispatch({ kind: 'submit' });
		onSubmitted();
	};
	useEffect(() => {
		if (submitRef === undefined) {
			return;
		}
		submitRef.current = submit;
		return () => {
			if (submitRef.current === submit) {
				submitRef.current = undefined;
			}
		};
	});
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
			onFocus={() => {
				focusedRef.current = true;
				onFocusChange(true);
			}}
			onBlur={() => {
				focusedRef.current = false;
				onFocusChange(false);
				composingRef.current = undefined;
				onComposingChange?.(false);
				dispatch({ kind: 'flush' });
			}}
			onChange={event => {
				rawTextRef.current = event.nativeEvent.text;
				composingRef.current = readComposing(event.nativeEvent);
				onComposingChange?.(composingRef.current === true);
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
				if (stateRef.current.retired !== true) {
					submit();
				}
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
