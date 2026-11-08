// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * その場で範囲を選んでいる間のお知らせ（「範囲を選んでコピー／誰の発言・外を押すと元に戻ります／完了」）の置き場所。
 *
 * 浮かぶお知らせ（`ui/toast.tsx`）は会話の一覧の上に重なるので、iPhone の幅では選んでいる発言（一番下の行など）と
 * 押した単語のつまみを隠した。会話の画面（`agentChatPane.tsx`）は、選んでいる間だけクイック返信の帯の位置にこの
 * お知らせを帯として置く（{@link useInplaceSelectNoticeHost}）。帯は画面の並びの中にあるので一覧に重ならず、
 * 一覧はその分だけ短くなる。置き場所の無い画面（作業の様子の画面など）では、今までどおり浮かぶお知らせを使う。
 */

/** 帯に出すお知らせ。 */
export interface InplaceSelectNotice {
	/** 出した発言の目印（自分が出したものだけを消す）。 */
	readonly key: string;
	/** 誰の発言か。 */
	readonly speaker: string;
	/** 「完了」。 */
	readonly done: () => void;
}

interface InplaceSelectNoticeStore {
	readonly notice: InplaceSelectNotice | undefined;
	/** 帯を置ける画面がいくつ前面にあるか。 */
	readonly hosts: number;
}

export const useInplaceSelectNotice = create<InplaceSelectNoticeStore>()(() => ({ notice: undefined, hosts: 0 }));

/** 帯に出す。帯を置ける画面が前面に無ければ出さずに false を返す（呼び出し側は浮かぶお知らせを使う）。 */
export function showInplaceSelectNotice(notice: InplaceSelectNotice): boolean {
	if (useInplaceSelectNotice.getState().hosts <= 0) {
		return false;
	}
	useInplaceSelectNotice.setState({ notice });
	return true;
}

/** `key` のお知らせを消す（別の発言のものは残す）。 */
export function hideInplaceSelectNotice(key: string): void {
	if (useInplaceSelectNotice.getState().notice?.key === key) {
		useInplaceSelectNotice.setState({ notice: undefined });
	}
}

/** 帯を置ける画面が、前面にある間（`active`）だけ置き場所として名乗る。 */
export function useInplaceSelectNoticeHost(active: boolean): void {
	useEffect(() => {
		if (!active) {
			return undefined;
		}
		useInplaceSelectNotice.setState(state => ({ hosts: state.hosts + 1 }));
		return () => useInplaceSelectNotice.setState(state => ({ hosts: Math.max(0, state.hosts - 1) }));
	}, [active]);
}
