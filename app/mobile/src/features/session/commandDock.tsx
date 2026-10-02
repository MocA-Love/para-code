// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, type ReactNode } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { ChevronDown, ChevronsRight, Monitor, Smartphone } from 'lucide-react-native';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import {
	TERMINAL_ACCESSORY_KEYS,
	TERMINAL_KEY_REPEAT_DELAY_MS,
	TERMINAL_KEY_REPEAT_INTERVAL_MS,
	TERMINAL_KEY_REPEAT_MAX,
	type TerminalKeyDef,
	type TerminalKeyId,
} from '../../terminalKeys.js';
import { colors, radius, space, type } from '../../theme.js';
import { Icon, iconSize } from '../../ui/index.js';

/** キーの見た目（モックの `.key`: 高さ 28・最小幅 36）。当たり判定は上下 8 ずつ広げて 44 にする。 */
const KEY_HEIGHT = 28;
const KEY_MIN_WIDTH = 36;
const KEY_SLOP = { top: 8, bottom: 8, left: 0, right: 0 };

/**
 * ターミナルのアクセサリキーの行（Orca の MobileSessionCommandDock の上段。モックの `.accbar`）。
 * 横にスクロールし、左から キーボードを閉じる（出ているときだけ）・表示モード・ライブ入力・貼付・
 * 既存のキー（`terminalKeys.ts` の `TERMINAL_ACCESSORY_KEYS` の順）。
 *
 * キーを押したときに何を送るかは既存の `terminalKeyAction`（呼び出し側の `useTerminalKeyInput`）が決める。
 * 矢印と ⌫ は押し続けるとリピートする（送るのは指を離したときか長押しの成立時。横にスクロールしようと
 * 触れただけでは送らない）。
 */
export function AccessoryKeyBar({ keyboardVisible, phoneWidth, live, ctrlLatched, onKey, onToggleDisplay, onToggleLive, onPaste }: {
	keyboardVisible: boolean;
	/** PC 側のターミナルをこの画面の幅に合わせているか（設定の「PC の幅を合わせる」）。 */
	phoneWidth: boolean;
	live: boolean;
	ctrlLatched: boolean;
	onKey: (id: TerminalKeyId, repeat: boolean) => void;
	onToggleDisplay: () => void;
	onToggleLive: () => void;
	onPaste: () => void;
}) {
	const repeatTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const stopRepeat = () => {
		if (repeatTimer.current !== undefined) {
			clearInterval(repeatTimer.current);
			repeatTimer.current = undefined;
		}
	};
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
			<Key
				key={def.id}
				on={latched}
				onPress={() => onKey(def.id, false)}
				{...(def.repeat ? { onLongPress: () => startRepeat(def.id), onPressOut: stopRepeat } : {})}
				role={def.id === 'ctrl' ? 'togglebutton' : 'button'}
				label={def.accessibilityLabel}
			>
				<Text style={[styles.keyText, def.danger ? styles.danger : undefined, latched ? styles.keyTextOn : undefined]}>{def.label}</Text>
			</Key>
		);
	};

	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			keyboardShouldPersistTaps="always"
			style={styles.bar}
			contentContainerStyle={styles.keys}
		>
			{keyboardVisible ? (
				<Key onPress={() => { Keyboard.dismiss(); }} label="キーボードを閉じる">
					<Icon icon={ChevronDown} size={iconSize.sm} color={colors.textDim} />
				</Key>
			) : null}
			<Key onPress={() => { haptic('tick'); onToggleDisplay(); }} label={phoneWidth ? 'デスクトップ表示に切り替え' : 'スマホ表示に切り替え'}>
				<Icon icon={phoneWidth ? Monitor : Smartphone} size={iconSize.sm} color={colors.textDim} />
			</Key>
			<Key on={live} role="togglebutton" onPress={() => { haptic('tick'); onToggleLive(); }} label="ライブ入力の切り替え">
				<Icon icon={ChevronsRight} size={iconSize.sm} color={live ? colors.bg : colors.textDim} />
			</Key>
			<Key onPress={() => { onPaste(); }} label="クリップボードを貼り付け">
				<Text style={styles.keyText}>貼付</Text>
			</Key>
			{TERMINAL_ACCESSORY_KEYS.map(renderKey)}
		</ScrollView>
	);
}

function Key({ children, on = false, role = 'button', label, onPress, onLongPress, onPressOut }: {
	children: ReactNode;
	on?: boolean;
	role?: 'button' | 'togglebutton';
	label: string;
	onPress: () => void;
	onLongPress?: () => void;
	onPressOut?: () => void;
}) {
	return (
		<Pressable
			style={({ pressed }) => [styles.key, pressed ? styles.keyPressed : undefined, on ? styles.keyOn : undefined]}
			hitSlop={KEY_SLOP}
			onPress={onPress}
			onLongPress={onLongPress}
			onPressOut={onPressOut}
			delayLongPress={onLongPress !== undefined ? TERMINAL_KEY_REPEAT_DELAY_MS : undefined}
			accessibilityRole={role}
			accessibilityLabel={label}
			accessibilityState={role === 'togglebutton' ? { checked: on } : undefined}
		>
			{children}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	bar: {
		flexGrow: 0,
		borderTopWidth: 1,
		borderTopColor: colors.border,
		backgroundColor: colors.panel,
	},
	keys: {
		alignItems: 'center',
		gap: space.xs,
		paddingHorizontal: space.sm,
		// キーの hitSlop（上下 8）をスクロール領域の内側に収める。
		paddingVertical: KEY_SLOP.top,
	},
	key: {
		height: KEY_HEIGHT,
		minWidth: KEY_MIN_WIDTH,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 10,
		borderRadius: radius.key,
		backgroundColor: colors.raised,
	},
	keyPressed: {
		backgroundColor: colors.border,
	},
	keyOn: {
		backgroundColor: colors.text,
	},
	keyText: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.textDim,
	},
	keyTextOn: {
		fontWeight: '700',
		color: colors.bg,
	},
	danger: {
		color: colors.red,
	},
});
