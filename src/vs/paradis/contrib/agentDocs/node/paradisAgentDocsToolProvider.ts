/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP サーバーへ資料のツール（list_docs・adopt_doc）を足すプロバイダ。shared process で動く。
// 台帳は shared process の資料のサービスが持つ。ペインのスペースのフォルダ・ファイルの有無と realpath・引き取りの確認は、
// 呼び出し元ペインのウィンドウ（paradisAgentDocsChannel.ts）へ頼む（接続先のファイルも IFileService で同じ形に扱えるため。
// shared process の fs は使わない）。
//
// 接続元: SSH の窓のペインからの呼び出しは SSH の戻り経路（tunnel）になるので、pane と tunnel を受け、確かめられない
// 接続（unverified）だけを断る（ポートの転送の道具と同じ）。ツールの戻り値に、ほかの会話の ID・会話の記録のパスは入れない。

import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, paradisMcpToolError as toolError, paradisMcpToolJson as toolJson } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	IParadisAdoptDocArgs,
	IParadisDocAdoptConfirm,
	IParadisDocInspectItem,
	IParadisDocInspectResult,
	IParadisDocRecord,
	IParadisListDocsArgs,
	PARADIS_AGENT_DOCS_CHANNEL,
	PARADIS_AGENT_DOCS_CONFIRM_METHOD,
	PARADIS_AGENT_DOCS_CONFIRM_TIMEOUT_MS,
	PARADIS_AGENT_DOCS_INSPECT_METHOD,
	PARADIS_AGENT_DOCS_TOOLS,
	PARADIS_LIST_DOCS_MAX,
	ParadisDocAdoptConfirmOutcome,
	paradisDecideAdopt,
	paradisDocBelongsToFolder,
	paradisDocKind,
	paradisDocLastActivity,
	paradisDocOwnerRelation,
	paradisIsInsideFolder,
	paradisIsVcsInternalPath,
	paradisNormalizeDocPath,
	paradisParseDocsToolCall,
} from '../common/paradisAgentDocs.js';
import { ParadisAgentDocsService } from './paradisAgentDocsService.js';

const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside a Para Code terminal pane (or from the SSH host of its window), so it refuses the request. Start this agent CLI from a terminal inside Para Code.';
const SESSION_UNKNOWN = (tool: string) => `${tool} was not run: Para Code does not know which agent session runs in this terminal yet (its hooks have not reported). Send one message in this terminal and retry.`;
const WINDOW_FAILURE_MESSAGE = 'Para Code could not reach the window of this terminal pane to check the files. Retry in a few seconds.';
const PANE_UNKNOWN_MESSAGE = 'Para Code could not find this terminal pane in its window (it may be restoring or closed). Retry in a few seconds.';
const CONFIRM_TIMEOUT_MESSAGE = 'Para Code did not get an answer in time. The user may not have answered the confirmation dialog. Call list_docs to see the current owners before asking again.';

/** adopt_doc の 1 件の結果。 */
type ParadisAdoptItemResult = 'adopted' | 'already_yours' | 'not_found' | 'unsupported_type' | 'outside_space' | 'denied' | 'approval_timed_out' | 'recently_denied' | 'busy' | 'unanswered';

export class ParadisAgentDocsToolProvider implements IParadisMcpToolProvider {

	constructor(private readonly _service: ParadisAgentDocsService) { }

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_AGENT_DOCS_TOOLS;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		const parsed = paradisParseDocsToolCall(name, args);
		if (parsed === undefined) {
			return undefined;
		}
		if (!context || await context.classifyCaller() === 'unverified') {
			return toolError(CALLER_UNVERIFIED_MESSAGE);
		}
		if (!parsed.ok) {
			return toolError(parsed.error);
		}
		await this._service.ledger.ready;
		return parsed.tool === 'list_docs'
			? this._listDocs(paneToken, parsed.args, context, signal)
			: this._adoptDocs(paneToken, parsed.args, context, signal);
	}

	private async _inspect(paneToken: string, items: readonly IParadisDocInspectItem[], context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<IParadisDocInspectResult | string> {
		const call = await context.callOwningWindow<IParadisDocInspectResult>({
			channelName: PARADIS_AGENT_DOCS_CHANNEL,
			method: PARADIS_AGENT_DOCS_INSPECT_METHOD,
			args: [paneToken, items],
			failureLabel: 'agent docs',
			failureMessage: WINDOW_FAILURE_MESSAGE,
		}, signal);
		if (!call.ok) {
			return call.error;
		}
		const value = call.value;
		if (!value || typeof value !== 'object' || !Array.isArray(value.files) || value.files.length !== items.length) {
			return WINDOW_FAILURE_MESSAGE;
		}
		return value.paneKnown ? value : PANE_UNKNOWN_MESSAGE;
	}

	private async _listDocs(paneToken: string, args: IParadisListDocsArgs, context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<unknown> {
		const pane = this._service.sessionOf(paneToken);
		let records: IParadisDocRecord[];
		if (args.scope === 'session') {
			if (pane === undefined) {
				return toolError(SESSION_UNKNOWN('list_docs'));
			}
			records = this._service.ledger.all().filter(record => record.owner?.session === pane.session);
		} else {
			const space = await this._inspect(paneToken, [], context, signal);
			if (typeof space === 'string') {
				return toolError(`list_docs was not run: ${space}`);
			}
			const folder = space.folder;
			if (folder === undefined) {
				return toolError('list_docs was not run: Para Code could not tell which space this terminal pane belongs to. Retry in a few seconds, or use scope "session".');
			}
			records = this._service.ledger.all().filter(record => paradisDocBelongsToFolder(record, folder));
		}
		// 未回答のコメントはまだ数えない（コメントは次の段で入る）。数える欄は形を先に決めておく
		if (args.onlyOpenComments) {
			records = [];
		}
		records.sort((a, b) => paradisDocLastActivity(b) - paradisDocLastActivity(a));
		const truncated = records.length > PARADIS_LIST_DOCS_MAX;
		const shown = records.slice(0, PARADIS_LIST_DOCS_MAX);
		const inspected = shown.length > 0 ? await this._inspect(paneToken, shown.map(record => ({ hostId: record.hostId, path: record.path })), context, signal) : undefined;
		const files = typeof inspected === 'object' ? inspected.files : undefined;
		return toolJson({
			scope: args.scope,
			docs: shown.map((record, index) => {
				const file = files?.[index];
				return {
					path: record.path,
					kind: record.kind,
					owner: paradisDocOwnerRelation(record.owner, pane?.session),
					registered_by: record.registeredBy,
					last_written: record.writes[0] !== undefined ? new Date(record.writes[0].at).toISOString() : null,
					open_comments: 0,
					exists: file?.exists === undefined ? null : file.exists && file.isFile !== false,
				};
			}),
			truncated,
		});
	}

	private async _adoptDocs(paneToken: string, args: IParadisAdoptDocArgs, context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<unknown> {
		const pane = this._service.sessionOf(paneToken);
		if (pane === undefined) {
			return toolError(SESSION_UNKNOWN('adopt_doc'));
		}
		const paths = args.paths.map(path => paradisNormalizeDocPath(path) ?? path);
		const inspected = await this._inspect(paneToken, paths.map(path => ({ path })), context, signal);
		if (typeof inspected === 'string') {
			return toolError(`adopt_doc was not run: ${inspected}`);
		}
		// ペインのファイルは、ウィンドウと同じ接続先にある（接続先のペインのパスは接続先のもの）
		const hostId = inspected.windowHostId;
		const results = new Map<string, { result: ParadisAdoptItemResult; previous?: string }>();
		const toConfirm: string[] = [];
		const toApply: string[] = [];
		paths.forEach((path, index) => {
			const file = inspected.files[index];
			const known = this._service.ledger.get(hostId, path);
			if (paradisDocKind(path) === undefined || paradisIsVcsInternalPath(path)) {
				results.set(path, { result: 'unsupported_type' });
				return;
			}
			if (file.exists !== true || file.isFile === false) {
				results.set(path, { result: 'not_found' });
				return;
			}
			// リンクを辿った先がスペースの外へ出るものは断る（台帳に既にあるものは別）
			const real = file.realPath !== undefined ? paradisNormalizeDocPath(file.realPath) ?? path : path;
			const inside = inspected.folder !== undefined && inspected.folder.hostId === hostId && paradisIsInsideFolder(path, inspected.folder.path) && paradisIsInsideFolder(real, inspected.folder.path);
			if (!inside && known === undefined) {
				results.set(path, { result: 'outside_space' });
				return;
			}
			const previous = paradisDocOwnerRelation(known?.owner, pane.session);
			switch (paradisDecideAdopt(known?.owner, pane.session, known?.owner !== undefined ? this._service.livenessOf(known.owner) : 'unknown')) {
				case 'already_yours':
					results.set(path, { result: 'already_yours', previous });
					return;
				case 'confirm':
					results.set(path, { result: 'denied', previous });
					toConfirm.push(path);
					return;
				default:
					results.set(path, { result: 'adopted', previous });
					toApply.push(path);
			}
		});
		if (toConfirm.length > 0) {
			const outcome = await this._confirm(paneToken, { names: toConfirm.map(path => path.split(/[\\/]/).pop() ?? path), ...(args.reason !== undefined ? { reason: args.reason } : {}) }, context, signal);
			const result = paradisAdoptResultForOutcome(outcome);
			for (const path of toConfirm) {
				results.set(path, { ...results.get(path), result });
				if (result === 'adopted') {
					toApply.push(path);
				}
			}
		}
		for (const path of toApply) {
			this._service.ledger.adopt(hostId, path, pane);
		}
		return toolJson({
			results: paths.map(path => {
				const entry = results.get(path)!;
				return {
					path,
					result: entry.result,
					...(entry.previous !== undefined ? { previous_owner: entry.previous } : {}),
					...(entry.result === 'adopted' || entry.result === 'already_yours' ? { open_comments: 0 } : {}),
				};
			}),
		});
	}

	private async _confirm(paneToken: string, request: IParadisDocAdoptConfirm, context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<ParadisDocAdoptConfirmOutcome | string> {
		const call = await context.callOwningWindow<ParadisDocAdoptConfirmOutcome>({
			channelName: PARADIS_AGENT_DOCS_CHANNEL,
			method: PARADIS_AGENT_DOCS_CONFIRM_METHOD,
			args: [paneToken, request],
			failureLabel: 'adopt_doc',
			failureMessage: WINDOW_FAILURE_MESSAGE,
			timeoutMs: PARADIS_AGENT_DOCS_CONFIRM_TIMEOUT_MS,
			timeoutMessage: CONFIRM_TIMEOUT_MESSAGE,
		}, signal);
		return call.ok ? call.value : call.error;
	}
}

/** 確認の答えを、adopt_doc の 1 件の結果へ写す。ウィンドウへ届かなかった（文字列）ときは時間切れとして扱う。 */
export function paradisAdoptResultForOutcome(outcome: ParadisDocAdoptConfirmOutcome | string): ParadisAdoptItemResult {
	switch (outcome) {
		case 'approve':
			return 'adopted';
		case 'recentlyDenied':
			return 'recently_denied';
		case 'busy':
			return 'busy';
		case 'unanswered':
			return 'unanswered';
		case 'denied':
		case 'cancelled':
		case 'paneUnknown':
			return 'denied';
		default:
			return 'approval_timed_out';
	}
}
