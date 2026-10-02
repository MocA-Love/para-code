// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RefObject } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ChevronDown, ChevronUp, Search } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticSelection } from '../../haptics.js';
import { colors, radius, space, type } from '../../theme.js';
import { Icon, iconSize } from '../../ui/index.js';
import { findCountLabel, type FindResult } from './fileFind.js';

/**
 * ファイルビューアの中の検索欄（モックの項目 3 の案A）。`ScreenHeader` の children に置き、見出しの帯の下に出す。
 * 寸法はファイルの画面の検索欄（`filesParts.tsx` の `FilesSearchBar`）と同じ。右に「2 / 5」と前後の矢印。
 *
 * Return は次の一致へ進み、キーボードを閉じる（閉じた後は矢印だけで動ける。本文が狭くならないように）。
 * 入力は uncontrolled（打ちながら親を描き直しても、欄の中身とカーソルが揺れないように）。
 */
export function FileFindBar({ inputRef, query, result, onChangeQuery, onStep, onEscape }: {
	inputRef: RefObject<TextInput | null>;
	/** 外付けキーボードの Esc（入力欄にフォーカスがあるとき。ショートカットの受け口より先に入力欄が受けるため）。 */
	onEscape?: () => void;
	query: string;
	result: FindResult | undefined;
	onChangeQuery: (query: string) => void;
	onStep: (delta: 1 | -1) => void;
}) {
	const label = findCountLabel(query, result);
	const canMove = result !== undefined && result.count > 0;
	return (
		<View style={styles.bar}>
			<View style={styles.field}>
				<Icon icon={Search} size={iconSize.sm} color={colors.textMuted} />
				<TextInput
					ref={inputRef}
					style={styles.input}
					autoFocus
					defaultValue=""
					onChangeText={onChangeQuery}
					onSubmitEditing={() => onStep(1)}
					onKeyPress={event => { if (event.nativeEvent.key === 'Escape') { onEscape?.(); } }}
					placeholder="ファイル内を検索…"
					placeholderTextColor={colors.textMuted}
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="search"
					clearButtonMode="while-editing"
					accessibilityLabel="ファイル内を検索"
				/>
				{label.length > 0 ? <Text style={styles.count} accessibilityLiveRegion="polite">{label}</Text> : null}
			</View>
			<StepButton icon={ChevronUp} label="前の一致" disabled={!canMove} onPress={() => onStep(-1)} />
			<StepButton icon={ChevronDown} label="次の一致" disabled={!canMove} onPress={() => onStep(1)} />
		</View>
	);
}

function StepButton({ icon, label, disabled, onPress }: { icon: typeof ChevronUp; label: string; disabled: boolean; onPress: () => void }) {
	return (
		<Pressable
			onPress={() => { hapticSelection(); onPress(); }}
			disabled={disabled}
			hitSlop={hitSlopToMinimum(FIELD_HEIGHT, FIELD_HEIGHT)}
			style={({ pressed }) => [styles.step, pressed ? styles.stepPressed : undefined, disabled ? styles.disabled : undefined]}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled }}
		>
			<Icon icon={icon} size={iconSize.md} color={colors.text} />
		</Pressable>
	);
}

/** 欄の高さ（pt。`FilesSearchBar` の `.sfield` と同じ）。 */
const FIELD_HEIGHT = 36;

const styles = StyleSheet.create({
	bar: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.sm,
		paddingHorizontal: space.md,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	field: {
		flex: 1,
		minWidth: 0,
		height: FIELD_HEIGHT,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.sm + 2,
		borderRadius: radius.tile,
		backgroundColor: colors.raised,
	},
	input: {
		flex: 1,
		minWidth: 0,
		height: FIELD_HEIGHT,
		fontSize: type.input,
		color: colors.text,
	},
	count: {
		fontSize: type.meta,
		color: colors.textDim,
		fontVariant: ['tabular-nums'],
	},
	step: {
		width: FIELD_HEIGHT,
		height: FIELD_HEIGHT,
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: radius.tile,
		backgroundColor: colors.raised,
	},
	stepPressed: {
		backgroundColor: colors.borderStrong,
	},
	disabled: {
		opacity: 0.4,
	},
});
