// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, type RefObject } from 'react';
import type { View } from 'react-native';
import { useParaToast } from '../../paraToast.js';
import { hideInplaceSelectNotice, showInplaceSelectNotice } from './inplaceSelectNotice.js';
import { beginInplaceSelect } from './inplaceSelectSession.js';

/**
 * 差し替えている間に出すお知らせの目印。差し替えるたびに変える（別の発言で始め直したとき、前の発言の後片付けが
 * 新しいお知らせを消さないように。自分が出したものだけを消す）。
 */
let selectToastSerial = 0;

/**
 * その場で範囲を選んでいる間の受け付けとお知らせ。発言 1 つ（`messageContextMenu.tsx`）と前後の発言をまとめて
 * （`crossSelect.tsx`）で共通。`active` の間だけ:
 *
 * - 画面に 1 つだけにし、`view` の外を押したら `stop` で戻す（`inplaceSelectSession.ts`）
 * - お知らせと「完了」を出す。会話の画面では、クイック返信の帯の位置に帯で出す（浮かぶお知らせは選んでいる発言と
 *   つまみに重なる）。帯を置けない画面では浮かぶお知らせ
 */
export function useInplaceSelectChrome(active: boolean, speaker: string, stop: () => void, view: RefObject<View | null>): void {
	useEffect(() => {
		if (!active) {
			return;
		}
		const end = beginInplaceSelect({
			close: stop,
			contains: (pageX, pageY, done) => {
				const target = view.current;
				if (target === null) {
					done(false);
					return;
				}
				target.measure((_x, _y, width, height, left, top) => {
					done(pageX >= left && pageX <= left + width && pageY >= top && pageY <= top + height);
				});
			},
		});
		const toastKey = `inplace-select:${++selectToastSerial}`;
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
	}, [active, speaker, stop, view]);
}
