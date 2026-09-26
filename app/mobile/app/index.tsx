// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, Construction, Monitor, Settings } from 'lucide-react-native';
import { useAppStore } from '../src/appState.js';
import { routes } from '../src/routes.js';
import { space } from '../src/theme.js';
import { EmptyState, HeaderButton, ListGroup, ListRow, Screen, ScreenHeader, SectionHeader, StatusDot, connectionKind, connectionLabel } from '../src/ui/index.js';

/**
 * ホーム（`/`）。**段階2の仮の画面**で、段階3の担当が Orca の MobileHomeScreen（見出し・統計・
 * PC のカード・再開・クイック操作・使用量）に作り直す。いまは PC の画面へ進む導線だけを置いている。
 */
export default function HomeScreen() {
	const router = useRouter();
	const pcs = useAppStore(s => s.pcs);
	const unread = useAppStore(s => s.notifications.length);
	return (
		<Screen>
			<ScreenHeader
				title="Para Code"
				back={false}
				right={(
					<>
						<HeaderButton icon={Bell} label="通知" round badge={unread} onPress={() => router.push(routes.notifications())} />
						<HeaderButton icon={Settings} label="設定" round onPress={() => router.push(routes.settings())} />
					</>
				)}
			/>
			<ScrollView contentContainerStyle={styles.body}>
				<EmptyState icon={Construction} title="作成中" body="ホームは作り直しの途中です。" style={styles.placeholder} />
				<SectionHeader title="デスクトップ" />
				<ListGroup>
					{pcs.map(pc => (
						<ListRow
							key={pc.id}
							icon={Monitor}
							label={pc.name}
							hint={connectionLabel(connectionKind(pc.connection, pc.pcOnline))}
							trailing={<StatusDot kind={connectionKind(pc.connection, pc.pcOnline)} />}
							onPress={() => router.push(routes.pc(pc.id))}
						/>
					))}
					<ListRow label="PC をペアリング" trailing="chevron" onPress={() => router.push(routes.pair())} />
				</ListGroup>
			</ScrollView>
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
