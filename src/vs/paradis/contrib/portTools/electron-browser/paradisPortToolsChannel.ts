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
// 新しく張る転送のリモートのホストは localhost にする。外す・張り直すは、ポートパネルで 0.0.0.0 などへ張られた転送も扱う。
//
// 張り直しは手元の受け口を開き直すだけで、SSH の接続そのものが詰まっていると直らない。そのため張り直した後に手元から
// 1 回つないで確かめ（reachable）、繋がらなかったポートを 5 分の間覚えて、同じポートをまた頼まれたら確認を出さずに返す。
//
// 追加・外す・張り直すは 1 回の呼び出しで複数の転送を受け、ダイアログは 1 回だけ出し、結果は 1 件ずつ返す。
// 変える操作は、この窓の中で 1 つずつ順に行う（並行で来ても、前の確認と転送が終わってから次の確認を出す）。
// 重ねて出すと、閉じた直後に同じ位置へ出た次のダイアログへのクリックが速押しと判定されるため。

import { Sequencer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { PARADIS_EPHEMERAL_PORT_START } from '../../../../platform/tunnel/common/paradisTunnelRestorePolicy.js';
import { isAllInterfaces, isLocalhost, RemoteTunnel, TunnelProtocol } from '../../../../platform/tunnel/common/tunnel.js';
import { Attributes, CandidatePort, Tunnel, TunnelProperties, TunnelSource, UserTunnelSource } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { ParadisChannelArgs } from '../../../common/paradisChannelArgs.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentApprovalRequest, ParadisAgentApprovalOutcome } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { ParadisPortReforwardProbeResult } from '../../portReforward/common/paradisPortReforward.js';
import { paradisDefaultCleanUpForwards, paradisIsLoopbackLocalAddress, paradisMismatchedForwards, paradisPortLocalHostAllowed } from '../common/paradisPortSelection.js';
import { IParadisReforwardConfirm, IParadisReforwardConfirmRow, paradisReforwardConfirm, paradisReforwardOtherWindows } from '../common/paradisPortReforwardConfirm.js';
import { IParadisPortForwardItem, IParadisPortReforwardItem, PARADIS_PORT_TOOLS_MAX_BATCH, PARADIS_PORT_TOOLS_METHOD, PARADIS_PORT_TOOLS_REASON_MAX_LENGTH, ParadisPortCleanUpMode, ParadisPortToolRequest, ParadisPortToolResult, paradisIsValidPort, paradisPortToolRequestChanges } from '../common/paradisPortTools.js';

/** 確認のダイアログに並べる転送の行の上限。超えた分は「ほか N 件」にまとめる。 */
const DIALOG_MAX_ROWS = 20;
/** ダイアログに出すラベルとプロセスの最大文字数（エージェントや SSH 先が決められる文字列なので長さも切る）。 */
const DIALOG_TEXT_MAX_LENGTH = 80;
/** 拒否の後の自動の断りを数える単位（ページ共有・端末の要求は止めない）。 */
const APPROVAL_COOLDOWN_KEY = 'port-forward';
/** 張り直した後の確かめで繋がらなかったポートを覚えておく時間。この間に同じポートを頼まれたら、確認を出さずに返す。 */
export const PARADIS_REFORWARD_UNREACHABLE_MEMORY_MS = 5 * 60_000;

const PANE_UNRESOLVED_MESSAGE = 'Para Code could not find the terminal pane of this request in its window (it may have been closed).';
const NOT_SSH_MESSAGE = 'This terminal pane belongs to a Para Code window that is not connected over SSH, so there are no port forwards for these tools to use. They only work for agents in a terminal of an SSH window.';
const LOCAL_HOST_MESSAGE = 'Para Code only opens port forwards that listen on 127.0.0.1, but this window is set to listen on all network interfaces (the user setting "remote.localPortHost" is "allInterfaces"). Nothing was changed. Ask the user to forward the port from the Ports panel.';
const NOT_DETECTED_MESSAGE = 'This window has not detected which remote ports have a listening process yet (for example "remote.autoForwardPortsSource" is "output"), so Para Code cannot tell which forwards are unused and does not clean them up. Nothing was changed.';

/** 張り直した後の確かめで繋がらなかったときに、エージェントへ返す英文。 */
const UNREACHABLE_HINT = 'The forward was opened again, but a test connection from this computer through it did not reach the SSH host. Reforwarding only reopens the listener on this computer; the SSH connection of this window seems stuck. Ask the user to reconnect the window (for example Reload Window), and do not reforward again. If no process listens on the remote port (list_port_forwards "listening"), start the server first.';
/** 確かめられなかったときに、エージェントへ返す英文。 */
const UNTESTED_HINT = 'Para Code could not test the forward from this computer. If the page still does not load, the SSH connection of this window may be stuck: ask the user to reconnect the window (for example Reload Window) instead of reforwarding again.';

function recentlyUnreachable(remotePort: number, minutesAgo: number): string {
	return `Port ${remotePort} was forwarded again ${minutesAgo < 1 ? 'less than a minute' : `${minutesAgo} minute${minutesAgo === 1 ? '' : 's'}`} ago, and a test connection from this computer through it still did not reach the SSH host, so Para Code did not ask the user again: reforwarding only reopens the listener on this computer and cannot repair the SSH connection. Ask the user to reconnect the window (for example Reload Window), then try the page again.`;
}

/** 複数の転送を変えるなら 1 回にまとめるよう促す 1 文（断りに添える）。 */
const BATCH_HINT = 'If you need several forwards changed, ask once with all of them in "ports" (one dialog for all of them) instead of one call per port; to make every mismatched local port equal to its remote port, use clean_up_port_forwards with mode "mismatched".';

/** 承認以外の答えのときにエージェントへ返す英文。 */
const REFUSALS: Readonly<Record<Exclude<ParadisAgentApprovalOutcome, 'approve' | 'alternative'> | 'timedOut', string>> = {
	'denied': 'The user declined, so nothing was changed. Do not ask again for this; ask the user in the conversation if needed.',
	'recentlyDenied': `Para Code turned this request down without showing a dialog, because the user clicked "Deny" on a port forwarding change from this terminal pane in the last 3 minutes. Nothing was changed. Ask the user in the conversation whether they still want the change. ${BATCH_HINT}`,
	'busy': `Another request from this terminal pane is waiting for the user. Nothing was changed. Wait for it to finish, then try again. ${BATCH_HINT}`,
	'unanswered': `Para Code could not get a clear answer: the dialog was answered right after it appeared or with a keyboard shortcut. Nothing was changed, and this does not count as a refusal. Ask the user to click a button in the dialog, then ask again. ${BATCH_HINT}`,
	'cancelled': 'The request was cancelled before the user answered, so nothing was changed.',
	'timedOut': 'The user did not answer the confirmation dialog in time, so nothing was changed. Ask the user in the conversation before asking again.',
};

/** まとめて頼まれた転送の、1 件ずつの結果。 */
type ParadisPortItemResult =
	| { readonly remote_port: number; readonly ok: true;[key: string]: unknown }
	| { readonly remote_port: number; readonly ok: false; readonly error: string };

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
	/** 転送ごとに、shared process でそれを使っている窓の数（この窓を含む）。分からなければその件は undefined。 */
	referenceCounts(tunnels: readonly Tunnel[]): Promise<readonly (number | undefined)[]>;
	/** 手元の受け口から 1 回つないで、SSH 先まで届くか確かめる。確かめられなければ undefined。 */
	probe(localPort: number, remotePort: number): Promise<ParadisPortReforwardProbeResult | undefined>;
}

/** 確認の求め。張り直しの確認には、UI キットの確認で描く中身（案 C）を添える。 */
export interface IParadisPortApprovalRequest extends IParadisAgentApprovalRequest {
	readonly reforward?: IParadisReforwardConfirm;
}

/** 確認のダイアログを出す口。締め切りで閉じたときは 'timedOut' を返す。 */
export type ParadisPortToolsAsk = (paneToken: string, request: IParadisPortApprovalRequest, cancellation: CancellationToken) => Promise<ParadisAgentApprovalOutcome | 'timedOut'>;

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

/**
 * 片付けの対象を選ぶ。`not_listening` は検出の結果が無ければ undefined（全部が動いていないように見えるため）。
 * 決め方はポートパネルの「動いていない転送を外す...」の既定のチェックと同じ（paradisPortSelection.ts）。
 */
export function paradisPortCleanUpTargets(mode: ParadisPortCleanUpMode, forwarded: readonly Tunnel[], detectionKnown: boolean): readonly Tunnel[] | undefined {
	if (mode === 'not_listening') {
		return detectionKnown ? paradisDefaultCleanUpForwards(forwarded) : undefined;
	}
	return paradisMismatchedForwards(forwarded);
}

function isForwardItem(value: unknown): value is IParadisPortForwardItem {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const item = value as Record<string, unknown>;
	return paradisIsValidPort(item.remotePort) && paradisIsValidPort(item.localPort)
		&& (item.label === undefined || typeof item.label === 'string')
		&& (item.protocol === undefined || item.protocol === 'http' || item.protocol === 'https');
}

function isReforwardItem(value: unknown): value is IParadisPortReforwardItem {
	return !!value && typeof value === 'object' && paradisIsValidPort((value as Record<string, unknown>).remotePort) && typeof (value as Record<string, unknown>).alignLocalPort === 'boolean';
}

function isBatch(items: unknown, isItem: (value: unknown) => boolean): boolean {
	return Array.isArray(items) && items.length > 0 && items.length <= PARADIS_PORT_TOOLS_MAX_BATCH && items.every(isItem);
}

function isRequest(value: unknown): value is ParadisPortToolRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Record<string, unknown>;
	switch (request.op) {
		case 'list': return typeof request.includeDetected === 'boolean';
		case 'forward': return isBatch(request.items, isForwardItem) && typeof request.batch === 'boolean';
		case 'stop': return isBatch(request.remotePorts, paradisIsValidPort);
		case 'reforward': return isBatch(request.items, isReforwardItem) && typeof request.batch === 'boolean' && (request.reason === undefined || typeof request.reason === 'string');
		case 'cleanUp': return (request.mode === 'not_listening' || request.mode === 'mismatched') && typeof request.dryRun === 'boolean';
	}
	return false;
}

/** ポートの転送の道具の要求を、この窓の転送の台帳へ当てる。 */
export class ParadisPortToolsChannel implements IServerChannel {

	/** 変える操作（確認と転送の変更）を 1 つずつ順に行う。 */
	private readonly _changes = new Sequencer();
	/** 張り直した後の確かめで繋がらなかったポートと、その時刻。 */
	private readonly _unreachable = new Map<number, number>();

	constructor(
		private readonly _window: IParadisPortToolsWindow,
		private readonly _paneExists: (paneToken: string) => boolean,
		private readonly _ask: ParadisPortToolsAsk,
		private readonly _now: () => number = Date.now,
	) { }

	/** 覚えている「繋がらなかった」を忘れる（窓の SSH の接続がつなぎ直されたとき）。 */
	forgetUnreachable(): void {
		this._unreachable.clear();
	}

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
		if (!paradisPortToolRequestChanges(request)) {
			return this._run(paneToken, request, cancellation);
		}
		// 順番を待つ間に呼び出し元が取り消したら、ダイアログを出さない。台帳は順番が来てから読む
		return this._changes.queue(() => cancellation.isCancellationRequested ? Promise.resolve(fail(REFUSALS.cancelled)) : this._run(paneToken, request, cancellation));
	}

	private async _run(paneToken: string, request: ParadisPortToolRequest, cancellation: CancellationToken): Promise<ParadisPortToolResult> {
		switch (request.op) {
			case 'list':
				return this._list(request.includeDetected);
			case 'forward':
				return single(request.batch, await this._forward(paneToken, request.items, cancellation));
			case 'stop':
				return this._stop(paneToken, request.remotePorts, cancellation);
			case 'reforward':
				return single(request.batch, await this._reforward(paneToken, request.items, request.reason, cancellation));
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
			// localhost の転送は、0.0.0.0・:: で listen しているサーバーにも届く。同じポートを 2 度出さない
			// （検出が 0.0.0.0 と :: の両方で同じポートを返すこともある）
			const listed: { readonly host: string; readonly port: number }[] = forwarded.map(tunnel => ({ host: tunnel.remoteHost, port: tunnel.remotePort }));
			for (const candidate of candidates) {
				if (listed.some(item => item.port === candidate.port && paradisSameRemoteHost(item.host, candidate.host))) {
					continue;
				}
				listed.push({ host: candidate.host, port: candidate.port });
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

	private async _forward(paneToken: string, items: readonly IParadisPortForwardItem[], cancellation: CancellationToken): Promise<ParadisPortToolResult> {
		const detectionKnown = () => this._window.candidates() !== undefined;
		const results = new Map<number, ParadisPortItemResult>();
		const targets: IParadisPortForwardItem[] = [];
		for (const item of items) {
			const already = this._find(item.remotePort);
			if (already) {
				results.set(item.remotePort, { remote_port: item.remotePort, ok: true, already_forwarded: true, forward: rowOf(already, detectionKnown()), hint: 'Nothing was changed. Use reforward_port with align_local_port to change its local port.' });
			} else {
				targets.push(item);
			}
		}
		if (targets.length === 0) {
			return ok({ results: items.map(item => results.get(item.remotePort)!) });
		}
		if (!this._localHostAllowed()) {
			return fail(LOCAL_HOST_MESSAGE);
		}
		const outcome = await this._ask(paneToken, {
			messageTemplate: pane => localize('paradis.portTools.forward.message', "{0} のエージェントが、SSH 先のポートの転送を {1} 件追加しようとしています", pane, targets.length),
			detail: [
				...dialogRows(targets.map(item => {
					const label = paradisSanitizeDisplayText(item.label, DIALOG_TEXT_MAX_LENGTH);
					return label
						? localize('paradis.portTools.forward.rowWithLabel', "SSH 先の localhost:{0} → この PC の 127.0.0.1:{1}（{2}）", item.remotePort, item.localPort, label)
						: localize('paradis.portTools.forward.row', "SSH 先の localhost:{0} → この PC の 127.0.0.1:{1}", item.remotePort, item.localPort);
				}), targets.map(item => item.remotePort)),
				localize('paradis.portTools.forward.effect', "手元の番号が使用中なら、別の番号で転送します。転送はポートパネルからいつでも停止できます。"),
			],
			approveLabel: localize('paradis.portTools.forward.approve', "{0} 件を転送", targets.length),
			cooldownKey: APPROVAL_COOLDOWN_KEY,
		}, cancellation);
		if (outcome !== 'approve') {
			return fail(refusal(outcome));
		}
		// 1 本ずつ順に張り、1 本の失敗で残りを止めない
		for (const item of targets) {
			try {
				results.set(item.remotePort, await this._forwardOne(item));
			} catch (error) {
				// SSH の接続が切れたときなどは、文字列ではなく例外で届く（shared process のトンネルが作れない）
				results.set(item.remotePort, { remote_port: item.remotePort, ok: false, error: `Para Code could not forward port ${item.remotePort}: ${toErrorMessage(error)}` });
			}
		}
		return ok({ results: items.map(item => results.get(item.remotePort)!) });
	}

	private async _forwardOne(item: IParadisPortForwardItem): Promise<ParadisPortItemResult> {
		const { remotePort, localPort, label, protocol } = item;
		// 答えを待つ間に転送されていたら、張り直さない
		const raced = this._find(remotePort);
		if (raced) {
			return { remote_port: remotePort, ok: true, already_forwarded: true, forward: rowOf(raced, this._window.candidates() !== undefined) };
		}
		if (!this._localHostAllowed()) {
			return { remote_port: remotePort, ok: false, error: LOCAL_HOST_MESSAGE };
		}
		const remote = { host: 'localhost', port: remotePort };
		const attributes: Attributes | undefined = protocol !== undefined
			? { label, onAutoForward: undefined, elevateIfNeeded: undefined, requireLocalPort: undefined, protocol: protocol === 'https' ? TunnelProtocol.Https : TunnelProtocol.Http }
			: undefined;
		const result = await this._window.forward({ remote, local: localPort, name: label, source: UserTunnelSource }, attributes);
		if (!result || typeof result === 'string') {
			return { remote_port: remotePort, ok: false, error: `Para Code could not forward port ${remotePort}${typeof result === 'string' ? `: ${result}` : '.'}` };
		}
		if (!paradisIsLoopbackLocalAddress(result.localAddress)) {
			// 127.0.0.1 以外で受けてしまったら、すぐに閉じる（LAN から SSH 先のサーバーが見えないように）
			try {
				await this._window.close(remote);
			} catch (error) {
				return { remote_port: remotePort, ok: false, error: `Para Code opened the forward of port ${remotePort} on ${result.localAddress}, not on 127.0.0.1, and could not stop it: ${toErrorMessage(error)}. Ask the user to stop it from the Ports panel.` };
			}
			return { remote_port: remotePort, ok: false, error: LOCAL_HOST_MESSAGE };
		}
		return {
			remote_port: remotePort,
			ok: true,
			forwarded: true,
			local_address: result.localAddress,
			local_port: result.tunnelLocalPort ?? null,
			local_port_taken: result.tunnelLocalPort !== localPort,
		};
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
				...dialogRows(targets.map(tunnel => this._describe(tunnel)), targets.map(tunnel => tunnel.remotePort)),
				localize('paradis.portTools.stop.effect', "停止すると、その手元のアドレスを開いているブラウザのタブは繋がらなくなります。"),
			],
			approveLabel: localize('paradis.portTools.stop.approve', "{0} 件を停止", targets.length),
			cooldownKey: APPROVAL_COOLDOWN_KEY,
		}, cancellation);
		if (outcome !== 'approve') {
			return fail(refusal(outcome));
		}
		const stopped = new Set<number>();
		const failedStops = new Map<number, string>();
		for (const target of targets) {
			// 見せた対象のうち、今も台帳にあるものだけを外す
			if (this._find(target.remotePort) === undefined) {
				notForwarded.push(target.remotePort);
				continue;
			}
			try {
				await this._window.close({ host: target.remoteHost, port: target.remotePort });
				stopped.add(target.remotePort);
			} catch (error) {
				failedStops.set(target.remotePort, `Para Code could not stop the forward of port ${target.remotePort}: ${toErrorMessage(error)}`);
			}
		}
		return ok({
			results: remotePorts.map((remotePort): ParadisPortItemResult => stopped.has(remotePort)
				? { remote_port: remotePort, ok: true, stopped: true }
				: { remote_port: remotePort, ok: false, error: failedStops.get(remotePort) ?? (notCloseable.includes(remotePort) ? 'not_closeable: provided by the remote environment' : 'not_forwarded') }),
		});
	}

	// --- 張り直す ---

	private async _reforward(paneToken: string, items: readonly IParadisPortReforwardItem[], reason: string | undefined, cancellation: CancellationToken): Promise<ParadisPortToolResult> {
		if (!this._localHostAllowed()) {
			return fail(LOCAL_HOST_MESSAGE);
		}
		const results = new Map<number, ParadisPortItemResult>();
		const targets: { readonly tunnel: Tunnel; readonly changesLocal: boolean }[] = [];
		const inUse: Tunnel[] = [];
		for (const item of items) {
			const remotePort = item.remotePort;
			const tunnel = this._find(remotePort);
			if (!tunnel) {
				results.set(remotePort, { remote_port: remotePort, ok: false, error: `Port ${remotePort} is not forwarded in this window. Call list_port_forwards for the current forwards, or forward_port to add it.` });
				continue;
			}
			if (tunnel.closeable === false) {
				results.set(remotePort, { remote_port: remotePort, ok: false, error: `The forward of port ${remotePort} is provided by the remote environment and cannot be forwarded again.` });
				continue;
			}
			// 少し前に張り直しても繋がらなかったポートは、もう一度張り直しても直らない。利用者に承認させない
			const unreachableAt = this._recentlyUnreachableAt(remotePort);
			if (unreachableAt !== undefined) {
				results.set(remotePort, { remote_port: remotePort, ok: false, error: recentlyUnreachable(remotePort, Math.floor((this._now() - unreachableAt) / 60_000)) });
				continue;
			}
			const changesLocal = item.alignLocalPort && tunnel.localPort !== remotePort;
			if (changesLocal && !await this._window.isLocalPortFree(remotePort)) {
				// 片付けの mismatched と同じく、外したものは確認と結果の両方で見せる
				results.set(remotePort, { remote_port: remotePort, ok: false, error: localPortInUse(remotePort) });
				inUse.push(tunnel);
				continue;
			}
			targets.push({ tunnel, changesLocal });
		}
		const all = () => ok({
			results: items.map(item => results.get(item.remotePort)!),
			...(inUse.length ? { local_port_in_use: inUse.map(tunnel => tunnel.remotePort) } : {}),
		});
		if (targets.length === 0) {
			return all();
		}
		const confirm = await this._reforwardConfirm(targets, inUse, paradisSanitizeDisplayText(reason, PARADIS_PORT_TOOLS_REASON_MAX_LENGTH), true);
		const outcome = await this._ask(paneToken, {
			messageTemplate: () => confirm.title,
			detail: reforwardDetail(confirm),
			approveLabel: confirm.approveLabel,
			cooldownKey: APPROVAL_COOLDOWN_KEY,
			reforward: confirm,
		}, cancellation);
		if (outcome !== 'approve') {
			return fail(refusal(outcome));
		}
		// 1 本ずつ順に（同じ SSH 先の shared process の転送をまとめて閉じる処理どうしを交差させない）。1 本の失敗で残りを止めない
		const reopened: { readonly remotePort: number; readonly localPort: number | undefined }[] = [];
		for (const { tunnel, changesLocal } of targets) {
			const remotePort = tunnel.remotePort;
			const current = this._find(remotePort);
			if (!current) {
				results.set(remotePort, { remote_port: remotePort, ok: false, error: `Port ${remotePort} stopped being forwarded while the user was answering, so it was not changed.` });
				continue;
			}
			if (changesLocal && current.localPort !== remotePort && !await this._window.isLocalPortFree(remotePort)) {
				results.set(remotePort, { remote_port: remotePort, ok: false, error: localPortInUse(remotePort) });
				continue;
			}
			// 番号を変えない行は、今の番号のまま開き直せたかを見る（張り直しの一瞬にほかのアプリに取られることがある）
			const expectedLocal = changesLocal ? remotePort : current.localPort;
			const result = await this._realign(current, changesLocal ? remotePort : undefined);
			if (result.error) {
				results.set(remotePort, { remote_port: remotePort, ok: false, error: result.error });
				continue;
			}
			const localPort = result.after?.localPort;
			results.set(remotePort, {
				remote_port: remotePort,
				ok: true,
				reforwarded: true,
				local_address: result.after?.localAddress ?? null,
				local_port: localPort ?? null,
				local_port_taken: localPort !== expectedLocal,
			});
			reopened.push({ remotePort, localPort });
		}
		// 開き直した転送を、手元から 1 回ずつつないで確かめる（詰まっていると 1 本に数十秒かかるので、まとめて並べて待つ）
		const probes = await Promise.all(reopened.map(({ remotePort, localPort }) => localPort !== undefined ? this._window.probe(localPort, remotePort) : Promise.resolve(undefined)));
		reopened.forEach(({ remotePort }, index) => {
			const probe = probes[index];
			// 時間切れ（やり直しの結果まで待っても答えが無い）は、繋がらないとは言えない。分からないにして覚えない
			const reachable = probe === 'reachable' ? true : probe === 'reset' || probe === 'refused' ? false : null;
			if (reachable === false) {
				this._unreachable.set(remotePort, this._now());
			} else {
				this._unreachable.delete(remotePort);
			}
			const result = results.get(remotePort);
			if (result?.ok) {
				results.set(remotePort, { ...result, reachable, ...(reachable === true ? {} : { hint: reachable === false ? UNREACHABLE_HINT : UNTESTED_HINT }) });
			}
		});
		return all();
	}

	/** 少し前に張り直しても繋がらなかったなら、その時刻。 */
	private _recentlyUnreachableAt(remotePort: number): number | undefined {
		const at = this._unreachable.get(remotePort);
		if (at === undefined) {
			return undefined;
		}
		if (this._now() - at >= PARADIS_REFORWARD_UNREACHABLE_MEMORY_MS) {
			this._unreachable.delete(remotePort);
			return undefined;
		}
		return at;
	}

	/** 張り直しの確認の中身（案 C）。ほかの窓の影響は shared process の参照の数から決める。 */
	private async _reforwardConfirm(targets: readonly { readonly tunnel: Tunnel; readonly changesLocal: boolean }[], inUse: readonly Tunnel[], reason: string | undefined, asksReason: boolean): Promise<IParadisReforwardConfirm> {
		const counts = await this._window.referenceCounts(targets.map(({ tunnel }) => tunnel));
		return paradisReforwardConfirm({
			rows: targets.map(({ tunnel, changesLocal }): IParadisReforwardConfirmRow => ({
				remotePort: tunnel.remotePort,
				localPort: tunnel.localPort,
				changesLocal,
				label: paradisSanitizeDisplayText(tunnel.name, DIALOG_TEXT_MAX_LENGTH),
			})),
			inUse: inUse.map(tunnel => ({ remotePort: tunnel.remotePort, localPort: tunnel.localPort })),
			reason,
			asksReason,
			otherWindows: paradisReforwardOtherWindows(counts),
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
			messageTemplate: pane => localize('paradis.portTools.cleanUp.message', "{0} のエージェントが、SSH 先で listen していないエフェメラル帯の転送を {1} 件停止しようとしています", pane, targets.length),
			detail: [
				...dialogRows(targets.map(tunnel => this._describe(tunnel)), targets.map(tunnel => tunnel.remotePort)),
				localize('paradis.portTools.cleanUp.effect', "どれも {0} 以上のエフェメラル帯の番号で、利用者（プレビューやリンクを含む）が張り、今は SSH 先のプロセスが listen していない転送です。{0} より下の決まった番号は対象にしていません。", PARADIS_EPHEMERAL_PORT_START),
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
		const inUseTunnels = candidates.filter(tunnel => inUse.includes(tunnel.remotePort));
		const confirm = await this._reforwardConfirm(targets.map(tunnel => ({ tunnel, changesLocal: true })), inUseTunnels, undefined, false);
		const outcome = await this._ask(paneToken, {
			messageTemplate: () => confirm.title,
			detail: reforwardDetail(confirm),
			approveLabel: confirm.approveLabel,
			cooldownKey: APPROVAL_COOLDOWN_KEY,
			reforward: confirm,
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

	/** SSH 先の localhost（または 0.0.0.0・:: など全部のインターフェース）の、そのポートの転送。 */
	private _find(remotePort: number): Tunnel | undefined {
		return this._window.forwarded().find(tunnel => tunnel.remotePort === remotePort && (isLocalhost(tunnel.remoteHost) || isAllInterfaces(tunnel.remoteHost)));
	}

	private _localHostAllowed(): boolean {
		return paradisPortLocalHostAllowed(this._window.localPortHost());
	}

	private _describe(tunnel: Tunnel): string {
		const label = paradisSanitizeDisplayText(tunnel.name, DIALOG_TEXT_MAX_LENGTH);
		const address = paradisSanitizeDisplayText(tunnel.localAddress, DIALOG_TEXT_MAX_LENGTH) ?? '?';
		return label
			? localize('paradis.portTools.rowWithLabel', "{0} → {1}（{2}）", tunnel.remotePort, address, label)
			: localize('paradis.portTools.row', "{0} → {1}", tunnel.remotePort, address);
	}
}

/**
 * リモートのホストが同じサーバーを指すか。localhost の転送は 0.0.0.0・:: で listen しているサーバーにも届くので、
 * localhost の別名と全部のインターフェースの別名はどれも同じものとみなす。
 */
export function paradisSameRemoteHost(a: string, b: string): boolean {
	const local = (host: string) => isLocalhost(host) || isAllInterfaces(host);
	return a === b || (local(a) && local(b));
}

/**
 * 張り直しの確認の中身を、文字だけの行にしたもの（UI キットの確認が描けないときの代わりと、テストで見る中身）。
 * 全部の転送を並べ、{@link DIALOG_MAX_ROWS} を超えた分は「ほか N 件: 番号…」の 1 行にまとめる。
 */
function reforwardDetail(confirm: IParadisReforwardConfirm): string[] {
	return [
		...(confirm.reason !== undefined ? [confirm.reason] : []),
		confirm.summary,
		...dialogRows(confirm.all.map(row => row.text), confirm.all.map(row => row.port)),
		...confirm.inUse,
		`${confirm.thisWindowHeading}: ${confirm.thisWindow}`,
		`${confirm.otherWindowsHeading}: ${confirm.otherWindows.text}`,
		confirm.denyNote,
	];
}

/**
 * ダイアログに並べる行（`rows[i]` は `ports[i]` の転送の行）。{@link DIALOG_MAX_ROWS} を超えた分は 1 行に
 * まとめるが、番号は全部見せる（中身を見ないまま承認させない）。長い行はダイアログの本文が折り返し、
 * 高すぎればスクロールする（upstream の dialog.css の `.dialog-message-container` と `.dialog-message-detail`）。
 */
function dialogRows(rows: readonly string[], ports: readonly number[]): string[] {
	const shown = rows.slice(0, DIALOG_MAX_ROWS);
	if (rows.length > DIALOG_MAX_ROWS) {
		shown.push(localize('paradis.portTools.more', "ほか {0} 件: {1}", rows.length - DIALOG_MAX_ROWS, ports.slice(DIALOG_MAX_ROWS).join(', ')));
	}
	return shown;
}

/**
 * 1 件の引数で頼まれた（`ports` を使っていない）ときは、これまでどおり 1 件の形で返す
 * （失敗ならその誤り、成功ならその 1 件の中身）。
 */
function single(batch: boolean, result: ParadisPortToolResult): ParadisPortToolResult {
	if (batch || !result.ok) {
		return result;
	}
	const [item] = (result.data as { readonly results: readonly ParadisPortItemResult[] }).results;
	if (!item.ok) {
		return fail(item.error);
	}
	const data: Record<string, unknown> = { ...item };
	delete data.ok;
	return ok(data);
}

function refusal(outcome: ParadisAgentApprovalOutcome | 'timedOut'): string {
	// 2 つ目の選択肢は出していないので alternative は来ない。来ても承認としては扱わない
	return outcome === 'approve' || outcome === 'alternative' ? REFUSALS.denied : REFUSALS[outcome];
}

function localPortInUse(port: number): string {
	return `Local port ${port} on the user's computer is in use, so Para Code did not change the forward. Tell the user which local port is in use (only they can see what uses it on their computer), or keep the current local port.`;
}
