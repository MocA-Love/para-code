// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { AppLinkMetrics } from './linkMetrics.js';

/**
 * アプリ全体で 1 つの通信の計測（`linkMetrics.ts`）。既定はオフ。ネイティブの再生の数の読み方は、音声の部品を
 * 読み込む `appState.ts` が差し込む（このファイルはネイティブの部品を読まないので、テストからも読み込める）。
 */
export const appLinkMetrics = new AppLinkMetrics({
	now: () => performance.now(),
	wallClock: () => Date.now(),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
});
