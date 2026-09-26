// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FileText } from 'lucide-react-native';
import { APP_VERSION } from '../../src/components/updateSheet.js';
import { hapticSelection } from '../../src/haptics.js';
import { routes } from '../../src/routes.js';
import { colors, space, type } from '../../src/theme.js';
import { ListGroup, ListRow } from '../../src/ui/index.js';
import { LogoTile, ParaLogo } from '../../src/features/pairing/paraLogo.js';
import { SettingsScreen } from '../../src/features/settings/settingsScaffold.js';

/**
 * このアプリについて（`/settings/about`。モックの「このアプリについて」）。
 * 印・名前・版と、更新履歴への行。モックの「オープンソースライセンス」は Para Code に一覧が無いので置いていない。
 */
export default function AboutScreen() {
	const router = useRouter();
	return (
		<SettingsScreen title="このアプリについて">
			<View style={styles.identity}>
				<LogoTile><ParaLogo size={34} /></LogoTile>
				<Text style={styles.name}>Para Code Mobile</Text>
				<Text style={styles.version}>バージョン {APP_VERSION}</Text>
			</View>
			<ListGroup>
				<ListRow icon={FileText} label="更新履歴" trailing="chevron" onPress={() => { hapticSelection(); router.push(routes.settings('changelog')); }} />
			</ListGroup>
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	identity: {
		alignItems: 'center',
		gap: space.sm,
		paddingTop: space.md,
		paddingBottom: space.xl,
	},
	name: {
		fontSize: type.title,
		fontWeight: '700',
		color: colors.text,
	},
	version: {
		fontSize: type.meta,
		color: colors.textDim,
	},
});
