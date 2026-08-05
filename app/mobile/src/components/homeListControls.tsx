// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './bottomSheet.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import {
	HOME_SORT_KEYS, HOME_STATUS_BUCKETS, bucketCounts, reconcileSecondary, secondaryCandidates, toggleFilter,
	type HomeListPreferences, type HomeSortKey, type HomeStatusBucket, type SortableTerminal,
} from '../homeSort.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/**
 * ホーム一覧の絞り込みチップと並び替えバー。
 *
 * 「今どういう並びで、何で絞られているか」を画面に出したままにするのが狙い。
 * シートを開かないと分からない作りにすると、絞り込んだこと自体を忘れて
 * 「エージェントが消えた」と誤解される。
 */

const BUCKET_LABEL: Record<HomeStatusBucket, string> = {
	waiting: '応答待ち',
	working: '実行中',
	review: 'レビュー',
	idle: 'アイドル',
};

const SORT_LABEL: Record<HomeSortKey, string> = {
	status: 'ステータス順',
	space: 'スペース順',
	name: '名前順',
	added: '追加順',
};

const SORT_DESCRIPTION: Record<HomeSortKey, string> = {
	// 応答待ちは上部のスタックが持つのでこの一覧には現れない。ここに書くと
	// 「応答待ちが上に来ないのは壊れている」と読まれる。
	status: '実行中 → レビュー → アイドル',
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

const BUCKET_DOT: Record<HomeStatusBucket, string> = {
	waiting: colors.red,
	working: colors.green,
	review: colors.yellow,
	idle: colors.textDim,
};

/** 並び順を1行で言い表す（バーのラベル）。第2キーは第1キーと違うときだけ添える。 */
export function describeSort(preferences: HomeListPreferences): string {
	return preferences.sort === preferences.secondary
		? SORT_LABEL[preferences.sort]
		: `${SORT_LABEL[preferences.sort]} · ${SORT_LABEL[preferences.secondary]}`;
}

export function HomeListControls({ preferences, onChange, rows, visibleCount, sheetOpen, onSheetOpenChange }: {
	preferences: HomeListPreferences;
	onChange: (next: HomeListPreferences) => void;
	/** 件数を数える対象（絞り込み前の一覧。応答待ちスタックのぶんは含まない）。 */
	rows: readonly SortableTerminal[];
	/** 絞り込んだ結果の件数。 */
	visibleCount: number;
	/**
	 * シートの開閉は画面側が持つ。ここで持つと、開いている最中に最後の1件が応答待ちへ
	 * 変わって一覧が0件になったとき、このコンポーネントごと消えてシートが勝手に閉じる。
	 */
	sheetOpen: boolean;
	onSheetOpenChange: (open: boolean) => void;
}) {
	const counts = bucketCounts(rows);
	const noFilter = preferences.filters.length === 0;

	return (
		<>
			{/* 横スクロールにしない。ホームは画面全体を右スワイプでドロワーを開くジェスチャで
			    包んでいる（index.tsx の openDrawerPan）ため、チップを右へ払い戻す操作が
			    そちらに奪われる。4つ固定で溢れるのは狭いiPhoneの1個ぶんなので、折り返しで足りる。 */}
			<View style={styles.chipRow}>
				<Chip
					label="すべて"
					count={rows.length}
					active={noFilter}
					onPress={() => {
						if (noFilter) {
							return;
						}
						hapticSelection();
						onChange({ ...preferences, filters: [] });
					}}
				/>
				{HOME_STATUS_BUCKETS.map(bucket => (
					<Chip
						key={bucket}
						label={BUCKET_LABEL[bucket]}
						count={counts[bucket]}
						dot={BUCKET_DOT[bucket]}
						active={preferences.filters.includes(bucket)}
						onPress={() => {
							hapticSelection();
							onChange({ ...preferences, filters: toggleFilter(preferences.filters, bucket) });
						}}
					/>
				))}
			</View>

			<View style={styles.sortBar}>
				<Text style={styles.resultText}>
					{visibleCount}件{noFilter ? '' : '（絞り込み中）'}
				</Text>
				<Pressable
					style={styles.sortButton}
					onPress={() => { hapticImpact('light'); onSheetOpenChange(true); }}
					accessibilityRole="button"
					accessibilityLabel={`並び替え。現在は${describeSort(preferences)}`}
				>
					<Ionicons name="swap-vertical" size={13} color={colors.textDim} />
					<Text style={styles.sortButtonText} numberOfLines={1}>{describeSort(preferences)}</Text>
					<Ionicons name="chevron-down" size={12} color={colors.textDim} />
				</Pressable>
			</View>

			<HomeSortSheet
				visible={sheetOpen}
				preferences={preferences}
				onChange={onChange}
				onClose={() => onSheetOpenChange(false)}
			/>
		</>
	);
}

function Chip({ label, count, active, dot, onPress }: { label: string; count: number; active: boolean; dot?: string; onPress: () => void }) {
	return (
		<Pressable
			style={[styles.chip, active && styles.chipActive]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityState={{ selected: active }}
			accessibilityLabel={`${label} ${count}件`}
		>
			{dot !== undefined ? <View style={[styles.chipDot, { backgroundColor: dot }]} /> : null}
			<Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
			<Text style={[styles.chipCount, active && styles.chipCountActive]}>{count}</Text>
		</Pressable>
	);
}

/** 並び替えシート。第1キー・第2キー・ピン留めの扱いを選ぶ。 */
function HomeSortSheet({ visible, preferences, onChange, onClose }: {
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
				{HOME_SORT_KEYS.map(key => (
					<OptionRow
						key={key}
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

				<Text style={styles.sheetSection}>同じときの並び</Text>
				{secondaryCandidates(preferences.sort).map(key => (
					<OptionRow
						key={key}
						icon={SORT_ICON[key]}
						title={SORT_LABEL[key]}
						description={SORT_DESCRIPTION[key]}
						selected={preferences.secondary === key}
						onPress={() => { hapticSelection(); onChange({ ...preferences, secondary: key }); }}
					/>
				))}

				<Text style={styles.sheetSection}>その他</Text>
				<OptionRow
					icon="bookmark-outline"
					title="ピン留めを最上部に固定"
					description="並び順に関係なく先頭へ出す"
					selected={preferences.pinFirst}
					onPress={() => { hapticSelection(); onChange({ ...preferences, pinFirst: !preferences.pinFirst }); }}
				/>
			</ScrollView>
		</BottomSheet>
	);
}

function OptionRow({ icon, title, description, selected, onPress }: {
	icon: keyof typeof Ionicons.glyphMap;
	title: string;
	description: string;
	selected: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			style={[styles.option, selected && styles.optionSelected]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityState={{ selected }}
			accessibilityLabel={title}
			accessibilityHint={description}
		>
			<Ionicons name={icon} size={17} color={selected ? colors.accent : colors.textDim} style={styles.optionIcon} />
			<View style={styles.optionBody}>
				<Text style={styles.optionTitle}>{title}</Text>
				<Text style={styles.optionDescription}>{description}</Text>
			</View>
			{selected ? <Ionicons name="checkmark" size={16} color={colors.accent} /> : null}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	// 親（ホームのScrollView contentContainer）が左右16ptを持つのでここでは足さない。
	chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingBottom: 10 },
	chip: {
		flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 11, borderRadius: 15,
		backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
	},
	chipActive: { backgroundColor: colors.accentWash, borderColor: 'rgba(9,175,217,0.5)' },
	chipDot: { width: 7, height: 7, borderRadius: 4 },
	chipText: { color: colors.textDim, fontSize: 11.5 },
	chipTextActive: { color: colors.accent, fontWeight: '700' },
	chipCount: { color: colors.textDim, fontSize: 10, fontWeight: '700', opacity: 0.8 },
	chipCountActive: { color: colors.accent },

	// 親が左右16ptを持つのでここでは足さない。件数と並び替えボタンは関連する2つなので
	// 左に寄せてまとめる（space-betweenだと広いiPadで900pt近く離れて別物に見える）。
	sortBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 8 },
	resultText: { color: colors.textDim, fontSize: 10.5 },
	sortButton: {
		flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 11, borderRadius: 9,
		backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, maxWidth: 260,
	},
	sortButtonText: { color: colors.text, fontSize: 11.5, flexShrink: 1 },

	sheetBody: { paddingHorizontal: 16 },
	sheetSection: { color: colors.textDim, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6 },
	option: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: 'transparent', marginBottom: 2 },
	optionSelected: { backgroundColor: colors.accentWash, borderColor: 'rgba(9,175,217,0.3)' },
	optionIcon: { width: 22, textAlign: 'center' },
	optionBody: { flex: 1, minWidth: 0 },
	optionTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
	optionDescription: { color: colors.textDim, fontSize: 10.5, marginTop: 2, lineHeight: 15 },
});
