// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { LayoutAnimation } from 'react-native';
import { useIsFocused } from 'expo-router';
import type { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';

/**
 * ヘッダーを**画面の外へ出す**ための仕組み（fixx.html ⑤案B）。
 *
 * これまでヘッダーは画面ごとに別のViewだった（ホームは `WsHeader`、エージェント詳細は
 * `app/agent.tsx` の自作ヘッダー…）。別のViewだと遷移のとき補間する相手が居ないので、
 * どう頑張っても入れ替わり（クロスフェード）にしかならない。LINEの録画をコマ送りすると、
 * あちらは**ヘッダーがその場から動かず、同じ器の中で子の枠だけが変わっている**——
 * 以前の調査どおり「融合は素材の差し替えではなく**枠の変化**で起きる」がそのまま出ている。
 *
 * そこで、`Stack` の上に**常設のヘッダー層を1枚**置き（`src/components/paraHeaderLayer.tsx`）、
 * 各画面は「自分のヘッダーの仕様」をここへ登録するだけにする。層は同じViewのまま子の枠を
 * 差し替えるので、`LayoutAnimation` が本当に融合を起こす。
 *
 * 使い方（画面側）:
 * ```ts
 * const spec = useMemo<ParaHeaderSpec>(() => ({ left: { kind: 'back', onPress: router.back, label: '戻る' }, … }), [deps]);
 * useParaHeader(spec);
 * const headerHeight = useParaHeaderHeight();
 * ```
 *
 * 気をつけること:
 *  - **ガラスの枠を動かすのは `LayoutAnimation` だけ。** Reanimated や
 *    `Animated.createAnimatedComponent(GlassView)` で大きさ・位置を動かすとアプリごと落ちる
 *    （既知・実機で確認済み。`glassSurface.tsx` の注意書き参照）
 *  - **戻るスワイプの進捗には連動しない。** ネイティブStackは遷移の進捗をJSへ渡さないので、
 *    モーフは固定のばねで走る。指でゆっくり戻すとヘッダーだけ先に終わる
 *  - **ズーム遷移（`Link.AppleZoom`）の画面は `instant: true` にする。** 画面全体が拡大して
 *    いるのに中のヘッダーだけ別の速度で動くと二重に見える。連続性はズームに任せる
 *  - **モーダル（設定・ペアリング）は `hidden: true`。** 層はモーダルの下に居るので出しても
 *    見えないが、戻ってきたときに前の画面のヘッダーが残らないよう明示的に伏せる
 */

type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * ヘッダーのスロット（島・丸ボタン・ピル）の高さ。**44ptに統一する**（HIGの最小タップ領域）。
 * 以前は島が40pt、エージェント詳細の丸が44pt、ブラウザの戻るが36ptと3種類あり、
 * 画面を移るたびにボタンの大きさが変わっていた。
 */
export const PARA_HEADER_SLOT_HEIGHT = 44;

/** ピルの中に並ぶ丸ボタン。見た目34ptで、当たり判定は hitSlop で44pt相当まで広げる。 */
export const PARA_HEADER_PILL_BUTTON = 34;

/** ピルの中／右端に置く1つのボタン。`node` を渡すと中身をそのまま差し込む（ネイティブボタン等）。 */
export interface ParaHeaderIcon {
	/** 並びの同一性。アイコン名と別に持つのは、同じアイコンで役割が違う場合があるため。 */
	readonly key: string;
	readonly label: string;
	readonly icon?: IoniconName;
	readonly onPress?: () => void;
	readonly color?: string;
	readonly size?: number;
	/** アイコンの右上に載せる印（赤＝注意、緑＝進行中）。 */
	readonly badge?: 'red' | 'green';
	/**
	 * 自前で描く中身。状態を持つボタン（音声通知）やネイティブのメニューボタン（＋）は
	 * データにできないのでこちらを使う。**器（ガラスのピル）は層が持つので、ここには
	 * ガラスを置かないこと**（重ねると2枚ぶん明るくなる）。
	 */
	readonly node?: ReactNode;
}

/**
 * 左のスロット。`back` は44ptの丸、`island` はアバター＋名前＋サブ行の島。
 * 遷移ではこの2つの間で枠が変わる（＝島が丸へ縮む、丸が島へ伸びる）。
 */
export interface ParaHeaderLeft {
	readonly kind: 'back' | 'island';
	readonly label: string;
	readonly onPress?: () => void;
	readonly disabled?: boolean;
	/** island のとき: アバターの文字（1文字）。`avatarIcon` とどちらか。 */
	readonly avatarText?: string;
	readonly avatarIcon?: IoniconName;
	/** アバターと文字の色。 */
	readonly color?: string;
	/** ガラスへの色被せ。スペースの固有色があるときだけ渡す。 */
	readonly tint?: string;
	readonly name?: string;
	readonly sub?: string;
	readonly subColor?: string;
	/** 島の左上に出す赤い点（他のスペースに応答待ちがある等）。 */
	readonly badge?: boolean;
	readonly maxWidth?: number;
}

export interface ParaHeaderSpec {
	/** 層を伏せる（自前のヘッダーを描く画面・モーダル）。 */
	readonly hidden?: boolean;
	readonly left?: ParaHeaderLeft;
	/**
	 * 中央のタイトル。左が丸のときだけ出す（島の中に名前があるので二重になる）。
	 * 左右のボタン数に関係なく画面の中央に据える。
	 */
	readonly title?: {
		readonly text: string;
		readonly sub?: string;
		readonly subColor?: string;
		readonly onPress?: () => void;
		readonly chevron?: boolean;
		readonly label?: string;
	};
	/**
	 * 左の島と右のピルの間に伸びる島。中身は画面が渡す（`node`）が、**器（ガラス）は層が持つ**。
	 *
	 * ターミナルタブの「ターミナル名 ▾」がこれ。中身にネイティブのメニューボタンを入れると、
	 * 島ぜんぶが標準の `UIMenu` の起点になる（ボタン→メニューのモーフをOSが描く）。
	 * これがあるときは中央のタイトルは出さない（同じ場所に2つ並ぶため）。
	 */
	readonly mid?: { readonly node: ReactNode; readonly label: string; readonly badge?: boolean };
	/** 右の1枚目。アイコンのピル（1〜4個）か、文字のピル（「すべて戻す」等）。 */
	readonly rightA?:
	| { readonly kind: 'icons'; readonly items: readonly ParaHeaderIcon[] }
	| { readonly kind: 'text'; readonly label: string; readonly color?: string; readonly onPress: () => void };
	/** 右の2枚目（✕など）。1枚→2枚に分裂する遷移はここで表現する。 */
	readonly rightB?: ParaHeaderIcon;
	/** 島の下に続く帯（絞り込みチップ・ターミナルのタブ列・ファイルの検索欄）。 */
	readonly band?: ReactNode;
	/** 本文が読み幅の列に収まらず画面いっぱいを使う画面（ホームの2列など）で true。 */
	readonly wide?: boolean;
	/** モーフさせない（ズーム遷移の画面）。 */
	readonly instant?: boolean;
}

interface ParaHeaderStore {
	readonly spec: ParaHeaderSpec | undefined;
	/** 層が実測した占有高さ。画面の `paddingTop` に使う。 */
	readonly height: number;
	set(next: ParaHeaderSpec): void;
	setHeight(height: number): void;
}

/**
 * 枠が変わったかどうかの見分け。**中身の文字ではなく形だけ**を見る。
 *
 * 画面が仕様を毎レンダー作り直しても（memo忘れ）ここが同じなら融合アニメは走らないので、
 * 「名前が1文字変わっただけでヘッダーが跳ねる」ことがない。
 */
function shapeOf(spec: ParaHeaderSpec): string {
	const right = spec.rightA === undefined ? '-'
		: spec.rightA.kind === 'text' ? `t:${spec.rightA.label.length}`
			: `i:${spec.rightA.items.length}`;
	return [
		spec.hidden === true ? 'h' : '',
		spec.left?.kind ?? '-',
		spec.mid === undefined ? '-' : 'M',
		spec.title === undefined ? '-' : 'T',
		right,
		spec.rightB === undefined ? '-' : 'B',
		spec.band === undefined ? '-' : 'D',
	].join('/');
}

/** 融合の速さ。ばねにするのは、UIKitのナビゲーションバーの変形と同じ手触りにするため。 */
const MORPH = {
	duration: 420,
	update: { type: LayoutAnimation.Types.spring, springDamping: 0.86 },
	create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity, duration: 260 },
	delete: { type: LayoutAnimation.Types.easeIn, property: LayoutAnimation.Properties.opacity, duration: 160 },
} as const;

export const useParaHeaderStore = create<ParaHeaderStore>()((set, get) => ({
	spec: undefined,
	height: 0,
	set(next) {
		const previous = get().spec;
		// **`LayoutAnimation` はここで予約する。** 次のコミットが対象なので、
		// レンダー後の effect で呼んでも間に合わない（1フレーム遅れて跳ねる）。
		const morph = previous !== undefined
			&& previous.instant !== true && next.instant !== true
			&& previous.hidden !== true && next.hidden !== true
			&& shapeOf(previous) !== shapeOf(next);
		if (morph) {
			LayoutAnimation.configureNext(MORPH);
		}
		set({ spec: next });
	},
	setHeight(height) {
		set(state => (state.height === height ? state : { height }));
	},
}));

/**
 * この画面のヘッダーの仕様を層へ登録する。
 *
 * **書き込むのはフォーカスされている画面だけ。** スタックには前の画面もマウントされたまま
 * 残るので、全員が書くと最後に再レンダーした画面が勝ってしまう。push した瞬間に新しい画面が
 * フォーカスを得るので、そこで融合が始まる（＝本文のスライドと同時に走る）。
 *
 * `spec` は `useMemo` で安定させること。忘れても形が同じなら融合は走らないが、
 * 無駄な再レンダーは増える。
 */
export function useParaHeader(spec: ParaHeaderSpec): void {
	const focused = useIsFocused();
	useEffect(() => {
		if (!focused) {
			return;
		}
		useParaHeaderStore.getState().set(spec);
	}, [focused, spec]);
}

/**
 * 層を伏せる仕様。自前のヘッダーを描く画面（パンくずや独自の選択UIを持つもの、モーダル）で
 * 使う。**参照を固定するためモジュール定数にする**（毎回作ると登録が走り続ける）。
 */
export const PARA_HEADER_HIDDEN: ParaHeaderSpec = { hidden: true };

/** 層が実測した占有高さ。本文の `paddingTop` に使う。 */
export function useParaHeaderHeight(): number {
	return useParaHeaderStore(state => state.height);
}
