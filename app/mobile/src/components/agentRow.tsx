// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { colors } from '../theme.js';

/**
 * ホーム一覧のエージェント行の見た目を、リスト本体と長押し時の「リフト（浮き上がり）
 * クローン」の双方で共有するためのプレゼンテーショナルコンポーネント群。
 * 行UIの実装を二重管理しないよう、内部の描画は必ず {@link AgentRowContent} を通す。
 *
 * リフト演出は、対象行のウィンドウ座標（measureInWindow）を親から受け取り、
 * OverlayPortal内のスクリム上に {@link AgentRowClone} として同じ行UIを再描画する
 * （iOSのコンテキストメニューと同じ考え方。ScrollViewのスタッキングコンテキストを
 * 越えて前面へ出すため、リスト内でのzIndex昇格では実現できない）。
 */

export interface AgentRowData {
	title: string;
	wsName: string;
	wsColor: string;
	branch?: string;
	pinned: boolean;
	agentStatus: string | undefined;
	/** 応答待ち（permission/question）。行の左端に赤いアクセントを出す。 */
	waiting: boolean;
}

/** measureInWindow で得た対象行のウィンドウ座標（pageX/pageY と同じ座標系）。 */
export interface AgentRowRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function agentLabel(status: string | undefined): string {
	return status === 'permission' ? '応答待ち' : status === 'question' ? '質問あり' : status === 'working' ? '実行中' : status === undefined ? 'アイドル' : 'レビュー';
}

function orbStyle(status: string | undefined) {
	return status === 'permission' || status === 'question' ? styles.orbWaiting
		: status === 'working' ? styles.orbRunning
			: status === undefined ? styles.orbIdle : styles.orbReview;
}

function badgeStyle(status: string | undefined) {
	return status === 'permission' || status === 'question' ? styles.badgeWaiting
		: status === 'working' ? styles.badgeRunning
			: status === undefined ? styles.badgeIdle : styles.badgeReview;
}

/** ステータスバッジ（非インタラクティブ）。レビュー行のタップ操作はリスト側でこれをPressableで包む。 */
export function AgentBadge({ status }: { status: string | undefined }) {
	return <Text style={[styles.badge, badgeStyle(status)]}>{agentLabel(status)}</Text>;
}

/**
 * 行の内側（ピン・オーブ・タイトル・ワークスペース・バッジ）。リストのPressableと
 * クローンのViewの双方から同じ見た目で描画する。`badge` を渡すとバッジ部分を差し替える
 * （リストのレビュー行は「確認済みにする」ポップオーバーを開くPressableを渡す）。
 */
export function AgentRowContent({ data, badge }: { data: AgentRowData; badge?: ReactNode }) {
	return (
		<>
			{data.pinned ? <Ionicons name="bookmark" size={11} color={colors.accent} style={styles.pinIcon} /> : null}
			<View style={[styles.orb, orbStyle(data.agentStatus)]} />
			<View style={styles.agentBody}>
				<Text style={styles.agentTitle} numberOfLines={1}>{data.title}</Text>
				<View style={styles.agentSub}>
					<Text style={[styles.agentWs, { color: data.wsColor }]} numberOfLines={1}>{data.wsName}</Text>
					{data.branch ? <Text style={styles.agentBranch} numberOfLines={1}> · {data.branch}</Text> : null}
				</View>
			</View>
			{badge ?? <AgentBadge status={data.agentStatus} />}
		</>
	);
}

/**
 * 長押しされた行の「浮き上がり」クローン。スクリムの上・メニューの下に、対象行の
 * ウィンドウ座標そのままの位置で描画し、scale 1.0→1.04 で前面へ持ち上げる。
 * タッチはそのまま背後のスクリム（タップで閉じる）へ通すため pointerEvents="none"。
 */
export function AgentRowClone({ data, rect }: { data: AgentRowData; rect: AgentRowRect }) {
	const scale = useSharedValue(1);
	useEffect(() => {
		scale.value = withTiming(1.04, { duration: 200, easing: Easing.out(Easing.back(1.4)) });
	}, [scale]);
	const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
	return (
		<Animated.View
			pointerEvents="none"
			style={[styles.clonePos, { top: rect.y, left: rect.x, width: rect.width }, animatedStyle]}
		>
			<View style={[agentRowStyles.container, styles.cloneRow, data.waiting && agentRowStyles.containerWaiting]}>
				<AgentRowContent data={data} />
			</View>
		</Animated.View>
	);
}

/** 行の外枠。リストのPressableとクローンで共有する（見た目を一致させるため）。 */
export const agentRowStyles = StyleSheet.create({
	container: {
		flexDirection: 'row', alignItems: 'center', gap: 11,
		backgroundColor: colors.surface, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14,
		borderWidth: 1, borderColor: colors.border, marginBottom: 8,
	},
	containerWaiting: { borderLeftWidth: 3, borderLeftColor: colors.red },
});

const styles = StyleSheet.create({
	pinIcon: { marginRight: -2 },
	orb: { width: 10, height: 10, borderRadius: 6 },
	orbWaiting: { backgroundColor: colors.red },
	orbRunning: { backgroundColor: colors.green },
	orbReview: { backgroundColor: colors.yellow },
	orbIdle: { backgroundColor: '#55555c' },
	agentBody: { flex: 1, minWidth: 0 },
	agentTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	agentSub: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
	agentWs: { fontSize: 11, fontFamily: 'Menlo', flexShrink: 1 },
	agentBranch: { color: colors.textDim, fontSize: 11, flexShrink: 1 },
	badge: { fontSize: 10, fontWeight: '700', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
	badgeWaiting: { backgroundColor: 'rgba(244,135,113,0.15)', color: colors.red },
	badgeRunning: { backgroundColor: 'rgba(78,201,176,0.15)', color: colors.green },
	badgeReview: { backgroundColor: 'rgba(220,220,170,0.15)', color: colors.yellow },
	badgeIdle: { backgroundColor: 'rgba(139,139,139,0.15)', color: colors.textDim },
	// クローンは前面へ持ち上げるため、面と枠をわずかに強調し、強い影で浮遊感を出す。
	// marginBottom はレイアウト用なのでクローンでは打ち消す（絶対配置のため不要）。
	clonePos: { position: 'absolute' },
	cloneRow: {
		marginBottom: 0,
		backgroundColor: colors.surface2,
		borderColor: colors.borderStrong,
		shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 16,
	},
});
