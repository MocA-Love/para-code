/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP のポートの転送の道具の、ウィンドウ側の受け口。shared process の ParadisPortToolProvider が
// 「呼び出し元ペインを所有するウィンドウ」だけへ送るので、扱うのはこの窓（SSH の窓）の転送だけになる。
//
// 変える操作（追加・外す・張り直す・片付け）は、毎回ページ共有と同じ承認のダイアログ
// （IParadisAgentBrowserTabsService.askApproval）で何を・いくつ変えるかを見せ、承認されたときだけ行う。
// 承認を待つ間に台帳が変わりうるので、承認の後に台帳を読み直し、「見せた対象」で「今もある」ものだけを変える。
// 手元の受け口は 127.0.0.1 だけにする（`remote.localPortHost` が allInterfaces の窓では張らない。張った後も確かめる）。
// リモートのホストは localhost だけを扱う。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { isLocalhost, RemoteTunnel, TunnelProtocol } from '../../../../platform/tunnel/common/tunnel.js';
import { Attributes, CandidatePort, Tunnel, TunnelProperties, TunnelSource, UserTunnelSource } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { ParadisChannelArgs } from '../../../common/paradisChannelArgs.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentApprovalRequest, ParadisAgentApprovalOutcome } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { PARADIS_PORT_TOOLS_METHOD, ParadisPortCleanUpMode, ParadisPortToolRequest, ParadisPortToolResult, paradisIsValidPort } from '../common/paradisPortTools.js';

/** 確認のダイアログに並べる転送の行の上限。超えた分は「ほか N 件」にまとめる。 */
const DIALOG_MAX_ROWS = 20;
/** ダイアログに出すラベルとプロセスの最大文字数（エージェントや SSH 先が決められる文字列なので長さも切る）。 */
const DIALOG_TEXT_MAX_LENGTH = 80;
/** 拒否の後の自動の断りを数える単位（ページ共有・端末の要求は止めない）。 */
const APPROVAL_COOLDOWN_KEY = 'port-forward';

const PANE_UNRESOLVED_MESSAGE = 'Para Code could not find the terminal pane of this request in its window (it may have been closed).';
const NOT_SSH_MESSAGE = 'This terminal pane belongs to a Para Code window that is not connected over SSH, so there are no port forwards for these tools to use. They only work for agents in a terminal of an SSH window.';
const LOCAL_HOST_MESSAGE = 'Para Code only opens port forwards that listen on 127.0.0.1, but this window is set to listen on all network interfaces (the user setting "remote.localPortHost" is "allInterfaces"). Nothing was changed. Ask the user to forward the port from the Ports panel.';
const NOT_DETECTED_MESSAGE = 'This window has not detected which remote ports have a listening process yet (for example "remote.autoForwardPortsSource" is "output"), so Para Code cannot tell which forwards are unused and does not clean them up. Nothing was changed.';

/** 承認以外の答えのときにエージェントへ返す英文。 */
const REFUSALS: Readonly<Record<Exclude<ParadisAgentApprovalOutcome, 'approve' | 'alternative'> | 'timedOut', string>> = {
	'denied': 'The user declined, so nothing was changed. Do not ask again for this; ask the user in the conversation if needed.',
	'recentlyDenied': 'The user declined a port forwarding change a short while ago, so Para Code turned this one down without asking. Nothing was changed. Ask the user in the conversation.',
	'busy': 'Another request from this terminal pane is waiting for the user. Nothing was changed. Wait for it to finish, then try again.',
	'unanswered': 'Para Code could not get a clear answer: the dialog was answered right after it appeared or with a keyboard shortcut. Nothing was changed. Ask the user to click a button in the dialog, then ask again.',
	'cancelled': 'The request was cancelled before the user answered, so nothing was changed.',
	'timedOut': 'The user did not answer the confirmation dialog in time, so nothing was changed. Ask the user in the conversation before asking again.',
};

/** ウィンドウの転送の台帳と操作のうち、道具が使う部分（テストでは差し替える）。 */
export interface IParadisPortToolsWindow {
	/** この窓の接続先（`ssh-remote+<host>` など）。手元の窓なら undefined。 */
	readonly remoteAuthority: string | undefined;
	/** 設定 `remote.localPortHost` の値。 */
	localPortHost(): unknown;
	/** 転送している行（ポートパネルの台帳）。 */
	forwarded(): readonly Tunnel[];
	/** SSH 先で listen しているポート。検出の結果をまだ一度も受け取っていなければ undefined。 */
	candidates(): readonly CandidatePort[] | undefined;
	forward(properties: TunnelProperties, attributes?: Attributes): Promise<RemoteTunnel | string | undefined>;
	close(remote: { readonly host: string; readonly port: number }): Promise<void>;
	/** 1 本を張り直す（portReforward の張り直し）。張れなければ理由を返す。 */
	reforward(tunnel: Tunnel, localPort?: number): Promise<string | undefined>;
	/** 手元のポートが空いているか。 */
	isLocalPortFree(port: number): Promise<boolean>;
}

/** 確認のダイアログを出す口。締め切りで閉じたときは 'timedOut' を返す。 */
export type ParadisPortToolsAsk = (paneToken: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => Promise<ParadisAgentApprovalOutcome | 'timedOut'>;

function fail(error: string): ParadisPortToolResult {
	return { ok: false, error };
}

function ok(data: object): ParadisPortToolResult {
	return { ok: true, data };
}

function sourceName(source: TunnelSource): 'user' | 'auto' | 'extension' {
	switch (source) {
		case TunnelSource.Auto: return 'auto';
		case TunnelSource.Extension: return 'extension';
		default: return 'user';
	}
}

/** 手元のアドレス（`127.0.0.1:21004`・`localhost:21004`・`[::1]:21004`・URL）がループバックか。 */
export function paradisIsLoopbackLocalAddress(address: string): boolean {
	let host: string;
	if (address.includes('://')) {
		try {
			host = new URL(address).hostname;
		} catch {
			return false;
		}
	} else {
		const match = /^(?<host>\[[^\]]+\]|[^:]+|[0-9a-fA-F:]+?)(?::\d+)?$/.exec(address);
		host = match?.groups?.host ?? '';
	}
	host = host.replace(/^\[|\]$/g, '');
	return isLocalhost(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** 一覧の 1 行。 */
function rowOf(tunnel: Tunnel, detectionKnown: boolean): object {
	return {
		forwarded: true,
		remote_host: tunnel.remoteHost,
		remote_port: tunnel.remotePort,
		local_address: tunnel.localAddress,
		local_port: tunnel.localPort ?? null,
		local_matches_remote: tunnel.localPort === tunnel.remotePort,
		source: sourceName(tunnel.source.source),
		listening: detectionKnown ? tunnel.hasRunningProcess === true : null,
		process: tunnel.runningProcess ?? null,
		pid: tunnel.pid ?? null,
		label: tunnel.name ?? null,
		protocol: tunnel.protocol,
	};
}

/** 片付けの対象を選ぶ。`not_listening` は検出の結果が無ければ undefined（全部が動いていないように見えるため）。 */
export function paradisPortCleanUpTargets(mode: ParadisPortCleanUpMode, forwarded: readonly Tunnel[], detectionKnown: boolean): readonly Tunnel[] | undefined {
	const eligible = forwarded.filter(tunnel => tunnel.closeable !== false && isLocalhost(tunnel.remoteHost));
	if (mode === 'not_listening') {
		if (!detectionKnown) {
			return undefined;
		}
		return eligible.filter(tunnel => tunnel.source.source === TunnelSource.User && tunnel.hasRunningProcess !== true);
	}
	// 拡張（HTML プレビューなど）の転送は持ち主が手元の番号を覚えているので、揃えない
	return eligible.filter(tunnel => tunnel.source.source !== TunnelSource.Extension && tunnel.localPort !== undefined && tunnel.localPort !== tunnel.remotePort);
}

function isRequest(value: unknown): value is ParadisPortToolRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Record<string, unknown>;
	switch (request.op) {
		case 'list': return typeof request.includeDetected === 'boolean';
		case 'forward': return paradisIsValidPort(request.remotePort) && paradisIsValidPort(request.localPort)
			&& (request.label === undefined || typeof request.label === 'string')
			&& (request.protocol === undefined || request.protocol === 'http' || request.protocol === 'https');
		case 'stop': return Array.isArray(request.remotePorts) && request.remotePorts.length > 0 && request.remotePorts.every(paradisIsValidPort);
		case 'reforward': return paradisIsValidPort(request.remotePort) && typeof request.alignLocalPort === 'boolean';
		case 'cleanUp': return (request.mode === 'not_listening' || request.mode === 'mismatched') && typeof request.dryRun === 'boolean';
	}
	return false;
}

/** ポートの転送の道具の要求を、この窓の転送の台帳へ当てる。 */
export class ParadisPortToolsChannel implements IServerChannel {

	constructor(
		private readonly _window: IParadisPortToolsWindow,
		private readonly _paneExists: (paneToken: string) => boolean,
		private readonly _ask: ParadisPortToolsAsk,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		if (command !== PARADIS_PORT_TOOLS_METHOD) {
			throw new Error(`Method not found: ${command}`);
		}
		const args = ParadisChannelArgs.from(arg);
		const paneToken = args.string(0);
		const request = args.at(1);
		if (paneToken === undefined || !isRequest(request)) {
			return fail('Para Code received a malformed port forwarding request.') as T;
		}
		return await this.handle(paneToken, request, cancellationToken ?? CancellationToken.None) as T;
	}

	async handle(paneToken: string, request: ParadisPortToolRequest, cancellation: CancellationToken = CancellationToken.None): Promise<ParadisPortToolResult> {
		if (!this._paneExists(paneToken)) {
			return fail(PANE_UNRESOLVED_MESSAGE);
		}
		const authority = this._window.remoteAuthority;
		if (authority === undefined || !authority.startsWith('ssh-remote+')) {
			return fail(NOT_SSH_MESSAGE);
		}
		switch (request.op) {
			case 'list':
				return this._list(request.includeDetected);
			case 'forward':
				return this._forward(paneToken, request.remotePort, request.localPort, request.label, request.protocol, cancellation);
			case 'stop':
				return this._stop(paneToken, request.remotePorts, cancellation);
			case 'reforward':
				return this._reforward(paneToken, request.remotePort, request.alignLocalPort, cancellation);
			case 'cleanUp':
				return request.mode === 'not_listening'
					? this._cleanUpNotListening(paneToken, request.dryRun, cancellation)
					: this._cleanUpMismatched(paneToken, request.dryRun, cancellation);
		}
	}

	// --- 読み取り ---

	private _list(includeDetected: boolean): ParadisPortToolResult {
		const candidates = this._window.candidates();
		const detectionKnown = candidates !== undefined;
		const forwarded = this._window.forwarded();
		const rows: object[] = forwarded.map(tunnel => rowOf(tunnel, detectionKnown));
		if (includeDetected && candidates) {
			for (const candidate of candidates) {
				if (forwarded.some(tunnel => tunnel.remotePort === candidate.port && (tunnel.remoteHost === candidate.host || (isLocalhost(tunnel.remoteHost) && isLocalhost(candidate.host))))) {
					continue;
				}
				rows.push({ forwarded: false, remote_host: candidate.host, remote_port: candidate.port, listening: true, process: candidate.detail ?? null, pid: candidate.pid ?? null });
			}
		}
		return ok({
			remote: this._window.remoteAuthority,
			detection_known: detectionKnown,
			forwards: rows,
		});
	}

	// --- 追加 ---

	private async _forward(paneToken: string, remotePort: number, localPort: number, label: string | undefined, protocol: 'http' | 'https' | undefined, cancellation: CancellationToken): Promise<ParadisPortToolResult> {
		const already = this._find(remotePort);
		if (already) {
			return ok({ already_forwarded: true, forward: rowOf(already, this._window.candidates() !== undefined), hint: 'Nothing was changed. Use reforward_port with align_local_port to change its local port.' });
		}
		if (!this._localHostAllowed()) {
			return fail(LOCAL_HOST_MESSAGE);
		}
		const safeLabel = paradisSanitizeDisplayText(label, DIALOG_TEXT_MAX_LENGTH);
		const outcome = await this._ask(paneToken, {
			messageTemplate: pane => localize('paradis.portTools.forward.message', "{0} のエージェントが、SSH 先のポートを転送しようとしています", pane),
			detail: [
				localize('paradis.portTools.forward.ports', "転送: SSH 先の localhost:{0} → この Mac の 127.0.0.1:{1}（1 件を追加）", remotePort, localPort),
				...(safeLabel ? [localize('paradis.portTools.forward.label', "ラベル: {0}", safeLabel)] : []),
				localize('paradis.portTools.forward.effect', "手元の {0} が使用中なら、別の番号で転送します。転送はポートパネルからいつでも停止できます。", localPort),
			],
			approveLabel: localize('paradis.portTools.forward.approve', "転送する"),
			cooldownKey: APPROVAL_COOLDOWN_KEY,
		}, cancellation);
		if (outcome !== 'approve') {
			return fail(refusal(outcome));
		}
		// 答えを待つ間に転送されていたら、張り直さない
		const raced = this._find(remotePort);
		if (raced) {
			return ok({ already_forwarded: true, forward: rowOf(raced, this._window.candidates() !== undefined) });
		}
		if (!this._localHostAllowed()) {
			return fail(LOCAL_HOST_MESSAGE);
		}
		const remote = { host: 'localhost', port: remotePort };
		const attributes: Attributes | undefined = protocol !== undefined
			? { label, onAutoForward: undefined, elevateIfNeeded: undefined, requireLocalPort: undefined, protocol: protocol === 'https' ? TunnelProtocol.Https : TunnelProtocol.Http }
			: undefined;
		const result = await this._window.forward({ remote, local: localPort, name: label, source: UserTunnelSource }, attributes);
		if (!result || typeof result === 'string') {
			return fail(`Para Code could not forward port ${remotePort}${typeof result === 'string' ? `: ${result}` : '.'}`);
		}
		if (!paradisIsLoopbackLocalAddress(result.localAddress)) {
			// 127.0.0.1 以外で受けてしまったら、すぐに閉じる（LAN から SSH 先のサーバーが見えないように）
			await this._window.close(remote);
			return fail(LOCAL_HOST_MESSAGE);
		}
		return ok({
			forwarded: true,
			remote_port: remotePort,
			local_address: result.localAddress,
			local_port: result.tunnelLocalPort ?? null,
			local_port_taken: result.tunnelLocalPort !== localPort,
		});
	}

	// --- 外す ---

	private async _stop(paneToken: string, remotePorts: readonly number[], cancellation: CancellationToken): Promise<ParadisPortToolResult> {
		const notForwarded: number[] = [];
		const notCloseable: number[] = [];
		const targets: Tunnel[] = [];
		for (const port of remotePorts) {
			const tunnel = this._find(port);
			if (!tunnel) {
				notForwarded.push(port);
			} else if (tunnel.closeable === false) {
				notCloseable.push(port);
			} else {
				targets.push(tunnel);
			}
		}
		if (targets.length === 0) {
			return fail(`None of those ports can be stopped (not forwarded: ${notForwarded.join(', ') || 'none'}; cannot be closed: ${notCloseable.join(', ') || 'none'}). Call list_port_forwards for the current forwards.`);
		}
		const outcome = await this._ask(paneToken, {
			messageTemplate: pane => localize('paradis.portTools.stop.message', "{0} のエージェントが、ポートの転送を {1} 件停止しようとしています", pane, targets.length),
			detail: [
				...this._dialogRows(targets, tunnel => this._describe(tunnel)),
				localize('paradis.portTools.stop.effect', "停止すると、その手元のアドレスを開いているブラウザのタブは繋がらなくなります。"),
			],
			approveLabel: localize('paradis.portTools.stop.approve', "{0} 件を停止", targets.length),
			cooldownKey: APPROVAL_COOLDOWN_KEY,
		}, cancellation);
		if (outcome !== 'approve') {
			return fail(refusal(outcome));
		}
		const stopped: number[] = [];
		for (const target of targets) {
			// 見せた対象のうち、今も台帳にあるものだけを外す
			if (this._find(target.remotePort) === undefined) {
				notForwarded.push(target.remotePort);
				continue;
			}
			await this._window.close({ host: target.remoteHost, port: target.remotePort });
			stopped.push(target.remotePort);
		}
		return ok({ stopped, ...(notForwarded.length ? { not_forwarded: notForwarded } : {}), ...(notCloseable.length ? { not_closeable: notCloseable } : {}) });
	}

	// --- 張り直す ---

	private async _reforward(paneToken: string, remotePort: number, align: boolean, cancellation: CancellationToken): Promise<ParadisPortToolResult> {
		const tunnel = this._find(remotePort);
		if (!tunnel) {
			return fail(`Port ${remotePort} is not forwarded in this window. Call list_port_forwards for the current forwards, or forward_port to add it.`);
		}
		if (tunnel.closeable === false) {
			return fail(`The forward of port ${remotePort} is provided by the remote environment and cannot be forwarded again.`);
		}
		if (!this._localHostAllowed()) {
			return fail(LOCAL_HOST_MESSAGE);
		}
		const oldLocal = tunnel.localPort;
		const changesLocal = align && oldLocal !== remotePort;
		if (changesLocal && !await this._window.isLocalPortFree(remotePort)) {
			return fail(localPortInUse(remotePort));
		}
		const outcome = await this._ask(paneToken, {
			messageTemplate: pane => localize('paradis.portTools.reforward.message', "{0} のエージェントが、ポートの転送を 1 件張り直そうとしています", pane),
			detail: [
				this._describe(tunnel),
				changesLocal
					? localize('paradis.portTools.reforward.align', "手元の番号を {0} から {1} に変えます。{0} を開いているブラウザのタブは繋がらなくなります。", oldLocal ?? '?', remotePort)
					: localize('paradis.portTools.reforward.keep', "手元の番号は {0} のまま、転送を閉じて張り直します。", oldLocal ?? '?'),
			],
			approveLabel: localize('paradis.portTools.reforward.approve', "張り直す"),
			cooldownKey: APPROVAL_COOLDOWN_KEY,
		}, cancellation);
		if (outcome !== 'approve') {
			return fail(refusal(outcome));
		}
		const current = this._find(remotePort);
		if (!current) {
			return fail(`Port ${remotePort} stopped being forwarded while the user was answering, so nothing was changed.`);
		}
		const result = await this._realign(current, changesLocal ? remotePort : undefined);
		if (result.error) {
			return fail(result.error);
		}
		return ok({
			reforwarded: true,
			remote_port: remotePort,
			local_address: result.after?.localAddress ?? null,
			local_port: result.after?.localPort ?? null,
			...(changesLocal ? { local_port_taken: result.after?.localPort !== remotePort } : {}),
		});
	}

	// --- 片付け ---

	private async _cleanUpNotListening(paneToken: string, dryRun: boolean, cancellation: CancellationToken): Promise<ParadisPortToolResult> {
		const targets = paradisPortCleanUpTargets('not_listening', this._window.forwarded(), this._window.candidates() !== undefined);
		if (targets === undefined) {
			return fail(NOT_DETECTED_MESSAGE);
		}
		const rows = targets.map(tunnel => rowOf(tunnel, true));
		if (dryRun || targets.length === 0) {
			return ok({ mode: 'not_listening', dry_run: dryRun, count: targets.length, targets: rows, ...(dryRun && targets.length > 0 ? { hint: 'Call again with dry_run false to stop these after the user approves.' } : {}) });
		}
		const outcome = await this._ask(paneToken, {
			messageTemplate: pane => localize('paradis.portTools.cleanUp.message', "{0} のエージェントが、SSH 先で listen していない転送を {1} 件停止しようとしています", pane, targets.length),
			detail: [
				...this._dialogRows(targets, tunnel => this._describe(tunnel)),
				localize('paradis.portTools.cleanUp.effect', "どれも利用者（プレビューやリンクを含む）が張った転送で、今は SSH 先のプロセスが listen していません。サーバーを止めているだけのものも含まれます。"),
			],
			approveLabel: localize('paradis.portTools.cleanUp.approve', "{0} 件を停止", targets.length),
			cooldownKey: APPROVAL_COOLDOWN_KEY,
		}, cancellation);
		if (outcome !== 'approve') {
			return fail(refusal(outcome));
		}
		const stopped: number[] = [];
		const skipped: number[] = [];
		for (const target of targets) {
			// 答えを待つ間に listen し始めたもの・外れたものは触らない
			const current = this._find(target.remotePort);
			if (!current || current.hasRunningProcess === true) {
				skipped.push(target.remotePort);
				continue;
			}
			await this._window.close({ host: current.remoteHost, port: current.remotePort });
			stopped.push(target.remotePort);
		}
		return ok({ mode: 'not_listening', stopped, ...(skipped.length ? { skipped } : {}) });
	}

	private async _cleanUpMismatched(paneToken: string, dryRun: boolean, cancellation: CancellationToken): Promise<ParadisPortToolResult> {
		if (!dryRun && !this._localHostAllowed()) {
			return fail(LOCAL_HOST_MESSAGE);
		}
		const candidates = paradisPortCleanUpTargets('mismatched', this._window.forwarded(), true) ?? [];
		const targets: Tunnel[] = [];
		const inUse: number[] = [];
		for (const tunnel of candidates) {
			if (await this._window.isLocalPortFree(tunnel.remotePort)) {
				targets.push(tunnel);
			} else {
				inUse.push(tunnel.remotePort);
			}
		}
		const detectionKnown = this._window.candidates() !== undefined;
		if (dryRun || targets.length === 0) {
			return ok({
				mode: 'mismatched',
				dry_run: dryRun,
				count: targets.length,
				targets: targets.map(tunnel => rowOf(tunnel, detectionKnown)),
				...(inUse.length ? { local_port_in_use: inUse } : {}),
				...(dryRun && targets.length > 0 ? { hint: 'Call again with dry_run false to forward these again with matching local ports after the user approves.' } : {}),
			});
		}
		const outcome = await this._ask(paneToken, {
			messageTemplate: pane => localize('paradis.portTools.align.message', "{0} のエージェントが、手元の番号が違う転送 {1} 件を、番号を揃えて張り直そうとしています", pane, targets.length),
			detail: [
				...this._dialogRows(targets, tunnel => localize('paradis.portTools.align.row', "{0}: 手元 {1} → {2}", tunnel.remotePort, tunnel.localPort ?? '?', tunnel.remotePort)),
				...(inUse.length ? [localize('paradis.portTools.align.inUse', "手元の番号が使用中のため張り直さないもの: {0}", inUse.join(', '))] : []),
				localize('paradis.portTools.align.effect', "張り直すと、元の手元の番号を開いているブラウザのタブは繋がらなくなります。"),
			],
			approveLabel: localize('paradis.portTools.align.approve', "{0} 件を張り直す", targets.length),
			cooldownKey: APPROVAL_COOLDOWN_KEY,
		}, cancellation);
		if (outcome !== 'approve') {
			return fail(refusal(outcome));
		}
		const aligned: number[] = [];
		const failed: { remote_port: number; reason: string }[] = [];
		// 1 本ずつ順に（同じ SSH 先の shared process の転送をまとめて閉じる処理どうしを交差させない）
		for (const target of targets) {
			const current = this._find(target.remotePort);
			if (!current || current.localPort === current.remotePort) {
				continue;
			}
			if (!await this._window.isLocalPortFree(current.remotePort)) {
				failed.push({ remote_port: current.remotePort, reason: 'local_port_in_use' });
				continue;
			}
			const result = await this._realign(current, current.remotePort);
			if (result.error) {
				failed.push({ remote_port: current.remotePort, reason: result.error });
			} else if (result.after?.localPort !== current.remotePort) {
				failed.push({ remote_port: current.remotePort, reason: `local_port_taken (now ${result.after?.localPort ?? 'unknown'})` });
			} else {
				aligned.push(current.remotePort);
			}
		}
		return ok({ mode: 'mismatched', aligned, ...(failed.length ? { failed } : {}), ...(inUse.length ? { local_port_in_use: inUse } : {}) });
	}

	// --- 共通 ---

	/** 張り直し、張れた後の行を返す。手元の番号が違っても元には戻さない（間に別のプロセスが取った）。 */
	private async _realign(tunnel: Tunnel, localPort: number | undefined): Promise<{ readonly error?: string; readonly after?: Tunnel }> {
		const error = await this._window.reforward(tunnel, localPort);
		if (error) {
			return { error: `Para Code could not forward port ${tunnel.remotePort} again: ${error}` };
		}
		const after = this._find(tunnel.remotePort);
		if (after && !paradisIsLoopbackLocalAddress(after.localAddress)) {
			await this._window.close({ host: after.remoteHost, port: after.remotePort });
			return { error: LOCAL_HOST_MESSAGE };
		}
		return { after };
	}

	/** SSH 先の localhost の、そのポートの転送。 */
	private _find(remotePort: number): Tunnel | undefined {
		return this._window.forwarded().find(tunnel => tunnel.remotePort === remotePort && isLocalhost(tunnel.remoteHost));
	}

	private _localHostAllowed(): boolean {
		const value = this._window.localPortHost();
		return value === undefined || value === null || value === '' || value === 'localhost';
	}

	private _describe(tunnel: Tunnel): string {
		const label = paradisSanitizeDisplayText(tunnel.name, DIALOG_TEXT_MAX_LENGTH);
		const address = paradisSanitizeDisplayText(tunnel.localAddress, DIALOG_TEXT_MAX_LENGTH) ?? '?';
		return label
			? localize('paradis.portTools.rowWithLabel', "{0} → {1}（{2}）", tunnel.remotePort, address, label)
			: localize('paradis.portTools.row', "{0} → {1}", tunnel.remotePort, address);
	}

	private _dialogRows(targets: readonly Tunnel[], describe: (tunnel: Tunnel) => string): string[] {
		const rows = targets.slice(0, DIALOG_MAX_ROWS).map(describe);
		if (targets.length > DIALOG_MAX_ROWS) {
			rows.push(localize('paradis.portTools.more', "ほか {0} 件", targets.length - DIALOG_MAX_ROWS));
		}
		return rows;
	}
}

function refusal(outcome: ParadisAgentApprovalOutcome | 'timedOut'): string {
	// 2 つ目の選択肢は出していないので alternative は来ない。来ても承認としては扱わない
	return outcome === 'approve' || outcome === 'alternative' ? REFUSALS.denied : REFUSALS[outcome];
}

function localPortInUse(port: number): string {
	return `Local port ${port} on the user's computer is in use, so Para Code did not change the forward. Tell the user which local port is in use (only they can see what uses it on their computer), or keep the current local port.`;
}
