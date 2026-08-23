// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { sizeClassFor } from '../sizeClass.js';
import { buildHomeHeaderActions, useHomeHeaderActions } from './homeHeaderActions.js';
import { homeHeaderLayout } from './homeHeaderMenuBehavior.js';

vi.mock('./homePlusMenu.js', () => ({ HomePlusMenuButton: 'HomePlusMenuButton' }));
vi.mock('./voiceNotificationControl.js', () => ({ VoiceNotificationControl: 'VoiceNotificationControl' }));
vi.mock('./notificationsSheet.js', () => ({ NotificationsButton: 'NotificationsButton' }));

const onArchive = vi.fn();
const onSelect = vi.fn();
const notifications: [] = [];

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
		notificationQuestionCount: 3,
		ackCount: 1,
		hasSpace: true,
		notifications,
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

	test('keeps the header spec stable across unrelated rerenders and refreshes it only for layout changes', () => {
		const rendered: unknown[] = [];
		function HeaderActionsProbe({ regular }: { regular: boolean; unrelated: number }) {
			const actions = useHomeHeaderActions({
				header: homeHeaderLayout(regular ? 'regular' : 'compact'),
				archivedCount: 2,
				voiceActive: true,
				notificationQuestionCount: 3,
				ackCount: 1,
				hasSpace: true,
				notifications,
				onArchive,
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
