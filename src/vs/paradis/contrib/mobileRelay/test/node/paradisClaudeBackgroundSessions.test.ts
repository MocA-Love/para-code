/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisHookTranscriptSightings, paradisClaudeTranscriptIsBackground, paradisClaudeTranscriptLineEndIsBackground, paradisClaudeTranscriptLinesAreBackground, paradisClaudeTranscriptSessionKind, paradisFindClaudeTranscriptByIdPrefix, paradisSelectClaudeTranscriptByIdPrefix } from '../../node/paradisClaudeBackgroundSessions.js';

/** Claude Code 2.1.289 の transcript の行の形（実物から値だけを差し替えた）。 */
const line = {
	aiTitle: (sessionId: string) => JSON.stringify({ type: 'ai-title', aiTitle: '調査', sessionId }),
	agentName: (sessionId: string) => JSON.stringify({ type: 'agent-name', agentName: 'fork ⑂ 調査', sessionId }),
	snapshot: () => JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', snapshot: {} }),
	user: (sessionId: string, uuid: string, text: string, sessionKind?: string) => JSON.stringify({
		parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text },
		uuid, timestamp: '2026-10-03T13:32:42.642Z', sessionId, ...(sessionKind !== undefined ? { sessionKind } : {}),
	}),
	assistant: (sessionId: string, uuid: string, text: string, sessionKind?: string) => JSON.stringify({
		parentUuid: 'u1', isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
		uuid, timestamp: '2026-10-03T13:33:42.642Z', sessionId, ...(sessionKind !== undefined ? { sessionKind } : {}),
	}),
};

const ORIGINAL = '11111111-1111-4111-8111-111111111111';
const FORK = '22222222-2222-4222-8222-222222222222';

function forkTranscript(): string {
	// `/fork` の分岐先: 写した元の行にも、分岐先が書いた行にも sessionKind: "bg" が付く。
	return [
		line.aiTitle(FORK), line.agentName(FORK), line.snapshot(),
		line.user(FORK, 'u1', '調べて', 'bg'),
		line.assistant(FORK, 'a1', '調べました', 'bg'),
		'',
	].join('\n');
}

function interactiveTranscript(sessionId: string, text = '調べて'): string {
	return [line.aiTitle(sessionId), line.snapshot(), line.user(sessionId, 'u1', text), line.assistant(sessionId, 'a1', 'はい'), ''].join('\n');
}

suite('ParadisClaudeBackgroundSessions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	setup(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-claude-bg-')));
	});
	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('reads sessionKind only from the top level of conversation lines', () => {
		assert.deepStrictEqual([
			paradisClaudeTranscriptLinesAreBackground(forkTranscript().split('\n')),
			paradisClaudeTranscriptLinesAreBackground(interactiveTranscript(ORIGINAL).split('\n')),
			// 本文に `"sessionKind":"bg"` という文字列が出るだけの会話（この不具合を調べている会話など）
			paradisClaudeTranscriptLinesAreBackground(interactiveTranscript(ORIGINAL, '{"sessionKind":"bg"} を見る').split('\n')),
			// 題名・スナップショットの行だけでは決まらない
			paradisClaudeTranscriptLinesAreBackground([line.aiTitle(FORK), line.snapshot()]),
			// 壊れた行は飛ばす
			paradisClaudeTranscriptLinesAreBackground(['{"sessionId":', line.user(FORK, 'u1', 'x', 'bg')]),
		], [true, false, false, undefined, true]);
	});

	test('decides from the newest lines first, so a forked session resumed in a pane is a pane session again', async () => {
		const fork = join(root, 'fork.jsonl');
		const interactive = join(root, 'interactive.jsonl');
		const resumedInPane = join(root, 'resumed.jsonl');
		const hugeTail = join(root, 'huge-tail.jsonl');
		const hugeOnly = join(root, 'huge-only.jsonl');
		const hugePaneLineAfterFork = join(root, 'huge-pane-line.jsonl');
		const hugeBgOnly = join(root, 'huge-bg-only.jsonl');
		const metadataOnly = join(root, 'metadata-only.jsonl');
		const missing = join(root, 'missing.jsonl');
		const huge = 'x'.repeat(100 * 1024);
		await writeFile(fork, forkTranscript());
		await writeFile(interactive, interactiveTranscript(ORIGINAL));
		// 分岐先をペインで `claude --resume` し直した: 先頭は bg のまま、末尾はペインの行
		await writeFile(resumedInPane, forkTranscript() + [line.user(FORK, 'u2', '続けて'), line.assistant(FORK, 'a2', 'はい'), ''].join('\n'));
		// 末尾の 1 行が窓（64KB）より長い bg の行: 行の終わりの sessionKind で決める
		await writeFile(hugeTail, forkTranscript() + line.assistant(FORK, 'a3', huge, 'bg') + '\n');
		// 窓より長い行しか無く、sessionKind も無い: 決まらない
		await writeFile(hugeOnly, line.user(ORIGINAL, 'u1', huge) + '\n');
		// 末尾の巨大な行はペインの行（sessionKind 無し）で決まらず、先頭の bg で決まる
		await writeFile(hugePaneLineAfterFork, forkTranscript() + line.assistant(FORK, 'a3', huge) + '\n');
		// 窓より長い行しか無いが、行の終わりに最上位の sessionKind がある
		await writeFile(hugeBgOnly, line.user(FORK, 'u1', huge, 'bg') + '\n');
		// 会話の行がまだ無い（ファイル全体を読み切れた）
		await writeFile(metadataOnly, [line.aiTitle(ORIGINAL), line.snapshot(), ''].join('\n'));
		const paths = [fork, interactive, resumedInPane, hugeTail, hugeOnly, hugePaneLineAfterFork, hugeBgOnly, metadataOnly, missing];
		assert.deepStrictEqual({
			kinds: await Promise.all(paths.map(paradisClaudeTranscriptSessionKind)),
			// hook の経路は、決まらないときは daemon の会話とみなさない
			background: await Promise.all(paths.map(paradisClaudeTranscriptIsBackground)),
		}, {
			kinds: ['bg', 'pane', 'pane', 'bg', undefined, 'bg', 'bg', 'pane', undefined],
			background: [true, false, false, true, false, true, true, false, false],
		});
	});

	test('reads a top-level sessionKind from the end of a line that does not fit in the window', () => {
		assert.deepStrictEqual([
			paradisClaudeTranscriptLineEndIsBackground('xxxx","version":"2.1.287","gitBranch":"main","sessionKind":"bg"}'),
			paradisClaudeTranscriptLineEndIsBackground('xxxx","gitBranch":"main","sessionKind":"interactive"}'),
			// 入れ子のオブジェクトの最後のキー（最上位ではない）
			paradisClaudeTranscriptLineEndIsBackground('xxxx","meta":{"sessionKind":"bg"}}'),
			paradisClaudeTranscriptLineEndIsBackground('xxxx","gitBranch":"main"}'),
		], [true, false, undefined, undefined]);
	});

	test('selects the transcript of claude attach <id> by a session id prefix', () => {
		const entry = (transcriptPath: string, mtime: number) => ({ transcriptPath, mtime });
		const a = entry('/p/-repo/52a3701d-a5b0-4252-99f9-e155af08db4d.jsonl', 10);
		const sameIdElsewhere = entry('/p/-other/52a3701d-a5b0-4252-99f9-e155af08db4d.jsonl', 20);
		const otherId = entry('/p/-repo/52a3701d-ffff-4252-99f9-e155af08db4d.jsonl', 30);
		const unrelated = entry('/p/-repo/98ccdd90-e050-46dd-b36c-a476c5aeb5eb.jsonl', 40);
		assert.deepStrictEqual([
			paradisSelectClaudeTranscriptByIdPrefix([a, unrelated], '52a3701d'),
			paradisSelectClaudeTranscriptByIdPrefix([a, unrelated], '52A3701D'),
			paradisSelectClaudeTranscriptByIdPrefix([a, unrelated], '52a3701d-a5b0-4252-99f9-e155af08db4d'),
			// 同じ会話 id が別の作業フォルダにもある: 最後に更新された方
			paradisSelectClaudeTranscriptByIdPrefix([a, sameIdElsewhere], '52a3701d'),
			// 一致する会話 id が 2 つ: 決めない
			paradisSelectClaudeTranscriptByIdPrefix([a, otherId], '52a3701d'),
			// 見つからない
			paradisSelectClaudeTranscriptByIdPrefix([unrelated], '52a3701d'),
			// 8 桁より短い・形が違う id は受け付けない
			paradisSelectClaudeTranscriptByIdPrefix([a], '52a'),
			paradisSelectClaudeTranscriptByIdPrefix([a], '52a3701'),
			paradisSelectClaudeTranscriptByIdPrefix([a], '../52a3701d'),
		], [a, a, a, sameIdElsewhere, undefined, undefined, undefined, undefined, undefined]);
	});

	test('finds the attached transcript in the pane folder first, then in every project folder', async () => {
		const projects = join(root, 'projects');
		const paneDir = join(projects, '-pane');
		const otherDir = join(projects, '-other');
		await mkdir(paneDir, { recursive: true });
		await mkdir(otherDir, { recursive: true });
		await writeFile(join(paneDir, `${ORIGINAL}.jsonl`), interactiveTranscript(ORIGINAL));
		await writeFile(join(otherDir, `${FORK}.jsonl`), forkTranscript());
		await writeFile(join(paneDir, '33333333-aaaa-4333-8333-333333333333.jsonl'), '');
		await writeFile(join(paneDir, '33333333-bbbb-4333-8333-333333333333.jsonl'), '');
		await writeFile(join(otherDir, '33333333-cccc-4333-8333-333333333333.jsonl'), '');
		const find = async (prefix: string) => (await paradisFindClaudeTranscriptByIdPrefix(projects, paneDir, prefix))?.transcriptPath;
		assert.deepStrictEqual([
			await find('11111111'),
			// ペインの作業フォルダに無い会話（attach はどこからでも打てる）
			await find('22222222'),
			(await paradisFindClaudeTranscriptByIdPrefix(projects, paneDir, '22222222'))?.sessionId,
			// ペインの作業フォルダで決められないときは、ほかのフォルダへ広げない
			await find('33333333'),
			await find('44444444'),
		], [join(paneDir, `${ORIGINAL}.jsonl`), join(otherDir, `${FORK}.jsonl`), FORK, undefined, undefined]);
	});

	test('scans every project folder only when the pane folder has no match', async () => {
		const projects = join(root, 'projects');
		const paneDir = join(projects, '-pane');
		await mkdir(paneDir, { recursive: true });
		await writeFile(join(paneDir, `${ORIGINAL}.jsonl`), interactiveTranscript(ORIGINAL));
		const scanned: string[] = [];
		const scanAll = async (prefix: string) => {
			scanned.push(prefix);
			return [];
		};
		const inPane = await paradisFindClaudeTranscriptByIdPrefix(projects, paneDir, '11111111', scanAll);
		const elsewhere = await paradisFindClaudeTranscriptByIdPrefix(projects, paneDir, '22222222', scanAll);
		assert.deepStrictEqual({ inPane: inPane?.sessionId, elsewhere, scanned }, { inPane: ORIGINAL, elsewhere: undefined, scanned: ['22222222'] });
	});

	test('excludes sessions seen in other panes, nested agents and the daemon from a pane reconciliation', () => {
		const sightings = new ParadisHookTranscriptSightings(1_000);
		sightings.note('/own.jsonl', 'pane-a', 'root', 0);
		sightings.note('/other.jsonl', 'pane-b', 'root', 0);
		sightings.note('/child.jsonl', 'pane-a', 'nested', 0);
		sightings.note('/fork.jsonl', 'pane-a', 'background', 0);
		const rootFor = [sightings.isRootFor('/own.jsonl', 'pane-a'), sightings.isRootFor('/own.jsonl', 'pane-b'), sightings.isRootFor('/fork.jsonl', 'pane-a')];
		const forPaneA = [...sightings.excludedFor('pane-a', 500)].sort();
		sightings.forgetRoots('pane-b');
		const afterPaneBExited = [...sightings.excludedFor('pane-a', 500)].sort();
		const afterTtl = [...sightings.excludedFor('pane-a', 2_000)];
		assert.deepStrictEqual({ rootFor, forPaneA, afterPaneBExited, afterTtl }, {
			rootFor: [true, false, false],
			forPaneA: ['/child.jsonl', '/fork.jsonl', '/other.jsonl'],
			afterPaneBExited: ['/child.jsonl', '/fork.jsonl'],
			afterTtl: [],
		});
	});
});
