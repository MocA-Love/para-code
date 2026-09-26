// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { redirectLegacyLink } from '../src/features/links/legacyLinks.js';

/**
 * OS から開かれたリンク（Live Activity・通知以外のディープリンク）を、画面を探す前に書き換える
 * （expo-router の `+native-intent`）。作り直し前のルート（以前の版の Live Activity の `paracode-mobile:///agent` など）を
 * いまのルートへ寄せる。ホーム画面・ロック画面のウィジェットと Live Activity のリンク（`paracode-mobile:///widget/…`。
 * Live Activity は表示していたセッションを直接開く）もここで書き換える。対応表は
 * `src/features/links/legacyLinks.ts` と `src/features/links/widgetLinks.ts`。
 *
 * ここで例外を出すとアプリが落ちるので、書き換えに失敗したら元のまま開く。
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
	try {
		return redirectLegacyLink(path) ?? path;
	} catch {
		return path;
	}
}
