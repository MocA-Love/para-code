/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 差分の画面の Word の「差分」（scm.word-diff.v1）。PC の Word 差分（shared process の Office の比較と
// `paradisMobileWordDiffHtml.ts` の描画）を、スペースの中の相対パスと「比べる側」の指定だけで頼めるようにする。
//
// fs の `office/wordDiff` は比べる側を Office の source descriptor（絶対の URI）で受けるが、アプリはスペースの根の
// 絶対パスを知らない。ここでは PC が descriptor を組み立てる（アプリから URI を受け取らないので、スペースの外を指す余地も無い）。
//
// scm の `wordDiff` { ws, path, original: 'head' | 'index' | 'missing', modified: 'index' | 'worktree' | 'missing' }
// → `{ t: 'wordDiff', html, outcome, warnings }`。同じモバイルから次の要求が来たら前の比較は止め、前の要求には
// `{ error: 'superseded' }` を返す（アプリは静かに捨てる。応答の無いまま待たせない）。スペースの外を指すパスは `{ error: 'invalid path' }`。

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_OFFICE_CHANNEL, marshalParadisOfficeRequest, unmarshalParadisOfficeResponse } from '../../fileViewers/common/paradisOfficeChannel.js';
import { paradisNegotiateMobileOfficeHost } from './paradisMobileOfficeHost.js';
import type { ParadisOfficeSourceDescriptor } from '../../fileViewers/common/paradisOfficeProtocol.js';
import { paradisMobileRelativeSegments, paradisResolveMobileFileAt } from './paradisMobileFileAtRequests.js';
import { IParadisMobileRequestContext, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';
import { loadParadisMobileWordDiffBundle, renderParadisMobileWordDiffHtml } from './paradisMobileWordDiffHtml.js';

type OriginalSide = 'head' | 'index' | 'missing';
type ModifiedSide = 'index' | 'worktree' | 'missing';

function parseOriginal(value: unknown): OriginalSide | undefined {
	return value === 'head' || value === 'index' || value === 'missing' ? value : undefined;
}

function parseModified(value: unknown): ModifiedSide | undefined {
	return value === 'index' || value === 'worktree' || value === 'missing' ? value : undefined;
}

/**
 * 比べる 1 つの側の descriptor を作る。その側にファイルが無ければ `sideMissing`（新規・削除のファイル）。
 * スペースの外・読めないパスは undefined。
 */
export async function paradisMobileWordDiffDescriptor(
	context: Pick<IParadisMobileRequestContext, 'root' | 'resolvePath' | 'runGit'>,
	remoteAgentService: Pick<IRemoteAgentService, 'getConnection'> | undefined,
	path: string,
	side: OriginalSide | ModifiedSide,
	role: 'original' | 'modified',
): Promise<ParadisOfficeSourceDescriptor | undefined> {
	const segments = paradisMobileRelativeSegments(path);
	if (segments === undefined) {
		return undefined;
	}
	const displayName = segments[segments.length - 1];
	const missing: ParadisOfficeSourceDescriptor = { kind: 'sideMissing', displayName, side: role };
	if (side === 'missing') {
		return missing;
	}
	const uri = await paradisResolveMobileFileAt(context, remoteAgentService, path, side);
	if (uri === undefined) {
		// 作業ツリーで解決できないのはスペースの外（シンボリックリンク）か読めないパス。HEAD・インデックスに無いのは「その側に無い」
		return side === 'worktree' ? undefined : missing;
	}
	return side === 'worktree'
		? { kind: 'workingTree', uri: uri.toString(true), displayName, side: role }
		: { kind: side === 'head' ? 'gitCommit' : 'gitIndex', uri: uri.toString(true), ...(side === 'head' ? { revisionHint: 'HEAD' } : {}), displayName, side: role };
}

/** 置き換えられた要求に返すエラー（アプリはこれを表示せずに捨てる）。 */
export const PARADIS_MOBILE_WORD_DIFF_SUPERSEDED = 'superseded';

/** モバイル → 進めている比較と、その要求への返事（同じモバイルの次の要求で止め、`superseded` を返す）。 */
const operations = new Map<string, { readonly cancellation: CancellationTokenSource; readonly reply: (body: object) => void }>();

registerParadisMobileRequestHandler('scm', 'wordDiff', {
	handle(accessor, request, context) {
		const sharedProcessService = accessor.get(ISharedProcessService);
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const original = parseOriginal(request.original);
		const modified = parseModified(request.modified);
		if (typeof request.path !== 'string' || original === undefined || modified === undefined || (original === 'missing' && modified === 'missing')) {
			context.reply({ error: 'invalid wordDiff request' });
			return;
		}
		if (context.root === undefined) {
			context.reply({ error: `unknown workspace: ${request.ws ?? ''}` });
			return;
		}
		if (paradisMobileRelativeSegments(request.path) === undefined) {
			context.reply({ error: 'invalid path' });
			return;
		}
		const key = context.mobileId ?? '';
		const previous = operations.get(key);
		if (previous !== undefined) {
			previous.reply({ error: PARADIS_MOBILE_WORD_DIFF_SUPERSEDED });
			previous.cancellation.dispose(true);
		}
		const cancellation = new CancellationTokenSource();
		const operation = { cancellation, reply: (body: object) => context.reply(body) };
		operations.set(key, operation);
		const path = request.path;
		return (async () => {
			try {
				const [negotiation, originalSource, modifiedSource] = await Promise.all([
					paradisNegotiateMobileOfficeHost(sharedProcessService),
					paradisMobileWordDiffDescriptor(context, remoteAgentService, path, original, 'original'),
					paradisMobileWordDiffDescriptor(context, remoteAgentService, path, modified, 'modified'),
				]);
				// 待っている間に次の要求で置き換えられた（`superseded` は返し済み）
				if (cancellation.token.isCancellationRequested) {
					return;
				}
				if (negotiation === undefined) {
					context.reply({ error: localize('paradis.mobile.wordDiff.hostUnavailable', "Word Diff is unavailable on this PC.") });
					return;
				}
				if (originalSource === undefined || modifiedSource === undefined) {
					context.reply({ error: 'invalid path' });
					return;
				}
				const channel = sharedProcessService.getChannel(PARADIS_OFFICE_CHANNEL);
				const authority = negotiation.ownerCapability && negotiation.connectionEpoch
					? { ownerCapability: negotiation.ownerCapability, connectionEpoch: negotiation.connectionEpoch }
					: undefined;
				const bundle = await loadParadisMobileWordDiffBundle({
					request: async (officeRequest, token) => unmarshalParadisOfficeResponse(await channel.call('request', marshalParadisOfficeRequest(officeRequest, authority), token)),
				}, { original: originalSource, modified: modifiedSource, generation: 1, requestIdPrefix: `mobile-word:${generateUuid()}` }, cancellation.token);
				if (cancellation.token.isCancellationRequested) {
					return;
				}
				context.reply({ t: 'wordDiff', html: renderParadisMobileWordDiffHtml(bundle, generateUuid().replace(/-/g, '')), outcome: bundle.outcome, warnings: bundle.warnings });
			} catch {
				if (!cancellation.token.isCancellationRequested) {
					context.reply({ error: localize('paradis.mobile.wordDiff.unavailable', "Word Diff relay is unavailable."), action: 'retryOnPc' });
				}
			} finally {
				if (operations.get(key) === operation) {
					operations.delete(key);
					cancellation.dispose();
				}
			}
		})();
	},
});
