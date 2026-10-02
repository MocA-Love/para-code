// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { monoFamily } from '../monoFont.js';
import { alpha, colors, HIT_SIZE, radius, squircle, tint, type } from '../theme.js';
import { KEY_TICK, haptic } from '../haptics.js';
import {
	ctrlLatchedTextInput,
	TERMINAL_ACCESSORY_KEYS,
	TERMINAL_KEY_REPEAT_DELAY_MS,
	TERMINAL_KEY_REPEAT_INTERVAL_MS,
	TERMINAL_KEY_REPEAT_MAX,
	terminalKeyAction,
	type TerminalArrowKey,
	type TerminalKeyDef,
	type TerminalKeyId,
} from '../terminalKeys.js';

/** キーの見た目の高さ。当たり判定は上下の hitSlop で 44pt にする。 */
const KEY_HEIGHT = 36;
const KEY_SLOP = { top: (HIT_SIZE - KEY_HEIGHT) / 2, bottom: (HIT_SIZE - KEY_HEIGHT) / 2 };

/**
 * アクセサリキーの押下と、Ctrl の押しっぱなし（ラッチ）を扱う。
 *
 * Ctrl は「押すと点き、次に押したキーか入力欄に打った1文字へ掛かって消える」。
 * 押し続けによるリピートの2回目以降も最初と同じ修飾で送る（Ctrl+↑ を押し続けたとき、
 * 2回目から素の ↑ に変わらないように）。
 *
 * `resetKey`（いま操作しているターミナル）が変わったら Ctrl を消す。点けたまま別のターミナルへ
 * 移ると、移った先で次に押したキーや打った1文字が思わぬ制御文字（Ctrl+C 等）として送られる。
 */
export function useTerminalKeyInput({ send, sendArrow, resetKey }: {
	send: (data: string) => void;
	sendArrow: (key: TerminalArrowKey) => void;
	resetKey?: string;
}) {
	const [ctrlLatched, setCtrlLatched] = useState(false);
	// 連続して呼ばれる（リピート・入力欄の変化）ので、描画を待たずに最新値を読む。
	const ctrlRef = useRef(false);
	const heldCtrlRef = useRef(false);
	const setCtrl = (next: boolean) => {
		ctrlRef.current = next;
		setCtrlLatched(next);
	};
	const resetKeyRef = useRef(resetKey);
	useEffect(() => {
		if (resetKeyRef.current === resetKey) {
			return;
		}
		resetKeyRef.current = resetKey;
		ctrlRef.current = false;
		heldCtrlRef.current = false;
		setCtrlLatched(false);
	}, [resetKey]);

	const pressKey = (id: TerminalKeyId, repeat: boolean) => {
		const ctrl = repeat ? heldCtrlRef.current : ctrlRef.current;
		const action = terminalKeyAction(id, ctrl);
		if (action.kind === 'toggleCtrl') {
			haptic('tick');
			setCtrl(!ctrlRef.current);
			return;
		}
		if (!repeat) {
			heldCtrlRef.current = ctrl;
			if (ctrl) {
				setCtrl(false);
			}
			if (id === 'ctrlC' || id === 'ctrlD') {
				haptic('edge');
			} else {
				haptic('tick', KEY_TICK);
			}
		}
		if (action.kind === 'arrow') {
			sendArrow(action.key);
		} else {
			send(action.data);
		}
	};

	/**
	 * 入力欄の変更を受け取る前に通す。Ctrl が点いていて1文字だけ打たれたら、その文字は
	 * 入力欄に足さずに制御文字として送り、`undefined` を返す（呼び出し側は値を更新しない）。
	 */
	const filterComposerText = (previous: string, next: string): string | undefined => {
		if (!ctrlRef.current) {
			return next;
		}
		const result = ctrlLatchedTextInput(previous, next);
		if (result.kind === 'control') {
			haptic('tick', KEY_TICK);
			setCtrl(false);
			send(result.data);
			return undefined;
		}
		if (result.release) {
			setCtrl(false);
		}
		return next;
	};

	return { ctrlLatched, pressKey, filterComposerText };
}

/**
 * ターミナルの入力欄の下段に並べるキー行。
 *
 * - キーボードが出ている間は、左端に「キーボードを閉じる」キーを固定する（横スクロールしても消えない）
 * - 右端に「Enterなし」の切り替えを固定する（送信ボタンの隣。ON のときは入力に Enter を付けない）
 * - 間のキーは横にスクロールする
 *
 * 入力欄（`GlassComposer`）の `tools` に渡す。
 */
export function TerminalKeyRow({ keyboardVisible, ctrlLatched, enterless, onKey, onToggleEnterless }: {
	keyboardVisible: boolean;
	ctrlLatched: boolean;
	enterless: boolean;
	/** `repeat` は押し続けによる2回目以降。 */
	onKey: (id: TerminalKeyId, repeat: boolean) => void;
	onToggleEnterless: () => void;
}) {
	const repeatTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const stopRepeat = () => {
		if (repeatTimer.current !== undefined) {
			clearInterval(repeatTimer.current);
			repeatTimer.current = undefined;
		}
	};
	// 押している最中に画面を離れても送り続けないよう、外れるときに必ず止める。
	useEffect(() => stopRepeat, []);
	const onKeyRef = useRef(onKey);
	onKeyRef.current = onKey;

	const startRepeat = (id: TerminalKeyId) => {
		stopRepeat();
		onKeyRef.current(id, false);
		let sent = 1;
		repeatTimer.current = setInterval(() => {
			if (sent >= TERMINAL_KEY_REPEAT_MAX) {
				stopRepeat();
				return;
			}
			sent++;
			onKeyRef.current(id, true);
		}, TERMINAL_KEY_REPEAT_INTERVAL_MS);
	};

	const renderKey = (def: TerminalKeyDef) => {
		const latched = def.id === 'ctrl' && ctrlLatched;
		return (
			<Pressable
				key={def.id}
				style={({ pressed }) => [styles.key, pressed && styles.keyPressed, latched && styles.keyLatched]}
				hitSlop={KEY_SLOP}
				// **リピートするキーも、送るのは指を離したとき（onPress）か長押しの成立時。**
				// 押した瞬間（onPressIn）に送ると、キー行を横にスクロールしようと触れただけで
				// キーが PC へ飛ぶ。
				onPress={() => onKey(def.id, false)}
				{...(def.repeat ? {
					onLongPress: () => startRepeat(def.id),
					onPressOut: stopRepeat,
					delayLongPress: TERMINAL_KEY_REPEAT_DELAY_MS,
				} : {})}
				accessibilityRole={def.id === 'ctrl' ? 'togglebutton' : 'button'}
				accessibilityLabel={def.accessibilityLabel}
				accessibilityState={def.id === 'ctrl' ? { checked: latched } : undefined}
			>
				<Text style={[styles.keyText, def.danger && styles.keyDanger, latched && styles.keyTextLatched]}>{def.label}</Text>
			</Pressable>
		);
	};

	return (
		<>
			{keyboardVisible ? (
				<Pressable
					style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
					hitSlop={KEY_SLOP}
					onPress={() => { Keyboard.dismiss(); }}
					accessibilityRole="button"
					accessibilityLabel="キーボードを閉じる"
				>
					<Ionicons name="chevron-down" size={16} color={colors.text} />
				</Pressable>
			) : null}
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				style={styles.scroll}
				contentContainerStyle={styles.scrollContent}
				keyboardShouldPersistTaps="always"
			>
				{TERMINAL_ACCESSORY_KEYS.map(renderKey)}
			</ScrollView>
			<Pressable
				style={({ pressed }) => [styles.toggle, enterless && styles.toggleOn, pressed && styles.keyPressed]}
				hitSlop={KEY_SLOP}
				onPress={() => { haptic('tick'); onToggleEnterless(); }}
				accessibilityRole="switch"
				accessibilityLabel="Enter なしで入力"
				accessibilityHint="オンにすると、送信しても Enter を押さずに入力だけします"
				accessibilityState={{ checked: enterless }}
			>
				<Ionicons name={enterless ? 'checkbox' : 'square-outline'} size={14} color={enterless ? colors.accent : colors.textDim} />
				<Text style={[styles.toggleText, enterless && styles.toggleTextOn]}>Enterなし</Text>
			</Pressable>
		</>
	);
}

const styles = StyleSheet.create({
	// 縦の余白は、キーの上下 hitSlop（4pt ずつ）をスクロール領域の中に収めるため
	// （領域の外へはみ出した当たり判定は OS に拾われない）。
	scroll: { flex: 1, minWidth: 0 },
	scrollContent: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingVertical: KEY_SLOP.top, paddingRight: 4 },
	key: {
		height: KEY_HEIGHT, minWidth: HIT_SIZE, paddingHorizontal: 10,
		alignItems: 'center', justifyContent: 'center',
		backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border,
		borderRadius: radius.key, ...squircle,
	},
	keyPressed: { backgroundColor: colors.surface2, borderColor: colors.borderStrong },
	// Ctrl が点いている（次のキーに掛かる）状態。選択中の印なので accent を使う。
	keyLatched: { backgroundColor: tint(colors.accent, alpha.wash), borderColor: tint(colors.accent, alpha.strong) },
	keyText: { color: colors.text, fontSize: type.meta, fontFamily: monoFamily },
	keyTextLatched: { color: colors.accent, fontWeight: '700' },
	keyDanger: { color: colors.red },
	toggle: {
		height: KEY_HEIGHT, minWidth: HIT_SIZE, paddingHorizontal: 8, flexDirection: 'row', gap: 4,
		alignItems: 'center', justifyContent: 'center', flexShrink: 0,
		borderWidth: 1, borderColor: colors.border, borderRadius: radius.key, ...squircle,
	},
	toggleOn: { backgroundColor: tint(colors.accent, alpha.wash), borderColor: tint(colors.accent, alpha.strong) },
	toggleText: { color: colors.textDim, fontSize: type.caption, fontWeight: '600' },
	toggleTextOn: { color: colors.accent },
});
