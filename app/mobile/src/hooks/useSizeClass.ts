// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useSyncExternalStore } from 'react';
import { Dimensions, Platform } from 'react-native';
import { sizeClassFor, sizeClassForWithHysteresis, type SizeClass } from '../sizeClass.js';

/**
 * このデバイスがタブレットか（iPadのみ対象。Androidタブレットは未検証のため含めない）。
 * 端末固有の値なので毎回同じ結果になり、フックの外で1度だけ解決してよい。
 */
const tablet = Platform.OS === 'ios' && Platform.isPad === true;

/** この端末がタブレット（iPad）か。幅に関係なく端末で決まるもの（ターミナルの既定の文字サイズ、ショートカット）に使う。 */
export const isTablet = tablet;

/**
 * 現在の判定（幅とsize class）。**モジュール単位の単一ソース**にする。
 *
 * Split View の分割線ドラッグは700pt前後を往復する。ここを跨ぐたびに
 * `regular ? <Tabs> : <NativeTabs>` のナビゲータ型が入れ替わると、(tabs) 配下が
 * 丸ごと再マウントされて TermView の WebView が破壊され、スクロール位置や入力途中の
 * 文字が消える。そこで `sizeClassForWithHysteresis` によるラッチを**この1箇所だけ**で
 * 持つ——呼び出しごとに独立した ref ラッチを持つと、境界幅で画面ごとに判定が割れて
 * 「サイドバー=regular / タブバー=compact」の不整合が起きるため。
 *
 * 更新は `useWindowDimensions` の購読経路ではなく `Dimensions` イベントで行う。
 * 各コンポーネントの再レンダーは `useSyncExternalStore` の同値比較で駆動する
 * （size class が実際に変わったときだけ全購読者が更新される）。
 */
let current: SizeClass = (() => {
	const initial = Dimensions.get('window');
	return sizeClassFor(initial.width, tablet);
})();

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	// リスナー登録前に幅が変わっていた場合の取りこぼしを防ぐ（初回購読時に再同期）。
	applyWidth(Dimensions.get('window').width);
	return () => { listeners.delete(listener); };
}

/**
 * 開発ビルド専用: アプリの幅を狭めて見せる（シミュレータで Split View の代わりに 2列 ⇄ 1列 を確かめる）。
 * `src/dev/devWidthFrame.tsx` が同じ値で画面を狭める。リリースビルドでは常に undefined。
 */
let devWidthOverride: number | undefined;
const devWidthListeners = new Set<() => void>();

function effectiveWidth(width: number): number {
	return devWidthOverride !== undefined ? Math.min(width, devWidthOverride) : width;
}

/** 開発ビルド専用: アプリの幅を `width` に狭める（undefined で元に戻す）。 */
export function setDevWidthOverride(width: number | undefined): void {
	if (!__DEV__) {
		return;
	}
	devWidthOverride = width;
	for (const listener of [...devWidthListeners]) {
		listener();
	}
	applyWidth(Dimensions.get('window').width);
}

/** 開発ビルド専用: 狭めている幅（狭めていなければ undefined）。 */
export function useDevWidthOverride(): number | undefined {
	return useSyncExternalStore(listener => {
		devWidthListeners.add(listener);
		return () => { devWidthListeners.delete(listener); };
	}, () => devWidthOverride);
}

function applyWidth(rawWidth: number): void {
	const width = effectiveWidth(rawWidth);
	const next = sizeClassForWithHysteresis(current, width, tablet);
	if (next === current) {
		return;
	}
	current = next;
	for (const listener of [...listeners]) {
		listener();
	}
}

// 幅変更の一元的な受け口。Split View 分割線ドラッグ中は高頻度で発火するが、
// 中身は「閾値を跨いだか」の比較だけなので安い。
Dimensions.addEventListener('change', event => {
	applyWidth(event.window.width);
});

/** 現在のsize class。Split View/Slide Overの幅変更や回転にも追従し、**ヒステリシス付き**
 * （700pt前後の往復ドラッグでは regular を維持する。sizeClass.ts の解除閾値参照）。 */
export function useSizeClass(): SizeClass {
	return useSyncExternalStore(subscribe, () => current);
}

/** サイドバー常設の2カラム表示中かどうか（`useSizeClass() === 'regular'` の読みやすい別名）。 */
export function useIsRegularWidth(): boolean {
	return useSizeClass() === 'regular';
}
