// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, SquareChevronRight } from 'lucide-react-native';
import { useAppStore } from '../../appState.js';
import { IOBlock } from '../../components/agentIoBlock.js';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { colors, space, type } from '../../theme.js';
import { useNow } from '../../time.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { Icon } from '../../ui/index.js';
import { ADVISOR_PENDING_GRACE_MS, ADVISOR_REDACTED_NOTE, advisorCallSummary, advisorModelLabel, describeAdvisorCall, isAdvisorLive } from './advisor.js';
import type { AdvisorChatRow } from './chatRows.js';

/** ツールの行は見た目 28。当たり判定は上下に 8 ずつ広げて 44 にする（chatItems の LINE_SLOP と同じ）。 */
const LINE_SLOP = { top: 8, bottom: 8, left: 0, right: 0 };

/**
 * 会話の中の Advisor への相談 1 回（モックの 2b）。ツールのまとまりとは分けた 1 行で、
 * 「Advisor 会話をレビューしました · Opus 5.5 · 14秒」を出す。押すと、暗号化された返答なら説明（S1）、
 * 平文の返答（旧世代のモデル）なら本文、失敗なら error_code を開く。相談中は押せない。
 *
 * 状態は一覧（activity の advisors）を正本にする。サブエージェントの詳細の会話でも同じ行を使い、
 * そのときは親の生成中の表示（live）では相談中と判断しない（サブエージェントの相談は親の表示に上げない）。
 */
export function AdvisorChatRowView({ row, terminalKey }: { row: AdvisorChatRow; terminalKey: string }) {
	const [open, setOpen] = useState(false);
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(15);
	const id = row.use?.toolUseId ?? row.result?.toolUseId;
	// 一覧の状態とモデル名（文字列だけを選ぶ。項目そのものは更新のたびに作り直される）
	const listedStatus = useAppStore(s => (id !== undefined ? s.agentChats.get(terminalKey)?.activity?.advisors?.find(advisor => advisor.id === id)?.status : undefined));
	const listedModel = useAppStore(s => (id !== undefined ? s.agentChats.get(terminalKey)?.activity?.advisors?.find(advisor => advisor.id === id)?.model : undefined));
	// 生成中の表示の Advisor は、開始の時刻（PC は呼び出しの行の時刻を使う）が同じ呼び出しにだけ当てる
	const useAt = row.use?.ts;
	const liveAdvisor = useAppStore(s => {
		const live = s.agentChats.get(terminalKey)?.live;
		return row.result === undefined && useAt !== undefined && isAdvisorLive(live) && Math.abs((live?.startedAt ?? 0) - useAt) < 2_000;
	});
	// 相談中かもしれない間だけ秒で刻む（一覧が相談中・生成中の表示が Advisor・呼び出しから間もない）
	const maybeRunning = row.result === undefined && (listedStatus === 'running'
		|| (listedStatus === undefined && (liveAdvisor || (useAt !== undefined && Date.now() - useAt < ADVISOR_PENDING_GRACE_MS))));
	const now = useNow(1_000, maybeRunning);
	const call = describeAdvisorCall(row.use, row.result, listedStatus !== undefined ? { status: listedStatus, model: listedModel } : undefined, liveAdvisor, now);
	const running = call.status === 'running';
	const failed = call.status === 'failed';
	const expandable = !running && row.result !== undefined;
	const summary = advisorCallSummary(call, now);
	const model = advisorModelLabel(call.model);
	return (
		<View style={styles.row}>
			<Pressable
				style={styles.line}
				hitSlop={LINE_SLOP}
				disabled={!expandable}
				onPress={() => { haptic('move'); setOpen(value => !value); }}
				accessibilityRole={expandable ? 'button' : 'text'}
				accessibilityState={expandable ? { expanded: open } : undefined}
				accessibilityLabel={`Advisor、${summary}`}
			>
				{running
					? <ActivityIndicator size="small" color={colors.textMuted} style={styles.spinner} />
					: <Icon icon={open ? ChevronDown : SquareChevronRight} size={iconSize} color={colors.textMuted} />}
				<Text style={[styles.name, failed ? styles.failed : undefined]}>Advisor</Text>
				<Text style={styles.preview} numberOfLines={1}>{summary}</Text>
			</Pressable>
			{open && expandable && row.result !== undefined ? (
				<View style={styles.detail}>
					{call.outcome === 'text'
						? <IOBlock label={model !== undefined ? `Advisor の返答（${model}）` : 'Advisor の返答'} message={row.result} terminalKey={terminalKey} />
						: call.outcome === 'error'
							? <Text style={styles.code} selectable>{`error_code: ${call.errorCode ?? row.result.text}`}</Text>
							: <Text style={styles.caption}>{ADVISOR_REDACTED_NOTE}</Text>}
				</View>
			) : null}
		</View>
	);
}

const baseStyles = StyleSheet.create({
	row: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
	},
	line: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 28,
		paddingVertical: 3,
	},
	spinner: {
		width: 15,
		height: 15,
		transform: [{ scale: 0.7 }],
	},
	name: {
		fontFamily: monoFamily,
		fontSize: type.label,
		fontWeight: '600',
		color: colors.claude,
	},
	failed: {
		color: colors.red,
	},
	preview: {
		flex: 1,
		minWidth: 0,
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	detail: {
		paddingLeft: space.lg,
		paddingTop: space.xs,
	},
	caption: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
	code: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.red,
	},
});
