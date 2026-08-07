// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';

/** Ionicons の名前。表示側でキャストしないよう、ここで型を締めておく。 */
type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * 一時的なお知らせ（トースト）の状態。
 *
 * 以前は「PCを切り替えました」「再接続中」「起動しました」が**3つの別々の部品**で、
 * 出る場所・素材・角丸・出入り・寿命の5つすべてが食い違っていた。共通点が無いので、
 * ユーザーは3つを別の機能として学習してしまう。ここで1つの器に集約する。
 *
 * 分けるのは**寿命だけ**:
 *  - **一過性**（起動完了・PC切替）… タイマーで沈む。{@link ParaToastStore.show} で出す
 *  - **継続**（再接続中・オフライン）… タイマーを持たない。状態から導出され、直るまで残る。
 *    ユーザーが上へ払えば消えるが、**状態が変わったら出し直す**（`dismissedStickyKey` が
 *    そのときの key と食い違うため再度出る）。黙って消えたまま操作されるのが唯一の危険なので、
 *    そこだけ拾えばよい
 *
 * 表示側は `src/components/paraToast.tsx`。ヘッダーの押し下げ量は {@link useToastInset}。
 */

/** アイコンの色で種別を示す。**面は染めない**（面を染めると暗所で泥色に濁る）。 */
export type ParaToastTone = 'info' | 'done' | 'warn';

export interface ParaToast {
	/**
	 * 内容の識別子。継続系はこれが変わると「別のお知らせ」として扱われ、
	 * いちど払われていても出し直される。
	 */
	readonly key: string;
	readonly text: string;
	/** 補足の1行（スペース名・ブランチなど）。無ければ1行のカプセルになる。 */
	readonly sub?: string;
	/** Ionicons の名前。 */
	readonly icon: IoniconName;
	readonly tone: ParaToastTone;
	/** 進行中はスピナーを出す（アイコンの代わり）。 */
	readonly spinner?: boolean;
	/** 押せる操作を1つだけ添えられる（「戻る」「再接続」など）。 */
	readonly action?: { readonly label: string; readonly onPress: () => void };
}

interface ParaToastStore {
	/** 一過性のお知らせ。同時に持つのは1件だけ（積まない）。 */
	readonly transient: ParaToast | undefined;
	/** ユーザーが払った継続系の key。状態が変わって key が変われば再度出る。 */
	readonly dismissedStickyKey: string | undefined;
	/** カプセルの実測高さ（pt）。ヘッダーを押し下げる量に使う。0 なら出ていない。 */
	readonly height: number;
	/** 一過性のお知らせを出す。`autoHideMs` を渡すとその時間後に自分で沈む。 */
	show(next: ParaToast, autoHideMs?: number): void;
	/** 一過性のお知らせを消す（スワイプ・操作の実行後）。タイマーも止める。 */
	hideTransient(): void;
	/** 継続系を払う。 */
	dismissSticky(key: string): void;
	/**
	 * 払った記録を捨てる。
	 *
	 * **これが無いと継続系は二度と出ない。** key は `'reconnecting'` のような固定文字列なので、
	 * 一度払うと「復帰 → また切れる」で同じ key に戻ってきたときに払い済みと判定されてしまう。
	 * 表示側が「継続系の条件が消えた」瞬間にここを呼んで白紙に戻す。
	 */
	resetSticky(): void;
	setHeight(height: number): void;
}

/** 自動非表示のタイマー。表示は同時に1件だけなのでモジュールに1本で足りる。 */
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function clearHideTimer(): void {
	if (hideTimer !== undefined) {
		clearTimeout(hideTimer);
		hideTimer = undefined;
	}
}

export const useParaToast = create<ParaToastStore>()(set => ({
	transient: undefined,
	dismissedStickyKey: undefined,
	height: 0,
	show(next, autoHideMs) {
		clearHideTimer();
		set({ transient: next });
		if (autoHideMs !== undefined) {
			hideTimer = setTimeout(() => {
				hideTimer = undefined;
				set({ transient: undefined });
			}, autoHideMs);
		}
	},
	hideTransient() {
		// スワイプで払われたらタイマーも止める。残しておくと、次に出したお知らせが
		// 前のタイマーで早すぎるタイミングで消える。
		clearHideTimer();
		set({ transient: undefined });
	},
	dismissSticky(key) {
		set({ dismissedStickyKey: key });
	},
	resetSticky() {
		set(state => (state.dismissedStickyKey === undefined ? state : { dismissedStickyKey: undefined }));
	},
	setHeight(height) {
		set(state => (state.height === height ? state : { height }));
	},
}));

/**
 * お知らせのぶんヘッダーを押し下げる量（pt）。
 *
 * 上端はナビの場所（島・ボタン・チップ）なので、覆うのではなく場所を空ける。
 * {@link ParaToastStore.height} は表示側が実測して入れるので、
 * 文字数や操作ボタンの有無で高さが変わっても追従する。
 */
export function useToastInset(): number {
	return useParaToast(state => (state.height > 0 ? state.height + TOAST_GAP : 0));
}

/** カプセルとヘッダーの間隔（pt）。 */
export const TOAST_GAP = 8;
