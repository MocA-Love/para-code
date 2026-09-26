// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { NotifyPayload } from '@para/protocol';

/**
 * 通知履歴に残っている質問の通知（未読）の件数。ベルに重ねる数はこれにする。
 *
 * ベルを押すと開くのは通知履歴なので、数もその中身に合わせる。要対応のエージェント数
 * （`attentionCount.ts`）を重ねると、押した先に同じ数の項目が無く食い違って見える。
 * 要対応の数はタブのバッジとホームの「要対応」の見出しが持つ。
 * 通知は既読にすると一覧から消えるので、残っている件数がそのまま未読の件数になる。
 */
export function unreadQuestionNotificationCount(notifications: readonly NotifyPayload[]): number {
	return notifications.filter(notification => notification.kind === 'agent-question').length;
}
