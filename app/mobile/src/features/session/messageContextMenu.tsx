// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { ContextMenu, nativeContextMenuAvailable } from '../../components/contextMenu.js';
import { contextMenuOps } from '../../components/copyActions.js';
import { useParaToast } from '../../paraToast.js';
import { useThemeColors } from '../../ui/index.js';
import { inplaceSelectMinHeight, localPressPoint, type InplaceSelectPoint, type InplaceSelectSegment } from './inplaceSelectHtml.js';
import { beginInplaceSelect } from './inplaceSelectSession.js';
import { InplaceSelectWebView, inplaceSelectForeground } from './inplaceSelectView.js';
import { buildMessageMenu } from './messageMenu.js';

/**
 * 差し替えている間に出すお知らせの目印。差し替えるたびに変える（別の発言で始め直したとき、前の発言の後片付けが
 * 新しいお知らせを消さないように。自分が出したものだけを消す）。
 */
let selectToastSerial = 0;

/** 差し替えを始めたときの写し。選んでいる間は本文が伸びても描き直さない（選択が消えないように）。 */
interface Selecting {
	readonly segments: readonly InplaceSelectSegment[];
	readonly point: InplaceSelectPoint | undefined;
	/** 始めたときの元の表示の高さ。 */
	readonly nativeHeight: number | undefined;
}

/**
 * 発言を包み、長押し（iPad では右クリックも）で発言のメニュー（`messageMenu.ts`）を出す。
 * ネイティブのメニューが無いビルドではメニューを付けない（本文の今の「長押しで全文コピー」のまま）。
 * 包んだ中の本文は `selectable` を外すこと（{@link chatTextSelectable}）。
 *
 * メニューの「範囲を選んでコピー…」を押すと、別の画面を開かずに、この発言の表示の上へ同じ見た目の WebView を重ねて
 * 範囲を選べるようにする（Q551 案 4。`inplaceSelectView.tsx`）。元の表示は隠すだけで外さないので、行の高さは変わらず、
 * 中のコードの色付けなども描き直さない。上のお知らせの「完了」か、外を押すと元に戻す（`inplaceSelectSession.ts`）。
 */
export function MessageContextMenu({ text, markdown, speaker, style, previewRadius, previewBackground, children }: {
	/** 発言の元の文字（エージェントは Markdown）。 */
	text: string;
	markdown: boolean;
	/** 範囲を選んでいる間のお知らせに出す、誰の発言か。 */
	speaker: string;
	style?: StyleProp<ViewStyle>;
	previewRadius?: number;
	previewBackground?: string;
	children: ReactNode;
}) {
	const theme = useThemeColors();
	const wrapRef = useRef<View>(null);
	/** 最後に触れた点（長押しでメニューを開いた点。そこの単語を選んで始める）。 */
	const lastTouch = useRef<{ pageX: number; pageY: number; at: number } | undefined>(undefined);
	const [selecting, setSelecting] = useState<Selecting | undefined>(undefined);
	const [webReady, setWebReady] = useState(false);
	const [webHeight, setWebHeight] = useState<number | undefined>(undefined);

	const stop = useCallback(() => {
		setSelecting(undefined);
		setWebReady(false);
		setWebHeight(undefined);
	}, []);

	const start = useCallback((source: string, isMarkdown: boolean) => {
		const begin = (point: InplaceSelectPoint | undefined, nativeHeight: number | undefined) => {
			setWebReady(false);
			setWebHeight(undefined);
			setSelecting({ segments: [{ text: source, markdown: isMarkdown }], point, nativeHeight });
		};
		const view = wrapRef.current;
		if (view === null) {
			begin(undefined, undefined);
			return;
		}
		view.measure((_x, _y, width, height, pageX, pageY) => {
			begin(localPressPoint(lastTouch.current, { pageX, pageY, width, height }, Date.now()), Number.isFinite(height) ? height : undefined);
		});
	}, []);

	// 差し替えている間: 画面に 1 つだけにし、外を押したら戻す。上にお知らせと「完了」を出す
	useEffect(() => {
		if (selecting === undefined) {
			return;
		}
		const end = beginInplaceSelect({
			close: stop,
			contains: (pageX, pageY, done) => {
				const view = wrapRef.current;
				if (view === null) {
					done(false);
					return;
				}
				view.measure((_x, _y, width, height, left, top) => {
					done(pageX >= left && pageX <= left + width && pageY >= top && pageY <= top + height);
				});
			},
		});
		const toastKey = `inplace-select:${++selectToastSerial}`;
		useParaToast.getState().show({ key: toastKey, text: '範囲を選んでコピー', sub: `${speaker}・外を押すと元に戻ります`, icon: 'text-outline', tone: 'info', action: { label: '完了', onPress: stop } });
		return () => {
			end();
			const current = useParaToast.getState();
			if (current.current?.key === toastKey) {
				current.hide();
			}
		};
	}, [selecting, speaker, stop]);

	const menu = useMemo(
		() => nativeContextMenuAvailable && text.trim().length > 0 ? buildMessageMenu({ text, markdown }, { ...contextMenuOps(), selectRange: () => start(text, markdown) }) : undefined,
		[text, markdown, start],
	);
	const recordTouch = useCallback((event: GestureResponderEvent) => {
		const { pageX, pageY } = event.nativeEvent;
		lastTouch.current = { pageX, pageY, at: Date.now() };
	}, []);
	const minHeight = selecting !== undefined ? inplaceSelectMinHeight(selecting.nativeHeight, webHeight) : undefined;
	const hidden = selecting !== undefined && webReady;
	return (
		<View ref={wrapRef} style={[style, minHeight !== undefined ? { minHeight } : null]} onTouchStart={recordTouch}>
			{/* 差し替えている間は #705 のメニューを止める（WebView の長押しの選択と取り合わないように） */}
			<ContextMenu menu={selecting !== undefined ? undefined : menu} previewRadius={previewRadius} previewBackground={previewBackground}>
				<View
					style={selecting !== undefined ? (hidden ? styles.hidden : styles.inert) : null}
					accessibilityElementsHidden={hidden}
					importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
				>
					{children}
				</View>
			</ContextMenu>
			{selecting !== undefined ? (
				<View style={[styles.overlay, webHeight !== undefined ? { height: webHeight } : styles.overlayFill]}>
					<InplaceSelectWebView
						segments={selecting.segments}
						point={selecting.point}
						fg={inplaceSelectForeground(markdown, theme.onBubble)}
						onReady={() => setWebReady(true)}
						onHeight={setWebHeight}
						onGone={stop}
					/>
				</View>
			) : null}
		</View>
	);
}

/** 発言の本文の Text に付ける `selectable`。メニューで包むビルドでは外す（同じ長押しを取り合わないように）。 */
export const chatTextSelectable = !nativeContextMenuAvailable;

const styles = StyleSheet.create({
	/** 差し替えている間（WebView が描き終えるまで見せたまま、触れは WebView へ）。 */
	inert: { pointerEvents: 'none' },
	hidden: { opacity: 0, pointerEvents: 'none' },
	overlay: { position: 'absolute', top: 0, left: 0, right: 0 },
	overlayFill: { bottom: 0 },
});
