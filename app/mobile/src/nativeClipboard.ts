// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * クリップボードの読み書き（ネイティブの ExpoClipboard を直接呼ぶ）。
 *
 * expo-clipboard の JS は読み込んだ時点で `requireNativeModule()` を呼ぶため、ネイティブ側に
 * 入っていないアプリでは import しただけで落ちる。ここでは optional に引き、無ければ何もしない。
 *
 * **ネイティブの関数は options の引数を省略できない。** expo-clipboard の JS は
 * `getStringAsync(options = {})` / `setStringAsync(text, options = {})` と既定値を埋めてから
 * ネイティブへ渡すが、ネイティブを直接呼ぶここでは自分で渡す必要がある（iOS の ClipboardModule.swift は
 * `getStringAsync(options: GetStringOptions)` / `setStringAsync(content:, options: SetStringOptions)`）。
 * 以前は省いていて「Received 0 arguments, but 1 was expected」で失敗し、ターミナルの貼付が
 * 常に空振りしていた。
 */
export interface NativeClipboardModule {
	getStringAsync(options: object): Promise<string>;
	setStringAsync(text: string, options: object): Promise<boolean>;
}

let cachedModule: NativeClipboardModule | null | undefined;

function nativeClipboard(): NativeClipboardModule | undefined {
	if (cachedModule === undefined) {
		try {
			cachedModule = requireOptionalNativeModule<NativeClipboardModule>('ExpoClipboard');
		} catch {
			cachedModule = null;
		}
	}
	return cachedModule ?? undefined;
}

/** このビルドでクリップボードが使えるか（使えなければコピーのボタンを出さない）。 */
export function isClipboardAvailable(): boolean {
	return nativeClipboard() !== undefined;
}

/** クリップボードの文字列。使えない・読めないときは空文字。 */
export async function readClipboardText(module: NativeClipboardModule | undefined = nativeClipboard()): Promise<string> {
	if (module === undefined) {
		return '';
	}
	try {
		const text = await module.getStringAsync({});
		return typeof text === 'string' ? text : '';
	} catch {
		return '';
	}
}

/** クリップボードへ書く。書けたら true。 */
export async function writeClipboardText(text: string, module: NativeClipboardModule | undefined = nativeClipboard()): Promise<boolean> {
	if (module === undefined) {
		return false;
	}
	try {
		return await module.setStringAsync(text, {});
	} catch {
		return false;
	}
}
