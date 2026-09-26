// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { extractPairingUri, formatSasCode, isPairingCancelled, pairingErrorMessage, pairingUriFromLinkParam } from './pairingInput.js';

describe('extractPairingUri', () => {
	it('リンクだけならそのまま返す', () => {
		expect(extractPairingUri('paracode-mobile://pair?d=eyJ2IjoxfQ')).toBe('paracode-mobile://pair?d=eyJ2IjoxfQ');
	});

	it('前後の空白・改行・説明の文章を落とす', () => {
		expect(extractPairingUri('  このリンクを開いてください\nparacode-mobile://pair?d=abc_DEF-123 \n')).toBe('paracode-mobile://pair?d=abc_DEF-123');
		expect(extractPairingUri('<paracode-mobile://pair?d=abc>')).toBe('paracode-mobile://pair?d=abc');
	});

	it('リンクが無ければ undefined', () => {
		expect(extractPairingUri('')).toBeUndefined();
		expect(extractPairingUri('https://example.com/pair?d=abc')).toBeUndefined();
		expect(extractPairingUri('paracode-mobile://pair?d=')).toBeUndefined();
	});
});

describe('pairingUriFromLinkParam', () => {
	it('ディープリンクの d からリンクを組み直す', () => {
		expect(pairingUriFromLinkParam('abc')).toBe('paracode-mobile://pair?d=abc');
		expect(pairingUriFromLinkParam(['abc', 'def'])).toBe('paracode-mobile://pair?d=abc');
	});

	it('d が無い・空なら undefined', () => {
		expect(pairingUriFromLinkParam(undefined)).toBeUndefined();
		expect(pairingUriFromLinkParam('')).toBeUndefined();
		expect(pairingUriFromLinkParam('  ')).toBeUndefined();
	});
});

describe('formatSasCode', () => {
	it('6桁は3桁ずつ区切る', () => {
		expect(formatSasCode('123456')).toBe('123 456');
	});

	it('6桁でなければそのまま', () => {
		expect(formatSasCode('12345')).toBe('12345');
		expect(formatSasCode('abcdef')).toBe('abcdef');
	});
});

describe('pairingErrorMessage', () => {
	it('リンクの形が違うときは、PC の QR を使うよう伝える', () => {
		expect(pairingErrorMessage(new Error('not a Para Code pairing URI'))).toContain('ペアリング用のコードではありません');
		expect(pairingErrorMessage(new Error('malformed pairing payload: deviceId'))).toContain('ペアリング用のコードではありません');
	});

	it('承認待ちの時間切れは、出し直しを促す', () => {
		expect(pairingErrorMessage(new Error('pairing approval timeout'))).toContain('出し直して');
	});

	it('知らない失敗は元の文言を添える', () => {
		expect(pairingErrorMessage(new Error('relay says no'))).toBe('ペアリングできませんでした（relay says no）');
		expect(pairingErrorMessage('boom')).toBe('ペアリングできませんでした（boom）');
	});
});

describe('isPairingCancelled', () => {
	it('中断だけを見分ける', () => {
		expect(isPairingCancelled(new Error('pairing cancelled'))).toBe(true);
		expect(isPairingCancelled(new Error('pairing approval timeout'))).toBe(false);
		expect(isPairingCancelled('pairing cancelled')).toBe(false);
	});
});
