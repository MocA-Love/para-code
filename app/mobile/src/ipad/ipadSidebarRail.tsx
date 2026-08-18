// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import { isAgentWaiting } from '../store.js';
import { colors } from '../theme.js';
import { activeSidebarTab, SIDEBAR_TABS } from './ipadTabs.js';
import { selectTab } from './ipadSelectTab.js';

/**
 * サイドバーを畳んだときの「レール」（`IpadShell` の開閉ボタンで切り替わる）。
 * ワークスペース一覧は出さず、iPhone版の下部タブに相当する4アイコンを縦に並べるだけに
 * 徹する（展開すればすぐ全部見えるため、レールは「今どのタブにいるか」の道しるべ）。
 */
export function IpadSidebarRail() {
	const router = useRouter();
	const pathname = usePathname();
	const active = activeSidebarTab(pathname);
	const pending = useAppStore(s => (s.workspace?.terminals ?? []).filter(t => isAgentWaiting(t.agentStatus)).length);

	return (
		<View style={styles.wrap}>
			{SIDEBAR_TABS.map(tab => {
				const isActive = active === tab.name;
				return (
					<Pressable
						key={tab.name}
						style={styles.tab}
						onPress={() => selectTab(router, tab, active)}
						accessibilityRole="tab"
						accessibilityState={{ selected: isActive }}
						accessibilityLabel={tab.label}
					>
						<View>
							<Ionicons name={isActive ? tab.iconActive : tab.icon} size={21} color={isActive ? colors.accent : colors.textDim} />
							{tab.badge && pending > 0 ? (
								<View style={styles.badge}><Text style={styles.badgeText}>{pending}</Text></View>
							) : null}
						</View>
					</Pressable>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22 },
	tab: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
	badge: {
		position: 'absolute', top: -5, right: -9, minWidth: 15, height: 15, borderRadius: 8,
		backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
	},
	badgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
});
