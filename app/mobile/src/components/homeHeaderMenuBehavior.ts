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

/**
 * ホームのヘッダー右の並べ方。
 *
 * iPhone（compact）は「ベル（要対応の件数付き）」と「`…` メニュー」の2つを直接置く。
 * 新規作成（エージェントの起動）は画面右下の＋（{@link buildHomeCreateMenuItems}）が持つので、
 * `…` には入れない。iPad（regular）はこれまでどおりアーカイブ・音声・通知・＋を並べる。
 */
export type HomeHeaderLayout =
	| { readonly kind: 'compact-menu'; readonly headerItemCount: 2; readonly itemWidth: 44 }
	| { readonly kind: 'regular-actions' };

export interface HomeHeaderMenuOptions {
	readonly compact: boolean;
	readonly archivedCount: number;
	readonly voiceActive: boolean;
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
		? { kind: 'compact-menu', headerItemCount: 2, itemWidth: 44 }
		: { kind: 'regular-actions' };
}

const WORKTREE_ITEM: HomeHeaderMenuItem = { id: 'new-worktree', title: 'ワークツリーを作成', fallbackTitle: 'ワークツリーを作成', systemImage: 'arrow.triangle.branch', fallbackIcon: 'git-branch-outline' };
const SPACE_NOTE_ITEM: HomeHeaderMenuItem = { id: 'space-note', title: 'メモ', fallbackTitle: 'メモ', systemImage: 'doc.text', fallbackIcon: 'document-text-outline' };

/**
 * ヘッダーのメニュー（iPhone は `…`、iPad は＋）の項目。
 *
 * iPhone の `…` には、ヘッダーに直接置いたベル（通知）と、画面右下の＋に移したエージェントの
 * 起動は入れない。ワークツリーの作成とメモは右下の＋にもあるが、`…` からも届くように残す。
 */
export function buildHomeHeaderMenuItems(options: HomeHeaderMenuOptions): HomeHeaderMenuItem[] {
	const items: HomeHeaderMenuItem[] = [];
	if (options.compact) {
		if (options.archivedCount > 0) {
			items.push({ id: 'archive', title: `アーカイブ（${options.archivedCount}件）`, fallbackTitle: `アーカイブ ${options.archivedCount}件を見る`, systemImage: 'archivebox', fallbackIcon: 'file-tray-full-outline' });
		}
		items.push(
			{ id: 'voice-notifications', title: options.voiceActive ? '音声通知（受信中）' : '音声通知', fallbackTitle: options.voiceActive ? '音声通知（受信中）' : '音声通知', systemImage: options.voiceActive ? 'speaker.wave.2.fill' : 'speaker.wave.2', fallbackIcon: options.voiceActive ? 'volume-high' : 'volume-high-outline' },
		);
	} else {
		items.push({
			id: 'agent',
			title: 'エージェントを起動',
			fallbackTitle: 'エージェントを起動',
			systemImage: 'sparkles',
			fallbackIcon: 'sparkles-outline',
			children: AGENT_CHILDREN,
		});
	}
	items.push({ ...WORKTREE_ITEM, startsSection: true });
	if (options.hasSpace) {
		items.push(SPACE_NOTE_ITEM);
	}
	items.push({ id: 'sort', title: '並び替え', fallbackTitle: '並び替え', systemImage: 'arrow.up.arrow.down', fallbackIcon: 'swap-vertical-outline', startsSection: true });
	if (options.ackCount > 0) {
		items.push({ id: 'ack-all', title: 'すべて確認済みにする', fallbackTitle: 'すべて確認済みにする', systemImage: 'checkmark.circle', fallbackIcon: 'checkmark-done-outline' });
	}
	return items;
}

/**
 * 画面右下の＋（新規作成）のメニュー。iPad のヘッダーの＋にある「エージェントを起動」の
 * 入れ子（Claude / Codex / ターミナル）を1段目に平らに出し、その下にワークツリーとメモを置く。
 * 右下から開くメニューは入れ子を辿るほど指の移動が長くなるので、ここは入れ子にしない。
 */
export function buildHomeCreateMenuItems(options: { readonly hasSpace: boolean }): HomeHeaderMenuItem[] {
	const items: HomeHeaderMenuItem[] = AGENT_CHILDREN.map(child => ({ ...child, title: child.fallbackTitle }));
	items.push({ ...WORKTREE_ITEM, startsSection: true });
	if (options.hasSpace) {
		items.push(SPACE_NOTE_ITEM);
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
