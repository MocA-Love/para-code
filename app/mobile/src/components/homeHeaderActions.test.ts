// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { type ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { sizeClassFor } from '../sizeClass.js';
import { buildHomeHeaderActions } from './homeHeaderActions.js';
import { homeHeaderLayout } from './homeHeaderMenuBehavior.js';

vi.mock('./homePlusMenu.js', () => ({ HomePlusMenuButton: 'HomePlusMenuButton' }));
vi.mock('./voiceNotificationControl.js', () => ({ VoiceNotificationControl: 'VoiceNotificationControl' }));
vi.mock('./notificationsSheet.js', () => ({ NotificationsButton: 'NotificationsButton' }));

const onArchive = vi.fn();
const onSelect = vi.fn();

function build(width: number, tablet: boolean, archivedCount = 2) {
	return buildHomeHeaderActions({
		header: homeHeaderLayout(sizeClassFor(width, tablet)),
		archivedCount,
		voiceActive: true,
		notificationQuestionCount: 3,
		ackCount: 1,
		hasSpace: true,
		notifications: [],
		onArchive,
		onSelect,
	});
}

describe('production home header action builder', () => {
	test.each([390, 375, 320])('registers exactly one 44pt overflow action at %ipt', width => {
		const actions = build(width, false);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ key: 'home-overflow', label: 'ホーム操作' });
		const node = actions[0]!.node as ReactElement<{
			compact: boolean;
			archivedCount: number;
			voiceActive: boolean;
			notificationQuestionCount: number;
		}>;
		expect(node.type).toBe('HomePlusMenuButton');
		expect(node.props).toMatchObject({
			compact: true,
			archivedCount: 2,
			voiceActive: true,
			notificationQuestionCount: 3,
		});
	});

	test('keeps archive, voice, notifications, and plus as separate regular-width actions', () => {
		const actions = build(744, true);
		expect(actions.map(action => action.key)).toEqual(['archive', 'voice', 'notifications', 'plus']);
		expect(actions.map(action => action.node === undefined ? undefined : (action.node as ReactElement).type)).toEqual([undefined, 'VoiceNotificationControl', 'NotificationsButton', 'HomePlusMenuButton']);
	});

	test('keeps regular-width archive conditional without collapsing the other actions', () => {
		const actions = build(744, true, 0);
		expect(actions.map(action => action.key)).toEqual(['voice', 'notifications', 'plus']);
	});
});
