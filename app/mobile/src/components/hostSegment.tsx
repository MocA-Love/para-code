// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SelectablePill } from './selectablePill.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import type { RelayHost } from '../relayHosts.js';

/**
 * 「接続先セグメント」— rtk/ccusage/rate limit の各画面のヘッダー直下に置く、PC内の
 * 接続先（ローカル/SSHリモート）を選ぶピル列。PCが1台の接続先しか持たない（＝SSHウィンドウを
 * 同時に開いていない）ときは何も描かない——ローカルだけの利用者に空振りの1ステップを見せない。
 */
export function HostSegment({ hosts, selectedId, onSelect }: {
	hosts: readonly RelayHost[];
	selectedId: string | undefined;
	onSelect: (id: string) => void;
}) {
	if (hosts.length <= 1) {
		return null;
	}
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.row}>
			{hosts.map(host => {
				const active = host.id === selectedId;
				return (
					<SelectablePill
						key={host.id}
						active={active}
						onPress={() => { hapticSelection(); onSelect(host.id); }}
						style={[styles.pill, !host.ready && styles.pillOffline]}
						hitStyle={styles.pillHit}
						accessibilityLabel={host.ready ? host.label : `${host.label}（オフライン）`}
					>
						<View style={[styles.dot, { backgroundColor: host.kind === 'local' ? colors.accent : colors.purple }]} />
						<Text style={[styles.text, active && styles.textActive]} numberOfLines={1}>
							{host.label}{!host.ready ? ' ○' : ''}
						</Text>
					</SelectablePill>
				);
			})}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	scroll: { marginTop: 4, marginBottom: 2 },
	row: { flexDirection: 'row', gap: 7, paddingRight: 4 },
	pill: { borderRadius: radius.pill, ...squircle },
	pillOffline: { opacity: 0.55 },
	pillHit: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 7, paddingHorizontal: 13 },
	dot: { width: 5, height: 5, borderRadius: 999, opacity: 0.8 },
	text: { color: colors.textDim, fontSize: 11.5, fontWeight: '600' },
	textActive: { color: colors.bg },
});
