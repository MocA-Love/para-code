// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { attachmentFileName, attachmentMediaTypeOfBase64, attachmentNameOf, composeAttachmentMessage, parseAttachmentMessage } from './attachmentText.js';

const MAC = '/Users/example/Library/Application Support/Para Code/User/paraMobileUploads';
const A = `${MAC}/attachment-1759500000000-abc123.jpg`;
const B = `${MAC}/attachment-1759500000001-k3x9q2.png`;
const WIN = 'C:\\Users\\example\\AppData\\Roaming\\Para Code\\User\\paraMobileUploads\\attachment-1759500000002-w1n.jpeg';
const REMOTE = '/home/example/.para-code-server/data/User/paraMobileUploads/attachment-1759500000003-r3m';

describe('parseAttachmentMessage', () => {
	test('先頭にまとめたパス（今の送り方）は札にして、改行の後の本文だけを残す', () => {
		expect(parseAttachmentMessage(`${A} ${B}\nこの画面のボタンを直して`)).toEqual({
			attachments: [
				{ name: 'attachment-1759500000000-abc123.jpg', path: A },
				{ name: 'attachment-1759500000001-k3x9q2.png', path: B },
			],
			body: 'この画面のボタンを直して',
		});
	});

	test('以前の送り方（パスの後ろに空白と改行、本文の後ろへ足したパス）・Windows・接続先のパスも拾う', () => {
		expect([
			parseAttachmentMessage(`${A} \n本文`),
			parseAttachmentMessage(`これを見て ${A} `),
			parseAttachmentMessage(`${WIN}\n見て`),
			parseAttachmentMessage(`${REMOTE}`),
		].map(result => [result.attachments.map(attachment => attachment.name), result.body])).toEqual([
			[['attachment-1759500000000-abc123.jpg'], '本文'],
			[['attachment-1759500000000-abc123.jpg'], 'これを見て'],
			[['attachment-1759500000002-w1n.jpeg'], '見て'],
			[['attachment-1759500000003-r3m'], ''],
		]);
	});

	test('Claude 2.1.207 の [Image #1] と画像の印、Codex の包みと本文中の番号も外す', () => {
		expect(parseAttachmentMessage(`[Image #1]${A} \n本文\n[image]`)).toEqual({
			attachments: [{ name: 'attachment-1759500000000-abc123.jpg', path: A }],
			body: '本文',
		});
		expect(parseAttachmentMessage(`<image name=[Image #1] path="${B}">\n[image]\n</image>\n[Image #1] の色を直して`)).toEqual({
			attachments: [{ name: 'attachment-1759500000001-k3x9q2.png', path: B }],
			body: 'の色を直して',
		});
	});

	test('置き場の外・名前の形が違う・相対のパスは添付と見なさず、本文をそのまま返す', () => {
		const texts = [
			'/Users/example/Desktop/attachment-1759500000000-abc123.jpg を見て',
			`${MAC}/attachment-1759500000000-abc123.jpg.bak`,
			`${MAC}/secret.png`,
			'paraMobileUploads/attachment-1759500000000-abc123.jpg',
			'/tmp/paraMobileUploads/attachment-1759500000000-abc123.jpg',
			'/Users/example/MyUser/paraMobileUploads/attachment-1759500000000-abc123.jpg',
			'C:\\Temp\\paraMobileUploads\\attachment-1759500000000-abc123.jpg',
			'ふつうの発言',
		];
		expect(texts.map(text => parseAttachmentMessage(text))).toEqual(texts.map(body => ({ attachments: [], body })));
	});

	test('同じ画像は 1 枚にまとめ、本文の中の改行と字下げはそのまま', () => {
		expect(parseAttachmentMessage(`${A} ${A}\n  1行目\n\n  2行目`)).toEqual({
			attachments: [{ name: 'attachment-1759500000000-abc123.jpg', path: A }],
			body: '1行目\n\n  2行目',
		});
	});
});

describe('添付の文字の組み立てと名前', () => {
	test('送る文字は「パスを空白で並べて改行、本文」。回答は 1 行', () => {
		expect([
			composeAttachmentMessage([A, B], '本文'),
			composeAttachmentMessage([A], '  '),
			composeAttachmentMessage([], '本文だけ'),
			composeAttachmentMessage([A], '回答', true),
		]).toEqual([`${A} ${B}\n本文`, A, '本文だけ', `${A} 回答`]);
	});

	test('組み立てた文字を読み直すと、同じ添付と本文に戻る', () => {
		const parsed = parseAttachmentMessage(composeAttachmentMessage([A, B, WIN], 'お願い'));
		expect([parsed.attachments.map(attachment => attachment.path), parsed.body]).toEqual([[A, B, WIN], 'お願い']);
	});

	test('パスから名前、名前から端末のファイル名、base64 から種類', () => {
		expect({
			names: [attachmentNameOf(A), attachmentNameOf(WIN), attachmentNameOf('/tmp/attachment-1759500000000-abc123.jpg'), attachmentNameOf('/tmp/paraMobileUploads/attachment-1759500000000-abc123.jpg')],
			files: [attachmentFileName('attachment-1759500000000-abc123.jpg'), attachmentFileName('attachment-1759500000003-r3m'), attachmentFileName('attachment-1759500000003-r3m', 'image/png')],
			types: [attachmentMediaTypeOfBase64('/9j/4AAQ'), attachmentMediaTypeOfBase64('iVBORw0KGgoAAA'), attachmentMediaTypeOfBase64('AAAA')],
		}).toEqual({
			names: ['attachment-1759500000000-abc123.jpg', 'attachment-1759500000002-w1n.jpeg', undefined, undefined],
			files: ['attachment-1759500000000-abc123.jpg', 'attachment-1759500000003-r3m.jpg', 'attachment-1759500000003-r3m.png'],
			types: ['image/jpeg', 'image/png', undefined],
		});
	});
});
