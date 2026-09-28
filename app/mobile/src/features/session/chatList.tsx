// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import type { AgentHistoryHeader } from '../../agentHistory.js';
import { AgentInitialRevealGate } from '../../agentInitialReveal.js';
import { shouldHandleLatestEntry } from '../../agentNavigation.js';
import { AgentStickyScroll, agentScrollEndOffset } from '../../agentStickyScroll.js';
import { hapticSelection } from '../../haptics.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { Icon } from '../../ui/index.js';
import { ChatRowView } from './chatItems.js';
import { chatRowKey, type ChatRow } from './chatRows.js';

/** 一覧の上端からこの距離に入ったら古い発言を読み込む（W2-30。Orca と同じ 60pt）。 */
const LOAD_OLDER_THRESHOLD = 60;

export interface ChatListHandle {
	/** 最新まで送って追従を再開する（送信の直後など）。 */
	scrollToLatest(): void;
}

/**
 * 会話の一覧（Orca の MobileNativeChatView の本文）。スクロールの追従は旧画面と同じ仕組みを使う:
 *  - 最下部にいる間は新しい行に追従し、遡って読んでいる間は動かさない（`agentStickyScroll.ts`）
 *  - 開いた直後は最下部へ届くまで見せない（履歴が上から流れ落ちて見えないように。`agentInitialReveal.ts`）
 *  - 通知やホームから「新しく開いた」印（`latest`）が来たら最新まで送る
 *  - 遡っている間は右下に「最新へ」のボタンと新着の件数を出す
 *  - 上端に近づいたら古い発言を読み込み（W2-30）、先頭に足しても見ている位置を動かさない
 *    （`maintainVisibleContentPosition`。先頭の案内の行を数えないよう 1 から）
 */
export const ChatList = forwardRef<ChatListHandle, {
	rows: readonly ChatRow[];
	epoch: string;
	terminalKey: string;
	latest: string | undefined;
	/** 先頭の案内（古い発言の読み込み・省略・上限）。 */
	history: AgentHistoryHeader;
	/** 古い発言を読み込む（さかのぼれない PC では何もしない）。 */
	onLoadOlder: () => void;
	allToolsOpen: boolean;
}>(function ChatList({ rows, epoch, terminalKey, latest, history, onLoadOlder, allToolsOpen }, ref) {
	const listRef = useRef<FlatList<ChatRow>>(null);
	const column = useContentColumnStyle();
	const scrollState = useRef(new AgentStickyScroll()).current;
	const [sticky, setSticky] = useState(true);
	const [newCount, setNewCount] = useState(0);
	const [revealed, setRevealed] = useState(false);
	// 末尾へ送るときの計算に使う、内容の高さ（onContentSizeChange）と一覧の高さ（onLayout）。
	const metricsRef = useRef({ contentHeight: 0, viewportHeight: 0 });
	/**
	 * 最下部へ送る。末尾へ送る経路（開いた直後・追従・「最新へ」・送信の直後・キーボード）は
	 * すべてここを通す。FlatList の scrollToEnd() は最後の行の位置を見積もるので使わない
	 * （外れる理由は agentScrollEndOffset を参照）。
	 */
	const scrollToBottom = useCallback((animated: boolean) => {
		const { contentHeight, viewportHeight } = metricsRef.current;
		if (contentHeight <= 0 || viewportHeight <= 0) {
			return; // まだ測れていない。測れた時点で onContentSizeChange / onLayout が送り直す
		}
		listRef.current?.scrollToOffset({ offset: agentScrollEndOffset(contentHeight, viewportHeight), animated });
	}, []);
	const revealGate = useRef(new AgentInitialRevealGate(() => {
		if (scrollState.sticky) {
			scrollToBottom(false);
		}
		setRevealed(true);
	})).current;
	const syncSticky = useCallback(() => {
		const next = scrollState.sticky;
		setSticky(next);
		if (next) {
			setNewCount(0);
		}
	}, [scrollState]);

	// セッションが変わったら（epoch）隠し直して最下部から見せ直す。
	useEffect(() => {
		scrollState.reset();
		// 前の会話の内容の高さで送らないよう、測り直すまで 0 にしておく（0 の間は送りを見送る）。
		metricsRef.current.contentHeight = 0;
		syncSticky();
		setRevealed(false);
		revealGate.begin();
		return () => revealGate.dispose();
	}, [epoch, scrollState, syncSticky, revealGate]);

	const handledLatestRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!shouldHandleLatestEntry(handledLatestRef.current, latest)) {
			return undefined;
		}
		handledLatestRef.current = latest;
		scrollState.followFromNavigation();
		syncSticky();
		const frame = requestAnimationFrame(() => scrollToBottom(false));
		return () => cancelAnimationFrame(frame);
	}, [latest, scrollState, syncSticky, scrollToBottom]);

	// 新着の数は、前回いちばん下にあった行より後ろに増えた行だけを数える（古い発言を先頭に足しても数えない）。
	const previousLastKeyRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		const previousLast = previousLastKeyRef.current;
		const last = rows.at(-1);
		previousLastKeyRef.current = last !== undefined ? chatRowKey(last, epoch) : undefined;
		if (previousLast === undefined || scrollState.sticky) {
			return;
		}
		const index = rows.findIndex(row => chatRowKey(row, epoch) === previousLast);
		const delta = index >= 0 ? rows.length - 1 - index : 0;
		if (delta > 0) {
			setNewCount(count => count + delta);
		}
	}, [rows, epoch, scrollState]);

	const scrollToLatest = useCallback(() => {
		scrollState.followNow();
		syncSticky();
		scrollToBottom(true);
	}, [scrollState, syncSticky, scrollToBottom]);
	useImperativeHandle(ref, () => ({ scrollToLatest }), [scrollToLatest]);

	const onContentSizeChange = (_width: number, height: number) => {
		metricsRef.current.contentHeight = height;
		if (scrollState.handleContentSize(height)) {
			scrollToBottom(false);
			revealGate.noteGrowth();
		}
	};
	const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
		const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
		if (scrollState.handleScroll({ offsetY: contentOffset.y, layoutHeight: layoutMeasurement.height, contentHeight: contentSize.height })) {
			syncSticky();
		}
		// 上端に近づいたら古い発言を読み込む。開いた直後（最下部へ送る前）の位置では読まない。
		if (revealed && contentOffset.y < LOAD_OLDER_THRESHOLD && history.kind === 'more' && !history.loading && contentSize.height > layoutMeasurement.height) {
			onLoadOlder();
		}
	};
	// キーボードで一覧が縮んだとき、追従中なら最下部に張り付き直す（最新の行がキーボードの裏に隠れないように）。
	// 初めて高さが測れたときも同じ（それまでは末尾の位置を計算できず、送りを見送っているため）。
	const onLayout = (event: LayoutChangeEvent) => {
		const height = event.nativeEvent.layout.height;
		const previous = metricsRef.current.viewportHeight;
		metricsRef.current.viewportHeight = height;
		if ((previous === 0 || height < previous) && scrollState.shouldPinOnViewportShrink()) {
			scrollToBottom(false);
		}
	};

	return (
		<View style={styles.root}>
			<FlatList
				ref={listRef}
				style={revealed ? styles.shown : styles.hidden}
				pointerEvents={revealed ? 'auto' : 'none'}
				data={rows}
				keyExtractor={row => chatRowKey(row, epoch)}
				renderItem={({ item }) => <ChatRowView row={item} terminalKey={terminalKey} allToolsOpen={allToolsOpen} />}
				extraData={allToolsOpen}
				ListHeaderComponent={<HistoryHeader header={history} onLoadOlder={onLoadOlder} />}
				maintainVisibleContentPosition={MAINTAIN_POSITION}
				ListEmptyComponent={(
					<View style={styles.empty}>
						<Text style={styles.emptyTitle}>まだ会話がありません</Text>
						<Text style={styles.emptyBody}>下の入力欄から指示を送ると始まります。</Text>
					</View>
				)}
				contentContainerStyle={[styles.content, column]}
				keyboardShouldPersistTaps="handled"
				keyboardDismissMode="interactive"
				onContentSizeChange={onContentSizeChange}
				onScroll={onScroll}
				onScrollBeginDrag={() => { revealGate.revealNow(); scrollState.beginDrag(); }}
				onScrollEndDrag={() => scrollState.endDrag()}
				onMomentumScrollBegin={() => scrollState.beginMomentum()}
				onMomentumScrollEnd={() => scrollState.endMomentum()}
				scrollEventThrottle={32}
				onLayout={onLayout}
			/>
			{!sticky ? (
				<Pressable
					style={styles.jump}
					onPress={() => { hapticSelection(); scrollToLatest(); }}
					accessibilityRole="button"
					accessibilityLabel={newCount > 0 ? `最新のメッセージへ移動。新着 ${newCount}件` : '最新のメッセージへ移動'}
				>
					<Icon icon={ChevronDown} color={colors.text} />
					{newCount > 0 ? <Text style={styles.jumpText}>{newCount > 99 ? '99+' : String(newCount)}</Text> : null}
				</Pressable>
			) : null}
		</View>
	);
});

/** 先頭に古い発言を足しても、見ている行の位置を保つ（0 番目は先頭の案内の行なので 1 から）。 */
const MAINTAIN_POSITION = { minIndexForVisible: 1 } as const;

/** 一覧の先頭の案内。行の数を変えないよう、何も出さないときも空の行を置く（位置の保持が 1 番目から数えるため）。 */
function HistoryHeader({ header, onLoadOlder }: { header: AgentHistoryHeader; onLoadOlder: () => void }) {
	switch (header.kind) {
		case 'truncated':
			return <Text style={styles.truncated}>古い履歴は省略しています</Text>;
		case 'capped':
			return <Text style={styles.truncated}>これより前の発言は PC で見てください</Text>;
		case 'error':
			return <Text style={styles.truncated}>{header.message}</Text>;
		case 'more':
			return header.loading ? (
				<View style={styles.older} accessibilityLabel="古い発言を読み込んでいます">
					<ActivityIndicator size="small" color={colors.textMuted} />
				</View>
			) : (
				<Pressable
					style={styles.older}
					onPress={() => { hapticSelection(); onLoadOlder(); }}
					accessibilityRole="button"
				>
					<Text style={styles.olderText}>さらに前の発言を読み込む</Text>
				</Pressable>
			);
		default:
			return <View />;
	}
}

const styles = StyleSheet.create({
	older: {
		alignItems: 'center',
		justifyContent: 'center',
		minHeight: HIT_SIZE,
		paddingVertical: space.xs,
	},
	olderText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textDim,
	},
	root: {
		flex: 1,
		minHeight: 0,
	},
	shown: {
		opacity: 1,
	},
	hidden: {
		opacity: 0,
	},
	content: {
		flexGrow: 1,
		paddingVertical: space.sm,
	},
	truncated: {
		paddingVertical: space.sm,
		textAlign: 'center',
		fontSize: type.caption,
		color: colors.textMuted,
	},
	empty: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.xs,
		paddingTop: 120,
	},
	emptyTitle: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.textDim,
	},
	emptyBody: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
	jump: {
		position: 'absolute',
		right: space.lg,
		bottom: space.md,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.xs,
		minWidth: HIT_SIZE,
		height: HIT_SIZE,
		paddingHorizontal: space.md,
		borderRadius: radius.pill,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
	},
	jumpText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
});
