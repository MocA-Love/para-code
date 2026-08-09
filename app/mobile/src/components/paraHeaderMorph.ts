// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { PARA_HEADER_PILL_BUTTON, PARA_HEADER_SLOT_HEIGHT, type ParaHeaderSpec } from '../paraHeader.js';
import { PARA_HEADER_NO_CAP, paraHeaderBoundsFor } from '../paraHeaderBounds.js';

/**
 * ヘッダーの形が変わるときの動き（モーフ）。**Reanimatedの共有値1本で回す。**
 *
 * ## なにを真似ているか（LINEの実機録画を60fpsでコマ送りして実測した値）
 *  - 形の変化は**角丸長方形→円へ単調に幅が縮むだけ**。凹み（くびれ）は一切無い
 *  - **中身はガウスぼかしされる**。半径はモーフ中央で最大、両端でゼロ。器の輪郭は常に鮮明
 *  - ぼけている最中、**旧と新の中身が同時に見える**。中身は一度も完全な透明にならない
 *  - 所要は往き約215ms／戻り約333ms
 *  - **遷移進捗には連動しない。**着地してから走る離散アニメーション
 *  - **タブ切り替えでは動かない**（OSのタブ切替は瞬時なので、ヘッダーだけ旅をさせると遅く見える）
 *
 * ぼかしはRNに手段が無い（iOSは `CALayer.filters` が非対応で、生きた中身をぼかす公開APIは
 * SwiftUIの `.blur` だけ）。ここでは**旧と新を重ねたクロスフェード**で代用する。
 * 谷を作って一度透明にしてはいけない——それが「ヘッダーが空になる」正体だった。
 *
 * ## 前の実装がなぜ壊れていたか（同じ失敗を繰り返さないため）
 * 1. `Animated` を `useNativeDriver: false` で使っていた。New Architecture では
 *    `requestAnimationFrame` は `setTimeout(0)` 相当のJSタスクにすぎず、`TimingAnimation` は
 *    `Date.now()` の壁時計で判定するため、**JSが詰まると中間値を1つも配らず終値へ飛ぶ**
 * 2. 「薄くする→**完了コールバックで差し替える**→濃くする」の2段だった。見えない時間が
 *    `OUT + JSが詰まっている時間 + IN` になり、遷移のたびに0.7〜0.9秒ヘッダーが空になった。
 *    しかもこの構造は reanimated#9776（完了コールバックからの `scheduleOnRN` で use-after-free）
 *    の踏み場そのものだった
 *
 * ## だから守っていること
 *  - **時計は共有値1本だけ。** 幅も不透明度もそこから導く（位相がずれない）
 *  - **アニメーション中にReactの更新を挟まない。** 旧と新は最初の1コミットで両方載せる
 *  - **完了時にworkletからJSを呼ばない。** 旧の取り外しは素のタイマーでやる
 *  - **止まったときに残るのは「古いヘッダーそのまま」。** 進捗0で器は旧の幅に固定され、旧の
 *    中身が不透明度1で出ている。JSが何秒詰まっても、消えるのではなく**変わらない**だけ
 *  - **ガラスに不透明度を当てない**（0にすると効果ごと死ぬ）。薄くするのは器の中身だけ
 *  - **`borderRadius` は動かさない。** 高さが一定なのでカプセルの半径は定数で足りる
 *    （毎フレーム変えると `UICornerRadius` を作り直す重い経路に入る）
 */

/** 往きの所要（ms）。実測値。 */
const FORWARD_MS = 215;
/** 戻りの所要（ms）。往きより長い（実測）。 */
const BACK_MS = 333;

/** 幅を動かすスロット。帯（チップ・検索欄）は含めない——理由は {@link useParaHeaderMorph}。 */
export type ParaHeaderSlot = 'left' | 'rightA' | 'rightB';

const SLOTS: readonly ParaHeaderSlot[] = ['left', 'rightA', 'rightB'];

/** 下部タブの根。ここからここへの移動ではモーフしない。 */
const TAB_ROOTS: ReadonlySet<string> = new Set(['/', '/terminal', '/scm', '/files']);

/**
 * 形が変わったかの見分け。**中身の文字ではなく形だけ**を見る。
 *
 * 画面が仕様を毎レンダー作り直しても（memo忘れ）ここが同じならモーフは走らないので、
 * 「名前が1文字変わっただけでヘッダーが跳ねる」ことがない。
 */
export function paraHeaderShapeOf(spec: ParaHeaderSpec): string {
	const right = spec.rightA === undefined ? '-'
		: spec.rightA.kind === 'text' ? 't'
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
 * 太らせる側の到達点（上限の見積もり）。**多めでよい。**
 *
 * 前の実装ではここを小さく見積もると器が切り取られたまま固まったが、いまは**着地したら
 * 制約そのものを外す**ので（`bounds` の `p >= 1` の枝）、見積もりが外れても一時的に
 * 太り方が速い／遅いだけで、最終的な幅は必ず中身なりになる。
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
		// 文字のピルは中身の長さで決まるので、静的な上限（styles.textPill）をそのまま使う。
		// アイコンのピルは中身が決まっているので実寸で出せる（styles.pill と同じ寸法）。
		return spec.rightA.kind === 'text' ? 200 : 10 + spec.rightA.items.length * (PARA_HEADER_PILL_BUTTON + 2);
	}
	return spec.rightB === undefined ? 0 : PARA_HEADER_SLOT_HEIGHT;
}

/**
 * 中身に当てる不透明度のスタイル。**ガラスの器には絶対に当てないこと**
 * （0にすると効果ごと死ぬ）。当てる先は必ず器の中身。
 */
export type ParaHeaderFade = ReturnType<typeof useAnimatedStyle>;

export interface ParaHeaderMorph {
	/** いま出すべき仕様（常に最新）。 */
	readonly current: ParaHeaderSpec;
	/** 消えていく仕様。モーフしていない間は `undefined`。 */
	readonly previous: ParaHeaderSpec | undefined;
	/** スロットごとの器の幅の制約（包みのスタイルに当てる。ガラス自身には当てない）。 */
	readonly bounds: Readonly<Record<ParaHeaderSlot, ParaHeaderFade>>;
	/** 消えていく中身に当てる不透明度。 */
	readonly fading: ParaHeaderFade;
	/** 出てくる中身に当てる不透明度。 */
	readonly entering: ParaHeaderFade;
	/** 包みの実測幅を控える（縮める起点になる）。 */
	measure(slot: ParaHeaderSlot, width: number): void;
}

/**
 * 仕様の変化を見張って、形が変わったときだけモーフを走らせる。
 *
 * `pathname` は「タブ切り替えかどうか」の判定にだけ使う。タブの根から根への移動では
 * OSが本文を瞬時に差し替えるので、ヘッダーだけ250msかけて動かすと**本文が既に新しいのに
 * ヘッダーだけ古い形で移動中**になり、遅く見える（LINEもタブ切替では動かさない）。
 *
 * **帯（絞り込みチップ・ファイル検索欄）はモーフの対象にしない。** 高さを毎フレーム変えると
 * (1) ヘッダーの高さが動くので本文の上余白が追従できず1行目が帯の裏に潜り、(2) 帯の中身は
 * ガラスのチップなので、動く親でクリップすると素材が壊れる。帯は即時に出し入れする。
 */
export function useParaHeaderMorph(spec: ParaHeaderSpec, pathname: string): ParaHeaderMorph {
	const [pair, setPair] = useState<{ current: ParaHeaderSpec; previous: ParaHeaderSpec | undefined }>(
		{ current: spec, previous: undefined });
	/** 0 = 旧の形・旧の中身、1 = 新の形・新の中身。静止時は必ず1。 */
	const progress = useSharedValue(1);
	const fromLeft = useSharedValue(0);
	const fromRightA = useSharedValue(0);
	const fromRightB = useSharedValue(0);
	// **初期値は「制約なし」。0にしてはいけない**——0は「このスロットは無くなる」の意味なので、
	// 静止時に器の幅が0になってヘッダーがまるごと消える（2026-08-09に実際にやった）。
	const capLeft = useSharedValue(PARA_HEADER_NO_CAP);
	const capRightA = useSharedValue(PARA_HEADER_NO_CAP);
	const capRightB = useSharedValue(PARA_HEADER_NO_CAP);
	const from: Record<ParaHeaderSlot, SharedValue<number>> = { left: fromLeft, rightA: fromRightA, rightB: fromRightB };
	const cap: Record<ParaHeaderSlot, SharedValue<number>> = { left: capLeft, rightA: capRightA, rightB: capRightB };

	/** 直前に実測した包みの幅。**動いている間は更新しない**（動いている幅を拾わない）。 */
	const measured = useRef<Record<ParaHeaderSlot, number>>({ left: 0, rightA: 0, rightB: 0 }).current;
	/** いま向かっている先。動いている最中も画面は仕様を出し続けるので、比較相手はこちら。 */
	const targetRef = useRef(spec);
	const pathRef = useRef(pathname);
	/** 旧の取り外しを予約するタイマー。**worklet の完了コールバックからJSを呼ばないため。** */
	const dropTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		const previous = targetRef.current;
		const previousPath = pathRef.current;
		if (previous === spec) {
			return;
		}
		targetRef.current = spec;
		pathRef.current = pathname;

		const shapeChanged = paraHeaderShapeOf(previous) !== paraHeaderShapeOf(spec);
		// タブの根から根への移動、伏せた状態を挟む往復、ズーム遷移の画面は動かさない。
		// 起点の幅が分からないときも動かさない（0に固定すると器が消えてしまう）。
		const betweenTabs = TAB_ROOTS.has(previousPath) && TAB_ROOTS.has(pathname);
		const measurable = SLOTS.every(slot => capOf(previous, slot) === 0 || measured[slot] > 0);
		const animate = shapeChanged && !betweenTabs && measurable
			&& previous.hidden !== true && spec.hidden !== true
			&& previous.instant !== true && spec.instant !== true;

		if (!animate) {
			if (dropTimer.current !== undefined) {
				clearTimeout(dropTimer.current);
				dropTimer.current = undefined;
			}
			// **制約を必ず外す。** 前のモーフで「無くなる」判定（上限0）のまま止まったスロットが
			// あると、動かさずに戻ってきたときに幅0のまま出てこない。
			for (const slot of SLOTS) {
				cap[slot].value = PARA_HEADER_NO_CAP;
			}
			progress.value = 1;
			setPair({ current: spec, previous: undefined });
			return;
		}

		for (const slot of SLOTS) {
			from[slot].value = measured[slot];
			cap[slot].value = capOf(spec, slot);
		}
		// 戻り（詳細→一覧＝左が丸から島へ戻る）だけ長い。実測の非対称に合わせる。
		const duration = previous.left?.kind === 'back' && spec.left?.kind !== 'back' ? BACK_MS : FORWARD_MS;
		setPair({ current: spec, previous });
		progress.value = 0;
		progress.value = withTiming(1, { duration, easing: Easing.out(Easing.cubic) });

		// 旧を木から外すのは**素のタイマー**で。worklet の完了コールバックから
		// `scheduleOnRN` するとアンマウント直後の use-after-free（reanimated#9776）を踏む。
		// 遅れて発火しても、旧は不透明度0で当たり判定も無いので害が無い。
		if (dropTimer.current !== undefined) {
			clearTimeout(dropTimer.current);
		}
		dropTimer.current = setTimeout(() => {
			dropTimer.current = undefined;
			setPair(state => (state.previous === undefined ? state : { current: state.current, previous: undefined }));
		}, duration + 80);
	}, [spec, pathname, progress, from, cap, measured]);

	useEffect(() => () => {
		if (dropTimer.current !== undefined) {
			clearTimeout(dropTimer.current);
		}
	}, []);

	// 器の幅。**着地したら制約を外す**ので、上限の見積もりが最終的な幅を縛ることはない。
	// 進捗0では下限＝上限＝旧の幅なので、動きが始まらなければ器は旧の幅のまま残る。
	// 式そのものは `paraHeaderBounds.ts`（テストあり）。
	const boundsLeft = useAnimatedStyle(() => paraHeaderBoundsFor(progress.value, fromLeft.value, capLeft.value));
	const boundsRightA = useAnimatedStyle(() => paraHeaderBoundsFor(progress.value, fromRightA.value, capRightA.value));
	const boundsRightB = useAnimatedStyle(() => paraHeaderBoundsFor(progress.value, fromRightB.value, capRightB.value));
	// 中身のクロスフェード。**谷を作らない**（一度透明にすると「消えた」に見える）。
	const fading = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
	const entering = useAnimatedStyle(() => ({ opacity: progress.value }));

	return {
		current: pair.current,
		previous: pair.previous,
		bounds: { left: boundsLeft, rightA: boundsRightA, rightB: boundsRightB },
		fading,
		entering,
		measure(slot, width) {
			// 動いている間の幅を起点として控えてはいけない（次のモーフが途中の幅から始まる）。
			if (width > 0 && progress.value >= 1) {
				measured[slot] = width;
			}
		},
	};
}
