// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { useMemo } from 'react';
import type { NotifyPayload } from '@para/protocol';
import { type ParaHeaderIcon } from '../paraHeader.js';
import { NotificationsButton } from './notificationsSheet.js';
import { VoiceNotificationControl } from './voiceNotificationControl.js';
import { HomePlusMenuButton } from './homePlusMenu.js';
import type { HomeHeaderLayout, HomeHeaderMenuAction } from './homeHeaderMenuBehavior.js';

export interface HomeHeaderActionsOptions {
	readonly header: HomeHeaderLayout;
	readonly archivedCount: number;
	readonly voiceActive: boolean;
	readonly notificationQuestionCount: number;
	readonly ackCount: number;
	readonly hasSpace: boolean;
	readonly notifications: readonly NotifyPayload[];
	readonly onArchive: () => void;
	readonly onSelect: (action: HomeHeaderMenuAction) => void;
}

export function buildHomeHeaderActions(options: HomeHeaderActionsOptions): ParaHeaderIcon[] {
	if (options.header.kind === 'compact-menu') {
		return [{
			key: 'home-overflow',
			label: 'ホーム操作',
			node: (
				<HomePlusMenuButton
					compact
					archivedCount={options.archivedCount}
					voiceActive={options.voiceActive}
					notificationQuestionCount={options.notificationQuestionCount}
					ackCount={options.ackCount}
					hasSpace={options.hasSpace}
					onSelect={options.onSelect}
				/>
			),
		}];
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
		options.notificationQuestionCount,
		options.notifications,
		options.onArchive,
		options.onSelect,
		options.voiceActive,
	]);
}
