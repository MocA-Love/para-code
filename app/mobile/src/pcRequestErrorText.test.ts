// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test, vi } from 'vitest';
import { PcReplyError, PcUnreachableError } from './store.js';
import { pcRequestErrorText } from './pcRequestErrorText.js';

// 無応答の判定（usageAggregate）が使用量の画面のフックを引き込むので、React Native を読まないよう差し替える。
vi.mock('./hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));

describe('pcRequestErrorText', () => {
	test('時間切れとスペースが無いことだけを日本語に言い換える', () => {
		expect([
			new PcUnreachableError('request timeout'),
			new PcReplyError('timed out', 'no-response'),
			new Error('workspace not found'),
			new PcUnreachableError('PC画面の再接続が完了してから操作してください'),
			new PcReplyError('scm unavailable', undefined),
			'not an error',
		].map(error => pcRequestErrorText(error, '原因が分かりませんでした'))).toEqual([
			'PC から返事がありませんでした。PC の Para Code が開いているか確かめてください',
			'PC から返事がありませんでした。PC の Para Code が開いているか確かめてください',
			'PC で開いているスペースが見つかりませんでした。PC で Para Code のウィンドウを開いてください',
			'PC画面の再接続が完了してから操作してください',
			'scm unavailable',
			'原因が分かりませんでした',
		]);
	});
});
