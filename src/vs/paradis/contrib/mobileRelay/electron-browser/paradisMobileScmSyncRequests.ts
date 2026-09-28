/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { PARADIS_WORKTREE_GIT_CHANNEL } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisChannelHostResolver } from '../../workspaceSwitch/electron-browser/paradisWorktreeGitChannelClient.js';
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
	paradisIsUnsupportedBranchFormat,
	paradisMobilePushPlan,
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
 * - `commitSafe { ws, message, all }`: `all` なら `git add -A` の前にインデックスのファイルを控え（git channel の
 *   `backupIndex`）、コミットが失敗したら戻す。HEAD が動いていれば（フックの途中で止まってもコミットはできた）戻さずに
 *   成功として `warning` を付けて返す。失敗は `{ ok: false, failure }`（要約・伏せ字を入れた出力・id）で返す
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

/** インデックスのファイルの控えと復元（そのリポジトリがあるマシンの git channel。SSH 先の REH を含む）。 */
interface IIndexBackupHost {
	backup(): Promise<{ readonly token: string }>;
	restore(token: string): Promise<{ readonly restored: boolean; readonly reason?: string }>;
	discard(token: string): Promise<void>;
}

/** `accessor` は await の前でしか使えないので、処理の先頭で呼ぶ。 */
function indexBackupHost(accessor: ServicesAccessor, root: URI | undefined): IIndexBackupHost | undefined {
	const host = root !== undefined ? paradisChannelHostResolver(accessor, PARADIS_WORKTREE_GIT_CHANNEL, 'reject')(root) : undefined;
	if (host === undefined || root === undefined) {
		return undefined;
	}
	const path = host.path(root);
	return {
		backup: () => host.channel.call('backupIndex', [path]),
		restore: token => host.channel.call('restoreIndex', [path, token]),
		discard: token => host.channel.call('discardIndexBackup', [path, token]),
	};
}

/** 同じスペースの git の操作を1本ずつにして実行する。 */
function registerGitOperation(kind: string, run: (request: IParadisMobileRequest, context: IParadisMobileRequestContext, ws: string, index: IIndexBackupHost | undefined) => Promise<void>, usesIndexBackup = false): void {
	registerParadisMobileRequestHandler('scm', kind, {
		async handle(accessor, request, context) {
			// インデックスを控えるのは `git add -A` をするときだけ（ステージ済みだけのコミットは触らない）
			const index = usesIndexBackup && request.all === true ? indexBackupHost(accessor, context.root) : undefined;
			const ws = requireWorkspace(request, context);
			if (ws === undefined) {
				return;
			}
			const done = await gitGate.run(ws, async () => {
				await run(request, context, ws, index);
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
	const [branches, remotes] = await Promise.all([context.runGit(['branch', PARADIS_MOBILE_BRANCH_FORMAT]), context.runGit(['remote'])]);
	if (branches.code !== 0 && paradisIsUnsupportedBranchFormat(branches.stderr)) {
		context.reply({ error: 'PC の git が古いため push 先を確かめられません。PC で push してください（スマホからの push には git 2.22 以降が要ります）。', code: 'old-git' });
		return;
	}
	const current = branches.code === 0 ? paradisParseCurrentBranchUpstream(branches.stdout) : undefined;
	if (current === undefined) {
		context.reply({ error: 'いまのブランチが分からないため push できません（detached HEAD など）。PC で確かめてください。', code: 'no-branch' });
		return;
	}
	// git の push 先（@{push}）に従い、上流が別名・手元のときは断る。remote は `git remote` の名前だけを使う
	const names = remotes.code === 0 ? remotes.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0) : [];
	const plan = paradisMobilePushPlan(current, names);
	if (plan.kind === 'refuse') {
		context.reply({ error: plan.message, code: plan.code });
		return;
	}
	// 宛先を名指しして、push.default の設定（matching など）で他のブランチまで送らない
	const result = await context.runGit(plan.publish
		? ['push', '--porcelain', '--set-upstream', plan.remote, `HEAD:${plan.ref}`]
		: ['push', '--porcelain', plan.remote, `HEAD:${plan.ref}`]);
	if (result.code !== 0) {
		replySyncFailure(context, 'push', result.stderr, result.stdout);
		return;
	}
	context.reply({ t: 'push', ws, ...(await readBranchSync(context)), ...(plan.publish ? { published: true } : {}) });
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

/**
 * HEAD のコミット。`rev-parse --verify --quiet HEAD` が終了コード 1 で何も出さなければまだコミットが無い（`unborn`）。
 * それ以外の失敗・時間切れは `error`（HEAD が動いたかを見分けられないので、コミットを始めない・結果を決めない）。
 */
async function headCommit(context: IParadisMobileRequestContext): Promise<{ readonly kind: 'ok'; readonly sha: string } | { readonly kind: 'unborn' } | { readonly kind: 'error' }> {
	const result = await context.runGit(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => undefined);
	if (result === undefined) {
		return { kind: 'error' };
	}
	const sha = result.stdout.trim();
	if (result.code === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
		return { kind: 'ok', sha };
	}
	return result.code === 1 && sha.length === 0 && result.stderr.trim().length === 0 ? { kind: 'unborn' } : { kind: 'error' };
}

/** `git commit -m` の既定の整形（`--cleanup=whitespace`）に揃える: 行末の空白・前後の空行・続く空行をまとめる。 */
export function paradisNormalizeCommitMessage(message: string): string {
	return message.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** HEAD のコミットのメッセージが、送ったメッセージと同じか（HEAD を動かしたのが自分のコミットか）。 */
async function headHasMessage(context: IParadisMobileRequestContext, message: string): Promise<boolean> {
	const result = await context.runGit(['log', '-1', '--format=%B', 'HEAD']).catch(() => undefined);
	return result?.code === 0 && paradisNormalizeCommitMessage(result.stdout) === paradisNormalizeCommitMessage(message);
}

registerGitOperation('commitSafe', async (request, context, ws, index) => {
	const message = typeof request.message === 'string' ? request.message.trim() : '';
	if (message.length === 0 || message.length > MAX_COMMIT_MESSAGE) {
		context.reply({ error: message.length === 0 ? 'empty commit message' : 'コミットメッセージが長すぎます。' });
		return;
	}
	const all = request.all === true;
	// フックの途中で止まってもコミット自体はできていることがある（post-commit の時間切れなど）。HEAD が動いたかで見分ける。
	// HEAD を読めなければ、後で見分けられないのでコミットを始めない
	const headBefore = await headCommit(context);
	if (headBefore.kind === 'error') {
		context.reply({ error: 'いまの HEAD を確かめられなかったため、コミットしませんでした。PC で確かめてください。', code: 'head-unknown' });
		return;
	}
	// `git add -A` の前のインデックスをファイルごと控える（部分的なステージや sparse-checkout の印まで、そのまま戻せるように）
	let backup: string | undefined;
	if (all) {
		if (index === undefined) {
			context.reply({ error: 'This workspace is not reachable from this window.' });
			return;
		}
		try {
			backup = (await index.backup()).token;
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			context.reply(/method not found/i.test(text)
				? { error: '接続先の Para Code のサーバーが古いため、コミットに失敗したときにステージを戻せません。PC で接続し直すか、ステージしたものだけをコミットしてください。', code: 'old-server' }
				: { error: `ステージの状態を控えられなかったため、コミットしませんでした: ${paradisRedactMobileCommandOutput(text)}`, code: 'backup-failed' });
			return;
		}
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
	const headAfter = committed ? undefined : await headCommit(context);
	const headMoved = headAfter !== undefined && (headAfter.kind === 'error' || (headAfter.kind === 'ok' && (headBefore.kind !== 'ok' || headAfter.sha !== headBefore.sha)));
	// HEAD が動いた（または読めない）のに、それが送ったメッセージのコミットと確かめられなければ、ほかの誰かのコミットか
	// 分からない。控えから戻すとその後のインデックスを壊しうるので、戻さずに PC で確かめてもらう
	const ownCommit = headMoved && headAfter?.kind === 'ok' && await headHasMessage(context, message);
	if (headMoved && !ownCommit) {
		// 控えは消さない（`index.paradis-mobile-<uuid>` として残り、git channel が 10 分後に片付ける）
		await replyCommitFailure(context, ws, message, stderr, stdout, backup !== undefined, false);
		return;
	}
	if (committed || ownCommit) {
		if (backup !== undefined) {
			await index?.discard(backup).catch(() => undefined);
		}
		commitFailures.delete(ws);
		context.refreshBranches();
		const warning = committed ? undefined : paradisSummarizeMobileCommitFailure(stderr).kind === 'timeout'
			? 'コミットはできましたが、コミットの後のフックが時間内に終わりませんでした。PC で確かめてください。'
			: 'コミットはできましたが、コミットの後に git が失敗を返しました。PC で確かめてください。';
		context.reply({ t: 'commitSafe', ok: true, output: stdout.trim(), ...(warning !== undefined ? { warning } : {}) });
		return;
	}
	// 失敗したら、コミットの前のステージの状態へ戻す（フックが足した・消したステージも戻る）
	let restored = false;
	if (backup !== undefined) {
		const reset = await index?.restore(backup).catch(() => undefined);
		restored = reset?.restored === true;
	}
	await replyCommitFailure(context, ws, message, stderr, stdout, backup !== undefined, restored);
}, true);

async function replyCommitFailure(context: IParadisMobileRequestContext, ws: string, message: string, stderr: string, stdout: string, attemptedRestore: boolean, restored: boolean): Promise<void> {
	// フックの出力には秘密値（環境変数の中身・トークン）が出ることがある。スマホに出す前と依頼文に載せる前に伏せる
	const output = paradisTruncateMiddle(paradisRedactMobileCommandOutput([stderr.trim(), stdout.trim()].filter(part => part.length > 0).join('\n')), PARADIS_MOBILE_COMMIT_OUTPUT_LIMIT);
	const { kind, summary } = paradisSummarizeMobileCommitFailure(output);
	const [branch, files] = await Promise.all([
		context.runGit(['rev-parse', '--abbrev-ref', 'HEAD']).then(result => result.code === 0 ? result.stdout.trim() : undefined, () => undefined),
		changedFiles(context),
	]);
	const record: ICommitFailureRecord = { id: generateUuid(), kind, branch: branch === 'HEAD' ? undefined : branch, message, summary, output, files: files.files, moreFiles: files.more };
	commitFailures.set(ws, record);
	const failure: IParadisMobileCommitFailure = { id: record.id, kind, summary, output, restored: attemptedRestore && restored, ...(attemptedRestore && !restored ? { restoreFailed: true } : {}) };
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
