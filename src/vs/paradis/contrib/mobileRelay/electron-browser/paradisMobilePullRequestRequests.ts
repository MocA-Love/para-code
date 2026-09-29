/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { raceTimeout } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { PARADIS_WORKTREE_GIT_CHANNEL } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisChannelHostResolver } from '../../workspaceSwitch/electron-browser/paradisWorktreeGitChannelClient.js';
import { paradisRedactMobileCommandOutput } from '../common/paradisMobileOutputRedaction.js';
import { IParadisFailedCheckForPrompt, PARADIS_AGENT_PROMPT_MAX_LENGTH, paradisBuildFixChecksPrompt } from '../common/paradisMobileAgentPrompts.js';
import {
	IParadisPullRequestDetail,
	PARADIS_PR_FAILED_LOG_JOBS,
	ParadisPullRequestLookup,
	paradisFailedPullRequestChecks,
	paradisPullRequestMergeBlock,
	paradisPullRequestMergeOutcome,
} from '../common/paradisMobilePullRequest.js';
import { ParadisMobileSendGate, paradisAgentPromptServices, paradisDeliverAgentPrompt, paradisParseAgentPromptTarget } from './paradisMobileAgentPromptDelivery.js';
import { IParadisMobileRequest, IParadisMobileRequestContext, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/**
 * スマホのプルリクエストの画面（Orca W2-36、Q128 A）。`gh` はそのスペースの作業ツリーがあるマシン（SSH 先を含む）の
 * git channel で動かす（`getPullRequestDetail` / `getFailedJobLogs` / `mergePullRequest`）。
 *
 * - `prView { ws }`: PR の状態・CI のチェック・マージの判断に要る項目。PR を出せないときは `unavailable`（理由）。
 *   スマホは PR の画面を開いている間だけ取りに来る（GitHub の制限に触れないため）
 * - `prFixChecks { ws, number, target: 'auto' | 'new' }`: PC が PR を取り直し、失敗したチェックと、失敗した Actions の
 *   ジョブのログの末尾（3 ジョブまで、各 200 行まで）から依頼文を組み立てて、そのスペースのエージェントへ送る
 * - `prMerge { ws, number, headSha }`: PC が取り直した状態で、スマホが見た head と同じで、CI が通っていて、
 *   止める理由が無いときだけ `gh pr merge --match-head-commit` でマージする（方式はリポジトリの既定）。
 *   マージの後に PR を取り直し、まだ MERGED でなければ（マージキュー）`merged: false, queued: true` を返す
 */

/** マージの後に PR を取り直すのを待つ時間（ms）。 */
const POST_MERGE_LOOKUP_TIMEOUT_MS = 10_000;

/** スペースごとのマージ・送信の最中の印。 */
const gate = new ParadisMobileSendGate();

/** 取得・マージの呼び出し口（そのリポジトリがあるマシンの git channel）。 */
interface IPullRequestHost {
	lookup(): Promise<ParadisPullRequestLookup>;
	failedJobLogs(jobs: readonly { readonly jobId: string; readonly repo: string }[]): Promise<readonly { readonly jobId: string; readonly log?: string; readonly error?: string }[]>;
	merge(request: { readonly repo: string; readonly number: number; readonly headSha: string }): Promise<{ readonly method: string }>;
}

/** `accessor` は await の前でしか使えないので、処理の先頭で呼ぶ。届かないスペースなら undefined。 */
function pullRequestHost(accessor: ServicesAccessor, root: URI): IPullRequestHost | undefined {
	// 書き込み（マージ）もあるので、届かないリソースを手元へ流さない 'reject' で解決する
	const host = paradisChannelHostResolver(accessor, PARADIS_WORKTREE_GIT_CHANNEL, 'reject')(root);
	if (host === undefined) {
		return undefined;
	}
	const path = host.path(root);
	return {
		lookup: () => host.channel.call<ParadisPullRequestLookup>('getPullRequestDetail', [path]),
		failedJobLogs: jobs => host.channel.call('getFailedJobLogs', [path, jobs]),
		merge: request => host.channel.call('mergePullRequest', [path, request]),
	};
}

function requireWorkspace(request: IParadisMobileRequest, context: IParadisMobileRequestContext): string | undefined {
	if (typeof request.ws !== 'string' || request.ws.length === 0 || context.root === undefined) {
		context.reply({ error: `unknown workspace: ${request.ws ?? ''}` });
		return undefined;
	}
	return request.ws;
}

/** 古い接続先のサーバー（SSH）はこの呼び出しを知らない。 */
function describeLookupError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return /method not found/i.test(message) ? '接続先の Para Code のサーバーが古いため取得できません。PC で接続し直してください。' : paradisRedactMobileCommandOutput(message);
}

/** PR を取り直す。取れなければ応答して undefined。 */
async function freshDetail(host: IPullRequestHost, context: IParadisMobileRequestContext, number: unknown): Promise<IParadisPullRequestDetail | undefined> {
	let lookup: ParadisPullRequestLookup;
	try {
		lookup = await host.lookup();
	} catch (error) {
		context.reply({ error: describeLookupError(error) });
		return undefined;
	}
	if (lookup.kind !== 'ok') {
		context.reply({ error: 'PR を取得できませんでした。読み直してください。', code: lookup.reason });
		return undefined;
	}
	if (lookup.detail.number !== number) {
		context.reply({ error: 'このスペースの PR が変わりました。読み直してください。', code: 'changed' });
		return undefined;
	}
	return lookup.detail;
}

registerParadisMobileRequestHandler('scm', 'prView', {
	async handle(accessor, request, context) {
		const ws = requireWorkspace(request, context);
		const host = context.root !== undefined ? pullRequestHost(accessor, context.root) : undefined;
		if (ws === undefined) {
			return;
		}
		if (host === undefined) {
			context.reply({ error: 'This workspace is not reachable from this window.' });
			return;
		}
		let lookup: ParadisPullRequestLookup;
		try {
			lookup = await host.lookup();
		} catch (error) {
			context.reply({ t: 'prView', ws, unavailable: 'error', message: describeLookupError(error) });
			return;
		}
		context.reply(lookup.kind === 'ok'
			? { t: 'prView', ws, pr: lookup.detail }
			: { t: 'prView', ws, unavailable: lookup.reason, ...(lookup.message !== undefined ? { message: paradisRedactMobileCommandOutput(lookup.message) } : {}) });
	},
});

registerParadisMobileRequestHandler('scm', 'prFixChecks', {
	async handle(accessor, request, context) {
		const services = paradisAgentPromptServices(accessor);
		const ws = requireWorkspace(request, context);
		const root = context.root;
		const host = root !== undefined ? pullRequestHost(accessor, root) : undefined;
		if (ws === undefined || root === undefined) {
			return;
		}
		const target = paradisParseAgentPromptTarget(request.target, false);
		if (host === undefined || target === undefined || typeof request.number !== 'number') {
			context.reply({ error: host === undefined ? 'This workspace is not reachable from this window.' : 'invalid request' });
			return;
		}
		const outcome = await gate.run(ws, async () => {
			// 依頼文はスマホの見たものではなく、PC が取り直した状態から組み立てる
			const detail = await freshDetail(host, context, request.number);
			if (detail === undefined) {
				return 'replied' as const;
			}
			const failed = paradisFailedPullRequestChecks(detail.checks);
			if (failed.length === 0) {
				context.reply({ error: 'いま失敗しているチェックはありません。', code: 'no-failures' });
				return 'replied' as const;
			}
			const jobs = failed.flatMap(check => check.jobId !== undefined && check.repo !== undefined && check.repo.toLowerCase() === detail.repo.toLowerCase() ? [{ jobId: check.jobId, repo: check.repo }] : []).slice(0, PARADIS_PR_FAILED_LOG_JOBS);
			const logs = jobs.length > 0 ? await host.failedJobLogs(jobs).catch(() => []) : [];
			const forPrompt: IParadisFailedCheckForPrompt[] = failed.map(check => {
				const log = logs.find(entry => entry.jobId === check.jobId)?.log;
				// CI のログにはマスクされなかった秘密値が出ることがある。依頼文に載せる前に伏せる
				return log !== undefined ? { check, log: paradisRedactMobileCommandOutput(log) } : { check };
			});
			const prompt = paradisBuildFixChecksPrompt(detail, forPrompt);
			if (prompt.length > PARADIS_AGENT_PROMPT_MAX_LENGTH) {
				context.reply({ error: '依頼文が長すぎます。PC で頼んでください。', code: 'too-long' });
				return 'replied' as const;
			}
			return paradisDeliverAgentPrompt(services, ws, root, prompt, target, () => context.pushState());
		});
		if (outcome === undefined) {
			context.reply({ error: 'このスペースで PR の操作をしている最中です。終わってからもう一度試してください。', code: 'busy' });
			return;
		}
		if (outcome === 'replied') {
			return;
		}
		context.reply(outcome.ok
			? { t: 'prFixChecks', delivered: true, via: outcome.via, ...(outcome.title !== undefined ? { title: outcome.title } : {}) }
			: { t: 'prFixChecks', delivered: false, code: outcome.code, message: outcome.error });
	},
});

registerParadisMobileRequestHandler('scm', 'prMerge', {
	async handle(accessor, request, context) {
		const ws = requireWorkspace(request, context);
		const host = context.root !== undefined ? pullRequestHost(accessor, context.root) : undefined;
		if (ws === undefined) {
			return;
		}
		const headSha = typeof request.headSha === 'string' && /^[0-9a-f]{40}$/i.test(request.headSha) ? request.headSha.toLowerCase() : undefined;
		if (host === undefined || headSha === undefined || typeof request.number !== 'number') {
			context.reply({ error: host === undefined ? 'This workspace is not reachable from this window.' : 'invalid request' });
			return;
		}
		const done = await gate.run(ws, async () => {
			const detail = await freshDetail(host, context, request.number);
			if (detail === undefined) {
				return true;
			}
			// スマホが見た後に push されていれば、確かめていない内容なのでマージしない（gh も --match-head-commit で断る）
			if (detail.headSha !== headSha) {
				context.reply({ error: 'スマホで見た後に PR へ新しいコミットが push されました。読み直して確かめてからマージしてください。', code: 'head-changed' });
				return true;
			}
			const block = paradisPullRequestMergeBlock(detail);
			if (block !== undefined) {
				context.reply({ error: block.message, code: block.code });
				return true;
			}
			try {
				const result = await host.merge({ repo: detail.repo, number: detail.number, headSha });
				// gh はマージキューへ入れただけでも成功を返す。取り直して MERGED でなければ「キューに入れた」と返す
				// （`queued` は後から足した項目。古いアプリは読まずに、これまでどおり「マージしました」と出す）
				// 取り直しは待ちすぎない（スマホは 130 秒で諦める）。時間切れは「キューに入れた」として返す
				const after = await raceTimeout(host.lookup().catch(() => undefined), POST_MERGE_LOOKUP_TIMEOUT_MS);
				context.reply({ t: 'prMerge', ws, ...paradisPullRequestMergeOutcome(after, detail.number), method: result.method });
			} catch (error) {
				context.reply({ error: `マージできませんでした: ${describeLookupError(error)}`, code: 'merge-failed' });
			}
			return true;
		});
		if (done === undefined) {
			context.reply({ error: 'このスペースで PR の操作をしている最中です。終わってからもう一度試してください。', code: 'busy' });
		}
	},
});
