// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import type { WorkspacePrStatus } from '../store.js';
import { alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { monoFamily } from '../monoFont.js';
import { hitSlopToMinimum } from './hitSlop.js';
import { PILL_HEIGHT } from './modelPill.js';

/**
 * エージェントコンポーザーのPRピル（prr.html 案A）。エージェントの所属ワークスペースの
 * 現在ブランチにGitHub PRが紐づいている場合のみ表示し、タップで外部ブラウザのPRページを開く。
 * 状態・アイコンはPC版WorkspacesビューのPRチップ（paradisWorkspaceSwitch.css）と同じ
 * GitHub準拠4状態（open/draft/merged/closed）。色はテーマの対応色に寄せている。
 */
export function PrPill({ pr }: { pr: WorkspacePrStatus }) {
	const look = PR_STATE_LOOK[pr.state] ?? PR_STATE_LOOK.open;
	return (
		<Pressable
			style={[styles.pill, { backgroundColor: look.wash, borderColor: look.border }]}
			hitSlop={PILL_HIT_SLOP}
			onPress={() => {
				void Linking.openURL(pr.url).catch(() => { /* 開けないURLは無視 */ });
			}}
			accessibilityRole="link"
			accessibilityLabel={`PR #${pr.number}（${look.label}）をブラウザで開く`}
		>
			<Octicons name={look.icon} size={13} color={look.color} />
			<Text style={[styles.number, { color: look.color }]}>#{pr.number}</Text>
		</Pressable>
	);
}

/** 状態 → 色・アイコン。PC版CSSのGitHub準拠4状態をテーマの green / textDim / purple / red に寄せ、ウォッシュ/枠線は alpha の段（wash/line）で重ねる。 */
const PR_STATE_LOOK: Record<WorkspacePrStatus['state'], {
	color: string;
	wash: string;
	border: string;
	icon: 'git-pull-request' | 'git-pull-request-draft' | 'git-merge' | 'git-pull-request-closed';
	label: string;
}> = {
	open: { color: colors.green, wash: tint(colors.green, alpha.wash), border: tint(colors.green, alpha.line), icon: 'git-pull-request', label: 'Open' },
	draft: { color: colors.textDim, wash: tint(colors.textDim, alpha.wash), border: tint(colors.textDim, alpha.line), icon: 'git-pull-request-draft', label: 'Draft' },
	merged: { color: colors.purple, wash: tint(colors.purple, alpha.wash), border: tint(colors.purple, alpha.line), icon: 'git-merge', label: 'Merged' },
	closed: { color: colors.red, wash: tint(colors.red, alpha.wash), border: tint(colors.red, alpha.line), icon: 'git-pull-request-closed', label: 'Closed' },
};

const PILL_HIT_SLOP = hitSlopToMinimum(PILL_HEIGHT);

const styles = StyleSheet.create({
	// ModelPill（styles.pill）と同じピル文法。PRピルは常に完全表示し、
	// 幅が足りないときはModelPill側（maxWidth指定あり）を省略させる。
	pill: {
		flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0,
		borderWidth: 1, borderRadius: radius.pill, ...squircle, paddingVertical: 9, paddingHorizontal: 12, minHeight: PILL_HEIGHT,
	},
	number: { fontSize: type.meta, fontWeight: '600', fontFamily: monoFamily },
});
