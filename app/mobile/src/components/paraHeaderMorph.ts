// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { PARA_HEADER_PILL_BUTTON, PARA_HEADER_SLOT_HEIGHT, type ParaHeaderSpec } from '../paraHeader.js';

/**
 * ヘッダーの形が変わるときの動き（モーフ）を、**層が自分で動かす**ための状態機械。
 *
 * `LayoutAnimation` は使わない。あれの予約は「次に画面へ適用される1回の描画」に**中身に
 * 関係なく無条件で消費される**（RN 0.86 `LayoutAnimationKeyFrameManager.cpp` の
 * `pullTransaction`）。ヘッダーの変化は必ず「画面／経路が変わった描画」の**次**に来るので、
 * 予約は毎回その手前の描画に食われて何も動かなかった（実機で確認済み）。ここは自分で
 * 補間するので、描画の順番に一切依存しない——押して変わる場合も、画面遷移も、端スワイプで
 * 戻る場合も同じように動く。
 *
 * 動きの形はLINEの録画（20fpsでコマ送り）に合わせている:
 *  - 戻りは**指に追従しない**。本文が滑り終わってから、丸が幅を変えながらぼけて島になる
 *  - 所要はおよそ250ms
 *  - 形が変わる瞬間、中身はぼけていて読めない
 * つまり「中身を薄くしながら細くする → 中身を差し替える → 太らせながら濃くする」の2段で足りる。
 * ぼかしはRNでは安く出せないので、不透明度＋わずかな縮小で代わりにする。
 *
 * **幅は `maxWidth` を動かす。** `width` を動かすには「島の自然な幅」を知る必要があり、
 * 中身（スペース名の長さ）で変わるので測ってからでないと動かせない。`maxWidth` なら
 *  - 縮めるとき: いまの実測幅 → 44 まで絞る（中身は切り取られて細くなって見える）
 *  - 太らせるとき: 44 → 大きめの上限（自然な幅で自然に止まる）
 * となり、測るのは「いま出ている幅」だけで済む。終わりも自然な幅で止まるので、制約を
 * 外すときに跳ねない。
 *
 * **ガラスそのものには不透明度を当てない。** 0にすると効果ごと死ぬ（glassSurface.tsx）。
 * 薄くするのは器の**中身**だけ。器の大きさは包みの `maxWidth` で変える。
 */

/** 中身を薄くして細くするまで（ミリ秒）。 */
const OUT_MS = 130;
/** 差し替えてから太らせて濃くするまで（ミリ秒）。 */
const IN_MS = 240;

/** 帯（絞り込みチップ・検索欄）の高さの上限。自然な高さで止まるよう余裕を持たせる。 */
const BAND_MAX = 160;

/** どのスロットを動かすか。 */
export type ParaHeaderSlot = 'left' | 'rightA' | 'rightB' | 'band';

const SLOTS: readonly ParaHeaderSlot[] = ['left', 'rightA', 'rightB', 'band'];

/**
 * 形が変わったかの見分け。**中身の文字ではなく形だけ**を見る。
 *
 * 画面が仕様を毎レンダー作り直しても（memo忘れ）ここが同じならモーフは走らないので、
 * 「名前が1文字変わっただけでヘッダーが跳ねる」ことがない。
 */
export function paraHeaderShapeOf(spec: ParaHeaderSpec): string {
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

/**
 * 新しい形でそのスロットが取りうる上限。**自然な幅より大きめでよい**（`maxWidth` なので
 * 上限が自然な幅を超えていれば制約にならず、自然な幅で止まる）。
 *
 * 逆に**小さすぎると切り取られたまま止まる**ので、見積もりは必ず多めにする。
 */
function capOf(spec: ParaHeaderSpec, slot: ParaHeaderSlot): number {
	if (slot === 'left') {
		if (spec.left === undefined) {
			return 0;
		}
		return spec.left.kind === 'back' ? PARA_HEADER_SLOT_HEIGHT : (spec.left.maxWidth ?? 224);
	}
	if (slot === 'rightA') {
		if (spec.rightA === undefined) {
			return 0;
		}
		if (spec.rightA.kind === 'text') {
			// 文字のピル。1文字あたり14ptで見積もり、左右の余白を足す（多めでよい）。
			return Math.min(200, 34 + spec.rightA.label.length * 14);
		}
		// アイコンのピル。中の丸ボタン＋隙間＋左右の余白（`styles.pill` と同じ寸法）。
		return 10 + spec.rightA.items.length * (PARA_HEADER_PILL_BUTTON + 2);
	}
	if (slot === 'rightB') {
		return spec.rightB === undefined ? 0 : PARA_HEADER_SLOT_HEIGHT;
	}
	return spec.band === undefined ? 0 : BAND_MAX;
}

export interface ParaHeaderMorph {
	/** いま描くべき仕様（差し替えは中身が薄くなってから行う）。 */
	readonly rendered: ParaHeaderSpec;
	/** 器の**中身**に当てる不透明度。器（ガラス）自体には当てないこと。 */
	readonly contentOpacity: Animated.Value;
	/** 動いている間だけ当てる上限。`undefined` のときは静的なスタイルのままにする。 */
	readonly limits: Readonly<Record<ParaHeaderSlot, Animated.Value>> | undefined;
	/** スロットの実測値を受け取る（縮める起点に使う）。 */
	measure(slot: ParaHeaderSlot, size: number): void;
}

/**
 * 仕様の変化を見張って、形が変わったときだけモーフを走らせる。
 *
 * `instant` な仕様（ズーム遷移の画面）と、伏せた状態からの復帰では動かさない
 * ——前者は画面全体が拡大しているので二重に見え、後者は実測値が古いままで起点にならない。
 */
export function useParaHeaderMorph(spec: ParaHeaderSpec): ParaHeaderMorph {
	const [rendered, setRendered] = useState(spec);
	const [animating, setAnimating] = useState(false);
	const contentOpacity = useRef(new Animated.Value(1)).current;
	const limits = useRef<Record<ParaHeaderSlot, Animated.Value>>({
		left: new Animated.Value(0), rightA: new Animated.Value(0),
		rightB: new Animated.Value(0), band: new Animated.Value(0),
	}).current;
	/** 実測した「いま出ている大きさ」。縮める起点に使う。 */
	const measured = useRef<Record<ParaHeaderSlot, number>>({ left: 0, rightA: 0, rightB: 0, band: 0 }).current;
	/** 走っている動きの世代。速く行き来したときに古い完了コールバックが割り込まないように。 */
	const generation = useRef(0);
	const renderedRef = useRef(rendered);
	renderedRef.current = rendered;

	useEffect(() => {
		const previous = renderedRef.current;
		if (previous === spec) {
			return;
		}
		const changed = paraHeaderShapeOf(previous) !== paraHeaderShapeOf(spec);
		// 形が同じなら中身だけ差し替える（名前が変わった等）。伏せた状態を挟む往復と
		// ズーム遷移の画面も動かさない。
		//
		// **走りかけの動きは必ず畳む。** 世代を進めるだけだと、途中で伏せられた場合に
		// `animating` が立ったまま・中身が薄いままで固まる（＝ヘッダーが細く透明なまま残る）。
		if (!changed || previous.hidden === true || spec.hidden === true
			|| previous.instant === true || spec.instant === true) {
			generation.current++;
			contentOpacity.stopAnimation();
			contentOpacity.setValue(1);
			setAnimating(false);
			setRendered(spec);
			return;
		}

		const token = ++generation.current;
		const caps = { left: capOf(spec, 'left'), rightA: capOf(spec, 'rightA'), rightB: capOf(spec, 'rightB'), band: capOf(spec, 'band') };
		for (const slot of SLOTS) {
			// 起点は実測値。測れていないスロット（まだ出ていなかった）は新しい上限から始める。
			limits[slot].setValue(measured[slot] > 0 ? measured[slot] : caps[slot]);
		}
		setAnimating(true);

		// ① 中身を薄くしながら、**新旧の細い方まで**絞る（島 → 丸なら44まで細くなる）。
		Animated.parallel([
			Animated.timing(contentOpacity, { toValue: 0, duration: OUT_MS, easing: Easing.in(Easing.quad), useNativeDriver: false }),
			...SLOTS.map(slot => Animated.timing(limits[slot], {
				toValue: Math.min(measured[slot] > 0 ? measured[slot] : caps[slot], caps[slot]),
				duration: OUT_MS, easing: Easing.in(Easing.quad), useNativeDriver: false,
			})),
		]).start(({ finished }) => {
			if (!finished || generation.current !== token) {
				return;
			}
			// ② 見えていないあいだに中身を差し替える。
			setRendered(spec);
			// ③ 新しい上限まで太らせながら濃くする（自然な幅で止まる）。
			Animated.parallel([
				Animated.timing(contentOpacity, { toValue: 1, duration: IN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
				...SLOTS.map(slot => Animated.timing(limits[slot], {
					toValue: caps[slot], duration: IN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false,
				})),
			]).start(({ finished: done }) => {
				if (done && generation.current === token) {
					// 制約を外す。上限は自然な幅を超えているので、外しても見た目は変わらない。
					setAnimating(false);
				}
			});
		});
	}, [spec, contentOpacity, limits, measured]);

	// 木から外れるときに走りかけの動きを止める（完了コールバックで state を触らせない）。
	useEffect(() => () => { generation.current++; }, []);

	return {
		rendered,
		contentOpacity,
		limits: animating ? limits : undefined,
		measure(slot, size) {
			if (size > 0) {
				measured[slot] = size;
			}
		},
	};
}
