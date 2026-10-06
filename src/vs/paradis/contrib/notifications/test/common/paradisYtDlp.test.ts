/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisAssessYtDlpVersion,
	paradisClassifyYtDlpError,
	paradisDetectYtDlpInstallMethod,
	paradisExtractYtDlpWarnings,
	paradisParseYtDlpVersion,
	paradisYtDlpUpdatePlan,
} from '../../common/paradisYtDlp.js';

suite('Paradis yt-dlp checks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses stable, nightly and Homebrew-style version output', () => {
		const inputs = ['2026.06.09\n', '2026.08.19.233211', '  2026.6.9  ', 'yt-dlp 2026.06.09', '2026.13.01', 'unknown', ''];
		assert.deepStrictEqual(inputs.map(paradisParseYtDlpVersion), [
			{ raw: '2026.06.09', year: 2026, month: 6, day: 9 },
			{ raw: '2026.08.19.233211', year: 2026, month: 8, day: 19 },
			{ raw: '2026.6.9', year: 2026, month: 6, day: 9 },
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('treats every version before 2026.08.19 as broken and flags versions older than 90 days', () => {
		const now = Date.UTC(2026, 9, 6); // 2026-10-06
		const versions = ['2026.07.04', '2026.08.18', '2026.06.09', '2025.12.01', '2026.08.19', '2026.09.30'];
		assert.deepStrictEqual(versions.map(raw => paradisAssessYtDlpVersion(paradisParseYtDlpVersion(raw)!, now)), [
			{ status: 'broken', ageDays: 94 },
			{ status: 'broken', ageDays: 49 },
			{ status: 'broken', ageDays: 119 },
			{ status: 'broken', ageDays: 309 },
			{ status: 'ok', ageDays: 48 },
			{ status: 'ok', ageDays: 6 },
		]);
		const later = Date.UTC(2027, 2, 1); // 2027-03-01
		assert.deepStrictEqual(paradisAssessYtDlpVersion(paradisParseYtDlpVersion('2026.08.19')!, later), { status: 'outdated', ageDays: 194 });
	});

	test('detects how yt-dlp was installed and picks the matching update command', () => {
		// Start of a Mach-O binary, as read with latin1.
		const machO = String.fromCharCode(0xcf, 0xfa, 0xed, 0xfe);
		const zipHead = `#!/usr/bin/env python3\nPK${String.fromCharCode(3, 4)}`;
		const cases: [string, string][] = [
			// Homebrew's yt-dlp is also a script importing yt_dlp, so Cellar is checked first
			['/opt/homebrew/Cellar/yt-dlp/2026.6.9/libexec/bin/yt-dlp', '#!/opt/homebrew/opt/python@3.14/bin/python3.14\nfrom yt_dlp import main'],
			['/home/linuxbrew/.linuxbrew/Cellar/yt-dlp/2026.6.9/bin/yt-dlp', ''],
			['/Users/example/.local/pipx/venvs/yt-dlp/bin/yt-dlp', '#!/usr/bin/python3\nfrom yt_dlp import main'],
			['/Users/example/.local/share/uv/tools/yt-dlp/bin/yt-dlp', '#!/usr/bin/python3\nfrom yt_dlp import main'],
			['/Users/example/.local/bin/yt-dlp', '#!/usr/bin/python3\n# -*- coding: utf-8 -*-\nimport re\nimport sys\nfrom yt_dlp import main'],
			// pip into Homebrew's Python (a homebrew path outside Cellar) is still pip
			['/opt/homebrew/bin/yt-dlp', '#!/opt/homebrew/opt/python@3.14/bin/python3.14\nimport sys\nfrom yt_dlp import main'],
			['/opt/homebrew/bin/yt-dlp', machO],
			['/usr/local/bin/yt-dlp', zipHead],
			['/usr/local/bin/yt-dlp_macos', machO],
			['/usr/local/bin/youtube-dl-wrapper', '#!/bin/sh'],
		];
		const methods = cases.map(([path, head]) => paradisDetectYtDlpInstallMethod(path, head));
		assert.deepStrictEqual(methods.map(method => [method, paradisYtDlpUpdatePlan(method)]), [
			['homebrew', { command: 'brew upgrade yt-dlp', runnable: true }],
			['homebrew', { command: 'brew upgrade yt-dlp', runnable: true }],
			['pipx', { command: 'pipx upgrade yt-dlp', runnable: true }],
			['uvTool', { command: 'uv tool upgrade yt-dlp', runnable: true }],
			['pip', { command: 'pip install -U "yt-dlp[default]"', runnable: false }],
			['pip', { command: 'pip install -U "yt-dlp[default]"', runnable: false }],
			['homebrew', { command: 'brew upgrade yt-dlp', runnable: true }],
			['standalone', { command: 'yt-dlp -U', runnable: true }],
			['standalone', { command: 'yt-dlp -U', runnable: true }],
			['unknown', { command: '', runnable: false }],
		]);
	});

	test('classifies failures without mistaking HTTP 403 for a private video', () => {
		const rightQuote = String.fromCharCode(0x2019);
		const inputs = [
			'ERROR: unable to download video data: HTTP Error 403: Forbidden',
			'ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video',
			'ERROR: [youtube] abc: Private video\nERROR: unable to download video data: HTTP Error 403: Forbidden',
			`ERROR: [youtube] abc: Sign in to confirm you${rightQuote}re not a bot. Use --cookies-from-browser`,
			'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.',
			'ERROR: [youtube] abc: Join this channel to get access to members-only content like this video',
			'ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader',
			'ERROR: [youtube] abc: This live event will begin in 3 hours.',
			'ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats',
			'ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>',
			'ERROR: something new happened',
		];
		assert.deepStrictEqual(inputs.map(input => paradisClassifyYtDlpError(input, 1)), [
			'forbidden', 'private', 'forbidden', 'botCheck', 'ageRestricted', 'membersOnly', 'unavailable', 'liveNotStarted', 'noFormats', 'network', 'unknown',
		]);
	});

	test('reads the ERROR lines before the whole output and maps exit code 101 to a too-long video', () => {
		const privateOnlyInWarning = 'WARNING: [youtube] abc: Private video hint in a warning\nERROR: unable to download video data: HTTP Error 403: Forbidden';
		const reasonOnlyInWarning = 'WARNING: [youtube] abc: Requested format is not available\nERROR: [youtube] abc: something new happened';
		// With --break-match-filters and --print-json, a too-long video prints nothing and exits with 101 (measured on 2026.6.9).
		const rejectedByFilter = 'WARNING: Your yt-dlp version (2026.06.09) is older than 90 days!';
		assert.deepStrictEqual([
			paradisClassifyYtDlpError(privateOnlyInWarning, 1),
			paradisClassifyYtDlpError(reasonOnlyInWarning, 1),
			paradisClassifyYtDlpError(rejectedByFilter, 101),
			paradisClassifyYtDlpError(rejectedByFilter, 1),
		], ['forbidden', 'noFormats', 'tooLong', 'unknown']);
	});

	test('collects warning lines and the precursors of breakage they mention', () => {
		const stderr = [
			'[youtube] Extracting URL: https://www.youtube.com/watch?v=jNQXAC9IVRw',
			'WARNING: Your yt-dlp version (2026.06.09) is older than 90 days!',
			'WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default; some formats may be missing.',
			'WARNING: [youtube] jNQXAC9IVRw: nsig extraction failed: Some formats may be missing',
			'WARNING: [youtube] jNQXAC9IVRw: Some web_safari client https formats have been skipped as they are missing a url. YouTube is forcing SABR streaming for this client.',
			'WARNING: [youtube] jNQXAC9IVRw: web client https formats require a GVS PO Token which was not provided.',
			'WARNING: Your yt-dlp version (2026.06.09) is older than 90 days!',
			'ERROR: not a warning',
		].join('\n');
		const result = paradisExtractYtDlpWarnings(stderr);
		assert.deepStrictEqual({ count: result.lines.length, precursors: result.precursors }, {
			count: 6,
			precursors: ['outdated', 'jsRuntime', 'signature', 'sabr', 'poToken'],
		});
		assert.deepStrictEqual(paradisExtractYtDlpWarnings('[download] 100% of 1.2MiB\n'), { lines: [], precursors: [] });
	});
});
