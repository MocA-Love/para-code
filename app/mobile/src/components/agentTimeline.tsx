// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentChatMessage } from '../store.js';
import {
	buildTimelineSteps, describeMeta, describeStep, summarizeSteps,
	type AgentStepTone, type AgentTimelineStep,
} from '../agentToolMeta.js';
import { ThinkingBody, ToolStepBody } from './agentToolBodies.js';
import { HIT_SIZE, alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { monoFamily } from '../monoFont.js';
import { haptic } from '../haptics.js';

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
				onPress={() => { haptic('move'); setExpanded(value => !value); }}
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
					onPress={() => { haptic('move'); setOpen(value => !value); }}
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
		case 'thinking': return { backgroundColor: tint(colors.purple, alpha.wash), borderColor: tint(colors.purple, alpha.line), color: colors.purple };
		case 'mcp': return { backgroundColor: tint(colors.accent, alpha.wash), borderColor: tint(colors.accent, alpha.line), color: colors.accent };
		case 'agent': return { backgroundColor: tint(colors.claude, alpha.wash), borderColor: tint(colors.claude, alpha.line), color: colors.claude };
		case 'approval': return { backgroundColor: tint(colors.red, alpha.wash), borderColor: tint(colors.red, alpha.line), color: colors.red };
		case 'error': return { backgroundColor: tint(colors.red, alpha.wash), borderColor: tint(colors.red, alpha.line), color: colors.red };
		case 'live': return { backgroundColor: tint(colors.amber, alpha.wash), borderColor: tint(colors.amber, alpha.line), color: colors.amber };
		default: return {};
	}
}

function toneNameStyle(tone: AgentStepTone): { color?: string } {
	switch (tone) {
		case 'thinking': return { color: colors.purple };
		case 'agent': return { color: colors.claude };
		case 'approval': return { color: colors.red };
		default: return {};
	}
}

function toneDotStyle(tone: AgentStepTone): { backgroundColor?: string } {
	switch (tone) {
		case 'thinking': return { backgroundColor: colors.purple };
		case 'error': return { backgroundColor: colors.red };
		case 'approval': return { backgroundColor: colors.red };
		case 'live': return { backgroundColor: colors.amber };
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
/** ステップ見出しは 44pt の行。ノードはその縦中央に置く。 */
const NODE_TOP = (HIT_SIZE - NODE) / 2;

const styles = StyleSheet.create({
	aggRow: { minHeight: HIT_SIZE, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
	aggText: { color: colors.textDim, fontSize: type.meta, flex: 1 },
	lane: { marginLeft: 8, marginTop: 2 },
	step: { flexDirection: 'row', alignItems: 'stretch' },
	// レーンの縦線とノードは専用の左カラムに描く（親からはみ出す絶対配置は
	// Android で描画されないことがあるため、はみ出さない構造にしている）。
	gutter: { width: GUTTER, alignItems: 'center' },
	laneLine: { position: 'absolute', width: 1.5, backgroundColor: 'rgba(255,255,255,0.10)', left: (GUTTER - 1.5) / 2 },
	laneLineTop: { top: 0, height: NODE_TOP + NODE / 2 },
	laneLineBottom: { top: NODE_TOP + NODE / 2, bottom: 0 },
	node: { position: 'absolute', top: NODE_TOP, width: NODE, height: NODE, borderRadius: NODE / 2, backgroundColor: colors.bg, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
	nodeError: { borderColor: tint(colors.red, alpha.strong) },
	nodeDot: { width: 5, height: 5, borderRadius: radius.pill, ...squircle, backgroundColor: colors.textDim },
	stepBody: { flex: 1, minWidth: 0 },
	head: { minHeight: HIT_SIZE, flexDirection: 'row', alignItems: 'center', gap: 7, paddingRight: 8 },
	chip: { width: 20, height: 20, borderRadius: radius.key, ...squircle, backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
	name: { color: colors.text, fontSize: type.meta, fontWeight: '700', flexShrink: 0 },
	namespace: { color: colors.textDim, fontSize: type.caption, fontWeight: '600' },
	arg: { flex: 1, minWidth: 0, color: colors.textDim, fontSize: type.badge, fontFamily: monoFamily },
	argSpacer: { flex: 1 },
	meta: { color: colors.textDim, fontSize: type.badge, opacity: 0.85 },
});
