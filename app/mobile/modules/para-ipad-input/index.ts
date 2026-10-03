// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ComponentType, ReactNode } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

/** ネイティブへ渡すショートカット1つぶん（`ios/ParaIpadInputModule.swift` の `ParaKeyCommandSpec`）。 */
export interface KeyCommandSpec {
	readonly id: string;
	/** 1文字、または `Enter` / `Escape` / `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight`。 */
	readonly input: string;
	readonly modifiers: readonly ('command' | 'alternate' | 'shift' | 'control')[];
	/** ⌘ を長押ししたときの一覧に出す名前。 */
	readonly title: string;
	/** 入力欄の標準の動きより先に効かせるか（`UIKeyCommand.wantsPriorityOverSystemBehavior`）。 */
	readonly priority: boolean;
}

interface NativeModuleShape {
	setKeyCommands(specs: readonly KeyCommandSpec[]): void;
	dismissPresentedAlerts?(): void;
	addListener(eventName: 'onKeyCommand', listener: (event: { id: string }) => void): { remove(): void };
	addListener(eventName: 'onWindowControlsInset', listener: (event: WindowControlsInset) => void): { remove(): void };
	addListener(eventName: 'onDeviceOrientation', listener: (event: { orientation: DeviceOrientation }) => void): { remove(): void };
	startWindowControlsObserver?(): void;
	setLandscapeAllowed?(allowed: boolean): void;
	setDeviceOrientationObserved?(observed: boolean): void;
	devDescribeWindowControls?(): unknown;
	devRequestOrientation?(landscape: boolean): void;
	devDescribeKeyCommands?(): unknown;
	devFireKeyCommand?(id: string): boolean;
}

/**
 * 古いバイナリ（このモジュールを含まないビルド）で JS だけ更新された場合に備え、見つからなければ
 * 何もしない（ショートカットとホバーが効かないだけ）。
 */
const native = Platform.OS === 'ios' ? requireOptionalNativeModule<NativeModuleShape>('ParaIpadInput') : null;

/** いま効かせるショートカットを差し替える（渡さなかったものは外れる）。 */
export function setKeyCommands(specs: readonly KeyCommandSpec[]): void {
	native?.setKeyCommands(specs);
}

/**
 * 出ている Alert（UIAlertController）をネイティブで閉じる（アプリのロック時。`src/paraAlert.ts`）。
 * 閉じる関数がある（このモジュールを含み、関数を足した後のバイナリ）なら true。無ければ何もせず false。
 */
export function dismissPresentedAlerts(): boolean {
	if (native?.dismissPresentedAlerts === undefined) {
		return false;
	}
	native.dismissPresentedAlerts();
	return true;
}

/** ショートカットが押されたときに呼ばれる。戻り値で購読をやめる。 */
export function onKeyCommand(listener: (id: string) => void): () => void {
	const subscription = native?.addListener('onKeyCommand', event => listener(event.id));
	return () => subscription?.remove();
}

/**
 * iPadOS のウィンドウ操作ボタン（ウィンドウアプリのときに左上へ出る3点）を避けるために、素のセーフエリアへ
 * 上乗せする余白（pt）。全画面・iPhone では 0。
 */
export interface WindowControlsInset {
	/** 画面の上端の帯（見出し）の先頭に足す幅。 */
	readonly leading: number;
}

/**
 * ウィンドウ操作ボタンを避ける余白を見張る。値はいま1回と、変わるたびに届く。戻り値で購読をやめる。
 * モジュールの無い古いバイナリでは何も届かない（呼び出し側は 0 のまま）。
 */
export function observeWindowControlsInset(listener: (inset: WindowControlsInset) => void): () => void {
	if (native?.startWindowControlsObserver === undefined) {
		return () => {};
	}
	const subscription = native.addListener('onWindowControlsInset', listener);
	native.startWindowControlsObserver();
	return () => subscription.remove();
}

/** 端末の向き。`other` は表を上・下に向けたもの・分からないもの。 */
export type DeviceOrientation = 'portrait' | 'landscape' | 'other';

/**
 * iPhone で横向きを許すか（ブラウザの全画面の間だけ許す）。許すと、端末が横ならすぐ横へ回る。許さなくすると
 * 縦へ戻す。iPad では何もしない（前から全方向）。モジュールの無い古いバイナリでは何もしない（縦のまま）。
 */
export function setLandscapeAllowed(allowed: boolean): void {
	native?.setLandscapeAllowed?.(allowed);
}

/** このビルドが横向きの切り替えを持っているか（無い古いバイナリでは、横に倒して全画面に入るのをやめる）。 */
export function supportsLandscapeGate(): boolean {
	return native?.setLandscapeAllowed !== undefined;
}

/**
 * 端末の向きを見張る（画面が縦に固定されている間も届く）。いま 1 回と、変わるたびに届く。戻り値で購読をやめる。
 * 見張りは 1 か所からだけ使う前提（最後に止めた側が見張りを止める）。
 */
export function observeDeviceOrientation(listener: (orientation: DeviceOrientation) => void): () => void {
	if (native?.setDeviceOrientationObserved === undefined) {
		return () => {};
	}
	const subscription = native.addListener('onDeviceOrientation', event => listener(event.orientation));
	native.setDeviceOrientationObserved(true);
	return () => {
		subscription.remove();
		native.setDeviceOrientationObserved?.(false);
	};
}

/** 開発ビルド専用: ルートの view の各レイアウト領域の生の余白（1回目で測らせ、2回目の呼び出しで読める）。 */
export function devDescribeWindowControls(): unknown {
	return __DEV__ ? native?.devDescribeWindowControls?.() : undefined;
}

/** 開発ビルド専用: シミュレータの向きを変える（リリースのネイティブ側では何もしない）。 */
export function devRequestOrientation(landscape: boolean): void {
	if (__DEV__) {
		native?.devRequestOrientation?.(landscape);
	}
}

/** 開発ビルド専用: 登録したショートカットと、いまのファーストレスポンダ。 */
export function devDescribeKeyCommands(): unknown {
	return __DEV__ ? native?.devDescribeKeyCommands?.() : undefined;
}

/** 開発ビルド専用: 登録したショートカットを、押されたときと同じくレスポンダチェーン経由で送る。 */
export function devFireKeyCommand(id: string): boolean {
	return __DEV__ ? native?.devFireKeyCommand?.(id) ?? false : false;
}

export interface PointerHoverProps {
	/** `highlight`: 小さいボタン（ポインタがボタンの形になる）。`tint`: 行（薄い色を重ねるだけ）。 */
	effect: 'highlight' | 'tint';
	cornerRadius?: number;
	style?: StyleProp<ViewStyle>;
	children?: ReactNode;
}

/** ポインタの効果を付けるネイティブの入れ物。モジュールが無いビルドでは undefined（呼び出し側は素の View を使う）。 */
export const NativePointerHover: ComponentType<PointerHoverProps> | undefined = (() => {
	if (native === null) {
		return undefined;
	}
	try {
		return requireNativeView<PointerHoverProps>('ParaIpadInput');
	} catch {
		return undefined;
	}
})();
