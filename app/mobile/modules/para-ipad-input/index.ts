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
	addListener(eventName: 'onKeyCommand', listener: (event: { id: string }) => void): { remove(): void };
	addListener(eventName: 'onWindowControlsInset', listener: (event: WindowControlsInset) => void): { remove(): void };
	startWindowControlsObserver?(): void;
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
