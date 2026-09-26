// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { useMemo } from 'react';
import type { NotifyPayload } from '@para/protocol';
import { type ParaHeaderIcon } from '../paraHeader.js';
import { HomeBellButton, NotificationsButton } from './notificationsSheet.js';
import { VoiceNotificationControl } from './voiceNotificationControl.js';
import { HomePlusMenuButton } from './homePlusMenu.js';
import type { HomeHeaderLayout, HomeHeaderMenuAction } from './homeHeaderMenuBehavior.js';
import { unreadQuestionNotificationCount } from './notificationCount.js';

export interface HomeHeaderActionsOptions {
	readonly header: HomeHeaderLayout;
	readonly archivedCount: number;
	readonly voiceActive: boolean;
	readonly ackCount: number;
	readonly hasSpace: boolean;
	readonly notifications: readonly NotifyPayload[];
	readonly onArchive: () => void;
	readonly onNotifications: () => void;
	readonly onSelect: (action: HomeHeaderMenuAction) => void;
}

/**
 * ホームのヘッダー右のボタン。
 *
 * iPhone は「ベル（未読の質問通知の件数付き）」と「`…`」の2つ。通知はメニューの奥ではなく
 * ヘッダーに直接出す。ベルの数は押した先（通知履歴）の中身に合わせる（`notificationCount.ts`）。
 * 要対応のエージェント数はタブのバッジとホームの「要対応」の見出しが示す。新規作成は画面右下の＋が持つ。
 * iPad はこれまでどおりアーカイブ・音声・通知・＋を並べる（並びを変えない）。
 */
export function buildHomeHeaderActions(options: HomeHeaderActionsOptions): ParaHeaderIcon[] {
	if (options.header.kind === 'compact-menu') {
		return [
			{
				key: 'bell',
				label: '通知',
				node: <HomeBellButton count={unreadQuestionNotificationCount(options.notifications)} onPress={options.onNotifications} />,
			},
			{
				key: 'home-overflow',
				label: 'ホーム操作',
				node: (
					<HomePlusMenuButton
						compact
						archivedCount={options.archivedCount}
						voiceActive={options.voiceActive}
						ackCount={options.ackCount}
						hasSpace={options.hasSpace}
						onSelect={options.onSelect}
					/>
				),
			},
		];
	}
	return [
		...(options.archivedCount > 0 ? [{ key: 'archive', icon: 'file-tray-full-outline' as const, label: `アーカイブ ${options.archivedCount}件を見る`, onPress: options.onArchive }] : []),
		{ key: 'voice', label: '音声通知', node: <VoiceNotificationControl /> },
		{ key: 'notifications', label: '通知', node: <NotificationsButton notifications={options.notifications} /> },
		{ key: 'plus', label: '作成と表示のメニュー', node: <HomePlusMenuButton ackCount={options.ackCount} hasSpace={options.hasSpace} onSelect={options.onSelect} /> },
	];
}

export function useHomeHeaderActions(options: HomeHeaderActionsOptions): ParaHeaderIcon[] {
	return useMemo(() => buildHomeHeaderActions(options), [
		options.ackCount,
		options.archivedCount,
		options.hasSpace,
		options.header.kind,
		options.notifications,
		options.onArchive,
		options.onNotifications,
		options.onSelect,
		options.voiceActive,
	]);
}
