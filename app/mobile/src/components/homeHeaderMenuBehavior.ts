// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { SizeClass } from '../sizeClass.js';

export type HomePlusMenuAction =
	| 'launch-claude'
	| 'launch-codex'
	| 'new-terminal'
	| 'new-worktree'
	| 'space-note'
	| 'sort'
	| 'ack-all';

export type HomeHeaderMenuAction = HomePlusMenuAction | 'archive' | 'voice-notifications' | 'notifications';

export interface HomeHeaderMenuItem {
	readonly id: HomeHeaderMenuAction | 'agent';
	readonly title: string;
	readonly fallbackTitle: string;
	readonly systemImage: string;
	readonly fallbackIcon: string;
	readonly startsSection?: boolean;
	readonly children?: readonly HomeHeaderMenuItem[];
}

export type HomeHeaderLayout =
	| { readonly kind: 'compact-menu'; readonly headerItemCount: 1; readonly itemWidth: 44 }
	| { readonly kind: 'regular-actions' };

export interface HomeHeaderMenuOptions {
	readonly compact: boolean;
	readonly archivedCount: number;
	readonly voiceActive: boolean;
	readonly notificationQuestionCount: number;
	readonly ackCount: number;
	readonly hasSpace: boolean;
}

export interface HomeHeaderMenuHandlers {
	readonly onArchive: () => void;
	readonly onVoiceNotifications: () => void;
	readonly onNotifications: () => void;
	readonly onPlusMenuSelect: (action: HomePlusMenuAction) => void;
}

const AGENT_CHILDREN: readonly HomeHeaderMenuItem[] = [
	{ id: 'launch-claude', title: 'Claude', fallbackTitle: 'Claude を起動', systemImage: 'sparkles', fallbackIcon: 'sparkles-outline' },
	{ id: 'launch-codex', title: 'Codex', fallbackTitle: 'Codex を起動', systemImage: 'chevron.left.forwardslash.chevron.right', fallbackIcon: 'code-slash-outline' },
	{ id: 'new-terminal', title: 'ターミナル', fallbackTitle: 'ターミナルを起動', systemImage: 'terminal', fallbackIcon: 'terminal-outline' },
];

export function homeHeaderLayout(sizeClass: SizeClass): HomeHeaderLayout {
	return sizeClass === 'compact'
		? { kind: 'compact-menu', headerItemCount: 1, itemWidth: 44 }
		: { kind: 'regular-actions' };
}

export function buildHomeHeaderMenuItems(options: HomeHeaderMenuOptions): HomeHeaderMenuItem[] {
	const items: HomeHeaderMenuItem[] = [];
	if (options.compact) {
		if (options.archivedCount > 0) {
			items.push({ id: 'archive', title: `アーカイブ（${options.archivedCount}件）`, fallbackTitle: `アーカイブ ${options.archivedCount}件を見る`, systemImage: 'archivebox', fallbackIcon: 'file-tray-full-outline' });
		}
		items.push(
			{ id: 'voice-notifications', title: options.voiceActive ? '音声通知（受信中）' : '音声通知', fallbackTitle: '音声通知', systemImage: options.voiceActive ? 'speaker.wave.2.fill' : 'speaker.wave.2', fallbackIcon: options.voiceActive ? 'volume-high' : 'volume-high-outline' },
			{ id: 'notifications', title: options.notificationQuestionCount > 0 ? `通知（応答待ち ${options.notificationQuestionCount}件）` : '通知', fallbackTitle: '通知', systemImage: 'bell', fallbackIcon: 'notifications-outline' },
		);
	}
	items.push({
		id: 'agent',
		title: 'エージェントを起動',
		fallbackTitle: 'エージェントを起動',
		systemImage: 'sparkles',
		fallbackIcon: 'sparkles-outline',
		startsSection: options.compact,
		children: AGENT_CHILDREN,
	});
	items.push({ id: 'new-worktree', title: 'ワークツリーを作成', fallbackTitle: 'ワークツリーを作成', systemImage: 'arrow.triangle.branch', fallbackIcon: 'git-branch-outline', startsSection: true });
	if (options.hasSpace) {
		items.push({ id: 'space-note', title: 'メモ', fallbackTitle: 'メモ', systemImage: 'doc.text', fallbackIcon: 'document-text-outline' });
	}
	items.push({ id: 'sort', title: '並び替えと絞り込み', fallbackTitle: '並び替えと絞り込み', systemImage: 'arrow.up.arrow.down', fallbackIcon: 'swap-vertical-outline', startsSection: true });
	if (options.ackCount > 0) {
		items.push({ id: 'ack-all', title: 'すべて確認済みにする', fallbackTitle: 'すべて確認済みにする', systemImage: 'checkmark.circle', fallbackIcon: 'checkmark-done-outline' });
	}
	return items;
}

export function dispatchHomeHeaderMenuAction(action: HomeHeaderMenuAction, handlers: HomeHeaderMenuHandlers): void {
	if (action === 'archive') {
		handlers.onArchive();
	} else if (action === 'voice-notifications') {
		handlers.onVoiceNotifications();
	} else if (action === 'notifications') {
		handlers.onNotifications();
	} else {
		handlers.onPlusMenuSelect(action);
	}
}
