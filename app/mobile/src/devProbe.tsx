// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useAppStore } from './appState.js';

/**
 * 開発ビルド専用: いま開いている画面をデバッガ（Metro の CDP）から読めるようにする。
 *
 * - 画面が変わるたびに `[para-dev] route ...` を console に出す
 * - `globalThis.__paraDev` に現在のパスと router とストアを置く（デバッガから `router.push()` で画面を移し、
 *   `store.getState()` で実在する PC・スペースの ID を読める）
 *
 * `__DEV__` のときだけ描画する（リリースビルドには何も残らない）。
 */
export function DevProbe() {
	const pathname = usePathname();
	const params = useGlobalSearchParams();
	const router = useRouter();
	// params はレンダーのたびに別オブジェクトになるので、中身の文字列で変化を判定する。
	const paramsKey = JSON.stringify(params);
	useEffect(() => {
		(globalThis as { __paraDev?: unknown }).__paraDev = { pathname, params: JSON.parse(paramsKey) as unknown, router, store: useAppStore, at: Date.now() };
		console.log(`[para-dev] route ${pathname} ${paramsKey}`);
	}, [pathname, paramsKey, router]);
	return null;
}
