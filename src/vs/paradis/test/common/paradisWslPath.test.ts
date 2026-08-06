/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisIsWslAgentHomePath, paradisResolveWslAgentHome } from '../../common/paradisWslAgentHome.js';
import { paradisBuildWslInvocationArgs, paradisCwdGroupKey, paradisMergeWslEnvNames, paradisParseWslLoginPath, paradisParseWslUncPath, paradisPlanWslCommand, paradisWslPathArg } from '../../common/paradisWslPath.js';

suite('ParadisWslPath', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognises WSL UNC paths and maps them onto the distro filesystem', () => {
		const parse = (path: string) => {
			const location = paradisParseWslUncPath(path);
			return location === undefined ? '<undefined>' : `${location.distro}${location.linuxPath}`;
		};

		assert.deepStrictEqual([
			parse('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo'),
			parse('//wsl.localhost/Ubuntu/home/u/repo'),
			// 古い綴りとホスト名の大文字小文字は同じ場所を指す
			parse('\\\\wsl$\\Ubuntu-22.04\\home\\u\\repo'),
			parse('\\\\WSL.LOCALHOST\\Ubuntu\\home\\u\\repo'),
			// 共有のルートはディストロのファイルシステムのルート
			parse('\\\\wsl.localhost\\Ubuntu'),
			parse('\\\\wsl.localhost\\Ubuntu\\'),
			// WSL 以外は対象外。ホスト名の前方一致で誤認しないこと
			parse('\\\\wsl.localhost.example.com\\Ubuntu\\home'),
			parse('\\\\nas\\projects\\repo'),
			parse('C:\\repo'),
			parse('/home/u/repo'),
			parse('\\\\wsl.localhost'),
		], [
			'Ubuntu/home/u/repo',
			'Ubuntu/home/u/repo',
			'Ubuntu-22.04/home/u/repo',
			'Ubuntu/home/u/repo',
			'Ubuntu/',
			'Ubuntu/',
			'<undefined>',
			'<undefined>',
			'<undefined>',
			'<undefined>',
			'<undefined>',
		]);
	});

	test('plans command execution per namespace and refuses mixed ones', () => {
		const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo';
		const WT = '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt';
		const p = paradisWslPathArg;
		const plan = (args: readonly (string | ReturnType<typeof paradisWslPathArg>)[], cwd?: string) => {
			const result = paradisPlanWslCommand(args, cwd);
			return result.kind === 'wsl' ? `wsl:${result.distro} [${result.args.join(' ')}] cwd=${result.cwd ?? '-'}` : result.kind;
		};

		assert.deepStrictEqual([
			// WSL のパスが無ければ従来どおりローカル実行
			plan(['-C', p('/repo'), 'worktree', 'prune']),
			plan(['-C', p('C:\\repo'), 'rev-parse', '--abbrev-ref', 'HEAD']),
			// パス以外の引数（フラグ・ブランチ名・ref）はそのまま通す
			plan(['-C', p(REPO), 'worktree', 'add', '--no-track', '-b', 'feat/x', p(WT), 'main']),
			// cwd だけが WSL でも WSL 実行に倒す
			plan(['pr', 'view', '--json', 'state'], REPO),
			// パスでない引数は、Windows のパスに見えても素通しする（`--reason` はユーザーの自由入力）
			plan(['-C', p(REPO), 'worktree', 'lock', '--reason', 'C:\\builds\\agent held', p(WT)]),
			plan(['-C', p(REPO), 'worktree', 'add', '-b', '\\\\nas\\weird-branch-name', p(WT), 'main']),
			// パスだと明示した引数が別の名前空間なら実行しない（ディストロ内では別の場所を指すため）
			plan(['-C', p(REPO), 'worktree', 'add', p('C:\\wt\\x'), 'main']),
			plan(['-C', p(REPO), 'worktree', 'add', p('\\\\nas\\wt\\x'), 'main']),
			// ドライブ相対・ルート相対も、WSL のパスでない以上は拒否する
			plan(['-C', p(REPO), 'worktree', 'add', p('C:wt\\x'), 'main']),
			plan(['-C', p(REPO), 'worktree', 'add', p('\\wt\\x'), 'main']),
			plan(['status'], 'C:\\repo\\sub'),
			// ディストロをまたぐ実行も同じく拒否する
			plan(['-C', p(REPO), 'worktree', 'add', p('\\\\wsl.localhost\\Debian\\home\\u\\wt'), 'main']),
			// `..` を含む UNC は Windows 側の解決結果と食い違うので WSL とみなさない
			plan(['-C', p('\\\\wsl.localhost\\Ubuntu\\..\\Debian\\home\\u\\repo'), 'status']),
		], [
			'local',
			'local',
			'wsl:Ubuntu [-C /home/u/repo worktree add --no-track -b feat/x /home/u/wt main] cwd=-',
			'wsl:Ubuntu [pr view --json state] cwd=/home/u/repo',
			'wsl:Ubuntu [-C /home/u/repo worktree lock --reason C:\\builds\\agent held /home/u/wt] cwd=-',
			'wsl:Ubuntu [-C /home/u/repo worktree add -b \\\\nas\\weird-branch-name /home/u/wt main] cwd=-',
			'conflict',
			'conflict',
			'conflict',
			'conflict',
			'local',
			'conflict',
			'local',
		]);
	});

	test('builds an invocation that avoids --cd and keeps the profile out of stdout', () => {
		assert.deepStrictEqual(
			paradisBuildWslInvocationArgs({ distro: 'Ubuntu', args: ['pr', 'view', '--json', 'state'], cwd: '/home/u/repo' }, 'gh', '/home/u/.local/bin:/usr/bin'),
			['-d', 'Ubuntu', '-e', 'env', 'PATH=/home/u/.local/bin:/usr/bin', 'sh', '-c', 'cd -- "$0" && exec "$@"', '/home/u/repo', 'gh', 'pr', 'view', '--json', 'state'],
		);
		// PATH が読めなかったときは env を挟まない。cwd 未指定はルートで走らせる
		assert.deepStrictEqual(
			paradisBuildWslInvocationArgs({ distro: 'Ubuntu', args: ['-C', '/home/u/repo', 'status'], cwd: undefined }, 'git'),
			['-d', 'Ubuntu', '-e', 'sh', '-c', 'cd -- "$0" && exec "$@"', '/', 'git', '-C', '/home/u/repo', 'status'],
		);
	});

	test('reads the login PATH past whatever the profile printed', () => {
		assert.deepStrictEqual([
			paradisParseWslLoginPath('Welcome!\n__paracode_wsl_path__=/home/u/.local/bin:/usr/bin\n'),
			// 目印そのものを含む出力があっても、最後のものを採る
			paradisParseWslLoginPath('__paracode_wsl_path__=/decoy\nx\n__paracode_wsl_path__=/usr/bin\n'),
			paradisParseWslLoginPath('nothing useful here'),
			paradisParseWslLoginPath('__paracode_wsl_path__=\n'),
		], [
			'/home/u/.local/bin:/usr/bin',
			'/usr/bin',
			undefined,
			undefined,
		]);
	});

	test('locates the agent home of whoever owns the working directory', () => {
		const home = (cwd: string) => {
			const resolved = paradisResolveWslAgentHome(cwd);
			return resolved === undefined ? '<undefined>' : `${resolved.distro}|${resolved.homeUncPath}|${resolved.linuxCwd}`;
		};

		assert.deepStrictEqual([
			home('\\\\wsl.localhost\\Ubuntu-26.04\\home\\paradis\\projects\\repo'),
			// ホーム直下でも成立する
			home('\\\\wsl.localhost\\Ubuntu-26.04\\home\\paradis'),
			// 古い綴りで登録されていれば、その綴りのまま返す（読み先を勝手に変えない）
			home('\\\\wsl$\\Ubuntu-26.04\\home\\paradis\\repo'),
			home('\\\\wsl.localhost\\Ubuntu\\root\\repo'),
			// ホームを特定できない場所は、推測で他人のホームを覗きに行かず諦める
			home('\\\\wsl.localhost\\Ubuntu\\srv\\repo'),
			home('\\\\wsl.localhost\\Ubuntu\\home'),
			// WSL でないパスは対象外
			home('C:\\repo'),
			home('/home/paradis/repo'),
		], [
			'Ubuntu-26.04|\\\\wsl.localhost\\Ubuntu-26.04\\home\\paradis|/home/paradis/projects/repo',
			'Ubuntu-26.04|\\\\wsl.localhost\\Ubuntu-26.04\\home\\paradis|/home/paradis',
			'Ubuntu-26.04|\\\\wsl$\\Ubuntu-26.04\\home\\paradis|/home/paradis/repo',
			'Ubuntu|\\\\wsl.localhost\\Ubuntu\\root|/root/repo',
			'<undefined>',
			'<undefined>',
			'<undefined>',
			'<undefined>',
		]);
	});

	test('recognises agent home paths by shape alone, so the answer never depends on timing', () => {
		// 生きているターミナルから許可集合を組み立てると、作業ディレクトリがまだ判明していない
		// 起動直後に「許可されていない」と「まだ分からない」が同じ答えに潰れ、永続化してあった
		// セッションを消してしまう。形だけで判定していれば、その窓は生まれない。
		assert.deepStrictEqual([
			paradisIsWslAgentHomePath('\\\\wsl.localhost\\Ubuntu-26.04\\home\\paradis\\.claude\\projects\\p\\a.jsonl'),
			paradisIsWslAgentHomePath('\\\\wsl$\\Ubuntu\\home\\u\\.codex\\sessions\\r.jsonl'),
			paradisIsWslAgentHomePath('\\\\wsl.localhost\\Ubuntu\\root\\.claude\\projects\\p\\a.jsonl'),
			// 綴りと大文字小文字の揺れで永続セッションを失わないこと
			paradisIsWslAgentHomePath('\\\\WSL.LOCALHOST\\ubuntu-26.04\\home\\Paradis\\.Claude\\projects\\p\\a.jsonl'),
			// エージェントのホーム以外へは広げない
			paradisIsWslAgentHomePath('\\\\wsl.localhost\\Ubuntu\\home\\u\\.ssh\\id_rsa'),
			paradisIsWslAgentHomePath('\\\\wsl.localhost\\Ubuntu\\etc\\.claude\\x.jsonl'),
			paradisIsWslAgentHomePath('\\\\nas\\share\\home\\u\\.claude\\x.jsonl'),
			paradisIsWslAgentHomePath('C:\\Users\\x\\.claude\\projects\\p\\a.jsonl'),
		], [true, true, true, true, false, false, false, false]);
	});

	test('counts two terminals in the same folder as one place, however the path is spelled', () => {
		// ここがすり抜けると、同じ場所の2枚を別々に数えてしまい、「どちらのセッションか
		// 決められないから何もしない」という取り違え防止がそのまま無効になる。
		const key = paradisCwdGroupKey;

		assert.strictEqual(key('\\\\wsl.localhost\\Ubuntu\\home\\u\\r'), key('\\\\WSL$\\ubuntu\\home\\u\\r\\'));
		assert.strictEqual(key('C:\\Repo'), key('c:/repo/'));
		// POSIX の `//data` は本当に別の場所なので、Windows の規則を当てて潰さない
		assert.notStrictEqual(key('//data/Repo'), key('//data/repo'));
		assert.strictEqual(key('/home/u/Repo'), '/home/u/Repo');
		// 別のフォルダを同じとみなさない
		assert.notStrictEqual(key('\\\\wsl.localhost\\Ubuntu\\home\\u\\a'), key('\\\\wsl.localhost\\Ubuntu\\home\\u\\b'));
		assert.notStrictEqual(key('\\\\wsl.localhost\\Ubuntu\\home\\u\\r'), key('\\\\wsl.localhost\\Debian\\home\\u\\r'));
	});

	test('threads env names through WSLENV without dropping the user own entries', () => {
		assert.deepStrictEqual([
			paradisMergeWslEnvNames(undefined, ['GIT_TERMINAL_PROMPT']),
			paradisMergeWslEnvNames('', ['A', 'B']),
			// ユーザーの既存指定は保つ。フラグ付き（NAME/p）の重複も名前で判定する
			paradisMergeWslEnvNames('EDITOR:PROJECT/p', ['GIT_TERMINAL_PROMPT']),
			paradisMergeWslEnvNames('PROJECT/p', ['PROJECT']),
			paradisMergeWslEnvNames('A', ['A', 'A']),
		], [
			'GIT_TERMINAL_PROMPT',
			'A:B',
			'EDITOR:PROJECT/p:GIT_TERMINAL_PROMPT',
			'PROJECT/p',
			'A',
		]);
	});
});
