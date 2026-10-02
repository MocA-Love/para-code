// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ScrollView, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PillHitArea } from './pillHitArea.js';
import { SelectablePill } from './selectablePill.js';
import { colors, radius, squircle, type } from '../theme.js';
import { haptic } from '../haptics.js';
import type { RelayHost } from '../relayHosts.js';

/**
 * ピルの見た目の高さ（最小）。当たり判定（HIT_SIZE）との差は、行の上下の余白になる。
 * 以前は負の margin でその差を行の外（上の要素＝ヘッダーの直下）へはみ出させて見た目の位置を保っていたが、
 * 食い込んだところを押したタッチをこの行が奪うのでやめた。ピルの上下の見た目の余白は、そのぶん以前（上4・下2）より広い。
 * 高さを固定にすると文字を大きくする設定で文字がはみ出すので、最小値として持つ。
 */
const PILL_HEIGHT = 28;

/**
 * 「接続先セグメント」— 使用量 / コスト / 利用上限 / RTK の節約 の各画面のヘッダー直下に置く、PC内の
 * 接続先（ローカル/SSHリモート）を選ぶピル列。PCが1台の接続先しか持たない（＝SSHウィンドウを
 * 同時に開いていない）ときは何も描かない——ローカルだけの利用者に空振りの1ステップを見せない。
 *
 * ローカルかリモートかは**色ではなくアイコン**で示す。以前は点の色（リモート=紫）で分けていたが、
 * 同じ画面の紫が別の意味（コスト画面の Gemini）と重なっていた。
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
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
			{hosts.map(host => {
				const active = host.id === selectedId;
				const select = () => { haptic('tick'); onSelect(host.id); };
				return (
					<PillHitArea key={host.id} onPress={select}>
						<SelectablePill
							active={active}
							onPress={select}
							style={[styles.pill, !host.ready && styles.pillOffline]}
							hitStyle={styles.pillHit}
							accessibilityLabel={host.ready ? host.label : `${host.label}（オフライン）`}
						>
							<Ionicons
								name={host.kind === 'local' ? 'desktop-outline' : 'server-outline'}
								size={12}
								color={active ? colors.bg : colors.textDim}
							/>
							<Text style={[styles.text, active && styles.textActive]} numberOfLines={1}>
								{host.label}{!host.ready ? ' ○' : ''}
							</Text>
						</SelectablePill>
					</PillHitArea>
				);
			})}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', gap: 7, paddingRight: 4 },
	pill: { borderRadius: radius.pill, ...squircle, minHeight: PILL_HEIGHT },
	pillOffline: { opacity: 0.55 },
	pillHit: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 7, paddingHorizontal: 13 },
	text: { color: colors.textDim, fontSize: type.meta, fontWeight: '600' },
	textActive: { color: colors.bg },
});
