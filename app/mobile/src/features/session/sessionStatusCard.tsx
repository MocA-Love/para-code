// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import { Gauge } from 'lucide-react-native';
import { claudeModelDisplayName } from '../../agentModels.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { Button, Icon } from '../../ui/index.js';

const AGENT_NAMES: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * `/status` を PC へ送らずに、この端末が持っている値で出すカード（モックの「/status をこの端末で表示」）。
 *
 * 載せるのは、PC が会話と一緒に送ってくる値（モデル・effort）と、この端末がスペースの一覧で持っている値（スペースの名前・
 * ブランチ）だけ。セッション ID は PC が送らない決まり（`info.resumeKey` の指紋だけ）で、コンテキストの使用率と作業フォルダの
 * パスは会話の同期に含まれないので載せない（/context は会話の知らせの行で出る）。
 */
export function SessionStatusCard({ agent, model, effort, spaceName, branch, onClose }: {
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	spaceName: string | undefined;
	branch: string | undefined;
	onClose: () => void;
}) {
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(14);
	const modelName = model !== undefined && agent === 'claude' ? claudeModelDisplayName(model) : undefined;
	const rows: [string, string][] = [];
	const agentName = agent !== undefined && Object.prototype.hasOwnProperty.call(AGENT_NAMES, agent) ? AGENT_NAMES[agent] : undefined;
	if (agentName !== undefined) {
		rows.push(['エージェント', agentName]);
	}
	if (model !== undefined) {
		rows.push(['モデル', modelName !== undefined && modelName !== model ? `${modelName}（${model}）` : model]);
	}
	if (effort !== undefined) {
		rows.push(['effort', effort]);
	}
	if (spaceName !== undefined) {
		rows.push(['スペース', branch !== undefined && branch.length > 0 ? `${spaceName} · ${branch}` : spaceName]);
	}
	return (
		<View style={styles.card} accessibilityLiveRegion="polite">
			<View style={styles.head}>
				<Icon icon={Gauge} size={iconSize} color={colors.blue} />
				<Text style={styles.title} accessibilityRole="header">セッションの状態</Text>
				<Text style={styles.tag}>この端末で表示</Text>
				<Button label="閉じる" variant="ghost" size="sm" onPress={onClose} />
			</View>
			{rows.length > 0 ? rows.map(([label, value]) => (
				<View key={label} style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
					<Text style={styles.label}>{label}</Text>
					<Text style={styles.value} selectable>{value}</Text>
				</View>
			)) : <Text style={styles.empty}>まだ PC から値が届いていません</Text>}
		</View>
	);
}

const baseStyles = StyleSheet.create({
	card: {
		marginBottom: space.sm,
		paddingHorizontal: space.md,
		paddingBottom: space.sm,
		borderRadius: radius.card,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	head: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 40,
	},
	title: {
		flexShrink: 1,
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
	tag: {
		flex: 1,
		fontSize: type.caption,
		color: colors.textMuted,
	},
	row: {
		flexDirection: 'row',
		gap: space.md,
		paddingVertical: 3,
	},
	label: {
		width: 84,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	value: {
		flex: 1,
		minWidth: 0,
		fontSize: type.meta,
		color: colors.text,
	},
	empty: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
});
