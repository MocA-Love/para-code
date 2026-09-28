/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { generateUuid } from '../../../../base/common/uuid.js';
import { paradisParseMobilePorcelainStatus } from '../common/paradisMobileDiffReview.js';
import { paradisRedactMobileCommandOutput } from '../common/paradisMobileOutputRedaction.js';
import {
	IParadisMobileBranchSync,
	IParadisMobileCommitFailure,
	PARADIS_MOBILE_BRANCH_FORMAT,
	PARADIS_MOBILE_COMMIT_OUTPUT_LIMIT,
	PARADIS_MOBILE_STAGE_MAX_PATHS,
	ParadisMobileCommitFailureKind,
	ParadisMobileSyncOperation,
	paradisBuildCommitFixPrompt,
	paradisClassifyMobileSyncFailure,
	paradisMobileCommitFailureIsFixable,
	paradisParseCurrentBranchUpstream,
	paradisParseMobileBranchSync,
	paradisSummarizeMobileCommitFailure,
	paradisTruncateMiddle,
} from '../common/paradisMobileScmSync.js';
import { ParadisMobileSendGate, paradisAgentPromptServices, paradisDeliverAgentPrompt, paradisParseAgentPromptTarget } from './paradisMobileAgentPromptDelivery.js';
import { IParadisMobileRequest, IParadisMobileRequestContext, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/**
 * スマホからの git の同期・コミットの失敗からの立て直し・ファイルごとのステージ（Orca W2-15、Q114 A）。
 *
 * - `push { ws }`: いまのブランチを上流へ（上流が無ければ origin へ公開して上流にする）。**強制 push はしない**
 *   （git channel の許可リストが `--force` 系・`+refspec` を弾く）。断られたら「取り込むか PC で解決」を返す
 * - `fetch { ws }` / `pull { ws }`: pull は `--ff-only` だけ（合流のコミットも rebase も作らない）
 *   どれも応答に `{ upstream, ahead, behind }`（status と同じ任意項目）を載せる
 * - `commitSafe { ws, message, all }`: `all` なら `git add -A` の前にインデックスを `write-tree` で控え、コミットが
 *   失敗したら `read-tree` で戻す。失敗は `{ ok: false, failure }`（要約・伏せ字を入れた出力・id）で返す
 * - `commitFix { ws, failureId, target: 'auto' | 'new' }`: PC が控えた失敗の記録から依頼文を組み立て、そのスペースの
 *   エージェントへ送る（いなければ既定のエージェントを起動。Q15-2）
 * - `stage { ws, paths }` / `unstage { ws, paths }`: ファイルごとのステージ
 *
 * 同じスペースの git の操作は1本ずつ（iPhone と iPad、連打で push とコミットが重ならないように）。
 */

/** スペースごとの git の操作中の印。 */
const gitGate = new ParadisMobileSendGate();
/** スペースごとのエージェントへの送信中の印。 */
const sendGate = new ParadisMobileSendGate();

const BUSY_MESSAGE = 'このスペースで別の git の操作をしています。終わってからもう一度試してください。';

/** コミットの失敗の記録（`commitFix` で依頼文を組み立てる材料。スマホから届いた文章は使わない）。 */
interface ICommitFailureRecord {
	readonly id: string;
	readonly kind: ParadisMobileCommitFailureKind;
	readonly branch: string | undefined;
	readonly message: string;
	readonly summary: string;
	readonly output: string;
	readonly files: readonly string[];
	readonly moreFiles: number;
}

/** スペースごとの最後のコミットの失敗（ウィンドウを閉じれば消える。成功したら消す）。 */
const commitFailures = new Map<string, ICommitFailureRecord>();

/** 依頼文に並べるファイルの数。 */
const PROMPT_FILES = 50;
/** コミットメッセージの上限（文字）。 */
const MAX_COMMIT_MESSAGE = 20_000;

function requireWorkspace(request: IParadisMobileRequest, context: IParadisMobileRequestContext): string | undefined {
	if (typeof request.ws !== 'string' || request.ws.length === 0 || context.root === undefined) {
		context.reply({ error: `unknown workspace: ${request.ws ?? ''}` });
		return undefined;
	}
	return request.ws;
}

/** 同期の状態を読み直す（読めなければ空。任意項目なので操作の応答は返す）。 */
async function readBranchSync(context: IParadisMobileRequestContext): Promise<IParadisMobileBranchSync> {
	const result = await context.runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=no']).catch(() => undefined);
	return result?.code === 0 ? paradisParseMobileBranchSync(result.stdout) : {};
}

/** 同じスペースの git の操作を1本ずつにして実行する。 */
function registerGitOperation(kind: string, run: (request: IParadisMobileRequest, context: IParadisMobileRequestContext, ws: string) => Promise<void>): void {
	registerParadisMobileRequestHandler('scm', kind, {
		async handle(_accessor, request, context) {
			const ws = requireWorkspace(request, context);
			if (ws === undefined) {
				return;
			}
			const done = await gitGate.run(ws, async () => {
				await run(request, context, ws);
				return true;
			});
			if (done === undefined) {
				context.reply({ error: BUSY_MESSAGE, code: 'busy' });
			}
		},
	});
}

/** 同期の失敗を応答する（出力は伏せ字を入れてから読む）。 */
function replySyncFailure(context: IParadisMobileRequestContext, operation: ParadisMobileSyncOperation, stderr: string, stdout: string): void {
	const failure = paradisClassifyMobileSyncFailure(operation, paradisRedactMobileCommandOutput(`${stderr}\n${stdout}`));
	context.reply({ error: failure.message, code: failure.code });
}

registerGitOperation('push', async (_request, context, ws) => {
	const branches = await context.runGit(['branch', PARADIS_MOBILE_BRANCH_FORMAT]);
	const current = branches.code === 0 ? paradisParseCurrentBranchUpstream(branches.stdout) : undefined;
	if (current === undefined) {
		context.reply({ error: 'いまのブランチが分からないため push できません（detached HEAD など）。PC で確かめてください。', code: 'no-branch' });
		return;
	}
	let args: string[];
	if (current.remote !== undefined && current.remoteRef !== undefined) {
		// 上流の名前を明示して、push.default の設定（matching など）で他のブランチまで送らない
		args = ['push', '--porcelain', current.remote, `HEAD:${current.remoteRef}`];
	} else {
		// 上流が無い（まだ公開していない）ブランチは、origin（無ければ唯一の remote）へ同じ名前で公開して上流にする
		const remotes = await context.runGit(['remote']);
		const names = remotes.code === 0 ? remotes.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0) : [];
		const remote = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : undefined;
		if (remote === undefined) {
			context.reply({ error: names.length === 0 ? 'リモートがありません。PC でリモートを設定してください。' : 'push 先のリモートを決められません。PC で上流を設定してください。', code: 'no-upstream' });
			return;
		}
		args = ['push', '--porcelain', '--set-upstream', remote, `HEAD:refs/heads/${current.branch}`];
	}
	const result = await context.runGit(args);
	if (result.code !== 0) {
		replySyncFailure(context, 'push', result.stderr, result.stdout);
		return;
	}
	context.reply({ t: 'push', ws, ...(await readBranchSync(context)), ...(current.remote === undefined ? { published: true } : {}) });
});

registerGitOperation('fetch', async (_request, context, ws) => {
	const result = await context.runGit(['fetch', '--quiet']);
	if (result.code !== 0) {
		replySyncFailure(context, 'fetch', result.stderr, result.stdout);
		return;
	}
	context.reply({ t: 'fetch', ws, ...(await readBranchSync(context)) });
});

registerGitOperation('pull', async (_request, context, ws) => {
	const before = await readBranchSync(context);
	if (before.upstream === undefined) {
		context.reply({ error: 'このブランチには上流（追跡するリモートのブランチ）がありません。', code: 'no-upstream' });
		return;
	}
	// 進められないとき（履歴が分かれている）は失敗させ、PC で解決してもらう（合流も rebase もしない）
	const result = await context.runGit(['pull', '--ff-only', '--no-rebase', '--quiet']);
	if (result.code !== 0) {
		replySyncFailure(context, 'pull', result.stderr, result.stdout);
		return;
	}
	context.reply({ t: 'pull', ws, ...(await readBranchSync(context)) });
});

/** いま変更のあるファイル（依頼文に並べる）。 */
async function changedFiles(context: IParadisMobileRequestContext): Promise<{ readonly files: readonly string[]; readonly more: number }> {
	const status = await context.runGit(['status', '--porcelain=v1']).catch(() => undefined);
	const paths = status?.code === 0 ? paradisParseMobilePorcelainStatus(status.stdout).map(file => `${file.x}${file.y} ${file.path}`) : [];
	return { files: paths.slice(0, PROMPT_FILES), more: Math.max(0, paths.length - PROMPT_FILES) };
}

registerGitOperation('commitSafe', async (request, context, ws) => {
	const message = typeof request.message === 'string' ? request.message.trim() : '';
	if (message.length === 0 || message.length > MAX_COMMIT_MESSAGE) {
		context.reply({ error: message.length === 0 ? 'empty commit message' : 'コミットメッセージが長すぎます。' });
		return;
	}
	const all = request.all === true;
	// `git add -A` の前のインデックスを控える（部分的にステージした内容まで、そのまま戻せるように）
	let savedTree: string | undefined;
	if (all) {
		const snapshot = await context.runGit(['write-tree']);
		const tree = snapshot.stdout.trim();
		if (snapshot.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) {
			// 競合が残っている（unmerged）とツリーを作れない。コミットもできないので、何も変えずに返す
			await replyCommitFailure(context, ws, message, snapshot.stderr, snapshot.stdout, false, undefined);
			return;
		}
		savedTree = tree;
	}
	let stderr = '';
	let stdout = '';
	let committed = false;
	try {
		const added = all ? await context.runGit(['add', '-A']) : undefined;
		const result = added === undefined || added.code === 0 ? await context.runGit(['commit', '-m', message]) : added;
		committed = result === added ? false : result.code === 0;
		stderr = result.stderr;
		stdout = result.stdout;
	} catch (error) {
		stderr = error instanceof Error ? error.message : String(error);
	}
	if (committed) {
		commitFailures.delete(ws);
		context.reply({ t: 'commitSafe', ok: true, output: stdout.trim() });
		return;
	}
	// 失敗したら、コミットの前のステージの状態へ戻す（フックが足した・消したステージも戻る）
	let restored = false;
	if (savedTree !== undefined) {
		const reset = await context.runGit(['read-tree', savedTree]).catch(() => undefined);
		restored = reset?.code === 0;
	}
	await replyCommitFailure(context, ws, message, stderr, stdout, restored, savedTree);
});

async function replyCommitFailure(context: IParadisMobileRequestContext, ws: string, message: string, stderr: string, stdout: string, restored: boolean, savedTree: string | undefined): Promise<void> {
	// フックの出力には秘密値（環境変数の中身・トークン）が出ることがある。スマホに出す前と依頼文に載せる前に伏せる
	const output = paradisTruncateMiddle(paradisRedactMobileCommandOutput([stderr.trim(), stdout.trim()].filter(part => part.length > 0).join('\n')), PARADIS_MOBILE_COMMIT_OUTPUT_LIMIT);
	const { kind, summary } = paradisSummarizeMobileCommitFailure(output);
	const [branch, files] = await Promise.all([
		context.runGit(['rev-parse', '--abbrev-ref', 'HEAD']).then(result => result.code === 0 ? result.stdout.trim() : undefined, () => undefined),
		changedFiles(context),
	]);
	const record: ICommitFailureRecord = { id: generateUuid(), kind, branch: branch === 'HEAD' ? undefined : branch, message, summary, output, files: files.files, moreFiles: files.more };
	commitFailures.set(ws, record);
	const failure: IParadisMobileCommitFailure = { id: record.id, kind, summary, output, restored: savedTree !== undefined && restored };
	context.reply({ t: 'commitSafe', ok: false, failure });
}

/** 依頼文の上限（文字）。出力は 12,000 字までに切っているので、通常は届かない。 */
const MAX_PROMPT_LENGTH = 40_000;

registerParadisMobileRequestHandler('scm', 'commitFix', {
	async handle(accessor, request, context) {
		const services = paradisAgentPromptServices(accessor);
		const ws = requireWorkspace(request, context);
		const root = context.root;
		if (ws === undefined || root === undefined) {
			return;
		}
		const target = paradisParseAgentPromptTarget(request.target, false);
		if (target === undefined || typeof request.failureId !== 'string') {
			context.reply({ error: 'invalid request' });
			return;
		}
		const record = commitFailures.get(ws);
		if (record === undefined || record.id !== request.failureId) {
			context.reply({ error: 'コミットの失敗の記録が PC に残っていません。もう一度コミットしてから頼んでください。', code: 'gone' });
			return;
		}
		if (!paradisMobileCommitFailureIsFixable(record.kind)) {
			context.reply({ error: 'この失敗はエージェントに直してもらうものではありません。', code: 'not-fixable' });
			return;
		}
		const prompt = paradisBuildCommitFixPrompt({ branch: record.branch, message: record.message, summary: record.summary, output: record.output, files: record.files, moreFiles: record.moreFiles });
		if (prompt.length > MAX_PROMPT_LENGTH) {
			context.reply({ error: '依頼文が長すぎます。PC で頼んでください。', code: 'too-long' });
			return;
		}
		const outcome = await sendGate.run(ws, () => paradisDeliverAgentPrompt(services, ws, root, prompt, target, () => context.pushState()));
		if (outcome === undefined) {
			context.reply({ error: 'このスペースのエージェントへ送っている最中です。終わってからもう一度試してください。', code: 'sending' });
			return;
		}
		context.reply(outcome.ok
			? { t: 'commitFix', delivered: true, via: outcome.via, ...(outcome.title !== undefined ? { title: outcome.title } : {}) }
			: { t: 'commitFix', delivered: false, code: outcome.code, message: outcome.error });
	},
});

/** `stage` / `unstage` の `paths` を読む（引用付きのパスは status の表記と実際の名前が違うので受けない）。 */
function parsePaths(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > PARADIS_MOBILE_STAGE_MAX_PATHS) {
		return undefined;
	}
	const paths: string[] = [];
	for (const path of value) {
		if (typeof path !== 'string' || path.length === 0 || path.length > 4_096 || path.includes('\0') || path.startsWith('/') || path.startsWith('"')) {
			return undefined;
		}
		if (!paths.includes(path)) {
			paths.push(path);
		}
	}
	return paths;
}

function registerStageOperation(kind: 'stage' | 'unstage'): void {
	registerGitOperation(kind, async (request, context, ws) => {
		const paths = parsePaths(request.paths);
		if (paths === undefined) {
			context.reply({ error: 'invalid paths' });
			return;
		}
		const status = await context.runGit(['status', '--porcelain=v1']);
		if (status.code !== 0) {
			context.reply({ error: status.stderr.trim() || 'git status failed' });
			return;
		}
		const byPath = new Map(paradisParseMobilePorcelainStatus(status.stdout).map(file => [file.path, file]));
		const pathspecs: string[] = [];
		const done: string[] = [];
		const skipped: string[] = [];
		for (const path of paths) {
			const file = byPath.get(path);
			// 変更の一覧に無い（コミット・破棄された）ものと、外す側・足す側に何も無いものは触らない
			const applicable = file !== undefined && (kind === 'stage' ? file.y !== ' ' : file.x !== ' ' && file.x !== '?');
			if (!applicable) {
				skipped.push(path);
				continue;
			}
			done.push(path);
			// 名前を変えたファイルを外すときは、元の名前の側（削除として入っている）も外す
			for (const target of kind === 'unstage' && file.oldPath !== undefined ? [path, file.oldPath] : [path]) {
				// `:(literal)` でパスの記法（`*` や先頭の `:` など）を読ませない
				pathspecs.push(`:(literal)${target}`);
			}
		}
		if (pathspecs.length > 0) {
			const result = await context.runGit(kind === 'stage' ? ['add', '--', ...pathspecs] : ['restore', '--staged', '--', ...pathspecs]);
			if (result.code !== 0) {
				context.reply({ error: paradisRedactMobileCommandOutput(result.stderr).trim() || `git ${kind} failed` });
				return;
			}
		}
		context.reply({ t: kind, ws, done, skipped });
	});
}

registerStageOperation('stage');
registerStageOperation('unstage');
