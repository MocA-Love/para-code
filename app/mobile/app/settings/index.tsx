// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Activity, Bell, Construction, FileText, Info, ListChecks, Monitor, Terminal } from 'lucide-react-native';
import { routes, type SettingsPage } from '../../src/routes.js';
import { space } from '../../src/theme.js';
import { EmptyState, ListGroup, ListRow, Screen, ScreenHeader, type LucideIcon } from '../../src/ui/index.js';

const PAGES: readonly { readonly page: SettingsPage; readonly label: string; readonly icon: LucideIcon }[] = [
	{ page: 'terminal', label: 'ターミナル', icon: Terminal },
	{ page: 'notifications', label: '通知と音声', icon: Bell },
	{ page: 'presets', label: 'コマンドプリセット', icon: ListChecks },
	{ page: 'usage', label: '使用量', icon: Activity },
	{ page: 'pcs', label: 'PC', icon: Monitor },
	{ page: 'changelog', label: '更新履歴', icon: FileText },
	{ page: 'about', label: 'このアプリについて', icon: Info },
];

/**
 * 設定（`/settings`）。**段階2の仮の画面**で、段階6の担当が Orca の settings（inset grouped）に
 * 作り直す。いまは下のページ（`app/settings/*.tsx`）へ進む導線だけを置いている。
 */
export default function SettingsScreen() {
	const router = useRouter();
	return (
		<Screen>
			<ScreenHeader title="設定" variant="settings" />
			<ScrollView contentContainerStyle={styles.body}>
				<EmptyState icon={Construction} title="作成中" body="設定は作り直しの途中です。" style={styles.placeholder} />
				<ListGroup>
					{PAGES.map(item => (
						<ListRow key={item.page} icon={item.icon} label={item.label} trailing="chevron" onPress={() => router.push(routes.settings(item.page))} />
					))}
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
