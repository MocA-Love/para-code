// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RouteHref } from '../../routes.js';

/**
 * `src/routes.ts` の `routes.settings(page)` に無い、設定の下の深いページ（段階6で足したもの）。
 * `src/routes.ts` は段階6の担当範囲の外なので、ここに置いている（親へ「routes.ts へ移したい」と依頼済み）。
 *
 * | ルート | 画面 |
 * |---|---|
 * | `/settings/session-view` | セッションの開き方（チャット UI かターミナルか） |
 * | `/settings/quick-replies` | 会話画面のクイック返信（入力欄の上のチップ） |
 * | `/settings/colors` | 色（主ボタン・自分の発言と送信・選択の印とリンクの色） |
 * | `/settings/widgets` | ホーム画面・ロック画面のウィジェットの見た目と表示項目 |
 * | `/settings/usage/cost` | コスト（日別・モデル別） |
 * | `/settings/usage/rtk` | RTK の節約 |
 * | `/settings/usage/github` | GitHub API |
 * | `/settings/usage/system` | システム（CPU・メモリ・ディスクの内訳） |
 * | `/settings/connection-log` | 接続の記録と簡単な診断（W2-22） |
 */
export type UsageDetailPage = 'cost' | 'rtk' | 'github' | 'system';

export const settingsRoutes = {
	sessionView: (): RouteHref => '/settings/session-view',
	quickReplies: (): RouteHref => '/settings/quick-replies',
	colors: (): RouteHref => '/settings/colors',
	widgets: (): RouteHref => '/settings/widgets',
	usageDetail: (page: UsageDetailPage): RouteHref => `/settings/usage/${page}`,
	connectionLog: (): RouteHref => '/settings/connection-log',
} as const;
