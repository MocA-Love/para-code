// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './bottomSheet.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import {
	HOME_SORT_KEYS, reconcileSecondary, secondaryCandidates,
	type HomeListPreferences, type HomeSortKey,
} from '../homeSort.js';
import { colors, radius, squircle, type } from '../theme.js';
import { hapticSelection } from '../haptics.js';

/**
 * ホーム一覧の並び替えシート。
 *
 * 以前はこのファイルに状態の絞り込みチップもあったが、ステータス順の一覧を状態の見出しで
 * 区切るようにしたことで役目を終えたので外した（見出しが「いま何がどれだけあるか」を示す）。
 * 入口はヘッダーの `…`（iPad は＋）メニューの「並び替え」。
 */

/** 選択肢の行の寸法。罫線のインセットを同じ値から導くためにまとめておく。 */
const OPTION_PADDING = 14;
const OPTION_ICON = 22;
const OPTION_GAP = 11;

const SORT_LABEL: Record<HomeSortKey, string> = {
	status: 'ステータス順',
	space: 'スペース順',
	name: '名前順',
	added: '追加順',
};

const SORT_DESCRIPTION: Record<HomeSortKey, string> = {
	// 要対応は上部のスタック（見出しの先頭の段）が持つ。一覧はその下を状態の見出しで区切る。
	status: '要対応 → 実行中 → 未確認 → 待機（見出しで区切る）',
	space: 'ワークスペース一覧と同じ並び',
	name: 'ターミナル名の順',
	added: 'PCでターミナルを作った順',
};

const SORT_ICON: Record<HomeSortKey, keyof typeof Ionicons.glyphMap> = {
	status: 'pulse-outline',
	space: 'albums-outline',
	name: 'text-outline',
	added: 'time-outline',
};

/** 並び替えシート。第1キー・第2キー・ピン留めの扱いを選ぶ。ヘッダーの＋メニューから開く。 */
export function HomeSortSheet({ visible, preferences, onChange, onClose }: {
	visible: boolean;
	preferences: HomeListPreferences;
	onChange: (next: HomeListPreferences) => void;
	onClose: () => void;
}) {
	const insets = useStableInsets();
	return (
		<BottomSheet visible={visible} onClose={onClose} title="並び替え" glass>
			<ScrollView contentContainerStyle={[styles.sheetBody, { paddingBottom: insets.bottom + 20 }]}>
				<Text style={styles.sheetSection}>並び順</Text>
				<View style={styles.optionGroup}>
					{HOME_SORT_KEYS.map((key, index) => (
						<OptionRow
							key={key}
							first={index === 0}
							icon={SORT_ICON[key]}
							title={SORT_LABEL[key]}
							description={SORT_DESCRIPTION[key]}
							selected={preferences.sort === key}
							onPress={() => {
								hapticSelection();
								onChange({ ...preferences, sort: key, secondary: reconcileSecondary(key, preferences.secondary) });
							}}
						/>
					))}
				</View>

				<Text style={styles.sheetSection}>同じときの並び</Text>
				<View style={styles.optionGroup}>
					{secondaryCandidates(preferences.sort).map((key, index) => (
						<OptionRow
							key={key}
							first={index === 0}
							icon={SORT_ICON[key]}
							title={SORT_LABEL[key]}
							description={SORT_DESCRIPTION[key]}
							selected={preferences.secondary === key}
							onPress={() => { hapticSelection(); onChange({ ...preferences, secondary: key }); }}
						/>
					))}
				</View>

				<Text style={styles.sheetSection}>その他</Text>
				<View style={styles.optionGroup}>
					<OptionRow
						first
						icon="bookmark-outline"
						title="ピン留めを最上部に固定"
						description="並び順に関係なく先頭へ出す"
						selected={preferences.pinFirst}
						onPress={() => { hapticSelection(); onChange({ ...preferences, pinFirst: !preferences.pinFirst }); }}
					/>
				</View>
			</ScrollView>
		</BottomSheet>
	);
}

/**
 * 選択肢の1行。**選択は右端のチェックだけ**で示し、面は塗らない。
 *
 * 以前は選択行を `accentWash` で塗りつぶしていたが、3つのグループそれぞれに選択行があるため
 * 「同じ強さの青い箱」が3つ縦に並び、3件選ばれているのかグループの見出しなのかが読めなかった。
 * 面は {@link styles.optionGroup} が1枚だけ持ち、行の間はアイコン幅ぶんインセットした
 * 罫線で割る（iOS の inset grouped）。押下は一瞬のハイライトで返す。
 */
function OptionRow({ icon, title, description, selected, onPress, first = false }: {
	icon: keyof typeof Ionicons.glyphMap;
	title: string;
	description: string;
	selected: boolean;
	onPress: () => void;
	/** グループの先頭行。上の罫線を引かない。 */
	first?: boolean;
}) {
	return (
		<Pressable
			style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityState={{ selected }}
			accessibilityLabel={title}
			accessibilityHint={description}
		>
			{first ? null : <View style={styles.optionDivider} pointerEvents="none" />}
			<Ionicons name={icon} size={17} color={selected ? colors.accent : colors.textDim} style={styles.optionIcon} />
			<View style={styles.optionBody}>
				<Text style={styles.optionTitle}>{title}</Text>
				<Text style={styles.optionDescription}>{description}</Text>
			</View>
			{selected ? <Ionicons name="checkmark" size={17} color={colors.accent} /> : null}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	sheetBody: { paddingHorizontal: 16 },
	// iOS 26 のリストは全大文字をやめ、見出しもタイトルの大小で書く。文字も一段大きい。
	sheetSection: { color: colors.textDim, fontSize: type.meta, fontWeight: '700', paddingHorizontal: 12, paddingTop: 16, paddingBottom: 7 },
	// グループを1枚の面にまとめる。行の形はこの器が持つので、行側は角丸も枠線も持たない。
	optionGroup: {
		borderRadius: radius.card, ...squircle, overflow: 'hidden',
		backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
	},
	option: { flexDirection: 'row', alignItems: 'center', gap: OPTION_GAP, paddingVertical: 13, paddingHorizontal: OPTION_PADDING },
	optionPressed: { backgroundColor: 'rgba(255,255,255,0.06)' },
	// 罫線はアイコンの右端から引く（左端まで引くと、アイコンの列が切り離されて見える）。
	optionDivider: {
		position: 'absolute', top: 0, right: 0, left: OPTION_PADDING + OPTION_ICON + OPTION_GAP,
		height: StyleSheet.hairlineWidth, backgroundColor: colors.border,
	},
	optionIcon: { width: OPTION_ICON, textAlign: 'center' },
	optionBody: { flex: 1, minWidth: 0 },
	optionTitle: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	optionDescription: { color: colors.textDim, fontSize: type.badge, marginTop: 2, lineHeight: 15 },
});
