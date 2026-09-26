// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HIT_SIZE, alpha, colors, radius, space, squircle, status, tint, type } from '../theme.js';
import { Badge } from './badge.js';
import { hitSlopToMinimum } from './hitSlop.js';

/** リンク行の高さ。会話の上余白・SubAgents の帯の位置の計算に使う。 */
export const AGENT_LINKS_HEIGHT = HIT_SIZE;

type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * エージェント会話画面のヘッダー直下に置く、関連画面への切替の帯。
 *
 * 左に「ターミナル / 変更 / ブラウザ」へのリンク、右に他のエージェントの要対応が残っていれば
 * 「要対応 N 件 ›」のピルを置く（狭い幅では「要対応」の側を省略し、件数は必ず見せる）。ピルを押すと次の要対応のエージェントへ移る
 * （ホームへ戻らずに、要対応を続けて片付けられるように）。
 *
 * 帯そのものは押せない。押せるのは各リンク（44pt）とピルだけ。
 */
export function AgentScreenLinks({ onTerminal, onChanges, changeCount, onBrowser, browserShared, attentionCount, onNextAttention }: {
	onTerminal: () => void;
	onChanges: () => void;
	/** このスペースの未コミットの変更の件数（取得できていなければ undefined）。 */
	changeCount: number | undefined;
	onBrowser: () => void;
	/** このエージェントと共有中のブラウザページがあるか。 */
	browserShared: boolean;
	/** いま開いているエージェント以外の要対応の件数。 */
	attentionCount: number;
	onNextAttention: () => void;
}) {
	return (
		<View style={styles.row}>
			<LinkItem icon="terminal-outline" label="ターミナル" onPress={onTerminal} accessibilityLabel="このエージェントのターミナルを開く" />
			<LinkItem
				icon="git-branch-outline"
				label="変更"
				onPress={onChanges}
				accessibilityLabel={changeCount !== undefined && changeCount > 0 ? `ソース管理を開く（変更 ${changeCount}件）` : 'ソース管理を開く'}
				trailing={changeCount !== undefined && changeCount > 0 ? <Badge label={changeCount > 999 ? '999+' : String(changeCount)} mono style={styles.countBadge} /> : undefined}
			/>
			<LinkItem
				icon="globe-outline"
				label="ブラウザ"
				onPress={onBrowser}
				accessibilityLabel={browserShared ? 'ブラウザを開く（共有中のページがあります）' : 'ブラウザを開く'}
				trailing={browserShared ? <View style={styles.sharedDot} /> : undefined}
			/>
			<View style={styles.spacer} />
			{attentionCount > 0 ? (
				<Pressable
					style={({ pressed }) => [styles.attention, pressed && styles.pressed]}
					hitSlop={ATTENTION_HIT_SLOP}
					onPress={onNextAttention}
					accessibilityRole="button"
					accessibilityLabel={`${status.attention.label}の次のエージェントへ移動（あと ${attentionCount}件）`}
				>
					{/* 幅が足りないときに省略するのは呼び名の側。件数は縮めずに残す（末尾の件数が「…」に消えないように）。 */}
					<Text style={styles.attentionText} numberOfLines={1}>{status.attention.label}</Text>
					<Text style={[styles.attentionText, styles.attentionCount]} numberOfLines={1}>{attentionCount} 件</Text>
					<Ionicons name="chevron-forward" size={12} color={status.attention.color} />
				</Pressable>
			) : null}
		</View>
	);
}

function LinkItem({ icon, label, onPress, accessibilityLabel, trailing }: {
	icon: IoniconName;
	label: string;
	onPress: () => void;
	accessibilityLabel: string;
	trailing?: ReactNode;
}) {
	return (
		<Pressable
			style={({ pressed }) => [styles.link, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="link"
			accessibilityLabel={accessibilityLabel}
		>
			<Ionicons name={icon} size={15} color={colors.textDim} />
			<Text style={styles.linkText}>{label}</Text>
			{trailing}
		</Pressable>
	);
}

/** 要対応ピルの見た目の高さ。当たり判定は 44pt へ広げる。 */
const ATTENTION_HEIGHT = 28;
const ATTENTION_HIT_SLOP = hitSlopToMinimum(ATTENTION_HEIGHT);

const styles = StyleSheet.create({
	row: { height: AGENT_LINKS_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.sm },
	link: { minHeight: HIT_SIZE, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.sm, borderRadius: radius.control, ...squircle },
	linkText: { color: colors.text, fontSize: type.meta, fontWeight: '600' },
	// Badge は既定で上寄せ（alignSelf: flex-start）なので、行の中では縦中央へ戻す。
	countBadge: { alignSelf: 'center' },
	sharedDot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.green },
	spacer: { flex: 1 },
	attention: {
		height: ATTENTION_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 10, flexShrink: 1,
		borderRadius: radius.pill, ...squircle, backgroundColor: tint(colors.red, alpha.wash), borderWidth: StyleSheet.hairlineWidth, borderColor: tint(colors.red, alpha.line),
	},
	attentionText: { color: status.attention.color, fontSize: type.caption, fontWeight: '700', flexShrink: 1 },
	attentionCount: { flexShrink: 0 },
	pressed: { opacity: 0.6 },
});
