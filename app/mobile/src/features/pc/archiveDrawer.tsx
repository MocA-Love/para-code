// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef } from 'react';
import { StyleSheet, Text } from 'react-native';
import { pinKeyForTerminal } from '../../store.js';
import { colors, space, type } from '../../theme.js';
import { AgentStateDot, BottomDrawer, Button, DrawerTitle, ListGroup, ListRow, agentKindFromStatus } from '../../ui/index.js';

/** アーカイブの一覧に並べる行。 */
export interface ArchivedRow {
	readonly terminalKey: string;
	readonly title: string;
	readonly agentStatus: string | undefined;
	readonly spaceName: string | undefined;
	readonly branch: string | undefined;
}

/**
 * アーカイブの一覧（旧 `archive` 画面の置き換え。PC の画面のツールバーから開く）。
 * 「戻す」で一覧へ戻し、行を押すとそのセッションを開く。アーカイブはこの端末だけの印で、
 * PC 側のターミナルは動き続ける。要対応になったものは自動で一覧へ戻る（`archivedAgents.ts`）。
 */
export function ArchiveDrawer({ visible, rows, onRestore, onOpen, onClose }: {
	visible: boolean;
	rows: readonly ArchivedRow[];
	/** 印を外す（`setArchived(key, false)`）。 */
	onRestore: (key: string) => void;
	/** セッションを開く。シートが閉じ切ってから呼ぶ。 */
	onOpen: (terminalKey: string) => void;
	onClose: () => void;
}) {
	const pendingOpen = useRef<string | undefined>(undefined);
	return (
		<BottomDrawer
			visible={visible}
			onClose={onClose}
			onAfterClose={() => {
				const key = pendingOpen.current;
				pendingOpen.current = undefined;
				if (key !== undefined) {
					onOpen(key);
				}
			}}
			accessibilityLabel="アーカイブ"
		>
			<DrawerTitle
				title="アーカイブ"
				right={rows.length > 0 ? (
					<Button label="すべて戻す" variant="ghost" size="sm" onPress={() => rows.forEach(row => onRestore(pinKeyForTerminal(row)))} />
				) : undefined}
			/>
			<Text style={styles.note}>
				{rows.length > 0
					? 'PC ではそのまま動いています。質問や許可待ちになったものは自動で一覧へ戻ります。'
					: 'アーカイブしたエージェントはありません。'}
			</Text>
			{rows.length > 0 ? (
				<ListGroup>
					{rows.map(row => (
						<ListRow
							key={row.terminalKey}
							label={row.title}
							hint={[row.spaceName, row.branch].filter((part): part is string => part !== undefined && part.length > 0).join(' · ') || undefined}
							leading={<AgentStateDot kind={agentKindFromStatus(row.agentStatus)} />}
							trailing={<Button label="戻す" variant="secondary" size="sm" onPress={() => onRestore(pinKeyForTerminal(row))} />}
							onPress={() => {
								pendingOpen.current = row.terminalKey;
								onClose();
							}}
						/>
					))}
				</ListGroup>
			) : null}
		</BottomDrawer>
	);
}

const styles = StyleSheet.create({
	note: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
		paddingHorizontal: space.xs,
		marginBottom: space.md,
	},
});
