// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, View } from 'react-native';
import { Folder } from 'lucide-react-native';
import { hapticSelection } from '../../haptics.js';
import type { HomeStatusBucket } from '../../homeSort.js';
import { radius, space } from '../../theme.js';
import { BottomDrawer, Button, DrawerTitle, Icon, ListGroup, ListRow, SectionHeader, iconSize } from '../../ui/index.js';
import { STATE_SECTIONS, filterCount, toggleValue, type PcListFilter } from './pcList.js';
import { bucketDotColor } from './pcListParts.js';
import { spaceColor } from './spaceColor.js';

/**
 * 絞り込みのシート（モックの「スペースの絞り込み」）。状態とスペースを複数選べ、押すたびにすぐ一覧に効く
 * （閉じなくてよい）。スペースの切り替えもここで行う。
 */
export function FilterDrawer({ visible, filter, spaces, onChange, onClose }: {
	visible: boolean;
	filter: PcListFilter;
	spaces: readonly { readonly id: string; readonly name: string; readonly color?: string }[];
	onChange: (next: PcListFilter) => void;
	onClose: () => void;
}) {
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
				right={<Button label="クリア" variant="ghost" size="sm" disabled={filterCount(filter) === 0} onPress={() => onChange({ ...filter, states: [], spaces: [] })} />}
			/>
			<SectionHeader title="状態" />
			<ListGroup>
				{STATE_SECTIONS.map(({ bucket, title }) => {
					const selected = filter.states.includes(bucket);
					return (
						<ListRow
							key={bucket}
							label={title}
							leading={<View style={[styles.dot, { backgroundColor: bucketDotColor(bucket) }]} />}
							selected={selected}
							trailing={selected ? 'check' : 'none'}
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
});
