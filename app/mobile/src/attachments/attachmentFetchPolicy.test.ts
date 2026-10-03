// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { PcReplyError, PcUnreachableError, isPcUnreachableError } from '../store.js';
import { attachmentImagesDuplicate, attachmentImagesMatch, base64ByteLength, classifyAttachmentFailure, finalAttachmentFailure, shouldRetryWithoutWorkspace } from './attachmentFetchPolicy.js';

describe('attachmentFetchPolicy', () => {
	test('失敗の見分け: code に従い、code の無い失敗は store が「つながっていない」の型で返したときだけ offline、それ以外は not-here', () => {
		expect([
			classifyAttachmentFailure('missing', false),
			classifyAttachmentFailure('no-thumbnail', false),
			classifyAttachmentFailure('other', false),
			classifyAttachmentFailure('remote-unavailable', true),
			classifyAttachmentFailure(undefined, true),
			classifyAttachmentFailure(undefined, false),
		]).toEqual(['missing', 'no-thumbnail', 'other', 'other', 'offline', 'not-here']);
	});

	test('store の「つながっていない」失敗は型で見分ける（文が同じでもふつうの Error は違う）', () => {
		expect([
			isPcUnreachableError(new PcUnreachableError('request timeout')),
			isPcUnreachableError(new Error('request timeout')),
			isPcUnreachableError(new PcReplyError('This image is no longer on the PC.', 'missing')),
			isPcUnreachableError('PCへ再接続してから操作してください'),
		]).toEqual([true, false, false, false]);
	});

	test('スペースを付けて頼んだ missing・not-here だけ、付けずに頼み直す。スペースを決められずに missing なら not-here', () => {
		expect({
			retry: [
				shouldRetryWithoutWorkspace('missing', true),
				shouldRetryWithoutWorkspace('not-here', true),
				shouldRetryWithoutWorkspace('offline', true),
				shouldRetryWithoutWorkspace('missing', false),
			],
			final: [finalAttachmentFailure('missing', false), finalAttachmentFailure('missing', true), finalAttachmentFailure('offline', false)],
		}).toEqual({ retry: [true, true, false, false], final: ['not-here', 'missing', 'offline'] });
	});

	test('下の画像のカードは枚数の一致で隠し、札の中身に当てるのは大きさまで一致したときだけ', () => {
		const images = [{ bytes: 1000 }, { bytes: 2000 }];
		expect({
			duplicate: [attachmentImagesDuplicate(2, 2), attachmentImagesDuplicate(1, 2), attachmentImagesDuplicate(0, 0)],
			matched: [
				attachmentImagesMatch([1000, 2001], images),
				attachmentImagesMatch([1000, undefined], images),
				attachmentImagesMatch([1000, 2500], images),
				attachmentImagesMatch([1000], images),
				attachmentImagesMatch([], []),
			],
		}).toEqual({ duplicate: [true, false, false], matched: [true, false, false, false, false] });
	});

	test('base64 の中身のバイト数', () => {
		expect([base64ByteLength('QUJD'), base64ByteLength('QUI='), base64ByteLength('QQ==')]).toEqual([3, 2, 1]);
	});
});
