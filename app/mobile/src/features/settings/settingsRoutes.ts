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
 * | `/settings/usage?source=…` | 使用量の、1つの出どころ（PC・SSH の接続先）だけの表示 |
 * | `/settings/usage/cost` | コスト（日別・モデル別） |
 * | `/settings/usage/rtk` | RTK の節約 |
 * | `/settings/usage/github` | GitHub API |
 * | `/settings/usage/system` | システム（CPU・メモリ・ディスクの内訳） |
 * | `/settings/usage/voice` | 読み上げ（Aivis・ElevenLabs の使用量。通知と音声の「読み上げの使用量」からも開く） |
 * | `/settings/connection-log` | 接続の記録と簡単な診断（W2-22） |
 */
export type UsageDetailPage = 'cost' | 'rtk' | 'github' | 'system' | 'voice';

export const settingsRoutes = {
	sessionView: (): RouteHref => '/settings/session-view',
	quickReplies: (): RouteHref => '/settings/quick-replies',
	colors: (): RouteHref => '/settings/colors',
	widgets: (): RouteHref => '/settings/widgets',
	/**
	 * 使用量の詳しい画面。`source` を渡すとその出どころ（PC・SSH の接続先）だけの値、渡さなければ
	 * PC が2台以上なら全 PC の合計（PC が1台なら見ている PC の値）。
	 */
	usageDetail: (page: UsageDetailPage, source?: string): RouteHref => (source !== undefined
		? { pathname: `/settings/usage/${page}`, params: { source } }
		: `/settings/usage/${page}`),
	/** 使用量の、1つの出どころ（PC・SSH の接続先）だけの表示（全 PC の合計の「PC ごと」の行から）。 */
	usageSource: (source: string): RouteHref => ({ pathname: '/settings/usage', params: { source } }),
	connectionLog: (): RouteHref => '/settings/connection-log',
} as const;
