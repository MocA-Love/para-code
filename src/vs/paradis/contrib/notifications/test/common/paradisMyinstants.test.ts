/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisCheckMyinstantsUrl,
	paradisIsMp3ContentType,
	paradisLooksLikeMp3,
	paradisMyinstantsDisplayName,
} from '../../common/paradisMyinstants.js';

suite('Paradis Myinstants import checks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only https mp3 links under /media/sounds/ on the two Myinstants hosts', () => {
		const inputs = [
			'https://www.myinstants.com/media/sounds/fahhh_KcgAXfs.mp3',
			'  https://myinstants.com/media/sounds/fahhh_KcgAXfs.mp3  ',
			'https://WWW.MYINSTANTS.COM/media/sounds/Loud.MP3',
			'https://www.myinstants.com:443/media/sounds/default-port.mp3',
			'https://www.myinstants.com/media/sounds/%E9%80%9A%E7%9F%A5.mp3',
		];
		assert.deepStrictEqual(inputs.map(paradisCheckMyinstantsUrl), [
			{ kind: 'mp3', url: 'https://www.myinstants.com/media/sounds/fahhh_KcgAXfs.mp3', fileName: 'fahhh_KcgAXfs.mp3' },
			{ kind: 'mp3', url: 'https://myinstants.com/media/sounds/fahhh_KcgAXfs.mp3', fileName: 'fahhh_KcgAXfs.mp3' },
			{ kind: 'mp3', url: 'https://www.myinstants.com/media/sounds/Loud.MP3', fileName: 'Loud.mp3' },
			{ kind: 'mp3', url: 'https://www.myinstants.com/media/sounds/default-port.mp3', fileName: 'default-port.mp3' },
			// allow-any-unicode-next-line
			{ kind: 'mp3', url: 'https://www.myinstants.com/media/sounds/%E9%80%9A%E7%9F%A5.mp3', fileName: '通知.mp3' },
		]);
	});

	test('rejects other schemes, hosts, ports, credentials, queries, fragments and paths', () => {
		const inputs = [
			'http://www.myinstants.com/media/sounds/a.mp3',
			'https://evil.example/media/sounds/a.mp3',
			'https://www.myinstants.com.evil.example/media/sounds/a.mp3',
			'https://cdn.myinstants.com/media/sounds/a.mp3',
			'https://www.myinstants.com:8443/media/sounds/a.mp3',
			'https://user:pass@www.myinstants.com/media/sounds/a.mp3',
			'https://user@www.myinstants.com/media/sounds/a.mp3',
			'https://www.myinstants.com/media/sounds/a.mp3?x=1',
			'https://www.myinstants.com/media/sounds/a.mp3?',
			'https://www.myinstants.com/media/sounds/a.mp3#t',
			'https://www.myinstants.com/media/sounds/sub/a.mp3',
			'https://www.myinstants.com/media/sounds/a.wav',
			'https://www.myinstants.com/media/a.mp3',
			'https://www.myinstants.com/media/sounds/.mp3',
			'https://www.myinstants.com/media/sounds/..%2Fsecret.mp3',
			'https://www.myinstants.com/media/sounds/a%5Cb.mp3',
			'https://www.myinstants.com/media/sounds/%00.mp3',
			'https://www.myinstants.com/media/sounds/%E0%A4%A.mp3',
			'https://www.myinstants.com/media/sounds/../../etc/a.mp3',
			'ftp://www.myinstants.com/media/sounds/a.mp3',
			'not a url',
		];
		assert.deepStrictEqual(inputs.map(input => paradisCheckMyinstantsUrl(input).kind), inputs.map(() => 'invalid'));
	});

	test('detects sound pages so the dialog can explain how to copy the mp3 link', () => {
		const inputs = [
			'https://www.myinstants.com/en/instant/fahhh-42300/',
			'https://www.myinstants.com/ja/instant/fahhh-42300/',
			'https://www.myinstants.com/instant/fahhh-42300',
			'http://myinstants.com/pt-br/instant/fahhh-42300/?utm=x',
			'',
			'   ',
		];
		assert.deepStrictEqual(inputs.map(input => paradisCheckMyinstantsUrl(input).kind), ['page', 'page', 'page', 'page', 'empty', 'empty']);
	});

	test('accepts mp3 content types only', () => {
		const inputs = ['audio/mpeg', 'Audio/MPEG; charset=binary', 'audio/mp3', 'audio/x-mpeg-3', 'text/html; charset=utf-8', 'application/octet-stream', 'audio/ogg', '', null, undefined];
		assert.deepStrictEqual(inputs.map(paradisIsMp3ContentType), [true, true, true, true, false, false, false, false, false, false]);
	});

	test('recognizes ID3 tags and MPEG layer III frame headers', () => {
		const samples: Uint8Array[] = [
			Uint8Array.of(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00), // ID3v2.3
			Uint8Array.of(0xff, 0xfb, 0x90, 0x64), // MPEG-1 Layer III, 128kbps, 44.1kHz
			Uint8Array.of(0xff, 0xf3, 0x48, 0xc4), // MPEG-2 Layer III
			Uint8Array.of(0x49, 0x44, 0x33, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00), // unknown ID3 version
			Uint8Array.of(0x49, 0x44, 0x33), // truncated ID3
			Uint8Array.of(0xff, 0xf1, 0x50, 0x80), // AAC ADTS (layer bits 00)
			Uint8Array.of(0xff, 0xfd, 0x90, 0x64), // MPEG-1 Layer II
			Uint8Array.of(0xff, 0xfb, 0xf0, 0x64), // bad bitrate index
			Uint8Array.of(0xff, 0xfb, 0x9c, 0x64), // reserved sample rate
			Uint8Array.of(0xff, 0xeb, 0x90, 0x64), // reserved MPEG version
			new TextEncoder().encode('<!DOCTYPE html>'),
			Uint8Array.of(0x4f, 0x67, 0x67, 0x53), // OggS
			new Uint8Array(0),
		];
		assert.deepStrictEqual(samples.map(paradisLooksLikeMp3), [true, true, true, false, false, false, false, false, false, false, false, false, false]);
	});

	test('derives a readable display name from the mp3 file name', () => {
		const inputs = ['fahhh_KcgAXfs.mp3', 'vine-boom.mp3', 'among_us_role_reveal_8fq3Bz1.mp3', 'short_ab.mp3', '_KcgAXfs.mp3', `${'x'.repeat(100)}.mp3`];
		assert.deepStrictEqual(inputs.map(paradisMyinstantsDisplayName), ['Fahhh', 'Vine boom', 'Among us role reveal', 'Short ab', '_KcgAXfs', 'X'.concat('x'.repeat(79))]);
	});
});
