// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * 写真アプリへの保存（ネイティブの ExpoMediaLibrary を直接呼ぶ。`expo-media-library` の legacy の
 * `requestPermissionsAsync(writeOnly)` / `saveToLibraryAsync(localUri)` と同じ関数）。
 *
 * `nativeClipboard.ts` と同じく optional に引く。ネイティブ部品（pod）が入る前のバイナリでも import で落ちず、
 * そのときは「写真に保存」のボタンを出さない（共有シートの「画像を保存」は使える）。
 *
 * 保存には Info.plist の `NSPhotoLibraryAddUsageDescription` が要る（無いとネイティブが例外を投げる）。
 */
interface NativeMediaLibraryModule {
	requestPermissionsAsync(writeOnly: boolean): Promise<{ readonly granted?: boolean; readonly status?: string }>;
	saveToLibraryAsync(localUri: string): Promise<void>;
}

let cachedModule: NativeMediaLibraryModule | null | undefined;

function nativeMediaLibrary(): NativeMediaLibraryModule | undefined {
	if (cachedModule === undefined) {
		try {
			cachedModule = requireOptionalNativeModule<NativeMediaLibraryModule>('ExpoMediaLibrary');
		} catch {
			cachedModule = null;
		}
	}
	return cachedModule ?? undefined;
}

/** このビルドで写真アプリへ保存できるか（できなければボタンを出さない）。 */
export function isPhotoLibrarySaveAvailable(): boolean {
	return nativeMediaLibrary() !== undefined;
}

export type PhotoSaveResult = 'saved' | 'denied' | 'unavailable';

/**
 * 端末のファイル（`file://…`。拡張子が要る）を写真アプリへ保存する。初回だけ追加の許可を求める。
 * 保存に失敗したら例外。
 */
export async function saveImageToPhotos(fileUri: string): Promise<PhotoSaveResult> {
	const module = nativeMediaLibrary();
	if (module === undefined) {
		return 'unavailable';
	}
	const permission = await module.requestPermissionsAsync(true);
	if (permission.granted !== true && permission.status !== 'granted') {
		return 'denied';
	}
	await module.saveToLibraryAsync(fileUri);
	return 'saved';
}
