// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AlertButton } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { createParaAlert, type AlertLockSource, type NativeAlert } from './paraAlertCore.js';

interface Shown {
	readonly title: string;
	readonly buttons: AlertButton[];
}

function setup(options: { locked?: boolean; canDismiss?: boolean } = {}) {
	let locked = options.locked ?? false;
	const listeners = new Set<(locked: boolean) => void>();
	const lock: AlertLockSource = {
		isLocked: () => locked,
		onChange: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const shown: Shown[] = [];
	const native: NativeAlert = {
		alert: (title, _message, buttons) => { shown.push({ title, buttons: buttons ?? [] }); },
		prompt: (title, _message, callbackOrButtons) => { shown.push({ title, buttons: Array.isArray(callbackOrButtons) ? callbackOrButtons : [] }); },
	};
	const dismissed = { count: 0 };
	const alert = createParaAlert(native, lock, options.canDismiss === false ? () => false : () => { dismissed.count++; return true; });
	const setLocked = (next: boolean) => {
		locked = next;
		listeners.forEach(listener => listener(next));
	};
	const press = (index: number, label: string, value?: string) => {
		const button = shown[index]?.buttons.find(candidate => candidate.text === label);
		(button?.onPress as ((value?: string) => void) | undefined)?.(value);
	};
	return { alert, shown, dismissed, setLocked, press };
}

describe('paraAlert', () => {
	it('holds alerts requested while locked until unlocking', () => {
		const t = setup({ locked: true });
		t.alert.alert('later');
		const whileLocked = t.shown.length;
		t.setLocked(false);
		expect({ whileLocked, titles: t.shown.map(item => item.title), buttons: t.shown[0]?.buttons.map(button => button.text) })
			.toEqual({ whileLocked: 0, titles: ['later'], buttons: ['OK'] });
	});

	it('dismisses open alerts on lock and shows them again after unlocking', () => {
		const t = setup();
		const onPress = vi.fn();
		t.alert.alert('confirm', undefined, [{ text: 'Delete', onPress }]);
		t.setLocked(true);
		// 入れ違いで届いた押下は捨てる（出し直しを待っている）。
		t.press(0, 'Delete');
		t.setLocked(false);
		t.press(1, 'Delete');
		expect({ dismissed: t.dismissed.count, titles: t.shown.map(item => item.title), pressed: onPress.mock.calls.length }).toEqual({ dismissed: 1, titles: ['confirm', 'confirm'], pressed: 1 });
	});

	it('ignores a press while locked when the alert could not be dismissed, and asks again after unlocking', () => {
		const t = setup({ canDismiss: false });
		const onPress = vi.fn();
		t.alert.alert('confirm', undefined, [{ text: 'Delete', onPress }]);
		t.setLocked(true);
		t.press(0, 'Delete');
		const pressedWhileLocked = onPress.mock.calls.length;
		t.setLocked(false);
		t.press(1, 'Delete');
		expect({ pressedWhileLocked, shown: t.shown.length, pressed: onPress.mock.calls.length }).toEqual({ pressedWhileLocked: 0, shown: 2, pressed: 1 });
	});

	it('passes the entered text through a prompt callback and adds a cancel button', () => {
		const t = setup();
		const onSubmit = vi.fn();
		t.alert.prompt('name', undefined, onSubmit);
		t.press(0, 'OK', 'new name');
		expect({ buttons: t.shown[0]?.buttons.map(button => button.text), submitted: onSubmit.mock.calls }).toEqual({ buttons: ['Cancel', 'OK'], submitted: [['new name']] });
	});

	it('does not show a closed alert again', () => {
		const t = setup();
		t.alert.alert('info');
		t.press(0, 'OK');
		t.setLocked(true);
		t.setLocked(false);
		expect({ dismissed: t.dismissed.count, shown: t.shown.length }).toEqual({ dismissed: 0, shown: 1 });
	});
});
