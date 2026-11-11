/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GeneralShellType, PosixShellType, WindowsShellType } from '../../../../../platform/terminal/common/terminal.js';
import { paradisBuildAgentCommand, paradisBuildWorktreeNames, paradisDeduplicateBranchName, paradisParseWorktreeNaming, paradisToBranchName, paradisToWorktreeTitle, paradisDeduplicateWorktreeDirName, paradisFindWorktreeLock, paradisFormatWorktreeLockReason, paradisParseGhPrStatus, paradisParseWorktreeListPorcelain, paradisShouldCreateDefaultTerminal } from '../../common/paradisWorktreeCreate.js';

suite('paradisWorktreeCreate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 大文字小文字を区別し、バックスラッシュを区切りとみなさない環境（Linux）。 */
	const posix = { ignoreCase: false, backslashIsSeparator: false };

	test('uses the space name only as the display name', () => {
		assert.deepStrictEqual(
			// allow-any-unicode-next-line
			paradisBuildWorktreeNames('音声メモの解析', 'feat/sample-ocr'),
			// allow-any-unicode-next-line
			{ displayName: '音声メモの解析', dirName: 'feat-sample-ocr' },
		);
	});

	test('falls back to the branch-derived directory name when the space name is empty', () => {
		assert.deepStrictEqual(
			paradisBuildWorktreeNames('  ', 'feat/sample-ocr'),
			{ displayName: 'feat-sample-ocr', dirName: 'feat-sample-ocr' },
		);
	});

	test('prefers a generated title over the branch-derived directory name', () => {
		assert.deepStrictEqual(
			// allow-any-unicode-next-line
			paradisBuildWorktreeNames('', 'feat/sample-ocr', [], [], '資料整理のOCR対応'),
			// allow-any-unicode-next-line
			{ displayName: '資料整理のOCR対応', dirName: 'feat-sample-ocr' },
		);
	});

	test('a hand-typed space name still wins over a generated title', () => {
		assert.deepStrictEqual(
			// allow-any-unicode-next-line
			paradisBuildWorktreeNames('手入力名', 'feat/x', [], [], '生成された見出し'),
			// allow-any-unicode-next-line
			{ displayName: '手入力名', dirName: 'feat-x' },
		);
	});

	test('falls back to the directory name when the generated title is unusable', () => {
		assert.deepStrictEqual(
			paradisBuildWorktreeNames('', 'feat/x', [], [], '   '),
			{ displayName: 'feat-x', dirName: 'feat-x' },
		);
	});

	/**
	 * 命名モデルは書式を守らない。ここが緩むと見出し行がそのままブランチ名になり、
	 * **日本語の worktree ディレクトリ**ができてしまう（Windows やツールチェーンで事故る）。
	 * 応答文字列から最終的なブランチ名までを通しで確かめる。
	 */
	test('never derives a branch name from the title line, whatever shape the model replies in', () => {
		// allow-any-unicode-next-line
		const replies = [
			// allow-any-unicode-next-line
			'Title: 資料整理のOCR\nBranch: feat-sample-ocr',
			// allow-any-unicode-next-line
			'**Title:** 資料整理のOCR\n**Branch:** feat-sample-ocr',
			// allow-any-unicode-next-line
			'- Title: 資料整理のOCR\n- Branch: feat-sample-ocr',
			// allow-any-unicode-next-line
			'1. Title: 資料整理のOCR\n2. Branch: feat-sample-ocr',
			// allow-any-unicode-next-line
			'タイトル: 資料整理のOCR\nブランチ: feat-sample-ocr',
			// allow-any-unicode-next-line
			'Sure, here you go:\nTitle: 資料整理のOCR\nBranch: feat-sample-ocr',
			// allow-any-unicode-next-line
			'```\nTitle: 資料整理のOCR\nBranch: feat-sample-ocr\n```',
		];
		assert.deepStrictEqual(
			replies.map(reply => paradisToBranchName(paradisParseWorktreeNaming(reply).branch)),
			replies.map(() => 'feat-sample-ocr'),
		);
	});

	test('drops a non-ascii branch candidate instead of naming a directory in Japanese', () => {
		// allow-any-unicode-next-line
		assert.strictEqual(paradisToBranchName('資料整理のOCR'), undefined);
		// allow-any-unicode-next-line
		assert.strictEqual(paradisToBranchName('Title: 資料整理'), undefined);
		assert.strictEqual(paradisToBranchName('feat-sample-ocr'), 'feat-sample-ocr');
		// 予約デバイス名とカット後の末尾記号は従来どおり弾く。
		assert.strictEqual(paradisToBranchName('CON'), undefined);
	});

	test('an unlabelled reply only yields a branch when a line looks like one', () => {
		assert.deepStrictEqual(
			paradisParseWorktreeNaming('feat-sample-ocr'),
			{ title: undefined, branch: 'feat-sample-ocr' },
		);
		assert.deepStrictEqual(
			// allow-any-unicode-next-line
			paradisParseWorktreeNaming('資料整理のOCR\nfeat-sample-ocr'),
			{ title: undefined, branch: 'feat-sample-ocr' },
		);
		// allow-any-unicode-next-line
		assert.deepStrictEqual(paradisParseWorktreeNaming('資料整理のOCR'), { title: undefined, branch: undefined });
	});

	test('keeps the title when the model omits the branch line', () => {
		assert.deepStrictEqual(
			// allow-any-unicode-next-line
			paradisParseWorktreeNaming('Title: 見出しだけ'),
			// allow-any-unicode-next-line
			{ title: '見出しだけ', branch: undefined },
		);
	});

	test('trims a generated title to one clean line', () => {
		// allow-any-unicode-next-line
		assert.strictEqual(paradisToWorktreeTitle('「資料整理」\n2行目'), '資料整理');
		// allow-any-unicode-next-line
		assert.strictEqual(paradisToWorktreeTitle('**資料整理**'), '資料整理');
		assert.strictEqual(paradisToWorktreeTitle('   '), undefined);
		assert.strictEqual(paradisToWorktreeTitle(undefined), undefined);
		// 24 コードポイントを超えたら省略記号を足して切る。
		assert.strictEqual(paradisToWorktreeTitle('a'.repeat(40)), `${'a'.repeat(24)}\u2026`);
	});

	test('strips invisible and bidi control characters that would scramble the row', () => {
		// allow-any-unicode-next-line
		assert.strictEqual(paradisToWorktreeTitle('役所\u202e調査\u200b'), '役所 調査');
		// allow-any-unicode-next-line
		assert.strictEqual(paradisToWorktreeTitle('\u200e\u2066\u2069'), undefined);
	});

	test('deduplicates directory names that collide after branch sanitization', () => {
		assert.strictEqual(
			paradisDeduplicateWorktreeDirName('feat-foo', ['main', 'feat/foo']),
			'feat-foo-2',
		);
		assert.strictEqual(
			paradisDeduplicateWorktreeDirName('feat-foo', ['feat/foo', 'feat/foo-2']),
			'feat-foo-3',
		);
		assert.strictEqual(
			paradisDeduplicateWorktreeDirName('custom-dir', ['main'], ['custom-dir']),
			'custom-dir-2',
		);
	});

	test('uses the deduplicated directory name as the fallback display name', () => {
		assert.deepStrictEqual(
			paradisBuildWorktreeNames('', 'feat-foo', ['feat/foo']),
			{ displayName: 'feat-foo-2', dirName: 'feat-foo-2' },
		);
	});

	test('deduplicates branch and directory names on case-insensitive file systems', () => {
		assert.deepStrictEqual({
			branch: paradisDeduplicateBranchName('feature', ['Feature'], true),
			directory: paradisDeduplicateWorktreeDirName('feature', [], ['Feature'], true),
		}, {
			branch: 'feature-2',
			directory: 'feature-2',
		});
	});

	test('creates a default terminal when no agent command will run', () => {
		assert.strictEqual(paradisShouldCreateDefaultTerminal('none', 'build this'), true);
	});

	test('does not create an extra default terminal when an agent command will run', () => {
		assert.strictEqual(paradisShouldCreateDefaultTerminal('codex', 'build this'), false);
		// プロンプト未入力でもエージェント選択時は対話モードで起動するため、既定ターミナルは作らない
		assert.strictEqual(paradisShouldCreateDefaultTerminal('codex', '   '), false);
	});

	test('omits the prompt argument entirely when the prompt is empty', () => {
		const template = { id: 'codex', label: 'Codex', command: 'codex {prompt}' };
		assert.strictEqual(paradisBuildAgentCommand(template, '', PosixShellType.Bash), 'codex');
		assert.strictEqual(paradisBuildAgentCommand(template, '  ', WindowsShellType.CommandPrompt), 'codex');
	});

	test('quotes agent prompts for POSIX and PowerShell terminals', () => {
		const template = { id: 'codex', label: 'Codex', command: 'codex {prompt}' };
		assert.strictEqual(paradisBuildAgentCommand(template, 'fix it\'s broken', PosixShellType.Bash), String.raw`codex 'fix it'\''s broken'`);
		assert.strictEqual(paradisBuildAgentCommand(template, 'fix it\'s broken', GeneralShellType.PowerShell), String.raw`codex 'fix it''s broken'`);
	});

	test('quotes fish prompts with its own escapes, PowerShell smart quotes, and drops control characters', () => {
		const template = { id: 'codex', label: 'Codex', command: 'codex {prompt}' };
		assert.deepStrictEqual([
			paradisBuildAgentCommand(template, 'it\'s a\\', PosixShellType.Fish),
			paradisBuildAgentCommand(template, 'fix it\u2019; Start-Process calc; \u2018', GeneralShellType.PowerShell),
			paradisBuildAgentCommand(template, 'a\x03b\x15c\td\r\ne', PosixShellType.Bash),
		], [
			String.raw`codex 'it\'s a\\'`,
			'codex \'fix it\u2019\u2019; Start-Process calc; \u2018\u2018\'',
			'codex \'abc    d\ne\'',
		]);
	});

	test('passes a prompt that starts with a dash or is a single word as the prompt, not as a CLI option or subcommand, and keeps $ patterns literal', () => {
		const template = { id: 'claude', label: 'Claude', command: 'claude {prompt}' };
		assert.deepStrictEqual([
			paradisBuildAgentCommand(template, '--dangerously-skip-permissions', PosixShellType.Bash),
			paradisBuildAgentCommand(template, '--permission-mode=bypassPermissions', GeneralShellType.PowerShell),
			paradisBuildAgentCommand(template, '- fix the bug', PosixShellType.Fish),
			paradisBuildAgentCommand(template, 'cost $& and $$ and $\'', PosixShellType.Bash),
			// 1語だけの指示はサブコマンドとして読まれる（`claude logout`・`codex e`）
			paradisBuildAgentCommand(template, 'logout', PosixShellType.Bash),
			paradisBuildAgentCommand(template, 'e', GeneralShellType.PowerShell),
			paradisBuildAgentCommand(template, 'fix the login bug', PosixShellType.Bash),
		], [
			'claude \' --dangerously-skip-permissions\'',
			'claude \' --permission-mode=bypassPermissions\'',
			'claude \' - fix the bug\'',
			'claude \'cost $& and $$ and $\'\\\'\'\'',
			'claude \' logout\'',
			'claude \' e\'',
			'claude \'fix the login bug\'',
		]);
	});

	test('refuses a prompt with a backslash when the shell is unknown, since it cannot be quoted for fish', () => {
		const template = { id: 'codex', label: 'Codex', command: 'codex {prompt}' };
		assert.throws(() => paradisBuildAgentCommand(template, 'a\\\'; touch /tmp/x; echo \\', undefined));
		assert.strictEqual(paradisBuildAgentCommand(template, 'plain text', undefined), 'codex \'plain text\'');
	});

	test('encodes arbitrary cmd.exe prompts without interpolating metacharacters', () => {
		const command = paradisBuildAgentCommand(
			{ id: 'codex', label: 'Codex', command: 'codex {prompt}' },
			'fix & echo %PATH% "now"',
			WindowsShellType.CommandPrompt,
		);
		assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
		assert.ok(!command.includes('%PATH%'));
		assert.ok(!command.includes('& echo'));
	});

	test('passes attached images as @ mentions to Claude Code, as one --image flag to Codex, and not at all to Gemini CLI', () => {
		const claude = { id: 'claude', label: 'Claude Code', command: 'claude {prompt}' };
		const codex = { id: 'codex', label: 'Codex', command: 'codex {prompt}' };
		const gemini = { id: 'gemini', label: 'Gemini CLI', command: 'gemini -i {prompt}' };
		const custom = { id: 'my-agent', label: 'Mine', command: 'mine --run {prompt}' };
		const images = ['.para-code/pasted-images/1762876411000-1.png', '.para-code/pasted-images/1762876411000-2.jpg'];
		// allow-any-unicode-next-line
		const prompt = 'スクショの赤い枠を直して';
		assert.deepStrictEqual([
			paradisBuildAgentCommand(claude, prompt, PosixShellType.Bash, { modelId: undefined }, images),
			paradisBuildAgentCommand(codex, prompt, PosixShellType.Bash, undefined, images),
			paradisBuildAgentCommand(gemini, prompt, PosixShellType.Bash, undefined, images),
			paradisBuildAgentCommand(custom, prompt, PosixShellType.Bash, undefined, images),
		], [
			// allow-any-unicode-next-line
			'claude \'スクショの赤い枠を直して @.para-code/pasted-images/1762876411000-1.png @.para-code/pasted-images/1762876411000-2.jpg\'',
			// allow-any-unicode-next-line
			'codex \'--image=.para-code/pasted-images/1762876411000-1.png,.para-code/pasted-images/1762876411000-2.jpg\' \'スクショの赤い枠を直して\'',
			// allow-any-unicode-next-line
			'gemini -i \'スクショの赤い枠を直して\'',
			// allow-any-unicode-next-line
			'mine --run \'スクショの赤い枠を直して @.para-code/pasted-images/1762876411000-1.png @.para-code/pasted-images/1762876411000-2.jpg\'',
		]);
	});

	test('passes images without an instruction, and keeps the image flag behind the other flags', () => {
		const claude = { id: 'claude', label: 'Claude Code', command: 'claude {prompt}', permissions: [{ id: 'default', label: 'Default', flag: '--permission-mode manual' }] };
		const codex = { id: 'codex', label: 'Codex', command: 'codex {prompt}', models: [{ id: 'm', flag: '--model m' }] };
		const images = ['.para-code/pasted-images/1-1.png'];
		assert.deepStrictEqual([
			paradisBuildAgentCommand(claude, '', PosixShellType.Bash, { permissionId: 'default' }, images),
			paradisBuildAgentCommand(codex, '  ', PosixShellType.Bash, { modelId: 'm' }, images),
			paradisBuildAgentCommand(codex, '', WindowsShellType.CommandPrompt, undefined, images),
			paradisBuildAgentCommand(codex, 'fix', PosixShellType.Bash, { modelId: 'm' }, images),
			paradisBuildAgentCommand(codex, '', PosixShellType.Bash, { modelId: 'm' }, []),
		], [
			'claude --permission-mode manual \'@.para-code/pasted-images/1-1.png\'',
			'codex --model m \'--image=.para-code/pasted-images/1-1.png\'',
			'codex "--image=.para-code/pasted-images/1-1.png"',
			// 1 語の指示は前に空白を足して指示として渡す（画像のフラグがあっても変わらない）
			'codex --model m \'--image=.para-code/pasted-images/1-1.png\' \' fix\'',
			'codex --model m',
		]);
	});

	test('quotes the image flag for each shell, so PowerShell does not read the comma as an array', () => {
		const codex = { id: 'codex', label: 'Codex', command: 'codex {prompt}' };
		const claude = { id: 'claude', label: 'Claude Code', command: 'claude {prompt}' };
		const images = ['.para-code/pasted-images/1-1.png', '.para-code/pasted-images/1-2.webp'];
		assert.deepStrictEqual([
			paradisBuildAgentCommand(codex, 'it\'s red', GeneralShellType.PowerShell, undefined, images),
			paradisBuildAgentCommand(codex, 'it\'s red', PosixShellType.Fish, undefined, images),
			paradisBuildAgentCommand(codex, 'look', undefined, undefined, images),
			paradisBuildAgentCommand(claude, 'it\'s red', GeneralShellType.PowerShell, undefined, images),
		], [
			'codex \'--image=.para-code/pasted-images/1-1.png,.para-code/pasted-images/1-2.webp\' \'it\'\'s red\'',
			'codex \'--image=.para-code/pasted-images/1-1.png,.para-code/pasted-images/1-2.webp\' \'it\\\'s red\'',
			'codex \'--image=.para-code/pasted-images/1-1.png,.para-code/pasted-images/1-2.webp\' \' look\'',
			'claude \'it\'\'s red @.para-code/pasted-images/1-1.png @.para-code/pasted-images/1-2.webp\'',
		]);
	});

	test('runs the image flag inside the PowerShell script for cmd.exe, quoted for PowerShell', () => {
		const command = paradisBuildAgentCommand({ id: 'codex', label: 'Codex', command: 'codex {prompt}' }, 'fix & echo %PATH%', WindowsShellType.CommandPrompt, undefined, ['.para-code/pasted-images/1-1.png', '.para-code/pasted-images/1-2.png']);
		const encoded = /-EncodedCommand (?<script>[A-Za-z0-9+/=]+)$/.exec(command)?.groups?.script ?? '';
		const bytes = decodeBase64(encoded).buffer;
		let script = '';
		for (let index = 0; index + 1 < bytes.length; index += 2) {
			script += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8));
		}
		assert.ok(script.endsWith('; codex \'--image=.para-code/pasted-images/1-1.png,.para-code/pasted-images/1-2.png\' $paradisPrompt'), script);
	});

	test('drops image paths that could break the quoting or point outside the space', () => {
		const claude = { id: 'claude', label: 'Claude Code', command: 'claude {prompt}' };
		const codex = { id: 'codex', label: 'Codex', command: 'codex {prompt}' };
		const images = ['.para-code/pasted-images/1-1.png', 'a b.png', 'x\'$(id).png', '../outside.png', '-rf.png', '.para-code/pasted-images/1-2.png'];
		assert.deepStrictEqual([
			paradisBuildAgentCommand(claude, 'look', PosixShellType.Bash, undefined, images),
			paradisBuildAgentCommand(codex, 'look', PosixShellType.Bash, undefined, images),
		], [
			'claude \'look @.para-code/pasted-images/1-1.png @.para-code/pasted-images/1-2.png\'',
			'codex \'--image=.para-code/pasted-images/1-1.png,.para-code/pasted-images/1-2.png\' \' look\'',
		]);
	});

	test('parses gh pr view output into a PR status', () => {
		const stdout = JSON.stringify({ number: 42, title: 'feat: mobile relay', url: 'https://github.com/o/r/pull/42', state: 'OPEN', isDraft: false, headRefName: 'feature/mobile-relay' });
		assert.deepStrictEqual(
			paradisParseGhPrStatus(stdout, 'feature/mobile-relay'),
			{ number: 42, title: 'feat: mobile relay', url: 'https://github.com/o/r/pull/42', state: 'open' },
		);
	});

	test('maps draft / merged / closed states', () => {
		const build = (state: string, isDraft: boolean) => JSON.stringify({ number: 1, title: 't', url: 'https://github.com/o/r/pull/1', state, isDraft, headRefName: 'b' });
		assert.deepStrictEqual(
			[
				paradisParseGhPrStatus(build('OPEN', true), 'b')?.state,
				paradisParseGhPrStatus(build('MERGED', false), 'b')?.state,
				paradisParseGhPrStatus(build('CLOSED', false), 'b')?.state,
			],
			['draft', 'merged', 'closed'],
		);
	});

	test('rejects PRs whose head branch does not match the current branch, allowing fork prefixes', () => {
		const stdout = JSON.stringify({ number: 7, title: 't', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, headRefName: 'feature' });
		assert.deepStrictEqual(
			[
				paradisParseGhPrStatus(stdout, 'other-branch'),
				paradisParseGhPrStatus(stdout, 'fork-owner/feature')?.number,
			],
			[undefined, 7],
		);
	});

	test('returns undefined for non-JSON or malformed payloads', () => {
		assert.deepStrictEqual(
			[
				paradisParseGhPrStatus('no pull requests found', 'b'),
				paradisParseGhPrStatus('null', 'b'),
				paradisParseGhPrStatus(JSON.stringify({ number: 'x', url: 'https://x', state: 'OPEN', headRefName: 'b' }), 'b'),
				paradisParseGhPrStatus(JSON.stringify({ number: 1, url: 'https://x', state: 'UNKNOWN', headRefName: 'b' }), 'b'),
				paradisParseGhPrStatus(JSON.stringify({ number: 1, url: 'file:///etc/passwd', state: 'OPEN', headRefName: 'b' }), 'b'),
			],
			[undefined, undefined, undefined, undefined, undefined],
		);
	});

	// `git worktree list --porcelain -z` は属性を NUL 終端で並べ、エントリの切れ目は空レコードで表す。
	// 実測（git 2.50）のバイト列をそのまま固定する。
	test('reads the lock state and reason out of the porcelain worktree list', () => {
		const output = [
			'worktree /repo', 'HEAD abc', 'branch refs/heads/main', '',
			'worktree /repo/wt1', 'HEAD abc', 'branch refs/heads/feat', 'locked claude session fix-issue-1965 (pid 8046)', '',
			'worktree /repo/wt2', 'HEAD abc', 'detached', 'locked', '',
			'',
		].join('\0');
		assert.deepStrictEqual(
			paradisParseWorktreeListPorcelain(output),
			[
				{ path: '/repo', locked: false, lockReason: '' },
				{ path: '/repo/wt1', locked: true, lockReason: 'claude session fix-issue-1965 (pid 8046)' },
				{ path: '/repo/wt2', locked: true, lockReason: '' },
			],
		);
	});

	// ロック理由はユーザーが自由に書ける文字列なので改行を含み得る。-z を使うのはこれを
	// 「次の属性行」と読み違えないためで、そこが崩れると別の作業ツリーを消しかねない。
	test('keeps a multi-line lock reason attached to its own worktree', () => {
		const output = [
			'worktree /repo/wt1', 'locked why\nbranch refs/heads/spoofed', '',
			'worktree /repo/wt2', 'branch refs/heads/real', '',
			'',
		].join('\0');
		assert.deepStrictEqual(
			paradisParseWorktreeListPorcelain(output),
			[
				{ path: '/repo/wt1', locked: true, lockReason: 'why\nbranch refs/heads/spoofed' },
				{ path: '/repo/wt2', locked: false, lockReason: '' },
			],
		);
	});

	// 区切りの無い出力（将来の git や別実装）でも、次の `worktree` 行でエントリを閉じられること。
	test('closes an entry at the next worktree record when the blank separator is missing', () => {
		assert.deepStrictEqual(
			paradisParseWorktreeListPorcelain(['worktree /repo/a', 'locked held', 'worktree /repo/b'].join('\0')),
			[
				{ path: '/repo/a', locked: true, lockReason: 'held' },
				{ path: '/repo/b', locked: false, lockReason: '' },
			],
		);
	});

	test('returns nothing for an empty worktree list', () => {
		assert.deepStrictEqual(paradisParseWorktreeListPorcelain(''), []);
	});

	// ここが外れると「ロックされていない」と誤判定し、強制削除がロックで失敗する詰みに戻る。
	// 例外は出ないので、効いていないことに気づけない。
	test('matches the worktree across separator, trailing slash and case differences', () => {
		const windows = { ignoreCase: true, backslashIsSeparator: true };
		const entries = [{ path: 'C:/Users/foo/wt', locked: true, lockReason: 'held' }];
		assert.deepStrictEqual(
			[
				paradisFindWorktreeLock(entries, 'C:\\Users\\foo\\wt', windows).locked,
				paradisFindWorktreeLock(entries, 'c:\\users\\foo\\wt\\', windows).locked,
				// UNC も git のフォワードスラッシュ表記と噛み合う。
				paradisFindWorktreeLock([{ path: '//server/share/wt', locked: true, lockReason: '' }], '\\\\server\\share\\wt', windows).locked,
				// 大文字小文字を区別する環境では別物として扱う。
				paradisFindWorktreeLock(entries, 'c:/users/foo/wt', posix).locked,
				paradisFindWorktreeLock(entries, '/repo/other', windows).locked,
			],
			[true, true, true, false, false],
		);
	});

	// Linux / macOS ではバックスラッシュは正当なファイル名文字。区切りとして潰すと、
	// 別々の作業ツリーを同一視して誤ったほうのロック状態を返す。
	test('does not treat a backslash as a separator away from Windows', () => {
		assert.strictEqual(
			// allow-any-unicode-next-line
			paradisFindWorktreeLock([{ path: '/repo/a\\b', locked: true, lockReason: '' }], '/repo/a/b', posix).locked,
			false,
		);
	});

	// `.git/worktrees/<name>/locked` へ直接 NUL を書けば偽エントリを注入できる。
	// 先頭一致だけを見ていると、ロックされていない側の偽物でロックを隠せてしまう。
	test('keeps a worktree locked even when a duplicate entry claims it is not', () => {
		assert.deepStrictEqual(
			paradisFindWorktreeLock([
				{ path: '/repo/wt', locked: false, lockReason: '' },
				{ path: '/repo/wt', locked: true, lockReason: 'held by a session' },
			], '/repo/wt', posix),
			{ locked: true, reason: 'held by a session' },
		);
	});

	test('reports no lock when the worktree is absent from the list', () => {
		assert.deepStrictEqual(paradisFindWorktreeLock([], '/repo/wt', posix), { locked: false, reason: '' });
	});

	// 理由はリポジトリ内のファイルに誰でも書ける任意の文字列。そのまま流すと確認ボタンが
	// 画面の外へ出て、消すことも閉じることもできなくなる。
	test('flattens and truncates the lock reason before it reaches a dialog', () => {
		const formatted = paradisFormatWorktreeLockReason(`  held\nby\n\n${'x'.repeat(500)}  `);
		assert.strictEqual(formatted.length, 201);
		assert.ok(formatted.startsWith('held by x'));
		assert.ok(formatted.endsWith('…'));
		assert.strictEqual(paradisFormatWorktreeLockReason('   '), '');
	});
});
