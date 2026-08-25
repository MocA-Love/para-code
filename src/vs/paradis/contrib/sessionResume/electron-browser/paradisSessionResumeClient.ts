/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../base/common/uri.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisResolveHostPath } from '../../../common/paradisHostPath.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisResumeListRequest, IParadisResumePreview, IParadisResumeSearchResult, IParadisResumeSession, IParadisResumeSpace, PARADIS_SESSION_RESUME_CHANNEL } from '../common/paradisSessionResume.js';

const MAX_MERGED_SESSIONS = 600;

/** list() に渡す空間。transcript を探すマシンを URI の scheme/authority から決めるため、cwd 文字列ではなく URI を持つ。 */
export interface IParadisResumeSpaceWithUri {
	readonly stateKey: string;
	readonly name: string;
	readonly uri: URI;
	readonly current: boolean;
}

export interface IParadisResumeListRequestWithUri {
	readonly spaces: readonly IParadisResumeSpaceWithUri[];
	readonly includeArchived?: boolean;
}

/**
 * セッション履歴のチャネルを「そのスペースがあるマシン」へ繋ぎ分ける。
 *
 * shared process 版は常に手元のマシンで動くため、SSH 接続先のスペースを渡しても手元の
 * ~/.claude・~/.codex を探しにいって何も見つからない。接続先の transcript は接続先の
 * REH サーバー（registerParadisSessionResumeForServer）へ問い合わせる必要がある。
 *
 * 手元とリモートのスペースが同じウィンドウに混在しうるため（統合フローで手元を選んだ場合や、
 * 手元のフォルダを追加した場合）、catalogId ごとに発行元のチャネルを覚えておき、preview・search
 * を必ず同じマシンへ返す。これを怠ると、別マシンの catalogId を誤って読みに行って
 * "Session is no longer available" になったり、最悪同名ハッシュで無関係な transcript を返しうる。
 */
export class ParadisSessionResumeClient {
	// list() が完了するまでは前回の結果を指す。in-flight の list を preview/search が手元へ
	// 誤って落とさないよう、更新は list() が settle してから丸ごと差し替える（部分更新しない）。
	private catalogHost = new Map<string, IChannel>();

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILogService private readonly logService: ILogService,
	) { }

	// `remoteAuthority` という名前で持つのは、そのまま `paradisResolveHostPath` の接続情報として
	// 渡せるようにするため（接続先の同定とパスの綴りを別々に書き下さない）。
	private hosts(): { local: IChannel; remote?: { channel: IChannel; remoteAuthority: string } } {
		const local = this.sharedProcessService.getChannel(PARADIS_SESSION_RESUME_CHANNEL);
		const connection = this.remoteAgentService.getConnection();
		if (!connection) {
			return { local };
		}
		return {
			local,
			remote: { channel: connection.getChannel(PARADIS_SESSION_RESUME_CHANNEL), remoteAuthority: connection.remoteAuthority.toLowerCase() },
		};
	}

	async list(request: IParadisResumeListRequestWithUri): Promise<readonly IParadisResumeSession[]> {
		const { local, remote } = this.hosts();
		const localSpaces: IParadisResumeSpace[] = [];
		const remoteSpaces: IParadisResumeSpace[] = [];
		for (const space of request.spaces) {
			// 別ホストの vscode-remote、または未接続なのに vscode-remote なスペースは、どちらの
			// マシンのものとも確証が持てないため、手元へ流さずスキップする（undefined が返る）。
			// fsPath は vscode-remote でもパスをそのまま返してしまい、無関係な手元の同名パスを
			// 拾いかねない。
			const resolved = paradisResolveHostPath(space.uri, remote);
			if (!resolved) {
				// 黙って落とすと「スペースはあるのに履歴だけ出ない」の切り分けができないので痕跡を残す。
				this.logService.trace(`[ParadisSessionResume] skipping a space that belongs to no reachable machine: ${space.uri.toString()}`);
				continue;
			}
			const resumeSpace: IParadisResumeSpace = { stateKey: space.stateKey, name: space.name, cwd: resolved.path, current: space.current };
			(resolved.host === 'remote' ? remoteSpaces : localSpaces).push(resumeSpace);
		}
		// 「呼び出さなかった（該当スペースが無い）」と「呼び出して失敗した」を区別するため、実際に
		// 呼び出したものだけを集める。区別しないと、片方のマシンにしかスペースが無い構成で、その
		// 唯一の呼び出しが失敗しても「もう片方は最初から成功扱い」でエラーが握り潰されてしまう。
		const attempts: { readonly channel: IChannel; readonly promise: Promise<readonly IParadisResumeSession[]> }[] = [];
		if (localSpaces.length > 0) {
			attempts.push({ channel: local, promise: this.callList(local, localSpaces, request.includeArchived) });
		}
		if (remote !== undefined && remoteSpaces.length > 0) {
			attempts.push({ channel: remote.channel, promise: this.callList(remote.channel, remoteSpaces, request.includeArchived) });
		}
		const results = await Promise.allSettled(attempts.map(attempt => attempt.promise));
		const sessions: IParadisResumeSession[] = [];
		const rejections: Error[] = [];
		results.forEach((result, index) => {
			const channel = attempts[index].channel;
			if (result.status === 'fulfilled') {
				// このマシン由来の古い記録を消してから、今回の結果で置き換える。失敗したマシンの
				// 記録には触れない（stale のままでも、"preview/search が丸ごと失効する"よりまし）。
				for (const [catalogId, existingChannel] of this.catalogHost) {
					if (existingChannel === channel) {
						this.catalogHost.delete(catalogId);
					}
				}
				for (const session of result.value) {
					this.catalogHost.set(session.catalogId, channel);
				}
				sessions.push(...result.value);
			} else {
				rejections.push(result.reason);
				// Warning, not error: when only one machine fails (e.g. an SSH host is down) the list
				// still renders with the other machine's sessions, so this is a silent partial result
				// rather than an outright failure — but it was previously invisible either way.
				reportParadisDiagnosticError('owned', 'session-resume', 'transcript-list-partial-failure', result.reason, {
					safe_failed_attempts: rejections.length,
					safe_total_attempts: attempts.length,
				}, 'warning');
				this.logService.warn('[ParadisSessionResume] a machine failed to list sessions', result.reason);
			}
		});
		if (attempts.length > 0 && rejections.length === attempts.length) {
			throw rejections[0];
		}
		return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_MERGED_SESSIONS);
	}

	private async callList(channel: IChannel, spaces: readonly IParadisResumeSpace[], includeArchived: boolean | undefined): Promise<readonly IParadisResumeSession[]> {
		const request: IParadisResumeListRequest = { spaces, includeArchived };
		return channel.call<readonly IParadisResumeSession[]>('list', [request]);
	}

	preview(catalogId: string, query?: string): Promise<IParadisResumePreview> {
		const channel = this.catalogHost.get(catalogId);
		if (!channel) {
			return Promise.reject(new Error('Session is no longer available.'));
		}
		return channel.call('preview', [catalogId, query]);
	}

	async search(query: string, catalogIds: readonly string[]): Promise<readonly IParadisResumeSearchResult[]> {
		const grouped = new Map<IChannel, string[]>();
		for (const catalogId of catalogIds) {
			const channel = this.catalogHost.get(catalogId);
			if (!channel) {
				continue;
			}
			const ids = grouped.get(channel);
			if (ids) {
				ids.push(catalogId);
			} else {
				grouped.set(channel, [catalogId]);
			}
		}
		const results = await Promise.all([...grouped.entries()].map(([channel, ids]) => channel.call<readonly IParadisResumeSearchResult[]>('search', [query, ids])));
		return results.flat();
	}
}
