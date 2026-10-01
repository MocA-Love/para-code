// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Folder } from 'lucide-react-native';
import { hapticSelection } from '../../haptics.js';
import type { HomeStatusBucket } from '../../homeSort.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { colors, radius, space, type } from '../../theme.js';
import { BottomDrawer, Button, DrawerTitle, Icon, ListGroup, ListRow, SectionHeader, iconSize } from '../../ui/index.js';
import { PC_LIST_KIND_OPTIONS, STATE_SECTIONS, filterCount, statesApply, toggleValue, type PcListFilter, type PcListKind } from './pcList.js';
import { bucketDotColor } from './pcListParts.js';
import { spaceColor } from './spaceColor.js';

/**
 * 絞り込みのシート（モックの「スペースの絞り込み」）。種類（すべて／エージェント／ターミナル）を 1 つ、
 * 状態とスペースを複数選べ、押すたびにすぐ一覧に効く（閉じなくてよい）。スペースの切り替えもここで行う。
 * 状態はエージェントにだけ効くので、ターミナルだけを出しているときは状態の段を押せなくする。
 */
export function FilterDrawer({ visible, filter, spaces, onChange, onClose }: {
	visible: boolean;
	filter: PcListFilter;
	spaces: readonly { readonly id: string; readonly name: string; readonly color?: string }[];
	onChange: (next: PcListFilter) => void;
	onClose: () => void;
}) {
	const selectKind = (kind: PcListKind) => {
		if (kind !== filter.kind) {
			hapticSelection();
			onChange({ ...filter, kind });
		}
	};
	const statesEnabled = statesApply(filter);
	const toggleState = (bucket: HomeStatusBucket) => {
		hapticSelection();
		onChange({ ...filter, states: toggleValue(filter.states, bucket) });
	};
	const toggleSpace = (id: string) => {
		hapticSelection();
		onChange({ ...filter, spaces: toggleValue(filter.spaces, id) });
	};
	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel="絞り込み">
			<DrawerTitle
				title="絞り込み"
				right={<Button label="クリア" variant="ghost" size="sm" disabled={filterCount(filter) === 0 && filter.kind === 'all'} onPress={() => onChange({ ...filter, kind: 'all', states: [], spaces: [] })} />}
			/>
			<SectionHeader title="種類" />
			<KindSegments value={filter.kind} onChange={selectKind} />
			<SectionHeader title="エージェントの状態" right={<Text style={styles.headerHint}>{statesEnabled ? 'ターミナルには効きません' : 'ターミナルだけを表示中'}</Text>} style={styles.groupGap} />
			<ListGroup style={statesEnabled ? undefined : styles.disabledGroup}>
				{STATE_SECTIONS.map(({ bucket, title }) => {
					const selected = filter.states.includes(bucket);
					return (
						<ListRow
							key={bucket}
							label={title}
							leading={<View style={[styles.dot, { backgroundColor: bucketDotColor(bucket) }]} />}
							selected={selected}
							trailing={selected ? 'check' : 'none'}
							disabled={!statesEnabled}
							onPress={() => toggleState(bucket)}
						/>
					);
				})}
			</ListGroup>
			{spaces.length > 0 ? (
				<>
					<SectionHeader title="スペース" style={styles.groupGap} />
					<ListGroup>
						{spaces.map(item => {
							const selected = filter.spaces.includes(item.id);
							return (
								<ListRow
									key={item.id}
									label={item.name}
									leading={<Icon icon={Folder} size={iconSize.md} color={spaceColor(item)} />}
									selected={selected}
									trailing={selected ? 'check' : 'none'}
									onPress={() => toggleSpace(item.id)}
								/>
							);
						})}
					</ListGroup>
				</>
			) : null}
		</BottomDrawer>
	);
}

/**
 * 種類の 3 択（すべて／エージェント／ターミナル）。1 つだけ選ぶ軸なので、行の複数選択ではなくセグメントにする。
 * 幅は親に任せて 3 等分する（iPad の左の列の幅でも収まる）。
 */
function KindSegments({ value, onChange }: { value: PcListKind; onChange: (kind: PcListKind) => void }) {
	return (
		<View style={styles.segments} accessibilityRole="radiogroup">
			{PC_LIST_KIND_OPTIONS.map(option => {
				const on = option.value === value;
				return (
					<Pressable
						key={option.value}
						onPress={() => onChange(option.value)}
						hitSlop={hitSlopToMinimum(SEGMENT_HEIGHT)}
						style={[styles.segment, on ? styles.segmentOn : undefined]}
						accessibilityRole="radio"
						accessibilityState={{ selected: on }}
						accessibilityLabel={option.label}
					>
						<Text style={[styles.segmentText, on ? styles.segmentTextOn : undefined]} numberOfLines={1}>{option.label}</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

/** セグメントの 1 つの高さ（pt。当たり判定は 44 に広げる）。 */
const SEGMENT_HEIGHT = 32;

/** 状態の点の大きさ（pt）。 */
const DOT_SIZE = 8;

const styles = StyleSheet.create({
	dot: {
		width: DOT_SIZE,
		height: DOT_SIZE,
		borderRadius: radius.pill,
	},
	groupGap: {
		marginTop: space.lg,
	},
	headerHint: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	disabledGroup: {
		opacity: 0.4,
	},
	segments: {
		flexDirection: 'row',
		gap: 2,
		padding: 2,
		borderRadius: radius.group,
		backgroundColor: colors.panel,
	},
	segment: {
		flex: 1,
		minHeight: SEGMENT_HEIGHT,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.xs,
		borderRadius: radius.group - 2,
	},
	segmentOn: {
		backgroundColor: colors.raised,
	},
	segmentText: {
		fontSize: type.label,
		color: colors.textDim,
	},
	segmentTextOn: {
		color: colors.text,
		fontWeight: '600',
	},
});
