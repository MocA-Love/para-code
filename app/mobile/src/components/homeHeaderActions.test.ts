// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { NotifyPayload } from '@para/protocol';
import { sizeClassFor } from '../sizeClass.js';
import { buildHomeHeaderActions, useHomeHeaderActions } from './homeHeaderActions.js';
import { homeHeaderLayout } from './homeHeaderMenuBehavior.js';

vi.mock('./homePlusMenu.js', () => ({ HomePlusMenuButton: 'HomePlusMenuButton' }));
vi.mock('./voiceNotificationControl.js', () => ({ VoiceNotificationControl: 'VoiceNotificationControl' }));
vi.mock('./notificationsSheet.js', () => ({ NotificationsButton: 'NotificationsButton', HomeBellButton: 'HomeBellButton' }));

const onArchive = vi.fn();
const onNotifications = vi.fn();
const onSelect = vi.fn();
const notifications: [] = [];
/** 通知履歴: 質問2件（未読）と完了1件。ベルの数は質問の2件になる。 */
const notice = (id: string, kind: NotifyPayload['kind']): NotifyPayload => ({ id, kind, title: 'スペース', body: '', at: 0 });
const historyWithQuestions: NotifyPayload[] = [notice('n1', 'agent-question'), notice('n2', 'agent-question'), notice('n3', 'agent-done')];

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function build(width: number, tablet: boolean, archivedCount = 2) {
	return buildHomeHeaderActions({
		header: homeHeaderLayout(sizeClassFor(width, tablet)),
		archivedCount,
		voiceActive: true,
		ackCount: 1,
		hasSpace: true,
		notifications: historyWithQuestions,
		onArchive,
		onNotifications,
		onSelect,
	});
}

describe('production home header action builder', () => {
	test.each([390, 375, 320])('registers the bell with the unread question notification count and one overflow action at %ipt', width => {
		const actions = build(width, false);
		expect(actions.map(action => action.key)).toEqual(['bell', 'home-overflow']);
		const bell = actions[0]!.node as ReactElement<{ count: number; onPress: () => void }>;
		expect(bell.type).toBe('HomeBellButton');
		// 押した先（通知履歴）に残っている質問の数。要対応エージェントの数ではない。
		expect(bell.props).toMatchObject({ count: 2, onPress: onNotifications });
		expect(actions[1]).toMatchObject({ key: 'home-overflow', label: 'ホーム操作' });
		const node = actions[1]!.node as ReactElement<{
			compact: boolean;
			archivedCount: number;
			voiceActive: boolean;
		}>;
		expect(node.type).toBe('HomePlusMenuButton');
		expect(node.props).toMatchObject({
			compact: true,
			archivedCount: 2,
			voiceActive: true,
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

	test('keeps the header spec stable across unrelated rerenders and refreshes it only for layout changes', () => {
		const rendered: unknown[] = [];
		function HeaderActionsProbe({ regular }: { regular: boolean; unrelated: number }) {
			const actions = useHomeHeaderActions({
				header: homeHeaderLayout(regular ? 'regular' : 'compact'),
				archivedCount: 2,
				voiceActive: true,
				ackCount: 1,
				hasSpace: true,
				notifications,
				onArchive,
				onNotifications,
				onSelect,
			});
			rendered.push(actions);
			return null;
		}

		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(HeaderActionsProbe, { regular: false, unrelated: 0 }));
		});
		act(() => {
			renderer!.update(createElement(HeaderActionsProbe, { regular: false, unrelated: 1 }));
		});
		expect(rendered[1]).toBe(rendered[0]);

		act(() => {
			renderer!.update(createElement(HeaderActionsProbe, { regular: true, unrelated: 2 }));
		});
		expect(rendered[2]).not.toBe(rendered[1]);

		act(() => {
			renderer!.update(createElement(HeaderActionsProbe, { regular: true, unrelated: 3 }));
		});
		expect(rendered[3]).toBe(rendered[2]);
		act(() => renderer!.unmount());
	});
});
