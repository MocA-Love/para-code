// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentChatMessage } from '../store.js';
import {
	buildTimelineSteps, describeMeta, describeStep, summarizeSteps,
	type AgentStepTone, type AgentTimelineStep,
} from '../agentToolMeta.js';
import { ThinkingBody, ToolStepBody } from './agentToolBodies.js';
import { colors, mono } from '../theme.js';
import { hapticSelection } from '../haptics.js';

/**
 * thinking / tool 群の集約表示（案A「タイムライン・レーン」）。
 *
 * 二段構造にしている:
 *  1段目 = 集約行（既定は折りたたみ。「思考 ×2 ・ ツール5件 ・ 48秒」）
 *  2段目 = 各ステップのヘッダー行（何をしたかの一覧）
 *  3段目 = ステップを開いた中身（入力と結果の全文）
 *
 * 中身は行数で切らず、枠の高さ上限＋枠内スクロールで抑える。旧実装は展開しても
 * numberOfLines で切っていたため「展開したのに続きが読めない」状態だった。
 */
/**
 * **memo する。** ストリーミング中は親（agent.tsx）が delta ごとに再描画されるうえ、
 * 集約行の `msgs` 配列は rows 再計算のたびに作り直される。コンパレータで要素の同一性まで
 * 見ないと memo が素通りし、折りたたみ中も buildTimelineSteps/summarizeSteps が走り続ける。
 */
export const AgentTimeline = memo(function AgentTimeline({ msgs, terminalKey }: { msgs: AgentChatMessage[]; terminalKey?: string }) {
	const [expanded, setExpanded] = useState(false);
	const steps = buildTimelineSteps(msgs);
	return (
		<View>
			<Pressable
				style={styles.aggRow}
				onPress={() => { hapticSelection(); setExpanded(value => !value); }}
				accessibilityRole="button"
				accessibilityState={{ expanded }}
				accessibilityLabel={expanded ? 'アクティビティを折りたたむ' : 'アクティビティを展開'}
			>
				<Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={12} color={colors.textDim} />
				<Text style={styles.aggText} numberOfLines={1}>{summarizeSteps(msgs)}</Text>
			</Pressable>
			{expanded ? (
				<View style={styles.lane}>
					{steps.map((step, index) => (
						<TimelineStepRow key={step.key} step={step} terminalKey={terminalKey} first={index === 0} last={index === steps.length - 1} />
					))}
				</View>
			) : null}
		</View>
	);
}, (prev, next) =>
	prev.terminalKey === next.terminalKey
	&& prev.msgs.length === next.msgs.length
	&& prev.msgs.every((m, i) => m === next.msgs[i]));

/** ステップ1件（ヘッダー行＋開いた中身）。 */
function TimelineStepRow({ step, terminalKey, first, last }: { step: AgentTimelineStep; terminalKey?: string; first: boolean; last: boolean }) {
	const [open, setOpen] = useState(false);
	const description = describeStep(step);
	const meta = describeMeta(step);
	const chipStyle = toneChipStyle(description.tone);
	const nameStyle = toneNameStyle(description.tone);
	return (
		<View style={styles.step}>
			<View style={styles.gutter}>
				{/* レーンの縦線。先頭は上半分、末尾は下半分を描かず、線の端を丸く見せる */}
				{first ? null : <View style={[styles.laneLine, styles.laneLineTop]} />}
				{last ? null : <View style={[styles.laneLine, styles.laneLineBottom]} />}
				<View style={[styles.node, description.tone === 'error' ? styles.nodeError : null]}>
					<View style={[styles.nodeDot, toneDotStyle(description.tone)]} />
				</View>
			</View>
			<View style={styles.stepBody}>
				<Pressable
					style={styles.head}
					onPress={() => { hapticSelection(); setOpen(value => !value); }}
					accessibilityRole="button"
					accessibilityState={{ expanded: open }}
					accessibilityLabel={`${description.label}の詳細を${open ? '折りたたむ' : '展開'}`}
				>
					<View style={[styles.chip, chipStyle]}>
						<Ionicons name={description.icon as never} size={11} color={chipStyle.color ?? colors.textDim} />
					</View>
					<Text style={[styles.name, nameStyle]} numberOfLines={1}>
						{description.label}
						{description.namespace !== undefined ? <Text style={styles.namespace}>{description.namespace}</Text> : null}
					</Text>
					{description.arg !== undefined && description.arg.length > 0
						? <Text style={styles.arg} numberOfLines={1}>{description.arg}</Text>
						: <View style={styles.argSpacer} />}
					{meta !== undefined ? <Text style={[styles.meta, metaToneStyle(meta.tone)]}>{meta.text}</Text> : null}
				</Pressable>
				{open ? <StepBody step={step} terminalKey={terminalKey} /> : null}
			</View>
		</View>
	);
}

/** ステップを開いた中身。ツールの性質ごとの作り分けは agentToolBodies が持つ。 */
function StepBody({ step, terminalKey }: { step: AgentTimelineStep; terminalKey?: string }) {
	const thinking = step.thinking;
	if (step.kind === 'thinking' && thinking !== undefined) {
		return <ThinkingBody message={thinking} terminalKey={terminalKey} />;
	}
	return <ToolStepBody step={step} terminalKey={terminalKey} />;
}

function toneChipStyle(tone: AgentStepTone): { backgroundColor?: string; borderColor?: string; color?: string } {
	switch (tone) {
		case 'thinking': return { backgroundColor: 'rgba(193,147,217,0.12)', borderColor: 'rgba(193,147,217,0.28)', color: colors.purple };
		case 'mcp': return { backgroundColor: 'rgba(9,175,217,0.10)', borderColor: 'rgba(9,175,217,0.26)', color: colors.accent };
		case 'agent': return { backgroundColor: 'rgba(217,119,87,0.14)', borderColor: 'rgba(217,119,87,0.30)', color: colors.claude };
		case 'approval': return { backgroundColor: 'rgba(224,192,125,0.12)', borderColor: 'rgba(224,192,125,0.30)', color: colors.yellow };
		case 'error': return { backgroundColor: 'rgba(244,114,114,0.12)', borderColor: 'rgba(244,114,114,0.30)', color: colors.red };
		case 'live': return { backgroundColor: colors.accentWash, borderColor: 'rgba(9,175,217,0.32)', color: colors.accent };
		default: return {};
	}
}

function toneNameStyle(tone: AgentStepTone): { color?: string } {
	switch (tone) {
		case 'thinking': return { color: colors.purple };
		case 'agent': return { color: colors.claude };
		case 'approval': return { color: colors.yellow };
		default: return {};
	}
}

function toneDotStyle(tone: AgentStepTone): { backgroundColor?: string } {
	switch (tone) {
		case 'thinking': return { backgroundColor: colors.purple };
		case 'error': return { backgroundColor: colors.red };
		case 'approval': return { backgroundColor: colors.yellow };
		case 'live': return { backgroundColor: colors.accent };
		default: return { backgroundColor: colors.green };
	}
}

function metaToneStyle(tone: 'default' | 'good' | 'bad' | 'warn'): { color?: string } {
	switch (tone) {
		case 'good': return { color: colors.green };
		case 'bad': return { color: colors.red };
		case 'warn': return { color: colors.yellow };
		default: return {};
	}
}

const NODE = 12;
const GUTTER = 24;

const styles = StyleSheet.create({
	aggRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 3 },
	aggText: { color: colors.textDim, fontSize: 11.5, flex: 1 },
	lane: { marginLeft: 8, marginTop: 2 },
	step: { flexDirection: 'row', alignItems: 'stretch' },
	// レーンの縦線とノードは専用の左カラムに描く（親からはみ出す絶対配置は
	// Android で描画されないことがあるため、はみ出さない構造にしている）。
	gutter: { width: GUTTER, alignItems: 'center' },
	laneLine: { position: 'absolute', width: 1.5, backgroundColor: 'rgba(255,255,255,0.10)', left: (GUTTER - 1.5) / 2 },
	laneLineTop: { top: 0, height: 9 + NODE / 2 },
	laneLineBottom: { top: 9 + NODE / 2, bottom: 0 },
	node: { position: 'absolute', top: 9, width: NODE, height: NODE, borderRadius: NODE / 2, backgroundColor: colors.bg, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
	nodeError: { borderColor: 'rgba(244,114,114,0.5)' },
	nodeDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.textDim },
	stepBody: { flex: 1, minWidth: 0 },
	head: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingRight: 8, paddingVertical: 6 },
	chip: { width: 20, height: 20, borderRadius: 6, backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
	name: { color: colors.text, fontSize: 12, fontWeight: '700', flexShrink: 0 },
	namespace: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	arg: { flex: 1, minWidth: 0, color: colors.textDim, fontSize: 10.5, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
	argSpacer: { flex: 1 },
	meta: { color: colors.textDim, fontSize: 9.5, opacity: 0.85 },
});
