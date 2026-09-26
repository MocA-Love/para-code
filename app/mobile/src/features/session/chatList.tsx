// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { AgentInitialRevealGate } from '../../agentInitialReveal.js';
import { shouldHandleLatestEntry } from '../../agentNavigation.js';
import { AgentStickyScroll } from '../../agentStickyScroll.js';
import { hapticSelection } from '../../haptics.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { Icon } from '../../ui/index.js';
import { ChatRowView } from './chatItems.js';
import { chatRowKey, type ChatRow } from './chatRows.js';

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
 */
export const ChatList = forwardRef<ChatListHandle, {
	rows: readonly ChatRow[];
	epoch: string;
	terminalKey: string;
	latest: string | undefined;
	truncated: boolean;
	allToolsOpen: boolean;
}>(function ChatList({ rows, epoch, terminalKey, latest, truncated, allToolsOpen }, ref) {
	const listRef = useRef<FlatList<ChatRow>>(null);
	const column = useContentColumnStyle();
	const scrollState = useRef(new AgentStickyScroll()).current;
	const [sticky, setSticky] = useState(true);
	const [newCount, setNewCount] = useState(0);
	const [revealed, setRevealed] = useState(false);
	const revealGate = useRef(new AgentInitialRevealGate(() => {
		if (scrollState.sticky) {
			listRef.current?.scrollToEnd({ animated: false });
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
		const frame = requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
		return () => cancelAnimationFrame(frame);
	}, [latest, scrollState, syncSticky]);

	const previousCountRef = useRef(rows.length);
	useEffect(() => {
		const delta = rows.length - previousCountRef.current;
		previousCountRef.current = rows.length;
		if (delta > 0 && !scrollState.sticky) {
			setNewCount(count => count + delta);
		}
	}, [rows.length, scrollState]);

	const scrollToLatest = useCallback(() => {
		scrollState.followNow();
		syncSticky();
		listRef.current?.scrollToEnd({ animated: true });
	}, [scrollState, syncSticky]);
	useImperativeHandle(ref, () => ({ scrollToLatest }), [scrollToLatest]);

	const onContentSizeChange = (_width: number, height: number) => {
		if (scrollState.handleContentSize(height)) {
			listRef.current?.scrollToEnd({ animated: false });
			revealGate.noteGrowth();
		}
	};
	const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
		const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
		if (scrollState.handleScroll({ offsetY: contentOffset.y, layoutHeight: layoutMeasurement.height, contentHeight: contentSize.height })) {
			syncSticky();
		}
	};
	// キーボードで一覧が縮んだとき、追従中なら最下部に張り付き直す（最新の行がキーボードの裏に隠れないように）。
	const heightRef = useRef(0);
	const onLayout = (event: LayoutChangeEvent) => {
		const height = event.nativeEvent.layout.height;
		const shrank = height < heightRef.current;
		heightRef.current = height;
		if (shrank && scrollState.shouldPinOnViewportShrink()) {
			listRef.current?.scrollToEnd({ animated: false });
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
				ListHeaderComponent={truncated ? <Text style={styles.truncated}>古い履歴は省略しています</Text> : null}
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

const styles = StyleSheet.create({
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
