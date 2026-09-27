// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RouteHref } from '../../routes.js';

/**
 * ソース管理・ファイル・メモを iPad のセッションの右のドックに置いたときの約束（ルートとして開いたときは渡さない）。
 *  - 見出しの左は戻るではなく閉じる（`close`）
 *  - 差分やファイルへ進むときは、ドックを閉じてから詳細の列で押し進める（`navigate`）
 */
export interface PanelDock {
	close(): void;
	navigate(href: RouteHref): void;
}
