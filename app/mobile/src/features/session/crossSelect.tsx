// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsRegularWidth } from '../../hooks/useSizeClass.js';
import { colors } from '../../theme.js';
import { chatRowKey, type ChatRow } from './chatRows.js';
import { crossSelectColumn, crossSelectSegments, type CrossSelectFrame } from './crossSelectSegments.js';
import { localPressPoint, type InplaceSelectPoint, type InplaceSelectScrollLayout, type InplaceSelectSegment } from './inplaceSelectHtml.js';
import { useInplaceSelectChrome } from './inplaceSelectChrome.js';
import { InplaceSelectWebView } from './inplaceSelectView.js';

/**
 * 前後の発言をまとめて範囲を選ぶ（708-RES。発言のメニューの「前後の発言もまとめて選ぶ…」）。
 *
 * 発言 1 つの「範囲を選んでコピー…」（`messageContextMenu.tsx`）の延長で、押した発言の前後の文字の発言
 * （`crossSelectSegments.ts`）を 1 枚の WebView に並べ、会話の一覧（`chatList.tsx`）の上いっぱいに重ねる。
 * WebView は中で縦にスクロールでき、押した発言が重ねる前と同じ位置に来るようにスクロールしてから見せる。
 * 押した点の単語を選んだ状態で始め、OS のつまみで発言をまたいで選べる。一覧の行は描き直さない（重ねているだけ）。
 * お知らせの「完了」か、一覧の外を押すと戻す。選んでいる間に届いた発言は、戻すと出る（始めたときの写しのまま）。
 */

export type { CrossSelectFrame } from './crossSelectSegments.js';

/** 発言の部品から始める口。`rowKey` は一覧の行の鍵（{@link ChatRowKeyContext}）、`touch` は長押しでメニューを開いた点。 */
export type CrossSelectStart = (rowKey: string, frame: CrossSelectFrame, touch: { readonly pageX: number; readonly pageY: number; readonly at: number } | undefined) => void;

/** 会話の一覧が配る、まとめて選ぶ口（一覧の外の発言には無い）。 */
export const CrossSelectContext = createContext<CrossSelectStart | undefined>(undefined);
/** 会話の一覧の行の鍵（`chatRowKey`）。 */
export const ChatRowKeyContext = createContext<string | undefined>(undefined);

interface Across {
	readonly segments: readonly InplaceSelectSegment[];
	readonly layout: InplaceSelectScrollLayout;
	readonly point: InplaceSelectPoint | undefined;
}

/**
 * 会話の一覧に付ける。`provider` で一覧の中身を包み（発言のメニューに項目が出る）、`overlay` を一覧の上に置く
 * （始めていないときは何も描かない。一覧の兄弟の末尾なので、出し入れしても一覧は作り直されない）。
 */
export function useCrossSelect(rows: readonly ChatRow[], epoch: string, listRef: RefObject<View | null>): { readonly provider: (children: ReactNode) => ReactNode; readonly overlay: ReactNode } {
	const regular = useIsRegularWidth();
	const [across, setAcross] = useState<Across | undefined>(undefined);
	const [ready, setReady] = useState(false);
	const overlayRef = useRef<View>(null);
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const stop = useCallback(() => {
		setAcross(undefined);
		setReady(false);
	}, []);
	const start = useCallback<CrossSelectStart>((rowKey, frame, touch) => {
		const current = rowsRef.current;
		const picked = crossSelectSegments(current, current.findIndex(row => chatRowKey(row, epoch) === rowKey));
		const list = listRef.current;
		if (picked === undefined || list === null) {
			return;
		}
		list.measure((_x, _y, width, height, pageX, pageY) => {
			const column = crossSelectColumn(picked.segments[picked.anchor]?.markdown === true, frame, { pageX, width }, regular);
			setReady(false);
			setAcross({
				segments: picked.segments,
				layout: { anchor: picked.anchor, top: frame.pageY - pageY, left: column.left, width: column.width, pad: height },
				point: localPressPoint(touch, { pageX, pageY, width, height }, Date.now()),
			});
		});
	}, [epoch, listRef, regular]);
	useInplaceSelectChrome(across !== undefined, across !== undefined ? `前後の発言 ${across.segments.length} 件` : '', stop, overlayRef);
	const provider = useCallback((children: ReactNode) => <CrossSelectContext.Provider value={start}>{children}</CrossSelectContext.Provider>, [start]);
	const overlay = across !== undefined ? (
		// 描き終えるまでは透明で触れも通す（下の一覧が見えたまま）。描き終えたら会話の地の色で一覧を覆う
		<View ref={overlayRef} collapsable={false} style={[StyleSheet.absoluteFill, ready ? styles.shown : styles.pending]}>
			<InplaceSelectWebView
				active
				segments={across.segments}
				point={across.point}
				layout={across.layout}
				fg={colors.text}
				onReady={() => setReady(true)}
				onHeight={ignoreHeight}
				onGone={stop}
			/>
		</View>
	) : null;
	return { provider, overlay };
}

/** まとめて選ぶ表示は一覧の高さいっぱいで中でスクロールするので、中身の高さは使わない。 */
function ignoreHeight(): void { }

const styles = StyleSheet.create({
	pending: { pointerEvents: 'none' },
	shown: { backgroundColor: colors.bg },
});
