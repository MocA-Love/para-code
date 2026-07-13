// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { hapticSelection } from '../haptics.js';
import type { WorkspacePrStatus } from '../store.js';

/**
 * エージェントコンポーザーのPRピル（prr.html 案A）。エージェントの所属ワークスペースの
 * 現在ブランチにGitHub PRが紐づいている場合のみ表示し、タップで外部ブラウザのPRページを開く。
 * 状態色・アイコンはPC版WorkspacesビューのPRチップ（paradisWorkspaceSwitch.css）と同一の
 * GitHub準拠4状態（open/draft/merged/closed）。
 */
export function PrPill({ pr }: { pr: WorkspacePrStatus }) {
	const look = PR_STATE_LOOK[pr.state] ?? PR_STATE_LOOK.open;
	return (
		<Pressable
			style={[styles.pill, { backgroundColor: look.wash, borderColor: look.border }]}
			onPress={() => {
				hapticSelection();
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

/** 状態 → 色・アイコン。色はPC版CSSの16進値、ウォッシュ/枠線は同CSSのcolor-mix比率（12%/38%）を焼き込んだもの。 */
const PR_STATE_LOOK: Record<WorkspacePrStatus['state'], {
	color: string;
	wash: string;
	border: string;
	icon: 'git-pull-request' | 'git-pull-request-draft' | 'git-merge' | 'git-pull-request-closed';
	label: string;
}> = {
	open: { color: '#3fb950', wash: 'rgba(63,185,80,0.12)', border: 'rgba(63,185,80,0.38)', icon: 'git-pull-request', label: 'Open' },
	draft: { color: '#8b949e', wash: 'rgba(139,148,158,0.12)', border: 'rgba(139,148,158,0.38)', icon: 'git-pull-request-draft', label: 'Draft' },
	merged: { color: '#a371f7', wash: 'rgba(163,113,247,0.12)', border: 'rgba(163,113,247,0.38)', icon: 'git-merge', label: 'Merged' },
	closed: { color: '#f85149', wash: 'rgba(248,81,73,0.12)', border: 'rgba(248,81,73,0.38)', icon: 'git-pull-request-closed', label: 'Closed' },
};

const styles = StyleSheet.create({
	// ModelPill（styles.pill）と同じピル文法。PRピルは常に完全表示し、
	// 幅が足りないときはModelPill側（maxWidth指定あり）を省略させる。
	pill: {
		flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0,
		borderWidth: 1, borderRadius: 999, paddingVertical: 9, paddingHorizontal: 12,
	},
	number: { fontSize: 12, fontWeight: '600', fontFamily: 'Menlo' },
});
