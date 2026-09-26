// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Construction, Folder } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../src/appState.js';
import { useRoutePc } from '../../../src/hooks/useRouteTargets.js';
import { routes } from '../../../src/routes.js';
import { space } from '../../../src/theme.js';
import { EmptyState, HeaderMetaText, ListGroup, ListRow, Screen, ScreenHeader, SectionHeader, StatusDot, connectionKind, connectionLabel } from '../../../src/ui/index.js';

const NO_SPACES: { id: string; name: string; branch?: string }[] = [];

/**
 * PC の画面（`/pc/[pcId]`）。**段階2の仮の画面**で、段階3の担当が Orca の host-screen
 * （2段のヘッダー、絞り込み・並び替え・グループ、スペースとエージェントの一覧、右下の ＋）に作り直す。
 * いまはスペースのセッションへ進む導線だけを置いている。
 */
export default function PcScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ pcId?: string }>();
	const { pcId, pc, status } = useRoutePc(params.pcId);
	const spaces = useAppStore(useShallow(s => (status === 'active' ? s.workspace?.workspaces ?? NO_SPACES : NO_SPACES)));
	const kind = pc !== undefined ? connectionKind(pc.connection, pc.pcOnline) : 'offline';
	return (
		<Screen>
			<ScreenHeader
				title={pc?.name ?? 'PC'}
				surface="panel"
				meta={pc !== undefined ? <><StatusDot kind={kind} /><HeaderMetaText>{connectionLabel(kind)}</HeaderMetaText></> : undefined}
			/>
			{status === 'unknown' ? (
				<EmptyState title="この PC は見つかりません" body="ペアリングを解除した PC かもしれません。" />
			) : (
				<ScrollView contentContainerStyle={styles.body}>
					<EmptyState icon={Construction} title="作成中" body="PC の画面は作り直しの途中です。" style={styles.placeholder} />
					<SectionHeader title="スペース" count={spaces.length} />
					<ListGroup>
						{spaces.map(item => (
							<ListRow
								key={item.id}
								icon={Folder}
								label={item.name}
								hint={item.branch}
								trailing="chevron"
								onPress={() => { if (pcId !== undefined) { router.push(routes.session(pcId, item.id)); } }}
							/>
						))}
					</ListGroup>
				</ScrollView>
			)}
		</Screen>
	);
}


const styles = StyleSheet.create({
	body: {
		padding: space.lg,
	},
	placeholder: {
		flex: 0,
		marginBottom: space.xl,
	},
});
