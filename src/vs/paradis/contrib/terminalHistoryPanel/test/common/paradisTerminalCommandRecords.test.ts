/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCommandRecord, PARADIS_COMMAND_RECORD_MAX_LENGTH, PARADIS_COMMAND_RECORDS_COMPACT_AT, PARADIS_COMMAND_RECORDS_MAX, paradisAppendCommandRecords, paradisParseCommandRecords, paradisSerializeCommandRecord, paradisShouldRecordCommand } from '../../common/paradisTerminalCommandRecords.js';

function records(count: number, from = 0): IParadisCommandRecord[] {
	return Array.from({ length: count }, (_, i) => ({ command: `c${from + i}`, timestamp: from + i, cwd: undefined, exitCode: undefined, duration: undefined }));
}

suite('ParadisTerminalCommandRecords', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('records only commands the shells would keep in their history', () => {
		assert.deepStrictEqual({
			normal: paradisShouldRecordCommand('git status'),
			empty: paradisShouldRecordCommand(''),
			blank: paradisShouldRecordCommand('   '),
			leadingSpace: paradisShouldRecordCommand(' export TOKEN=secret'),
			leadingTab: paradisShouldRecordCommand('\tls'),
			atLimit: paradisShouldRecordCommand('x'.repeat(PARADIS_COMMAND_RECORD_MAX_LENGTH)),
			tooLong: paradisShouldRecordCommand('x'.repeat(PARADIS_COMMAND_RECORD_MAX_LENGTH + 1)),
		}, {
			normal: true,
			empty: false,
			blank: false,
			leadingSpace: false,
			leadingTab: false,
			atLimit: true,
			tooLong: false,
		});
	});

	test('round-trips records and leaves out unknown fields', () => {
		const written: IParadisCommandRecord[] = [
			{ command: 'npm test', cwd: '/home/example/app', exitCode: 1, timestamp: 1700000000000, duration: 2345.6 },
			{ command: 'echo "a\nb"', cwd: undefined, exitCode: undefined, timestamp: 1700000001000, duration: undefined },
		];
		const lines = written.map(paradisSerializeCommandRecord);
		assert.deepStrictEqual({
			lines,
			parsed: paradisParseCommandRecords(lines.join('\n') + '\n'),
		}, {
			lines: [
				'{"c":"npm test","t":1700000000000,"d":"/home/example/app","e":1,"u":2346}',
				'{"c":"echo \\"a\\nb\\"","t":1700000001000}',
			],
			parsed: [
				{ command: 'npm test', cwd: '/home/example/app', exitCode: 1, timestamp: 1700000000000, duration: 2346 },
				{ command: 'echo "a\nb"', cwd: undefined, exitCode: undefined, timestamp: 1700000001000, duration: undefined },
			],
		});
	});

	test('skips broken and foreign lines', () => {
		const content = [
			'{"c":"ok","t":1}',
			'not json',
			'{"c":"","t":2}',
			'{"c":"no time"}',
			'{"c":"bad time","t":"x"}',
			'null',
			'[1,2]',
			'{"c":"odd fields","t":3,"d":5,"e":1.5,"u":-1}',
			'{"c":"truncated","t":4',
		].join('\n');
		assert.deepStrictEqual(paradisParseCommandRecords(content), [
			{ command: 'ok', timestamp: 1, cwd: undefined, exitCode: undefined, duration: undefined },
			{ command: 'odd fields', timestamp: 3, cwd: undefined, exitCode: undefined, duration: undefined },
		]);
	});

	test('keeps appending until the compaction point, then keeps only the newest records', () => {
		const below = paradisAppendCommandRecords(records(PARADIS_COMMAND_RECORDS_COMPACT_AT - 1), records(1, PARADIS_COMMAND_RECORDS_COMPACT_AT - 1));
		const over = paradisAppendCommandRecords(records(PARADIS_COMMAND_RECORDS_COMPACT_AT), records(1, PARADIS_COMMAND_RECORDS_COMPACT_AT));
		assert.deepStrictEqual({
			belowLength: below.length,
			overLength: over.length,
			overFirst: over[0].command,
			overLast: over[over.length - 1].command,
		}, {
			belowLength: PARADIS_COMMAND_RECORDS_COMPACT_AT,
			overLength: PARADIS_COMMAND_RECORDS_MAX,
			overFirst: `c${PARADIS_COMMAND_RECORDS_COMPACT_AT + 1 - PARADIS_COMMAND_RECORDS_MAX}`,
			overLast: `c${PARADIS_COMMAND_RECORDS_COMPACT_AT}`,
		});
	});
});
