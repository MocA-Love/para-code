// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { ContextMenu, nativeContextMenuAvailable } from '../../components/contextMenu.js';
import { contextMenuOps } from '../../components/copyActions.js';
import { useParaToast } from '../../paraToast.js';
import { useThemeColors } from '../../ui/index.js';
import { inplaceSelectMinHeight, localPressPoint, type InplaceSelectPoint, type InplaceSelectSegment } from './inplaceSelectHtml.js';
import { hideInplaceSelectNotice, showInplaceSelectNotice } from './inplaceSelectNotice.js';
import { beginInplaceSelect, isHoldCancel } from './inplaceSelectSession.js';
import { InplaceSelectWebView, inplaceSelectForeground } from './inplaceSelectView.js';
import { ChatQuoteContext } from './chatQuote.js';
import { buildMessageMenu } from './messageMenu.js';

/**
 * 差し替えている間に出すお知らせの目印。差し替えるたびに変える（別の発言で始め直したとき、前の発言の後片付けが
 * 新しいお知らせを消さないように。自分が出したものだけを消す）。
 */
let selectToastSerial = 0;

/**
 * 長押しでメニューが出てから、この時間のうちに「範囲を選んでコピー…」が押されなければ、用意しておいた WebView を外す（ms）。
 */
const WARM_KEEP_MS = 10_000;

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
 * 中のコードの色付けなども描き直さない。お知らせ（会話ではクイック返信の帯の位置に置く帯。`inplaceSelectNotice.ts`）の「完了」か、外を押すと元に戻す（`inplaceSelectSession.ts`）。
 */
export function MessageContextMenu({ text, markdown, plain = 'bubble', speaker, style, previewRadius, previewBackground, children }: {
	/** 発言の元の文字（エージェントは Markdown）。 */
	text: string;
	markdown: boolean;
	/** Markdown でない発言の字（範囲を選ぶ表示をそろえる）。会話の吹き出しは `bubble`、過去の会話の一覧は `body`。 */
	plain?: 'bubble' | 'body';
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
	/** 最後に指があった点（長押しかスクロールかを見分ける）。 */
	const lastMove = useRef<{ pageX: number; pageY: number } | undefined>(undefined);
	const [selecting, setSelecting] = useState<Selecting | undefined>(undefined);
	/**
	 * 長押しでメニューが出た時点で、見えないまま用意しておく選ぶ表示（WebView の起動に数秒かかることがあるため。
	 * 「範囲を選んでコピー…」を押したら同じ WebView をそのまま使う）。押されなければ {@link WARM_KEEP_MS} で外す。
	 */
	const [warm, setWarm] = useState<Selecting | undefined>(undefined);
	const warmRef = useRef<Selecting | undefined>(undefined);
	warmRef.current = warm;
	const [webReady, setWebReady] = useState(false);
	const [webHeight, setWebHeight] = useState<number | undefined>(undefined);

	const stop = useCallback(() => {
		setSelecting(undefined);
		setWarm(undefined);
		setWebReady(false);
		setWebHeight(undefined);
	}, []);

	/** 押した点と元の表示の高さを測って写しを作る。 */
	const snapshot = useCallback((source: string, isMarkdown: boolean, done: (value: Selecting) => void) => {
		const make = (point: InplaceSelectPoint | undefined, nativeHeight: number | undefined): Selecting => ({ segments: [{ text: source, markdown: isMarkdown, plain }], point, nativeHeight });
		const view = wrapRef.current;
		if (view === null) {
			done(make(undefined, undefined));
			return;
		}
		view.measure((_x, _y, width, height, pageX, pageY) => {
			done(make(localPressPoint(lastTouch.current, { pageX, pageY, width, height }, Date.now()), Number.isFinite(height) ? height : undefined));
		});
	}, [plain]);

	const start = useCallback((source: string, isMarkdown: boolean) => {
		// メニューが出たときに用意しておいた表示が同じ本文なら、そのまま使う（WebView を作り直さない）
		const prepared = warmRef.current;
		if (prepared !== undefined && prepared.segments.length === 1 && prepared.segments[0]?.text === source && prepared.segments[0]?.markdown === isMarkdown) {
			setSelecting(prepared);
			return;
		}
		snapshot(source, isMarkdown, value => {
			setWarm(undefined);
			setWebReady(false);
			setWebHeight(undefined);
			setSelecting(value);
		});
	}, [snapshot]);

	// 用意しておいた表示は、選ばれないまましばらく経ったら外す
	useEffect(() => {
		if (warm === undefined || selecting !== undefined) {
			return undefined;
		}
		const timer = setTimeout(() => {
			setWarm(undefined);
			setWebReady(false);
			setWebHeight(undefined);
		}, WARM_KEEP_MS);
		return () => clearTimeout(timer);
	}, [warm, selecting]);

	// 差し替えている間: 画面に 1 つだけにし、外を押したら戻す。お知らせと「完了」を出す
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
		// 会話の画面では、クイック返信の帯の位置に帯で出す（浮かぶお知らせは選んでいる発言とつまみに重なる）。帯を置けない
		// 画面では浮かぶお知らせ
		if (!showInplaceSelectNotice({ key: toastKey, speaker, done: stop })) {
			useParaToast.getState().show({ key: toastKey, text: '範囲を選んでコピー', sub: `${speaker}・外を押すと元に戻ります`, icon: 'text-outline', tone: 'info', action: { label: '完了', onPress: stop } });
		}
		return () => {
			end();
			hideInplaceSelectNotice(toastKey);
			const current = useParaToast.getState();
			if (current.current?.key === toastKey) {
				current.hide();
			}
		};
	}, [selecting, speaker, stop]);

	const quote = useContext(ChatQuoteContext);
	const menu = useMemo(
		() => nativeContextMenuAvailable && text.trim().length > 0
			? buildMessageMenu({ text, markdown }, { ...contextMenuOps(), selectRange: () => start(text, markdown), ...(quote !== undefined ? { quoteReply: () => quote(text) } : {}) })
			: undefined,
		[text, markdown, start, quote],
	);
	const recordTouch = useCallback((event: GestureResponderEvent) => {
		const { pageX, pageY } = event.nativeEvent;
		lastTouch.current = { pageX, pageY, at: Date.now() };
		lastMove.current = undefined;
	}, []);
	const recordMove = useCallback((event: GestureResponderEvent) => {
		const { pageX, pageY } = event.nativeEvent;
		lastMove.current = { pageX, pageY };
	}, []);
	// 長押しのメニューが触れを取り消したら（＝メニューが出た）、選ぶ表示を見えないまま用意し始める
	const prepareOnHold = useCallback(() => {
		if (menu === undefined || selecting !== undefined || warmRef.current !== undefined || !isHoldCancel(lastTouch.current, lastMove.current, Date.now())) {
			return;
		}
		snapshot(text, markdown, value => {
			if (warmRef.current === undefined) {
				setWebReady(false);
				setWebHeight(undefined);
				setWarm(value);
			}
		});
	}, [menu, selecting, snapshot, text, markdown]);
	const shown = selecting ?? warm;
	const minHeight = selecting !== undefined ? inplaceSelectMinHeight(selecting.nativeHeight, webHeight) : undefined;
	const hidden = selecting !== undefined && webReady;
	return (
		<View ref={wrapRef} style={[style, minHeight !== undefined ? { minHeight } : null]} onTouchStart={recordTouch} onTouchMove={recordMove} onTouchCancel={prepareOnHold}>
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
			{/* 用意している間（warm）も同じ位置に置き、選び始めたら同じ WebView をそのまま見せる（木の形を変えない） */}
			{shown !== undefined ? (
				<View style={[styles.overlay, webHeight !== undefined ? { height: webHeight } : styles.overlayFill, selecting === undefined ? styles.inert : null]}>
					<InplaceSelectWebView
						active={selecting !== undefined}
						segments={shown.segments}
						point={shown.point}
						fg={inplaceSelectForeground(markdown || plain === 'body', theme.onBubble)}
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
