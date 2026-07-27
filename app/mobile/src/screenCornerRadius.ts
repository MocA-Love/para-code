// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * 端末のディスプレイ角丸半径（pt）。ドロワーを開いたときにコンテンツへ付ける角丸に使う。
 *
 * 実体は `expo-screen-corner-radius`。iOSではプライベートAPI（UIScreenの
 * `_displayCornerRadius`）を使わず、`uname()`のハードウェアモデル識別子と
 * ルックアップテーブルから求めるためApp Storeの審査を通せる。Androidは12(API 31)以降のみ
 * 値が取れ、それ未満やテーブルに無い機種では0/nullが返る。
 *
 * パッケージのJSラッパー（`requireNativeModule`）はimport時点でネイティブモジュールを
 * 解決するため、pod install前のJSリロードなどで例外になる。モジュール名を直接
 * `requireOptionalNativeModule`で引くことで、ネイティブ側が無い環境でも落とさず
 * フォールバック値で動かす（`modules/para-live-activity` と同じ流儀）。
 */
interface ScreenCornerRadiusModule {
	getCornerRadiusSync(): number | null;
}

/**
 * テーブルに無い新機種やネイティブ未リンク時にiOSで使う値。iPhone 14 Pro〜16世代の55pt
 * （16 Pro以降と17系は62pt、それ以前は39〜53.33pt）。開いた状態では画面内に比較対象の
 * 角が無いため、多少ずれても見た目の破綻にはならない。
 */
const IOS_FALLBACK_RADIUS = 55;

function resolveScreenCornerRadius(): number {
	try {
		const native = requireOptionalNativeModule<ScreenCornerRadiusModule>('ExpoScreenCornerRadius');
		const radius = native?.getCornerRadiusSync();
		if (typeof radius === 'number' && radius > 0) {
			return radius;
		}
	} catch (err) {
		console.warn('[screenCornerRadius] failed to read native corner radius', err);
	}
	// Androidの角丸なし端末（API 31未満を含む）では0のままにする。iOSは必ず丸いのでフォールバックする。
	return Platform.OS === 'ios' ? IOS_FALLBACK_RADIUS : 0;
}

/** 端末のディスプレイ角丸半径（pt）。取得できない場合はiOSで55、Androidで0。 */
export const screenCornerRadius = resolveScreenCornerRadius();
