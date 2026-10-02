// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RouteHref } from '../../routes.js';

/**
 * ソース管理・ファイル・メモを iPad のセッションの右のドックに置いたときの約束（ルートとして開いたときは渡さない）。
 *  - 見出しの左は戻るではなく閉じる（`close`）
 *  - 差分やファイルへ進むときは、ドックを閉じてから詳細の列で押し進める（`navigate`）。戻ってきたら、セッションの画面が
 *    同じドックを開き直す（ファイルの一覧の状態は `fileTreeStore.ts` に退避してあるので、開いていたフォルダや位置も戻る）
 */
export interface PanelDock {
	close(): void;
	navigate(href: RouteHref): void;
}
