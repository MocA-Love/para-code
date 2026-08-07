// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './bottomSheet.js';
import { GlassSurface } from './glassSurface.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import {
	HOME_SORT_KEYS, HOME_STATUS_BUCKETS, bucketCounts, reconcileSecondary, secondaryCandidates, toggleFilter,
	type HomeListPreferences, type HomeSortKey, type HomeStatusBucket, type SortableTerminal,
} from '../homeSort.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/**
 * ホーム一覧の絞り込みチップと、並び替えシート。
 *
 * 「今どういう condition で絞られているか」は画面に出したままにする。シートを開かないと
 * 分からない作りにすると、絞り込んだこと自体を忘れて「エージェントが消えた」と誤解される。
 *
 * 一方で**並び順のほうはチップの下にバーを出さない**。常時見せるほど頻繁には変えないのに
 * 一段まるごと占めてしまい、そのぶん本文の始まりが下がる。入口はヘッダーの＋メニューの
 * 「並び替えと絞り込み」に置く。
 */

/** 選択肢の行の寸法。罫線のインセットを同じ値から導くためにまとめておく。 */
const OPTION_PADDING = 14;
const OPTION_ICON = 22;
const OPTION_GAP = 11;

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

export function HomeFilterChips({ preferences, onChange, rows }: {
	preferences: HomeListPreferences;
	onChange: (next: HomeListPreferences) => void;
	/** 件数を数える対象（絞り込み前の一覧。応答待ちスタックのぶんは含まない）。 */
	rows: readonly SortableTerminal[];
}) {
	const counts = bucketCounts(rows);
	const noFilter = preferences.filters.length === 0;

	return (
		// 横スクロールにしない。ホームは画面全体を右スワイプでドロワーを開くジェスチャで
		// 包んでいる（index.tsx の openDrawerPan）ため、チップを右へ払い戻す操作が
		// そちらに奪われる。4つ固定で溢れるのは狭いiPhoneの1個ぶんなので、折り返しで足りる。
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
					active={preferences.filters.includes(bucket)}
					onPress={() => {
						hapticSelection();
						onChange({ ...preferences, filters: toggleFilter(preferences.filters, bucket) });
					}}
				/>
			))}
		</View>
	);
}

/**
 * 絞り込みチップ。面はガラスのピルで、ヘッダーの島と同じレイヤーに浮く。
 *
 * **選択中も素材はガラスのまま**にして、色は `tintColor` として素材へ混ぜる。
 * 以前は選択中だけ不透明な地の `View` へ差し替えていたが、
 *  - 同じ列にガラスと不透明が並んで素材が食い違い、選択が「別の部品に化けた」ように見える
 *  - そこだけ背後のスクロールが透けないので、動きが止まって見える
 *  - `active ? <GlassSurface> : <View>` は条件でReactツリーの形を変えるため再マウントが起きる
 *    （CLAUDE.md が禁じている書き方）
 * の3つが起きていた。tint は Apple の言う「前面性を示す」用途そのもの。
 *
 * 状態の色ドットは付けない。同じ意味の色は右端のステータスバッジが行ごとに持っており、
 * チップにも足すと1画面に同じ凡例が二重に並ぶ。
 */
function Chip({ label, count, active, onPress }: { label: string; count: number; active: boolean; onPress: () => void }) {
	return (
		<GlassSurface
			style={styles.chip}
			interactive
			// 枠線は足さない（ガラスが自前で縁の光を持っている）。
			tintColor={active ? colors.accent : undefined}
			tintOpacity={0.22}
		>
			<Pressable
				style={styles.chipHit}
				onPress={onPress}
				accessibilityRole="button"
				accessibilityState={{ selected: active }}
				accessibilityLabel={`${label} ${count}件`}
			>
				<Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
				<Text style={[styles.chipText, styles.chipCount, active && styles.chipTextActive]}>{count}</Text>
			</Pressable>
		</GlassSurface>
	);
}

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
	// 左右の余白は置き場所（ヘッダーの帯）が持つのでここでは足さない。
	chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
	chip: { height: 32, borderRadius: radius.pill, ...squircle },
	chipHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
	chipText: { color: colors.text, fontSize: 11.5 },
	chipTextActive: { color: '#bfeeff', fontWeight: '700' },
	// 件数はラベルと同じ色のまま薄くする。別の色を当てると数字だけが先に目に入る。
	chipCount: { fontSize: 10.5, opacity: 0.75 },

	sheetBody: { paddingHorizontal: 16 },
	// iOS 26 のリストは全大文字をやめ、見出しもタイトルの大小で書く。文字も一段大きい。
	sheetSection: { color: colors.textDim, fontSize: 12.5, fontWeight: '700', paddingHorizontal: 12, paddingTop: 16, paddingBottom: 7 },
	// グループを1枚の面にまとめる。行の形はこの器が持つので、行側は角丸も枠線も持たない。
	optionGroup: {
		borderRadius: 16, ...squircle, overflow: 'hidden',
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
	optionTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	optionDescription: { color: colors.textDim, fontSize: 10.5, marginTop: 2, lineHeight: 15 },
});
