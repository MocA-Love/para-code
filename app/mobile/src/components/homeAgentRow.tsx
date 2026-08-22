// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ホーム一覧の行1件。
 *
 * 「葉のコンポーネントを memo する」のではなく、**行を丸ごと1つの memo 境界にする**のが
 * このファイルの目的。バッジ（JSX）・スワイプ操作（配列リテラル）・行本体（JSX）を呼び出し側で
 * 組み立てていた頃は、それらが毎レンダー新品になるため、葉をいくら memo しても比較が必ず
 * 落ちていた（バッジが1つ付いているだけで `AgentRowContent` の memo は無意味になる）。
 * ここが受け取るのはスカラと安定なコールバックだけで、参照が変わるものは内側で作る。
 *
 * 受け取るのがスカラと安定なコールバックだけなので、この memo は親（ホーム画面）が再描画される
 * たびに比較で止まる。PCの state は revision が毎回進むため親自身の再描画は止まらず、止められる
 * のはここから下だけ、という前提で置いている。上流の `workspaceIdentity.ts`（構造共有）は
 * 一覧の derive（listable など）の memo を止めるほうに効く別の層で、両者は独立に成立する。
 */

import { memo, useMemo } from 'react';
import { Pressable, type GestureResponderEvent, type View } from 'react-native';
import { AgentBadge, AgentRowContent, agentRowStyles, type AgentRowData } from './agentRow.js';
import { SwipeRow, swipeActionColors } from './swipeRow.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/**
 * 行から呼ぶ操作。**1つのオブジェクトにまとめて呼び出し側で useMemo する**こと
 * （個別に渡すと、1つでも安定していない関数があった時点で行全体の memo が落ちる）。
 */
export interface HomeAgentRowHandlers {
	registerRef: (terminalKey: string, node: View | null) => void;
	/** wsId が undefined の行は開けない（所属ワークスペースを解決できていない）。 */
	onOpen: (wsId: string | undefined, terminalKey: string) => void;
	onLongPress: (terminalKey: string, title: string, pinned: boolean, rowData: AgentRowData, anchor: { x: number; y: number }) => void;
	onStatusPress: (terminalKey: string, anchor: { x: number; y: number }) => void;
	onAck: (terminalKey: string) => void;
	onArchive: (terminalKey: string, title: string) => void;
	onDelete: (terminalKey: string, title: string) => void;
}

export const HomeAgentRow = memo(function HomeAgentRow({
	terminalKey, wsId, title, wsName, wsColor, branch, pinned, agentStatus, handlers, locked,
}: {
	terminalKey: string;
	wsId: string | undefined;
	title: string;
	wsName: string;
	wsColor: string;
	branch: string | undefined;
	pinned: boolean;
	agentStatus: string | undefined;
	handlers: HomeAgentRowHandlers;
	/** この行の長押しメニューが開いている間true。スワイプのPanを止めて、浮かせたクローンと
	    行の実体がズレるのを防ぐ。 */
	locked?: boolean;
}) {
	const rowData = useMemo<AgentRowData>(
		() => ({ title, wsName, wsColor, branch, pinned, agentStatus }),
		[title, wsName, wsColor, branch, pinned, agentStatus]);
	// 左スワイプで片付ける。応答待ちの行はここには来ない（上部のスタックが持つ）ので、
	// 片付けても自動で戻ってくる行にスワイプを出してしまう心配はない。
	//
	// 引き切って実行されるのは**アーカイブだけ**。削除は開いてカードを押さないと
	// 実行できない。勢いよく払っただけでエージェントが消えるのは取り返しがつかない。
	const actions = useMemo(() => [
		// 「確認済み」は全行に出す（決定D）。行によって枚数が変わると、
		// スワイプのたびに開く深さが違って手が覚えられない。
		{
			key: 'ack',
			label: '確認済み',
			icon: 'eye-outline' as const,
			color: swipeActionColors.neutral,
			onPress: () => handlers.onAck(terminalKey),
		},
		{
			key: 'archive',
			label: 'アーカイブ',
			icon: 'file-tray-full-outline' as const,
			color: swipeActionColors.strong,
			fullSwipe: true,
			onPress: () => handlers.onArchive(terminalKey, title),
		},
		{
			key: 'delete',
			label: '削除',
			icon: 'trash-outline' as const,
			color: swipeActionColors.destructive,
			onPress: () => handlers.onDelete(terminalKey, title),
		},
	], [terminalKey, title, handlers]);
	const badge = agentStatus === 'review' ? (
		// レビューのみタップで「確認済みにする」ポップオーバーを開ける
		// （応答待ち/質問は回答して解消するもの、実行中/アイドルは既読の概念が無い）
		<Pressable
			hitSlop={8}
			onPress={(event: GestureResponderEvent) => {
				hapticSelection();
				handlers.onStatusPress(terminalKey, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });
			}}
			accessibilityLabel="ステータスを確認済みにする"
		>
			<AgentBadge status={agentStatus} />
		</Pressable>
	) : undefined;
	return (
		<SwipeRow direction="left" actions={actions} panLocked={locked === true}>
			<Pressable
				ref={node => handlers.registerRef(terminalKey, node)}
				style={agentRowStyles.container}
				onPress={() => handlers.onOpen(wsId, terminalKey)}
				// 既定の500msは一覧の行に対しては待たされ過ぎるので半分にする。
				delayLongPress={250}
				onLongPress={(event: GestureResponderEvent) => {
					hapticImpact('medium');
					handlers.onLongPress(terminalKey, title, pinned, rowData, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });
				}}
			>
				<AgentRowContent data={rowData} badge={badge} />
			</Pressable>
		</SwipeRow>
	);
});
