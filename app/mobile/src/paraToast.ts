// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';

/** Ionicons の名前。表示側でキャストしないよう、ここで型を締めておく。 */
type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * 一時的なお知らせ（トースト）の状態。
 *
 * **ここが持つのは「一過性のお知らせ」だけ。** 起動しました・PCを切り替えました のように、
 * 起きたことを伝えて数秒で沈むものに限る。
 *
 * かつては「再接続中」「オフライン」といった**継続する状態**も同じカプセルで出していたが、
 * カプセルは上端＝ナビの場所に重なるため、直るまで居座ると「いまどのリポジトリを見ているか」
 * が見えないまま操作することになる（オフライン中はまさに誤認が起きやすい）。継続する状態は
 * 新しい部品を出さず、**スペースの島そのものの中で示す**ことにした（{@link useOfflineNotice}）。
 *
 * また、以前はカプセルの高さぶんヘッダーを押し下げていた（`useToastInset`）。押し下げは
 * 島だけでなくその下の帯・本文の上端まで連鎖して動かすうえ、押し下げの `LayoutAnimation` と
 * カプセルのばねが別々に走るので境目が一瞬重なる。**いまは押し下げず、素直に重ねる**
 * ——iOSの通知バナーと同じ読み方で、出入りでレイアウトが一切動かない。
 *
 * 表示側は `src/components/paraToast.tsx`。
 */

/** アイコンの色で種別を示す。**面は染めない**（面を染めると暗所で泥色に濁る）。 */
export type ParaToastTone = 'info' | 'done' | 'warn';

export interface ParaToast {
	/** 内容の識別子（同じ出来事を二重に出さないための目印）。 */
	readonly key: string;
	readonly text: string;
	/** 補足の1行（スペース名・ブランチなど）。無ければ1行のカプセルになる。 */
	readonly sub?: string;
	/** Ionicons の名前。 */
	readonly icon: IoniconName;
	readonly tone: ParaToastTone;
	/** 進行中はスピナーを出す（アイコンの代わり）。 */
	readonly spinner?: boolean;
	/** 押せる操作を1つだけ添えられる（「戻る」など）。 */
	readonly action?: { readonly label: string; readonly onPress: () => void };
}

interface ParaToastStore {
	/** いま出ているお知らせ。同時に持つのは1件だけ（積まない）。 */
	readonly current: ParaToast | undefined;
	/** お知らせを出す。`autoHideMs` を渡すとその時間後に自分で沈む。 */
	show(next: ParaToast, autoHideMs?: number): void;
	/** お知らせを消す（スワイプ・操作の実行後）。タイマーも止める。 */
	hide(): void;
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
	current: undefined,
	show(next, autoHideMs) {
		clearHideTimer();
		set({ current: next });
		if (autoHideMs !== undefined) {
			hideTimer = setTimeout(() => {
				hideTimer = undefined;
				set({ current: undefined });
			}, autoHideMs);
		}
	},
	hide() {
		// スワイプで払われたらタイマーも止める。残しておくと、次に出したお知らせが
		// 前のタイマーで早すぎるタイミングで消える。
		clearHideTimer();
		set({ current: undefined });
	},
}));
