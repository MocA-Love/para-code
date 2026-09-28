// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

// ネイティブ部品の無いビルドを再現する（requireOptionalNativeModule が null を返す）。
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));

import { isClipboardAvailable, readClipboardText, writeClipboardText, type NativeClipboardModule } from './nativeClipboard.js';

/** 本物のネイティブ関数と同じく、options を省くと失敗するモジュール。 */
function strictClipboard(content: string): NativeClipboardModule & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		calls,
		getStringAsync(...args: unknown[]) {
			calls.push(['get', ...args]);
			return args.length < 1 ? Promise.reject(new Error('Received 0 arguments, but 1 was expected')) : Promise.resolve(content);
		},
		setStringAsync(...args: unknown[]) {
			calls.push(['set', ...args]);
			return args.length < 2 ? Promise.reject(new Error('Received 1 arguments, but 2 was expected')) : Promise.resolve(true);
		},
	} as NativeClipboardModule & { calls: unknown[][] };
}

describe('nativeClipboard', () => {
	it('passes the options argument the native functions require', async () => {
		const module = strictClipboard('ls -la');
		expect([await readClipboardText(module), await writeClipboardText('echo hi', module), module.calls])
			.toEqual(['ls -la', true, [['get', {}], ['set', 'echo hi', {}]]]);
	});

	it('returns empty / false when reading or writing fails', async () => {
		const failing: NativeClipboardModule = {
			getStringAsync: () => Promise.reject(new Error('denied')),
			setStringAsync: () => Promise.reject(new Error('denied')),
		};
		expect([await readClipboardText(failing), await writeClipboardText('x', failing)]).toEqual(['', false]);
	});

	it('does nothing on a build without the native module', async () => {
		expect([isClipboardAvailable(), await readClipboardText(), await writeClipboardText('x')]).toEqual([false, '', false]);
	});
});
