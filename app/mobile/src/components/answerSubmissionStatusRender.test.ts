// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { createElement, type ElementType, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AnswerSubmissionState } from './answerSubmission.js';
import { AnswerSubmissionStatus } from './answerSubmissionStatus.js';
import { SubmissionStatus } from '../features/session/submissionStatus.js';

// 部品の .tsx は React を import しない（JSX の変換が React を参照する）。
vi.stubGlobal('React', React);
vi.mock('react-native', () => ({
	ActivityIndicator: 'ActivityIndicator', Text: 'Text', View: 'View',
	StyleSheet: { create: <T>(styles: T): T => styles },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('lucide-react-native', () => ({ CircleAlert: 'CircleAlert', CircleCheck: 'CircleCheck', RotateCw: 'RotateCw' }));
vi.mock('./button.js', () => ({ Button: 'Button' }));
vi.mock('../ui/index.js', () => ({ Button: 'Button', Icon: 'Icon', iconSize: { md: 16 } }));
vi.mock('../ui/chatTextScale.js', () => ({ useChatStyles: <T>(styles: T): T => styles, useChatIconSize: (size: number): number => size }));
vi.mock('../haptics.js', () => ({ haptic: vi.fn() }));
vi.mock('../theme.js', () => ({
	HIT_SIZE: 44,
	colors: { text: 'text', textDim: 'textDim', yellow: 'yellow', amber: 'amber' },
	space: { sm: 8 },
	type: { body: 15, meta: 13 },
}));

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

interface StatusProps {
	state: AnswerSubmissionState;
	onRetry: () => void;
	onReselect: () => void;
}

interface Rendered {
	readonly texts: string[];
	readonly buttons: ReactTestInstance[];
	readonly icons: { name: unknown; color: unknown }[];
}

function render(component: (props: StatusProps) => ReactNode, props: StatusProps): Rendered {
	let renderer: ReactTestRenderer | undefined;
	act(() => {
		renderer = create(createElement(component, props));
	});
	const root = renderer!.root;
	return {
		texts: root.findAllByType('Text' as ElementType).map(node => String(node.props.children)),
		buttons: root.findAllByType('Button' as ElementType),
		icons: [
			...root.findAllByType('Ionicons' as ElementType).map(node => ({ name: node.props.name, color: node.props.color })),
			...root.findAllByType('Icon' as ElementType).map(node => ({ name: node.props.icon, color: node.props.color })),
		],
	};
}

const TITLE = 'PC でまだ反映されていません';
const HINT = 'PC は回答を受け付けています。PC の画面で確認し、回答が入っていなければ選び直してください。';

describe.each([
	['the legacy card status', AnswerSubmissionStatus, { name: 'alert-circle-outline', color: 'yellow' }],
	['the session card status', SubmissionStatus, { name: 'CircleAlert', color: 'amber' }],
] as const)('%s for an accepted answer that is still on the card', (_name, component, icon) => {
	test('shows the title, the hint and one button that only chooses again', () => {
		const onRetry = vi.fn();
		const onReselect = vi.fn();
		const stale = render(component, { state: { phase: 'acceptedStale' }, onRetry, onReselect });
		act(() => stale.buttons[0]?.props.onPress());
		expect({
			texts: stale.texts,
			icons: stale.icons,
			buttons: stale.buttons.map(button => [button.props.label, button.props.variant]),
			reselect: onReselect.mock.calls.length,
			retry: onRetry.mock.calls.length,
		}).toEqual({ texts: [TITLE, HINT], icons: [icon], buttons: [['選び直す', 'secondary']], reselect: 1, retry: 0 });
	});

	test('keeps the earlier states as they were: no button right after the PC accepted, two buttons when the PC did not answer', () => {
		const noop = (): void => { };
		const accepted = render(component, { state: { phase: 'acceptedNoResponse' }, onRetry: noop, onReselect: noop });
		const noResponse = render(component, { state: { phase: 'noResponse' }, onRetry: noop, onReselect: noop });
		expect({
			accepted: [accepted.texts, accepted.buttons.length],
			noResponse: [noResponse.texts[0], noResponse.buttons.map(button => button.props.label)],
		}).toEqual({
			accepted: [['PC は受け付けました', 'PC の画面で確認してください。'], 0],
			noResponse: ['PC から応答がありません', ['選び直す', '再送']],
		});
	});
});
