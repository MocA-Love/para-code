/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { IntervalTimer, raceTimeout, RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { reportParadisDiagnosticError, runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { generateTokensCSSForColorMap } from '../../../../editor/common/languages/supports/tokenization.js';
import { tokenizeToString } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { editorBackground, editorForeground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TerminalExitReason, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { XtermAddonImporter } from '../../../../workbench/contrib/terminal/browser/xterm/xtermAddonImporter.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisCollectAllTerminalInstances, paradisCollectLivePaneInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisTerminalIdentityService } from '../browser/paradisTerminalIdentityService.js';
import { IParadisSpaceNotesService } from '../../workspaceSwitch/common/paradisSpaceNotes.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPrStatus } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { renderSpreadsheetDiffMobileHtml, renderSpreadsheetMobileSheet } from './paradisMobileSpreadsheetHtml.js';
import { Channels, decodeParadisMobileWarmLeaseRequest, encodeNotify, NotifyKind, NotifyPayload, ParadisMobileWarmLeaseRequest } from '../common/paradisMobileProtocol.js';
import { paradisNotifySubtitleCandidate, paradisNotifyTitle } from '../common/paradisNotifyPresentation.js';
import { IParadisGitResult, IParadisMobileDesktopBattery, IParadisMobileInboundFrame, IParadisMobileInboundFrame as InboundFrame, IParadisMobileWindowStateV2, IParadisMobileWindowWorkspaceV2, PARADIS_MOBILE_PROTOCOL_VERSION, ParadisMobileTerminalOperationStatus, paradisResolveMobileTerminalStateKey } from '../common/paradisMobileRelay.js';
import { IParadisMobileWindowHost } from '../common/paradisMobileHost.js';
import { IParadisCcusageDashboardData } from '../../ccusage/electron-browser/paradisCcusageClient.js';
// PARA-PATCH: RTK節約データのモバイル配信
import { localize } from '../../../../nls.js';
import { isParadisRtkNotFoundError } from '../../rtk/common/paradisRtk.js';
import { IParadisRtkDashboardData } from '../../rtk/electron-browser/paradisRtkClient.js';
import { IParadisLimitsSnapshot } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { IParadisGithubMetricsSnapshot } from '../../githubMetrics/common/paradisGithubMetrics.js';
import { IParadisResourceMonitorMobileReport } from '../../resourceMonitor/common/paradisResourceMonitor.js';
import { IParadisSpaceDiskResult } from '../../spaceDisk/common/paradisSpaceDisk.js';
import { hash } from '../../../../base/common/hash.js';
import { IParadisPresetService, IParadisResolvedPreset, paradisGetPresetTasks, paradisPresetApprovalSignature, paradisPresetQualifiers } from '../../terminalPresets/common/paradisTerminalPresets.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisAgentModelSwitchGuard } from './paradisAgentModelSwitchGuard.js';
import { paradisCreateTerminalOutputConsumer, paradisQueueTerminalRelayOutput } from '../common/paradisTerminalOutputHotPath.js';
import { type ParadisBinaryFsResponseType, paradisEncodeNegotiatedBinaryFsResponse } from '../common/paradisMobileFileResponse.js';
import { paradisDecodeBinaryFsUpload } from '../common/paradisMobileFileUpload.js';
import { PARADIS_TERMINAL_BINARY_DATA_ENCODING, paradisEncodeNegotiatedBinaryTerminalData } from '../common/paradisMobileTerminalData.js';
import { IParadisMobileTerminalViewport, paradisIsValidTerminalViewportMessage, paradisReadTerminalViewport, paradisResolveTerminalViewport } from '../common/paradisMobileTerminalViewport.js';
import { paradisEncodeJsonResponsePayload } from '../common/paradisMobileGzipJson.js';
import { paradisContentHashResponse } from '../common/paradisMobileContentHash.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import { paradisCreateMobileUploadTarget, paradisResolveMobileWorkspacePath } from '../common/paradisMobileWorkspacePath.js';
import type { IParadisAgentLaunchInWorkspaceRequest, IParadisHeadlessWorktreeRequest, IParadisHeadlessWorktreeResult, IParadisWorktreeCreateFormData } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type StateSnapshot = IParadisMobileWindowStateV2;

/** Battery Status API（Chromium実装）。lib.domに型が無いため最小限を自前定義する。 */
interface INavigatorBatteryManager {
	readonly level: number;
	readonly charging: boolean;
	addEventListener(type: 'levelchange' | 'chargingchange', listener: () => void): void;
	removeEventListener(type: 'levelchange' | 'chargingchange', listener: () => void): void;
}

const MOBILE_WARM_LEASE_EXPIRY_MS = 15 * 60 * 1000;
const MOBILE_WARM_LEASE_MAX_OWNERS = 128;

export interface IParadisMobileWarmLeaseScheduler extends IDisposable {
	schedule(delay: number): void;
	cancel(): void;
}

type ParadisMobileWarmLeaseResource = 'ccusage' | 'spaceDisk';

interface IParadisMobileWarmLeaseOperation {
	readonly ownerId: string;
	readonly resource: ParadisMobileWarmLeaseResource;
	desiredActive: boolean;
	version: number;
	processedVersion: number;
	running: Promise<void> | undefined;
	abortPendingAcquire: (() => void) | undefined;
}

/**
 * Mobile wire の lease を renderer client の one-shot owner API へ橋渡しする。
 * provider 自身は renew を生成せず、mobile から届いた heartbeat と release だけを owner ごとに直列化する。
 */
export class ParadisMobileWarmLeaseProvider implements IDisposable {
	private readonly leases = new Map<string, { readonly ownerId: string; readonly resource: ParadisMobileWarmLeaseResource; expiresAt: number }>();
	private readonly operations = new Map<string, IParadisMobileWarmLeaseOperation>();
	private readonly expiryScheduler: IParadisMobileWarmLeaseScheduler;
	private disposed = false;

	constructor(
		private readonly setUsageWarmLease: (ownerId: string, active: boolean) => Promise<void>,
		private readonly setSpaceDiskWarmLease: (ownerId: string, active: boolean, cancellation?: AbortSignal) => Promise<void>,
		private readonly now: () => number = Date.now,
		schedulerFactory: (runner: () => void) => IParadisMobileWarmLeaseScheduler = runner => new RunOnceScheduler(runner, MOBILE_WARM_LEASE_EXPIRY_MS),
	) {
		this.expiryScheduler = schedulerFactory(() => this.purgeExpired());
	}

	setLease(mobileId: string, request: ParadisMobileWarmLeaseRequest): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		this.purgeExpired();
		const resource: ParadisMobileWarmLeaseResource = request.t === 'usageWarmLease' ? 'ccusage' : 'spaceDisk';
		const ownerId = `${mobileId}:${resource}:${request.leaseId}`;
		if (!request.active) {
			if (!this.leases.delete(ownerId)) {
				return Promise.resolve();
			}
			this.scheduleExpiry();
			return this.requestOperation(ownerId, resource, false);
		}
		if (!this.operations.has(ownerId) && this.operationCount(resource) >= MOBILE_WARM_LEASE_MAX_OWNERS) {
			return Promise.resolve();
		}
		this.leases.set(ownerId, { ownerId, resource, expiresAt: this.now() + MOBILE_WARM_LEASE_EXPIRY_MS });
		this.scheduleExpiry();
		return this.requestOperation(ownerId, resource, true);
	}

	private operationCount(resource: ParadisMobileWarmLeaseResource): number {
		let count = 0;
		for (const operation of this.operations.values()) {
			if (operation.resource === resource) {
				count++;
			}
		}
		return count;
	}

	private purgeExpired(): void {
		if (this.disposed) {
			return;
		}
		const now = this.now();
		for (const [ownerId, lease] of this.leases) {
			if (lease.expiresAt <= now) {
				this.leases.delete(ownerId);
				void this.requestOperation(ownerId, lease.resource, false);
			}
		}
		this.scheduleExpiry();
	}

	private scheduleExpiry(): void {
		this.expiryScheduler.cancel();
		let earliest = Number.POSITIVE_INFINITY;
		for (const lease of this.leases.values()) {
			earliest = Math.min(earliest, lease.expiresAt);
		}
		if (Number.isFinite(earliest)) {
			this.expiryScheduler.schedule(Math.max(0, earliest - this.now()));
		}
	}

	private requestOperation(ownerId: string, resource: ParadisMobileWarmLeaseResource, active: boolean): Promise<void> {
		let operation = this.operations.get(ownerId);
		if (operation === undefined) {
			operation = { ownerId, resource, desiredActive: active, version: 0, processedVersion: 0, running: undefined, abortPendingAcquire: undefined };
			this.operations.set(ownerId, operation);
		}
		if (!active) {
			operation.abortPendingAcquire?.();
		}
		operation.desiredActive = active;
		operation.version++;
		operation.running ??= this.reconcile(operation);
		return operation.running;
	}

	private async reconcile(operation: IParadisMobileWarmLeaseOperation): Promise<void> {
		try {
			while (operation.processedVersion !== operation.version) {
				const version = operation.version;
				const active = operation.desiredActive;
				try {
					if (operation.resource === 'ccusage') {
						await this.setUsageWarmLease(operation.ownerId, active);
					} else if (active) {
						const cancellation = new AbortController();
						const abortPendingAcquire = () => cancellation.abort();
						operation.abortPendingAcquire = abortPendingAcquire;
						try {
							await this.setSpaceDiskWarmLease(operation.ownerId, true, cancellation.signal);
						} finally {
							if (operation.abortPendingAcquire === abortPendingAcquire) {
								operation.abortPendingAcquire = undefined;
							}
						}
					} else {
						await this.setSpaceDiskWarmLease(operation.ownerId, false);
					}
				} catch (error) {
					const action = active ? 'acquire' : 'release';
					reportParadisDiagnosticError('owned', 'mobile-warm-lease', `backend-${action}`, error, {
						safe_action: action,
						safe_resource: operation.resource,
						safe_owner_id: operation.ownerId,
					}, active ? 'error' : 'warning');
					// release は best-effort、acquire は local lease を残して次の mobile heartbeat で再試行する。
				}
				operation.processedVersion = version;
			}
		} finally {
			operation.running = undefined;
			if (!operation.desiredActive && operation.processedVersion === operation.version && !this.leases.has(operation.ownerId)) {
				this.operations.delete(operation.ownerId);
			}
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.expiryScheduler.dispose();
		const leases = [...this.leases.values()];
		this.leases.clear();
		for (const lease of leases) {
			void this.requestOperation(lease.ownerId, lease.resource, false);
		}
	}
}

/**
 * Resolves the best local cwd available for agent command discovery. CwdDetection
 * is authoritative when present; local terminals then fall back to the terminal's
 * speculative resolver, which also includes NaiveCwdDetection and the initial cwd.
 */
export async function paradisResolveLocalAgentPaneCwd(instance: Pick<ITerminalInstance, 'remoteAuthority' | 'getCwdResource' | 'getSpeculativeCwd'>): Promise<string | undefined> {
	try {
		const detected = await instance.getCwdResource();
		if (detected !== undefined) {
			return detected.scheme === 'file' ? detected.fsPath : undefined;
		}
	} catch {
		// A local speculative cwd can still be available without shell integration.
	}
	if (instance.remoteAuthority !== undefined) {
		return undefined;
	}
	try {
		const speculative = await instance.getSpeculativeCwd();
		return speculative.length > 0 ? speculative : undefined;
	} catch {
		return undefined;
	}
}

/** ターミナルのサブプロトコル（termチャネルのペイロード、JSON）。 */
type TermInboundBase = { protocolVersion: 3; desktopEpoch: string; operationId: string };
type TermInbound = TermInboundBase & (
	// epoch はモバイルが attach ごとに採番する世代番号。指定があると同期プロトコル
	// （seq 付与・ACKフロー制御・リサイズ時スナップショット再同期）が有効になる。
	// viewCols/viewRows はモバイル画面が読める寸法。指定があると PTY 自体をその寸法へ
	// 寄せる（setOverrideDimensions）。省略時は従来どおり PC 側の寸法のまま。
	| { t: 'attach'; terminalKey: string; epoch: number; dataEncoding?: string; viewCols?: number; viewRows?: number }
	| { t: 'detach'; terminalKey: string }
	// attach 済みのまま画面寸法だけ変わったとき（回転・キーボード開閉・設定変更）。
	// 両方省略すると寸法の寄せをやめて PC 側の寸法へ戻す。
	| { t: 'viewport'; terminalKey: string; viewCols?: number; viewRows?: number }
	// 受信済み最終 seq の確認応答（epoch 対応クライアントのみ）。フロー制御の材料。
	| { t: 'ack'; terminalKey: string; epoch: number; seq: number }
	// input は3形態:
	// - key: 矢印キー等のセマンティック指定。PC側が端末モード（application cursor keys）に
	//   合わせて CSI / SS3 へエンコードする
	// - text: コンポーザーからのテキスト入力。sendText の bracketed paste 対応を通し、
	//   複数行貼り付けがTUIで1行目から実行されてしまう問題を防ぐ。execute=true で実行（Enter）
	// - data: Esc/Tab/^C 等の生のエスケープシーケンス
	| { t: 'input'; terminalKey: string; data?: string; key?: TermSemanticKey; text?: string; execute?: boolean }
	// モバイルでターミナルを指でなぞったときのスクロール要求。
	// 「どのシーケンスを送るか」はPC側で決める。モバイルの xterm は PC のモードを
	// スナップショット越しにミラーしているだけで、再同期の谷間では古い値を持ちうるし、
	// マウスレポートのエンコーディング（SGR かどうか）は公開APIから読めない。
	// 意図（どちらへ何行）だけを受け取り、本物の端末を持っているPC側で組み立てる。
	| { t: 'scroll'; terminalKey: string; dir: 'up' | 'down'; lines: number }
	| { t: 'create'; windowId: number; ws: string }
	// モバイルからのターミナル名変更。PC側の実インスタンスへ反映し、stateの再送で
	// 他モバイル端末（およびPC自身のタブ表示）にも波及させる。
	| { t: 'rename'; terminalKey: string; title: string }
	// モバイルからのターミナル削除（ホーム長押しメニュー）。モバイル側で確認済みの前提で
	// PC側の実インスタンスを閉じる。onDidChangeInstances経由でstateが自動再送され、
	// 他モバイル端末・PC自身のタブ表示からも消える。
	| { t: 'close'; terminalKey: string }
	// モバイルからのエージェント状態の既読（ホームのステータスバッジタップ→「確認済みにする」）。
	// PCのフォーカス中自動既読と同じ acknowledgePaneStatus 経路を通すため、'review' 状態のみ
	// クリアされ、通知履歴のdismiss等の後続処理も自動で走る。
	| { t: 'ackStatus'; terminalKey: string }
);
type TermSemanticKey = 'up' | 'down' | 'right' | 'left';
type TermOutbound =
	// snapshot=true は画面復元用フレーム（VTシーケンス込み）。モバイルは追記せず
	// バッファ全体を置き換える（attach 時・リサイズ時・フロー制御の追いつき時）。
	// epoch/seq は同期プロトコル有効時のみ付与（seq は送信順に1ずつ増える。モバイルは
	// ギャップ検出で再attachする）。snapshot には適用すべき cols/rows と unicode 幅版も同梱する。
	| { t: 'data'; data: string; snapshot?: boolean; epoch: number; seq: number; cols?: number; rows?: number; unicode?: string }
	| { t: 'exit'; epoch?: number };

/** scm チャネルのサブプロトコル（JSON、リクエスト/レスポンス）。 */
type ScmInbound =
	| { t: 'status'; id: string; ws: string }
	| { t: 'diff'; id: string; ws: string; path?: string; staged?: boolean; responseEncoding?: string }
	| { t: 'xlsxDiff'; id: string; ws: string; path: string; responseEncoding?: string }
	| { t: 'commit'; id: string; ws: string; message: string; all?: boolean }
	| { t: 'log'; id: string; ws: string; limit?: number; skip?: number }
	| { t: 'commitFiles'; id: string; ws: string; hash: string }
	// worktree（スペース）作成のフォーム材料と作成本体。他のscmメッセージと違い特定の
	// ワークスペースに紐づかないため ws を持たない（repo はリポジトリid）。
	// model/effort/permission はエージェント定義（worktreeForm の agents）の各オプションid。
	| { t: 'worktreeForm'; id: string; ws?: undefined }
	| { t: 'createWorktree'; id: string; ws?: undefined; repo: string; name?: string; branch?: string; base?: string; prompt?: string; agent?: string; model?: string; effort?: string; permission?: string; runSetup?: boolean }
	// 既存ワークスペース（スペース）でのエージェント起動（モバイルのホーム＋ボタン）。
	// 新しいターミナルを作ってエージェントCLIコマンドを送る。
	| { t: 'launchAgent'; id: string; ws: string; agent: string; prompt?: string; model?: string; effort?: string; permission?: string }
	// スペースのメモ（PC版 Workspaces ビュー下部のメモ欄と同じ本文）の取得・更新。
	// git 実行を伴わないが、ws 単位のリクエストという点で他の scm メッセージと同じ扱いにする。
	| { t: 'noteGet'; id: string; ws: string }
	| { t: 'noteSet'; id: string; ws: string; text: string }
	// コマンドプリセット（PC版のターミナルタブバー右のボタンと同じもの）の一覧と実行。
	// launchAgent と同じく「そのスペースで新しいターミナルを作る」操作なので ws 単位。
	| { t: 'presets'; id: string; ws: string }
	// signature は一覧で受け取った承認署名。実行の直前に PC 側で計算し直して突き合わせる
	// （詳細は paradisPresetMobileSignature）。
	| { t: 'runPreset'; id: string; ws: string; key: string; signature: string };

/** モバイルへ渡すコマンドの最大長。プレビューではなく実行される本文をそのまま見せるための上限。 */
const PRESET_COMMAND_MAX_LENGTH = 500;
/** モバイルへ渡すタスク（＝ターミナル）とコマンドの最大数。異常に大きい定義で state を膨らませない。 */
const PRESET_MAX_TASKS = 12;
const PRESET_MAX_COMMANDS_PER_TASK = 20;
/** モバイルへ渡すプリセットの最大件数。1リクエストの応答サイズを定義の書き方に委ねない。 */
const PRESET_MAX_ENTRIES = 60;

/**
 * 承認の突き合わせに使う署名。
 *
 * **モバイルが組み立てた署名を信じない。** モバイルへ渡す tasks は表示のために切り詰めてあり
 * （上の3つの上限）、切り詰めた形から署名を作ると「シートに出ない13番目のタスク」や
 * 「500文字目より後ろのコマンド」を書き足しても署名が変わらず、一度承認したプリセットが
 * その中身のまま黙って実行される。cwd も同じ理由で表示に含めていない。
 *
 * そこで PC 側が完全な定義から署名を作り、モバイルはそれを預かって実行時に返すだけにする。
 * 実体は PC 版の autoRun 承認と同じ paradisPresetApprovalSignature（cwd も含む）。
 */
function paradisPresetMobileSignature(preset: IParadisResolvedPreset): string {
	return String(hash(paradisPresetApprovalSignature(preset)));
}

/**
 * モバイルへ渡すプリセット1件の形（app/mobile/src/store.ts の PresetDef と対）。
 * 定義を明示するのは、この形がそのままスマホの表示と承認の材料になるため。
 */
interface IParadisMobilePreset {
	readonly key: string;
	readonly name: string;
	readonly source: 'user' | 'workspace';
	readonly layout: string;
	readonly signature: string;
	readonly description?: string;
	readonly icon?: string;
	/**
	 * 同じ名前のプリセットが並ぶときに、その1件を他と分けている語（対象リポジトリなど）。
	 * **PC側で一覧全体を見て決める。** スマホには一覧の一部しか届かない（上限で切り詰める）ので、
	 * 手元で名前を数えると「同名なのに区別語が出ない」ことが起きる。
	 */
	readonly qualifier?: string;
	/** 上限で切り詰めた表示であること（実行される内容はこれより多い）。 */
	readonly truncated?: boolean;
	readonly tasks: readonly { readonly name?: string; readonly commands: readonly string[] }[];
}

/**
 * プリセット定義を、モバイルが一覧・確認ダイアログに出せる形へ落とす。
 * 実行に必要なのは key と signature だけだが、押す前に「どの端末で何が走るか」を
 * 見せるため、タスクの分かれ方とコマンド本文も一緒に渡す。
 * 上限で切り詰めた場合は truncated を立て、モバイル側が「全部は出せていない」と言えるようにする。
 */
function paradisDescribePresetForMobile(preset: IParadisResolvedPreset, qualifiers?: ReadonlyMap<string, string>): IParadisMobilePreset {
	const { tasks, layout } = paradisGetPresetTasks(preset);
	const shown = tasks.slice(0, PRESET_MAX_TASKS).map(task => ({
		...(task.name ? { name: task.name } : {}),
		commands: task.commands.slice(0, PRESET_MAX_COMMANDS_PER_TASK).map(command => command.slice(0, PRESET_COMMAND_MAX_LENGTH)),
	}));
	const truncated = tasks.length > PRESET_MAX_TASKS
		|| tasks.some(task => task.commands.length > PRESET_MAX_COMMANDS_PER_TASK
			|| task.commands.some(command => command.length > PRESET_COMMAND_MAX_LENGTH));
	return {
		key: preset.key,
		name: preset.name,
		source: preset.source,
		layout,
		signature: paradisPresetMobileSignature(preset),
		...(preset.description ? { description: preset.description } : {}),
		...(preset.icon ? { icon: preset.icon } : {}),
		...(qualifiers?.get(preset.key) ? { qualifier: qualifiers.get(preset.key) } : {}),
		...(truncated ? { truncated: true } : {}),
		tasks: shown,
	};
}

/** fs チャネルのサブプロトコル（JSON、リクエスト/レスポンス）。 */
type FsInbound =
	| { t: 'list'; id: string; ws: string; path: string }
	| { t: 'resolveLink'; id: string; ws: string; path: string }
	| { t: 'read'; id: string; ws: string; path: string; highlight?: boolean; responseEncoding?: string; cacheEncoding?: string; ifContentHash?: string }
	| { t: 'xlsx'; id: string; ws: string; path: string; sheet?: number; responseEncoding?: string; cacheEncoding?: string; ifContentHash?: string }
	| { t: 'pdf'; id: string; ws: string; path: string; responseEncoding?: string }
	| { t: 'docx'; id: string; ws: string; path: string; responseEncoding?: string }
	| { t: 'media'; id: string; ws: string; path: string; responseEncoding?: string }
	| { t: 'find'; id: string; ws: string; query: string }
	| { t: 'grep'; id: string; ws: string; query: string }
	| { t: 'upload'; id: string; name: string; data: string | Uint8Array; base64Length?: number }
	| { t: 'usage'; id: string; bypassCache?: boolean }
	// PARA-PATCH: RTK節約データのモバイル配信（PC版のRTKダッシュボードと同じデータ）
	| { t: 'rtk'; id: string; bypassCache?: boolean }
	// Rate Limit(AIリミット)スナップショット（PC版タイトルバーのリミットモニターと同じデータ）
	| { t: 'limits'; id: string; bypassCache?: boolean }
	// GitHub API利用状況（PC版のGitHub API Usageダッシュボードと同じデータ）
	| { t: 'github'; id: string; bypassCache?: boolean }
	// PC本体のリソース使用量（マシン全体のCPU/メモリ/ディスク＋Para Code内訳）
	| { t: 'sysres'; id: string; bypassCache?: boolean }
	| { t: 'spacedisk'; id: string; bypassCache?: boolean }
	// テキスト断片のシンタックスハイライト（エージェントチャットのコードブロック用）。
	// lang はMarkdownフェンスの言語名（ts / typescript / python 等）。
	| { t: 'hl'; id: string; text: string; lang?: string };

// ファイル読み取り上限（バイト）。旧上限（1MiB）では単一ページに完結した大きめのHTMLレポート/
// ダッシュボード出力が先頭で打ち切られ、`.html`のレンダー表示（生HTMLをそのままWebViewへ
// 渡す唯一の経路）で途中から表示が壊れる不具合の原因になっていたため、バイナリと同じ
// BINARY_READ_LIMIT まで引き上げた。
//
// 注意: gzip圧縮（store.ts の fsRead が指定する JSON_GZIP_RESPONSE_ENCODING）が効くのは
// クライアントが対応を交渉し、かつJSON化後が32MiB以下のときだけで、無条件には効かない。
// また非UTF-8バイト列は `content.value.toString()` でU+FFFDへ置換されて3倍、制御文字は
// JSONエスケープで最大6倍に膨らみうる（base64膨張は無いという主張は本文には正しいが、
// JSONエスケープ膨張は別に効く）。20MiB読んだテキストがJSON化・エスケープでFrameMuxの
// 再結合上限（FRAME_REASSEMBLY_LIMIT = 32MiB）を超えないよう、下の FS_RESPONSE_PAYLOAD_LIMIT
// で送信直前に実サイズを検査している。
const FS_READ_LIMIT = 20 * 1024 * 1024;
// fsチャンネルの応答（gzip交渉が効かない場合は無圧縮のJSON）が FrameMux の再結合上限
// （FRAME_REASSEMBLY_LIMIT = 32MiB）を超えないよう、安全マージンを残して送信前に弾く値。
// 超えた場合、黙って送って接続を切断させる（`onFatal`でソケットが閉じ再ハンドシェイクになる）
// より、エラー応答を返すほうがユーザーへの影響が小さい。
const FS_RESPONSE_PAYLOAD_LIMIT = 24 * 1024 * 1024;
// バイナリ（PDF・Word・画像・動画・音声）の読み取り上限。base64 で約1.37倍に膨らむため、
// FrameMux の再結合上限（FRAME_REASSEMBLY_LIMIT = 32MiB）に収まるようここで抑える（20MiB → base64 約27MiB）。
const BINARY_READ_LIMIT = 20 * 1024 * 1024;
const UPLOAD_LIMIT = 10 * 1024 * 1024; // モバイルからの添付アップロード上限（バイト）
const UPLOAD_BASE64_LIMIT = Math.ceil(UPLOAD_LIMIT * 4 / 3) + 4; // 同、base64文字列長での事前判定用
const UPLOAD_DECODED_LIMIT = Math.floor(UPLOAD_BASE64_LIMIT * 3 / 4); // unpadded Base64を含む従来許容範囲のraw上限
const HIGHLIGHT_SOURCE_LIMIT = 128 * 1024; // ハイライト対象の上限（HTML化で数倍に膨らむため読み取り上限より絞る）
const TERM_SCROLLBACK_LIMIT = 16 * 1024; // attach時に送る直近バッファ上限（文字。serialize不可時のフォールバック用）
/**
 * 質問の選択肢が画面に出るのを待つ上限。ここを過ぎたら待たずに流す（送信を止める門ではない）。
 *
 * 実測（Claude Code 2.1.223）では、質問が描かれてから打鍵が効くまでに待ちが要る。待たずに
 * 送った1打鍵は入力欄へ吸われて消え、3秒待った同じ打鍵は通った。上限はその実測より少し広く取る。
 */
const INTERACTION_READY_TIMEOUT_MS = 5_000;
/** 選択肢が見えてから打鍵するまでの一拍（描画とフォーカス移動の隙間ぶん）。 */
const INTERACTION_READY_SETTLE_MS = 400;
/** 画面を見に行く間隔。 */
const INTERACTION_READY_POLL_MS = 150;

/**
 * ターミナルの**見えている範囲**だけを文字列にする。
 *
 * `getContentsAsText()` を引数無しで呼ぶと**スクロールバック全体**（既定1000行、設定次第でもっと）
 * を走査する。目印の照合にそれを使うと、**過去に同じ質問が出ていれば履歴に必ず当たる**ので
 * 「もう描かれている」と誤判定し、待ちの意味が消える。同じ質問へ答え直すケース（まさに直したい
 * 場面）ほど確実に踏むので、可視領域に限ること。走査量が数十行で収まる利点もある。
 */
function paradisVisibleTerminalText(instance: ITerminalInstance): string {
	const raw = instance.xterm?.raw;
	if (raw === undefined) {
		return '';
	}
	const buffer = raw.buffer.active;
	const lines: string[] = [];
	for (let y = buffer.baseY; y < buffer.baseY + raw.rows; y++) {
		lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
	}
	return lines.join('\n');
}

/**
 * 画面に目印が出ているかを、**空白と改行を無視して**照合する。
 *
 * ターミナルは幅で折り返し、折り返しの境目には改行が入る。Para Code は2Dグリッドで
 * 狭いペインが常態なので、素朴な部分一致だと日本語ラベルなどは折り返しでほぼ必ず外れる。
 * 目印側も同じ規則で作る（{@link paradisQuestionReadyMarker}）。
 */
export function paradisScreenShowsMarker(screen: string, marker: string): boolean {
	return screen.replace(/\s+/g, '').includes(marker);
}

/**
 * xterm.js が今まさにSGR拡張座標（DECSET 1006）でマウスイベントを符号化しているか。
 *
 * 公開APIには無いが、`_core` 経由で内部サービスを覗くのは upstream 自身が既に使っている
 * パターン（`workbench/contrib/terminal/browser/xterm/xtermTerminal.ts:285-288` の
 * `ITerminalWithCore`/`IXtermCore`）。ここで覗く `_inputHandler._mouseStateService` は
 * `IXtermCore` にまだ無いフィールドなので、このファイル内だけの狭い構造型で受ける
 * （`IXtermCore` 自体は書き換えない＝差し替え点を1つに保つ）。
 *
 * `@xterm/headless` で実測して到達可能なことを確認済み: DECSET 1000/1002/1003/1006 を
 * 流すと `activeEncoding` は `'SGR'`。1006 抜き（`mouse=a` だが legacy encoding の vim 相当）
 * だと `'DEFAULT'` のまま。読めない・想定外の形のときは `false`（矢印キーへのフォールバック
 * 側）に倒す。
 */
export function paradisIsSgrMouseEncodingActive(raw: RawXtermTerminal): boolean {
	interface IXtermCoreWithMouseState {
		_inputHandler?: {
			_mouseStateService?: {
				activeEncoding?: unknown;
			};
		};
	}
	const core = (raw as unknown as { _core?: IXtermCoreWithMouseState })._core;
	return core?._inputHandler?._mouseStateService?.activeEncoding === 'SGR';
}

const TERM_SNAPSHOT_SCROLLBACK_ROWS = 1000; // attach時のVTスナップショットで通常バッファから含めるスクロールバック行数（代替バッファ=TUIは常に全体）
/**
 * リサイズ再同期のスナップショットに含めるスクロールバック行数。
 *
 * **0にしてはいけない。** モバイルはスナップショットを受けると必ず端末をリセットしてから
 * 書き戻すので、ここに載らなかった履歴はその場で失われる（遡れなくなる）。さらにこの再同期は
 * attach のたびにも走る（モバイルの申告寸法をPTYへ反映した結果リサイズが発火するため）ので、
 * 0 だと attach で送った1000行を200ms後に自分で消してしまう。
 *
 * 1000行のままだと実測16万文字に達し、TERM_HIGH_WATERMARK_CHARS を超えて送信直後に必ず
 * フロー制御のsuspendedを誘発していた。200行はその上限を下回りつつ、遡れる範囲を残す妥協点。
 */
const TERM_RESIZE_SNAPSHOT_SCROLLBACK_ROWS = 200;
// --- ターミナル同期プロトコル（epoch対応クライアント向け）の定数 ---
const TERM_COALESCE_MS = 16; // onData のまとめ送り間隔（1フレーム=1暗号化+relay往復のため細切れ送信を避ける）
// フロー制御: 未ACK文字数が HIGH を超えたら生ストリーム転送を止め（ptyは止めない）、
// ACK が LOW まで追いついたらスナップショット1発で最新画面へ追いつく（mosh の
// 「中間状態スキップ」方式）。値は本家 FlowControlConstants（renderer↔ptyHost間）に合わせる。
const TERM_HIGH_WATERMARK_CHARS = 100_000;
const TERM_LOW_WATERMARK_CHARS = 5_000;
const TERM_RESIZE_SNAPSHOT_DELAY_MS = 200; // リサイズ確定からスナップショット再同期までのデバウンス
const TERMINAL_CREATE_READY_TIMEOUT_MS = 10_000; // 非表示スペース向け作成時にPTY起動を待つ上限（park に persistentProcessId が要る）
// モバイル画面幅に合わせた寸法申告のリース。
//
// PTYを細くしたまま戻せなくなる事故を根本から防ぐための仕組み。「モバイルがオフラインに
// なった」通知に頼ると、アプリのタスクキルや圏外でソケットが half-open のまま残った場合に
// 復帰できない（リレーはモバイルソケットの生死を監視していない。キープアライブpingを
// 送っているのはPCだけで、DOはエッジ自動応答で寝たままハイバネートする）。
// そこでモバイルには申告を定期更新させ、更新が途絶えたらPC側の判断で寸法を戻す。
const TERM_VIEWPORT_LEASE_MS = 60_000;       // この時間更新が無ければ申告を捨てる
const TERM_VIEWPORT_SWEEP_MS = 15_000;       // 満了チェックの周期
// スワイプ1回で送れるスクロール行数の上限。速くなぞったときに大量のキーを撃ち込まない。
const TERM_SCROLL_MAX_LINES = 40;
// マウスホイール1刻みで進む行数の目安（多くのTUIが採用する慣習値）。モバイル側は行数で
// 申告してくるため、ホイールで送るときはこの値で割ってホイール刻み数へ変換する。
// 割らずに1行=1刻みで送ると、同じスワイプでも矢印キー経路の約3倍スクロールしてしまう。
const TERM_SCROLL_LINES_PER_WHEEL_TICK = 3;

/** VTスナップショットを送る理由（計測でどの経路が転送量を占めるか切り分けるため）。 */
type TermSnapshotReason = 'attach' | 'flow' | 'resize';

/** epoch対応クライアントがattach中のターミナル1つ分の同期プロトコル状態。 */
interface TermSyncState {
	/** モバイルが attach 時に採番した世代番号（送信フレームへ毎回付与する）。 */
	epoch: number;
	/** 現在のattachが明示交渉したdata encoding。別epochへ持ち越さない。 */
	dataEncoding?: string;
	/** 直近に送信したseq（送信直前にインクリメント。snapshotも消費する）。 */
	seq: number;
	/** 送信済み・未ACKのフレーム（フロー制御の残量計算用）。 */
	inflight: { seq: number; chars: number }[];
	unackedChars: number;
	/** フロー制御で生ストリーム転送を停止中（ptyは止めない。ACKが追いつくとsnapshotで再同期）。 */
	suspended: boolean;
	/** suspend中に出力を破棄した（=再開時にsnapshot再同期が必要）。 */
	droppedWhileSuspended: boolean;
	/** onData のまとめ送りバッファ。 */
	pending: string[];
	pendingChars: number;
	coalesceTimer: ReturnType<typeof setTimeout> | undefined;
	resizeTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * shared process のリレーサービスと、このウィンドウのワークスペース/ターミナルを橋渡しする。
 * - state: ワークスペース・ターミナル・エージェント状態のスナップショットを push
 * - term: モバイルからの attach/input を処理し、ターミナル出力を stream 送信
 *
 * SCM / fs / browser チャネルは本スライスでは未実装（設計書 M2/M3。ここに追加していく）。
 */
export class ParadisMobileWorkspaceProvider extends Disposable {
	readonly initialAgentPanesReady: Promise<void>;
	private readonly markInitialAgentPanesReady: () => void;
	private agentPanesRevision = 0;
	private confirmedAgentPaneTokens = new Set<string>();
	private readonly provisionalAgentPaneTokens = new Set<string>();
	// ターミナルID → PC側出力listener（全モバイル購読者へ分配するため1端末1本）。
	private readonly attachedTerminals = this._register(new DisposableMap<number>());
	// ターミナルID → 出力を購読中のモバイルID。
	private readonly terminalSubscribers = new Map<number, Set<string>>();
	// エージェント状態の遷移検知用（stateKey → 直近の状態）。
	private readonly previousScopeStatus = new Map<string, string>();
	// attach時のVTスナップショット生成に使う serialize addon（PC側xtermの現画面を
	// エスケープシーケンス込みでシリアライズし、モバイルのxtermで完全再現するため）。
	private readonly xtermAddonImporter = new XtermAddonImporter();
	// raw xterm → その端末に一度だけ load した serialize addon（端末ごとに1つ）。
	private readonly serializeAddons = new WeakMap<object, { serialize(options?: { scrollback?: number }): string }>();
	// mobileId + ターミナルID → 独立したepoch/seq/ACK状態。
	private readonly termSyncStates = new Map<string, TermSyncState>();
	// mobileId + ターミナルID → そのモバイルが読める画面寸法（申告があったものだけ）と、
	// 最後に申告を受け取った時刻。申告はリース制で、更新が途絶えたら期限切れで捨てる。
	// instanceId を値に持たせているのは、期限切れの掃除でキー文字列を再パースしないため
	// （パースに失敗すると台帳からは消えるのに override は解除されず、この機能が防ごうと
	// している「細いまま戻らない」がそのまま残る）。
	private readonly termViewports = new Map<string, { instanceId: number; viewport: IParadisMobileTerminalViewport; renewedAt: number }>();
	// ターミナルID → 最後に適用した寸法。リースの更新（同じ値の再申告）で毎回
	// setOverrideDimensions を叩かないためのガード。同値でも PTY への IPC は走るため、
	// 20秒ごとの更新が端末数ぶん積み上がる（ConPTY は同値リサイズでも再レイアウトする）。
	private readonly termAppliedDimensions = new Map<number, { cols: number; rows: number }>();
	// リース満了を掃く周期タイマー（申告が1つも無い間は動かさない）。
	private readonly viewportLeaseSweeper = this._register(new IntervalTimer());
	private viewportLeaseSweeperRunning = false;
	// 寸法の上書きを「自分が」掛けているターミナルID。拡張機能が握っている override を
	// 解除時に巻き込まないよう、自分で掛けた分だけを覚えておく。
	private readonly termOverriddenInstanceIds = new Set<number>();
	// モバイル発の /model・/effort 切替でClaude TUIが出す確認ダイアログを自動確定するガード。
	private readonly modelSwitchGuard = this._register(new ParadisAgentModelSwitchGuard(this.logService));
	// PC本体のバッテリー状態（Battery Status API）。未対応環境ではundefinedのまま＝state未配信。
	private battery: IParadisMobileDesktopBattery | undefined;
	private readonly mobileWarmLeases: ParadisMobileWarmLeaseProvider;
	constructor(
		private readonly sendFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly windowId: number,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly terminalService: ITerminalService,
		private readonly terminalGroupService: ITerminalGroupService,
		private readonly terminalEditorService: ITerminalEditorService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly spaceNotesService: IParadisSpaceNotesService,
		private readonly agentStatusStore: IParadisAgentStatusStore,
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly environmentService: IEnvironmentService,
		private readonly languageService: ILanguageService,
		private readonly extensionService: IExtensionService,
		private readonly themeService: IThemeService,
		private readonly sharedProcessService: ISharedProcessService,
		/**
		 * その URI が「このウィンドウから触れてよい場所」か。file はローカルなので常に true、
		 * vscode-remote は接続中の authority と一致する場合だけ true。
		 *
		 * 別ホストで登録した古い vscode-remote や、未接続中の vscode-remote を「手元」として
		 * 扱ってしまうと、たまたま絶対パスが一致する手元の無関係なリポジトリ/フォルダへ誤って
		 * 到達できてしまう（`runGit` は書き込みを伴うため実害が大きい。PR状態・ブランチ表示・
		 * 検索も、無関係な手元の内容を返す事故になる）。file/vscode-remote の許可判定は
		 * すべてこの関数を通すこと。
		 */
		private readonly isReachableWorkspaceUri: (uri: URI) => boolean,
		// 対象リポジトリ/worktree の URI から、git を動かすマシンを解決するのは呼び出し元
		// （paradisChannelHostResolver）の役目。ここは file・vscode-remote どちらの URI も
		// そのまま受け取れる。unresolved: 'reject' で解決できない場合は reject する。
		private readonly runGit: (repoUri: URI, args: readonly string[]) => Promise<IParadisGitResult>,
		private readonly paneTokenService: IParadisPaneTokenService,
		private readonly terminalIdentityService: IParadisTerminalIdentityService,
		private readonly syncTerminalState: (state: IParadisMobileWindowStateV2) => void,
		private readonly syncAgentPanes: (revision: number, entries: readonly { terminalId: number; token: string; cwd?: string; ws?: string }[]) => Promise<void>,
		private readonly completeTerminalOperation: (mobileId: string, operationId: string, status: ParadisMobileTerminalOperationStatus) => Promise<void>,
		private readonly claimAgentAction: (mobileId: string, requestId: string, token: string, epoch: string) => Promise<'claimed' | 'stale' | 'expired'>,
		private readonly continueAgentInteraction: (mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, windowId: number) => Promise<'valid' | 'completed' | 'stale'>,
		private readonly finalizeAgentInteraction: (mobileId: string, requestId: string, token: string, outcome: 'accepted' | 'failed') => Promise<void>,
		private readonly validateAgentAction: (mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, windowId: number) => Promise<boolean>,
		// search対象がどのマシンにあるかは呼び出し元（paradisRemoteSearchHostResolver）が
		// root の scheme/authority から解決する。
		private readonly searchFiles: (root: URI, query: string, maxResults: number) => Promise<{ files: string[]; truncated: boolean }>,
		private readonly searchText: (root: URI, query: string, maxResults: number) => Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>,
		private readonly fetchUsageDashboard: (bypassCache: boolean) => Promise<IParadisCcusageDashboardData>,
		setUsageWarmLease: (ownerId: string, active: boolean) => Promise<void>,
		// PARA-PATCH: RTK節約データのモバイル配信。実体は rtk のバックエンド(接続中は接続先の REH)
		private readonly fetchRtkSavings: (bypassCache: boolean) => Promise<IParadisRtkDashboardData>,
		// AIリミット(Rate Limit)スナップショット。実体は limitsMonitor の shared process バックエンド
		private readonly fetchLimitsSnapshot: (bypassCache: boolean) => Promise<IParadisLimitsSnapshot>,
		// GitHub API利用状況。実体は githubMetrics の shared process バックエンド（PC版と同じクライアント）
		private readonly fetchGithubMetrics: (bypassCache: boolean) => Promise<IParadisGithubMetricsSnapshot>,
		// worktree（スペース）作成。実体は paradisWorktreeHeadlessCreate.ts（contribution側で
		// instantiationService.invokeFunction に束ねて渡される。runGit等と同じコールバック方式）
		private readonly getWorktreeCreateForm: () => Promise<IParadisWorktreeCreateFormData>,
		private readonly createWorktree: (request: IParadisHeadlessWorktreeRequest) => Promise<IParadisHeadlessWorktreeResult>,
		// 既存ワークスペースへのエージェント起動。実体は paradisLaunchAgentInWorkspace
		private readonly launchAgentInWorkspace: (request: IParadisAgentLaunchInWorkspaceRequest) => Promise<void>,
		// 各リポジトリ/worktree の現在ブランチに紐づく PR 状態。実体は PC 版 Workspaces ビューと同じ
		// paradis.workspaceSwitch.getPrStatuses コマンド（contribution側で束ねて渡される）。
		// SSH 接続先のリポジトリでも正しいマシンの gh を使えるよう、URI をそのまま渡す
		// （コマンド側で paradisWorktreeGitHostResolver がホストを解決する）。
		private readonly getPrStatuses: (uris: readonly URI[]) => Promise<Record<string, IParadisPrStatus> | undefined>,
		// PC本体のCPU/メモリ/ディスクと Para Code 内訳。実体は resourceMonitor のクライアント
		// （収集はメインプロセス。モバイルの「システム」画面が開いている間だけ呼ばれる）
		private readonly fetchResourceReport: (force: boolean) => Promise<IParadisResourceMonitorMobileReport>,
		// スペース(リポジトリ/worktree)ごとのディスク使用量。実体は spaceDisk のクライアント
		// （計測は shared process。1周に数十秒かかるので裏で温めた結果が即座に返る）
		private readonly fetchSpaceDisk: (bypassCache: boolean) => Promise<IParadisSpaceDiskResult>,
		setSpaceDiskWarmLease: (ownerId: string, active: boolean, cancellation?: AbortSignal) => Promise<void>,
		// コマンドプリセット（PC版と同一の定義・同一の実行経路）。モバイルの一覧と実行はここを通す
		private readonly presetService: IParadisPresetService,
		// このウィンドウの接続先（ローカル/SSHリモート等）を都度解決する。モバイルの「接続先セグメント」
		// (rtk/ccusage/rate limit/GitHub API)向け。ラベルは拡張機能のフォーマッタ登録が遅れて届くため、
		// 呼び出し元（contribution）が onDidChangeFormatters で pushState() を呼び直す前提のコールバック。
		private readonly resolveWindowHost?: () => IParadisMobileWindowHost,
	) {
		super();
		this.mobileWarmLeases = this._register(new ParadisMobileWarmLeaseProvider(setUsageWarmLease, setSpaceDiskWarmLease));
		let markInitialAgentPanesReady!: () => void;
		this.initialAgentPanesReady = new Promise<void>(resolve => { markInitialAgentPanesReady = resolve; });
		this.markInitialAgentPanesReady = markInitialAgentPanesReady;

		// 状態が変わったらスナップショットを再送。エージェント状態の変化は通知判定も行う。
		// 再送はイベント起点では100msに集約する（特にウィンドウリサイズ中の
		// onDidChangeInstanceDimensions はインスタンス数×フレーム数で連射されるため、
		// そのまま送るとリレー帯域を浪費する）。
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => { this.refreshBranches(); this.kickPrStatusRefresh(); this.pushStateSoon(); }));
		// 切替はエディタターミナルのpark/unpark（allInstances の増減）を伴うため、agentペイン対応表も同期し直す
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => { this.pushStateSoon(); void this.pushAgentPanes(); }));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => { this.detectAndNotify(); this.pushStateSoon(); }));
		this._register(this.terminalService.onDidChangeInstances(() => this.pushStateSoon()));
		this._register(this.terminalIdentityService.onDidChange(() => this.pushStateSoon()));
		// タイトル変更（F2手動リネーム、モバイルからのrename、プロセス由来の自動タイトルなど）を
		// 他のペアリング端末・他ウィンドウへも伝播する。
		this._register(this.terminalService.onAnyInstanceTitleChange(() => this.pushStateCosmeticSoon()));
		// park/unpark（ワークスペース切り替えでの退避/復帰）は instances イベントに乗らないため groups 変化でも再送する
		this._register(this.terminalGroupService.onDidChangeGroups(() => this.pushStateSoon()));
		// PC側のリサイズで cols/rows が変わったら再送（モバイルのxtermが同寸法に追従する）
		this._register(this.terminalService.onDidChangeInstanceDimensions(() => this.pushStateCosmeticSoon()));
		// attach中ターミナルのリサイズは、寸法確定後にVTスナップショットで再同期する。
		// 生ストリームだけだと「新寸法向けの再描画がモバイルの旧寸法xtermへ書かれる」レースが
		// 構造的に残り、特に代替バッファ（TUI）はリサイズでリフローされないため崩れたままになる。
		this._register(this.terminalService.onDidChangeInstanceDimensions(instance => this.scheduleResizeResync(instance)));
		// worktree（スペース）の増減もワークスペース一覧に反映する（PR 状態も前倒しで取り直す）
		this._register(this.worktreeService.onDidChangeWorktrees(() => { this.kickPrStatusRefresh(); this.pushStateSoon(); }));
		// メモの未完了件数はワークスペース一覧に載るため、PC側で編集されたらモバイルへも反映する
		this._register(this.spaceNotesService.onDidChangeNotes(() => this.pushStateSoon()));
		// agentチャネル用: terminalId ⇔ ペイントークンの対応を shared process へ同期する
		// （チャットミラーが attach(id) を transcript へ解決するのに使う）。
		this._register(this.paneTokenService.onDidChange(() => { this.pushStateSoon(); void this.pushAgentPanes(); }));
		// 起動時の孤児エディタターミナル復活（reviveOrphanedScopedEditorTerminals）等、
		// park台帳への登録はterminalServiceのイベントに乗らない。スコープ確定の変化を
		// 再送のトリガーにして、復活したペインが state / agentペイン対応表へ確実に載るようにする。
		this._register(this.terminalScopeService.onDidChangeStableScope(() => { this.pushStateSoon(); void this.pushAgentPanes(); }));
		this._register(this.terminalService.onDidChangeInstances(() => { void this.pushAgentPanes(); }));
		this._register(this.terminalService.onAnyInstanceProcessIdReady(() => { void this.pushAgentPanes(); }));
		this._register(this.terminalService.onDidChangeInstanceCapability(() => { void this.pushAgentPanes(); }));
		void this.pushAgentPanes();
		this.refreshBranches();
		void this.trackBattery();
	}

	/**
	 * Mobile relayが有効な間だけstate push計測タイマーを動かす。
	 *
	 * 無効化時は、停止済みタイマーのキュー済みcallbackが実行されても古い集計を報告しないよう、
	 * 集計も同時に捨てる。
	 */
	setStatePushMetricsEnabled(enabled: boolean): void {
		if (this.statePushMetricsEnabled === enabled) {
			return;
		}
		this.statePushMetricsEnabled = enabled;
		const generation = ++this.statePushMetricsGeneration;
		if (!enabled) {
			this.statePushMetricsTimer.cancel();
			this.resetStatePushMetrics();
			return;
		}
		this.resetStatePushMetrics();
		this.statePushMetricsTimer.cancelAndSet(() => {
			if (this.statePushMetricsEnabled && generation === this.statePushMetricsGeneration) {
				this.reportStatePushMetrics();
			}
		}, 60_000);
	}

	private reportStatePushMetrics(): void {
		if (this.pushStateCalls === 0 && this.snapshotMetrics.size === 0) {
			return;
		}
		const { pushStateCalls: calls, pushStateSkipped: skipped } = this;
		const snapshots = [...this.snapshotMetrics].map(([reason, m]) => `${reason}=${m.count}/max${m.maxChars}/total${m.totalChars}`).join(' ');
		this.resetStatePushMetrics();
		this.logService.info(`[paradisMobileRelay][metrics] state push: ${calls} calls, ${skipped} skipped (no change), ${calls - skipped} forwarded, terminals=${this.allInstances().length}, stateBytes=${this.lastPushedSnapshot?.length ?? 0}${snapshots.length > 0 ? ` | terminal snapshots: ${snapshots}` : ''}`);
	}

	private resetStatePushMetrics(): void {
		this.pushStateCalls = 0;
		this.pushStateSkipped = 0;
		this.snapshotMetrics.clear();
	}

	/**
	 * PC本体のバッテリー状態を購読してstateへ載せる（モバイルのLive Activity表示用）。
	 * levelは5%刻みへ量子化し、1%ごとのstate全体再送でリレー帯域を浪費しないようにする。
	 */
	private async trackBattery(): Promise<void> {
		const getBattery = (navigator as Partial<{ getBattery(): Promise<INavigatorBatteryManager> }>).getBattery;
		if (typeof getBattery !== 'function') {
			return;
		}
		let manager: INavigatorBatteryManager;
		try {
			manager = await getBattery.call(navigator);
		} catch (err) {
			this.logService.trace('[paradisMobileRelay] battery status unavailable', err);
			return;
		}
		if (this._store.isDisposed) {
			return;
		}
		const apply = () => {
			const level = Math.max(0, Math.min(100, Math.round(manager.level * 100 / 5) * 5));
			const next: IParadisMobileDesktopBattery = { level, charging: manager.charging };
			if (this.battery?.level === next.level && this.battery.charging === next.charging) {
				return;
			}
			this.battery = next;
			this.pushStateCosmeticSoon();
		};
		manager.addEventListener('levelchange', apply);
		manager.addEventListener('chargingchange', apply);
		this._register(toDisposable(() => {
			manager.removeEventListener('levelchange', apply);
			manager.removeEventListener('chargingchange', apply);
		}));
		apply();
	}

	/**
	 * terminalId ⇔ ペイントークン対応表を shared process のチャットミラーへ同期する。
	 * cwd はhook未発火時のセッション探索フォールバック（~/.claude/projects の逆引き）に使う。
	 */
	syncAgentPaneRegistry(): Promise<void> {
		this.refreshAgentPaneCwdListeners();
		const revision = ++this.agentPanesRevision;
		const livePanes = paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService);
		const result = Promise.all(livePanes.map(async ({ instance: inst, token }) => {
			const cwd = await paradisResolveLocalAgentPaneCwd(inst);
			const ws = this.resolveTerminalStateKey(inst.instanceId);
			return { terminalId: inst.instanceId, token, ...(cwd !== undefined ? { cwd } : {}), ...(ws !== undefined ? { ws } : {}) };
		})).then(entries => this.syncAgentPanes(revision, entries.filter(entry =>
			this.paneTokenService.getInstanceForToken(entry.token) === entry.terminalId
			&& this.paneTokenService.getTokenForInstance(entry.terminalId) === entry.token,
		))).then(() => this.markInitialAgentPanesReady());
		void result.catch(err => this.logService.warn('[paradisMobileRelay] pushAgentPanes failed', err));
		return result;
	}

	private pushAgentPanes(): Promise<void> {
		return this.syncAgentPaneRegistry();
	}

	private readonly agentPaneCwdListeners = this._register(new DisposableMap<number>());

	private refreshAgentPaneCwdListeners(): void {
		const instances = paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService);
		const liveInstanceIds = new Set(instances.map(instance => instance.instanceId));
		for (const instanceId of [...this.agentPaneCwdListeners.keys()]) {
			if (!liveInstanceIds.has(instanceId)) {
				this.agentPaneCwdListeners.deleteAndDispose(instanceId);
			}
		}

		for (const instance of instances) {
			if (this.agentPaneCwdListeners.has(instance.instanceId)) {
				continue;
			}
			const listeners = new DisposableStore();
			const cwdListener = listeners.add(new MutableDisposable());
			const bindCwdListener = () => {
				const capability = instance.capabilities.get(TerminalCapability.CwdDetection)
					?? instance.capabilities.get(TerminalCapability.NaiveCwdDetection);
				cwdListener.value = capability?.onDidChangeCwd(() => { void this.pushAgentPanes(); });
			};
			bindCwdListener();
			listeners.add(instance.capabilities.onDidAddCapability(() => {
				bindCwdListener();
				void this.pushAgentPanes();
			}));
			listeners.add(instance.capabilities.onDidRemoveCapability(() => bindCwdListener()));
			listeners.add(instance.onDisposed(() => this.agentPaneCwdListeners.deleteAndDispose(instance.instanceId)));
			this.agentPaneCwdListeners.set(instance.instanceId, listeners);
		}
	}

	private readonly pushStateScheduler = this._register(new RunOnceScheduler(() => this.pushState(), 100));
	/**
	 * 見た目だけの変化（タイトル・cols/rows・バッテリー）専用の遅いスケジューラ。
	 * これらは表示が少し遅れても実害がない一方、TUIはタイトルを連射するため、構造変化と
	 * 同じ100msで流すと state がほぼ絶え間なく飛ぶ。
	 */
	private readonly pushStateCosmeticScheduler = this._register(new RunOnceScheduler(() => this.pushState(), 500));

	/**
	 * イベント起点のスナップショット再送（100msに集約）。
	 * public: contribution側の外部イベント（例: `ILabelService.onDidChangeFormatters`）からも
	 * 合流させたいため。呼び出し元を増やす場合も、この100ms集約に乗せることを優先すること
	 * （`pushState()`を直接呼ぶと、連続発火時にフルスナップショット構築が都度走る）。
	 */
	pushStateSoon(): void {
		// 構造変化のスナップショットには見た目の変化も入るので、待たせていたぶんは取り下げる。
		this.pushStateCosmeticScheduler.cancel();
		if (!this.pushStateScheduler.isScheduled()) {
			this.pushStateScheduler.schedule();
		}
	}

	/**
	 * 見た目だけの変化の再送（500msに集約）。
	 *
	 * **`isScheduled()` のガードは絶対に外さないこと。** 素の `schedule()` は既存タイマーを
	 * 張り直す＝デバウンスになるため、タイトルを連射するTUIが動いている間、state が永久に
	 * 更新されなくなる（スロットルなら必ず500msごとに1回は流れる）。
	 */
	private pushStateCosmeticSoon(): void {
		// 構造変化が既に予約されていれば、そちらが見た目の変化ごと運ぶので何もしない。
		if (!this.pushStateCosmeticScheduler.isScheduled() && !this.pushStateScheduler.isScheduled()) {
			this.pushStateCosmeticScheduler.schedule();
		}
	}

	/** 直近に shared process へ渡したスナップショットのJSON（無変化再送の打ち切り用）。 */
	private lastPushedSnapshot: string | undefined;
	/** 計測用: pushState の呼び出し回数と、そのうち無変化で打ち切った回数。 */
	private pushStateCalls = 0;
	private pushStateSkipped = 0;
	// state push計測は有効時だけ動かし、無効なworkbenchではrendererの定期起床を作らない。
	private readonly statePushMetricsTimer = this._register(new IntervalTimer());
	private statePushMetricsEnabled = false;
	private statePushMetricsGeneration = 0;
	/**
	 * 計測用: VTスナップショットの送信実績（理由別の件数と最大文字数）。
	 * 1件ごとに出すとフロー制御の追いつきが連発する状況——まさに測りたい場面——で
	 * ログが溢れるため、集計して1分ごとの1行に畳み込む。
	 */
	private readonly snapshotMetrics = new Map<TermSnapshotReason, { count: number; maxChars: number; totalChars: number }>();

	private recordSnapshotMetric(reason: TermSnapshotReason, chars: number): void {
		const entry = this.snapshotMetrics.get(reason) ?? { count: 0, maxChars: 0, totalChars: 0 };
		entry.count++;
		entry.totalChars += chars;
		entry.maxChars = Math.max(entry.maxChars, chars);
		this.snapshotMetrics.set(reason, entry);
	}

	// リポジトリID → 現在のブランチ名（state スナップショット用の非同期キャッシュ）。
	private readonly branchCache = new Map<string, string>();

	// ---- PR 状態（ワークスペースid → 現在ブランチの GitHub PR）のポーリング ----
	// PC版 Workspaces ビューと同じ間隔。gh の GitHub API 呼び出しを伴うため、
	// モバイルが1台もオンラインでない間はポーリングを止める。
	private static readonly PR_STATUS_POLL_INTERVAL_MS = 300_000;
	private readonly prStatusCache = new Map<string, IParadisPrStatus>();
	private mobileOnline = false;
	private prStatusesInFlight = false;
	private readonly prStatusScheduler = this._register(new RunOnceScheduler(() => { this.refreshPrStatuses().catch(() => { /* refreshPrStatuses内で処理済み */ }); }, ParadisMobileWorkspaceProvider.PR_STATUS_POLL_INTERVAL_MS));

	/** リポジトリ/worktree 構成が変わった直後の前倒し取得（オンライン時のみ）。 */
	private kickPrStatusRefresh(): void {
		if (this.mobileOnline) {
			this.prStatusScheduler.schedule(0);
		}
	}

	/** contribution が relay の接続状態（オンラインのモバイル台数 > 0）を反映する。 */
	setMobileOnline(online: boolean): void {
		if (this.mobileOnline === online) {
			return;
		}
		this.mobileOnline = online;
		if (online) {
			// オンラインへ転じた瞬間に1回即時取得し、以後は間隔ポーリング
			this.prStatusScheduler.schedule(0);
		} else {
			this.prStatusScheduler.cancel();
		}
	}

	/** 各ワークスペース（リポジトリ本体 + worktree）の PR 状態を取得し、変化があれば state を再送する。 */
	private async refreshPrStatuses(): Promise<void> {
		if (!this.mobileOnline) {
			return;
		}
		if (this.prStatusesInFlight) {
			this.prStatusScheduler.schedule();
			return;
		}
		// fsPath → ワークスペースid（stateスナップショットの workspaces[].id と同じキー体系）。
		// キーは呼び出し先 (paradis.workspaceSwitch.getPrStatuses コマンド) が結果を返す際の
		// キーと揃える必要があり、そちらは常に resource.fsPath (URI.revive 後、呼び出し元
		// =このウィンドウの OS でのパス表記) を使う。SSH 接続先のリポジトリでも scheme を
		// vscode-remote のまま渡す — git を動かすマシンの解決はコマンド側 (paradisWorktreeGitHostResolver)
		// に任せる。
		const pathToWsId = new Map<string, string>();
		const uris: URI[] = [];
		for (const repo of this.workspaceSwitchService.repositories) {
			if (!this.isReachableWorkspaceUri(repo.uri)) {
				continue;
			}
			pathToWsId.set(repo.uri.fsPath, repo.id);
			uris.push(repo.uri);
			for (const worktree of this.worktreeService.getWorktrees(repo.id)) {
				if (!worktree.missing && this.isReachableWorkspaceUri(worktree.uri)) {
					pathToWsId.set(worktree.uri.fsPath, paradisWorktreeStateKey(worktree.uri));
					uris.push(worktree.uri);
				}
			}
		}
		if (uris.length === 0) {
			this.prStatusScheduler.schedule();
			return;
		}
		this.prStatusesInFlight = true;
		try {
			const result = await this.getPrStatuses(uris);
			if (result) {
				const next = new Map<string, IParadisPrStatus>();
				for (const [path, status] of Object.entries(result)) {
					const wsId = pathToWsId.get(path);
					if (wsId !== undefined) {
						next.set(wsId, status);
					}
				}
				const changed = next.size !== this.prStatusCache.size
					|| [...next].some(([wsId, status]) => {
						const prev = this.prStatusCache.get(wsId);
						return !prev || prev.number !== status.number || prev.state !== status.state || prev.url !== status.url;
					});
				if (changed) {
					this.prStatusCache.clear();
					for (const [wsId, status] of next) {
						this.prStatusCache.set(wsId, status);
					}
					this.pushStateSoon();
				}
			}
		} catch (err) {
			// gh 未認証・コマンド未登録等は PR ピルを出さないだけで安全に縮退する
			this.logService.trace('[paradisMobileRelay] refreshPrStatuses failed', String(err));
		} finally {
			this.prStatusesInFlight = false;
			// 取得中にモバイルが全切断された場合はここで止める（setMobileOnlineのcancelは
			// スケジューラにしか効かないため、実行中だった1回分の再スケジュールを防ぐ）
			if (this.mobileOnline) {
				this.prStatusScheduler.schedule();
			}
		}
	}

	/** stateスナップショットの workspaces[].pr 用に必要最小限のフィールドへ絞る。 */
	private prForWs(wsId: string): { pr: { number: number; state: IParadisPrStatus['state']; url: string } } | Record<string, never> {
		const status = this.prStatusCache.get(wsId);
		return status ? { pr: { number: status.number, state: status.state, url: status.url } } : {};
	}

	/**
	 * stateスナップショットの workspaces[].note 用の集計。本文は載せず（毎回のpushを太らせないため）、
	 * チェックリストが1件も無いスペースではフィールドごと省略する。
	 */
	private noteForWs(wsId: string): { note: { open: number; done: number } } | Record<string, never> {
		const summary = this.spaceNotesService.summary(wsId);
		return summary.open > 0 || summary.done > 0 ? { note: { open: summary.open, done: summary.done } } : {};
	}

	/** 各リポジトリのブランチ名を非同期に更新し、変化があれば state を再送する。 */
	private refreshBranches(): void {
		for (const repo of this.workspaceSwitchService.repositories) {
			if (!this.isReachableWorkspaceUri(repo.uri)) {
				continue;
			}
			this.runGit(repo.uri, ['rev-parse', '--abbrev-ref', 'HEAD']).then(result => {
				const branch = result.stdout.trim();
				if (branch && this.branchCache.get(repo.id) !== branch) {
					this.branchCache.set(repo.id, branch);
					this.pushState();
				}
			}).catch(() => { /* gitが無い等は無視 */ });
		}
	}

	/**
	 * エージェント状態の遷移を検知して notify フレームを送る。
	 * - permission（質問/許可要求）への遷移 → agent-question
	 * - review（作業完了）への遷移 → agent-done
	 * これがモバイルの「エージェントの質問通知」の供給源。全オンラインモバイルへ届ける。
	 */
	/**
	 * park 中（他ワークスペースへ退避中）のグループも含めた全ターミナルインスタンス。
	 * terminalService.instances はアクティブワークスペースの表示中グループしか含まないため、
	 * これを使わないとモバイル側は「PCで選択中のワークスペースのターミナル」しか見えない。
	 */
	private allInstances(): ITerminalInstance[] {
		return paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService);
	}

	private resolveTerminalStateKey(instanceId: number): string | undefined {
		const recordedStateKey = this.terminalScopeService.getStateKeyForInstance(instanceId);
		return paradisResolveMobileTerminalStateKey(
			recordedStateKey,
			this.terminalScopeService.resolveScope(instanceId),
			this.workspaceSwitchService.activeStateKey,
		);
	}

	/** Agent復元・Hint購読向けに、表示中/背景/park済みを含む全live terminalを返す。 */
	getAllTerminalInstancesForAgentRecovery(): readonly ITerminalInstance[] {
		return paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService).map(({ instance }) => instance);
	}

	private findAuthoritativePaneInstance(instanceId: number, token: string): ITerminalInstance | undefined {
		if (this.paneTokenService.getInstanceForToken(token) !== instanceId) {
			return undefined;
		}
		return this.allInstances().find(candidate => candidate.instanceId === instanceId
			&& !candidate.isDisposed
			&& this.paneTokenService.getTokenForInstance(instanceId) === token);
	}

	private detectAndNotify(): void {
		for (const inst of this.allInstances()) {
			const stateKey = this.terminalScopeService.getStateKeyForInstance(inst.instanceId);
			if (!stateKey) {
				continue;
			}
			const status = this.agentStatusStore.getScopeStatus(stateKey);
			const prev = this.previousScopeStatus.get(stateKey);
			if (status && status !== prev) {
				// 'question' (AskUserQuestion) はここでは通知しない: shared process の
				// transcript ミラーが質問本文・選択肢つきの通知を別経路で全モバイルへ
				// 送るため、状態遷移ベースの汎用通知と二重になるのを防ぐ。
				if (status === 'permission' || status === 'review') {
					this.emitNotify(status === 'permission' ? 'agent-question' : 'agent-done', inst.instanceId, stateKey, inst.title);
				}
			}
			if (status) {
				this.previousScopeStatus.set(stateKey, status);
			} else {
				this.previousScopeStatus.delete(stateKey);
			}
		}
	}

	private emitNotify(kind: NotifyKind, terminalId: number, ws: string, terminalTitle: string): void {
		// タイトルはワークツリー名だけに使い、細い行にはターミナル名を回す。
		// ここからはエージェント種別（Claude/Codex）を引けないため、shared process 側の
		// 質問通知（notifyAgentQuestion）が入れる呼び名の代わりにターミナル名を使う。
		// ワークツリー名が引けずタイトルがターミナル名へ落ちたときは、同じ名前が2行並ぶので出さない。
		const title = paradisNotifyTitle(this.wsNotifyName(ws), terminalTitle);
		const subtitle = paradisNotifySubtitleCandidate(terminalTitle, title);
		const body = kind === 'agent-question'
			? 'エージェントが確認を求めています'
			: 'エージェントが作業を完了しました';
		// agentToken: PC側でこのペインが確認済みになった際に、対応するモバイル通知を
		// 一括で既読化する識別子として使う（dispatchAgentDismiss、notifyPrefsとは別用途）。
		const agentToken = this.paneTokenService.getTokenForInstance(terminalId);
		const terminalKey = this.terminalIdentityService.getTerminalKey(terminalId);
		const payload: NotifyPayload = {
			kind, id: `n${generateUuid()}`, title, body,
			...(subtitle !== undefined ? { subtitle } : {}),
			ws: `${this.windowId}:${ws}`,
			terminalId,
			...(terminalKey !== undefined ? { terminalKey } : {}),
			windowId: this.windowId,
			...(agentToken !== undefined ? { agentToken } : {}),
			at: Date.now(),
		};
		this.sendFrame({ ch: Channels.Notify, ws: undefined, seq: 0, payload: VSBuffer.wrap(encodeNotify(payload)) });
	}

	/**
	 * 接続確立直後などに全状態を送る。現在のスナップショットを shared process へ渡す。
	 *
	 * 内容が前回と同一なら打ち切る。この先には IPC・main プロセスへのlease検証RPC・
	 * manifest取得・Desktop Stateの再構築と深い比較・JSON化が並んでおり、無変化でも
	 * 全部走ってしまう（重複除去は最終段のバイト比較しかなく、電波に出ないだけで
	 * 経路の代金は払っている）。タイトル変更やリサイズは中身が変わらないまま
	 * 連射されるため、ここで止めるのが最も効く。
	 *
	 * `force` は「送信内容ではなく、送ること自体に意味がある」呼び出し用。
	 * モバイルがオンラインへ転じた瞬間や、モバイルからのstate要求への応答では、
	 * 内容が同一でも lease メタデータの更新と応答そのものが要る。
	 */
	pushState(force = false): void {
		const snapshot = this.buildSnapshot();
		const json = JSON.stringify(snapshot);
		this.pushStateCalls++;
		if (!force && json === this.lastPushedSnapshot) {
			this.pushStateSkipped++;
			return;
		}
		this.lastPushedSnapshot = json;
		this.syncTerminalState(snapshot);
	}

	private buildSnapshot(): StateSnapshot {
		// リポジトリの直後にそのworktree（スペース）を並べる。idはターミナルスコープ等と
		// 同じ状態キー（worktree:<uri>）なので、モバイル側のフィルタがそのまま効く。
		const workspaces: IParadisMobileWindowWorkspaceV2[] = [];
		for (const r of this.workspaceSwitchService.repositories) {
			workspaces.push({
				id: r.id,
				name: r.name,
				...(r.color ? { color: r.color } : {}),
				...(this.branchCache.has(r.id) ? { branch: this.branchCache.get(r.id) } : {}),
				...this.prForWs(r.id),
				...this.noteForWs(r.id),
				...(this.worktreeService.isPinned(r.id) ? { pinned: true } : {}),
			});
			for (const worktree of this.worktreeService.getWorktrees(r.id)) {
				if (worktree.missing) {
					continue;
				}
				workspaces.push({
					id: paradisWorktreeStateKey(worktree.uri),
					// 「✦ 」接頭辞は旧アプリ（フラット表示）互換のため残す。新アプリはparentで
					// グルーピングし、表示時に接頭辞を取り除く
					name: `✦ ${worktree.name}`,
					...(r.color ? { color: r.color } : {}),
					...(worktree.branch ? { branch: worktree.branch } : {}),
					parent: r.id,
					...this.prForWs(paradisWorktreeStateKey(worktree.uri)),
					...this.noteForWs(paradisWorktreeStateKey(worktree.uri)),
					...(this.worktreeService.isPinned(paradisWorktreeStateKey(worktree.uri)) ? { pinned: true } : {}),
				});
			}
		}
		const terminals = this.allInstances().flatMap(inst => {
			const terminalKey = this.terminalIdentityService.getTerminalKey(inst.instanceId);
			if (terminalKey === undefined) {
				return [];
			}
			// 確定した未スコープ端末だけをactiveへフォールバックする。切替・再attach中の
			// pending端末をactiveへ誤配送せず、次の確定スナップショットまで所属を保留する。
			const stateKey = this.resolveTerminalStateKey(inst.instanceId);
			// 状態はペイン単位の値を使う。スコープ集約値（getScopeStatus）を付けると、
			// 同スコープで別のエージェントが動いているだけで無関係なプレーンターミナルまで
			// 「実行中」に見えてしまう（ホーム一覧・Live Activity の誤表示の原因）。
			const agentStatus = this.agentStatusStore.getInstanceStatus(inst.instanceId);
			// agent: そのターミナルでエージェントCLIの実在セッションが確認できたか。
			// 通常はhook発火、共有daemon利用時は鮮度検証済みtranscript探索で確定する。
			// モバイル側はホーム一覧・Live Activity をこのフラグで絞る。
			const paneToken = this.getPaneTokenForTerminalHint(inst.instanceId);
			const agent = this.agentStatusStore.isAgentInstance(inst.instanceId)
				|| (paneToken !== undefined && (this.confirmedAgentPaneTokens.has(paneToken) || this.provisionalAgentPaneTokens.has(paneToken)));
			return {
				terminalKey,
				id: inst.instanceId,
				title: inst.title,
				...(stateKey ? { ws: stateKey } : {}),
				...(agent ? { agent } : {}),
				...(agent && paneToken !== undefined ? { agentToken: paneToken } : {}),
				...(agentStatus ? { agentStatus } : {}),
				...(inst.cols > 0 && inst.rows > 0 ? { cols: inst.cols, rows: inst.rows } : {}),
			};
		});
		return {
			activeWs: this.workspaceSwitchService.activeStateKey,
			workspaces,
			terminals,
			...(this.battery !== undefined ? { battery: this.battery } : {}),
			...(this.resolveWindowHost !== undefined ? { host: this.resolveWindowHost() } : {}),
		};
	}

	/** shared processがhookまたは検証済みtranscriptから確定したエージェント端末を反映する。 */
	setConfirmedAgentPaneTokens(tokens: readonly string[]): void {
		const next = new Set(tokens);
		if (next.size === this.confirmedAgentPaneTokens.size
			&& [...next].every(token => this.confirmedAgentPaneTokens.has(token))) {
			return;
		}
		this.confirmedAgentPaneTokens = next;
		this.pushStateSoon();
	}

	/** shell integrationが検知した対話型Agent CLIを、session確定前からホームへ反映する。 */
	setProvisionalAgentPaneToken(token: string, active: boolean): void {
		const changed = active ? !this.provisionalAgentPaneTokens.has(token) : this.provisionalAgentPaneTokens.has(token);
		if (!changed) { return; }
		if (active) { this.provisionalAgentPaneTokens.add(token); } else { this.provisionalAgentPaneTokens.delete(token); }
		this.pushStateSoon();
	}

	/** Terminal Hintの高頻度出力経路を、実行中世代またはworking状態のexact ownerへ限定する。 */
	isTerminalHintActive(token: string): boolean {
		if (this.provisionalAgentPaneTokens.has(token)) {
			return true;
		}
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		return instanceId !== undefined
			&& this.paneTokenService.getTokenForInstance(instanceId) === token
			&& this.agentStatusStore.getInstanceStatus(instanceId) === 'working';
	}

	/** Terminal Hint対象判定用に、instanceへ現在割り当てられたpane tokenを返す。 */
	getPaneTokenForTerminalHint(instanceId: number): string | undefined {
		const token = this.paneTokenService.getTokenForInstance(instanceId);
		return token !== undefined && this.paneTokenService.getInstanceForToken(token) === instanceId ? token : undefined;
	}

	/** オンラインのモバイルが居なくなったら、全ターミナル購読を解放する（M-2: 購読リーク防止）。 */
	detachAll(): void {
		for (const key of this.termSyncStates.keys()) {
			this.clearTermSync(key);
		}
		this.termSyncStates.clear();
		this.attachedTerminals.clearAndDisposeAll();
		this.terminalSubscribers.clear();
		// detach が届かないまま切れた場合でも、ここでPTY寸法をPC側へ戻す。
		this.clearAllTerminalViewports();
	}

	override dispose(): void {
		// setTimeout ベースのタイマー（coalesce/resize）を確実に止める。
		for (const key of this.termSyncStates.keys()) {
			this.clearTermSync(key);
		}
		this.termSyncStates.clear();
		this.clearAllTerminalViewports();
		super.dispose();
	}

	/** shared process から届いたモバイル→PCフレームを処理する。 */
	handleInbound(frame: InboundFrame): void {
		if (frame.ch === Channels.State) {
			// モバイルからの state 要求（空ペイロード）には現在のスナップショットで応答。
			// 要求への応答なので、内容が前回と同一でも必ず送る。
			this.pushState(true);
			return;
		}
		if (frame.ch === Channels.Terminal) {
			this.handleTerminalInbound(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] terminal operation failed', err));
			return;
		}
		if (frame.ch === Channels.Agent) {
			this.handleAgentAction(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] agent action failed', err));
			return;
		}
		if (frame.ch === Channels.Scm) {
			this.handleScmInbound(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] scm request failed', err));
			return;
		}
		if (frame.ch === Channels.Fs) {
			const warmLease = decodeParadisMobileWarmLeaseRequest(frame.payload.buffer);
			if (warmLease.kind !== 'not-warm') {
				if (warmLease.kind === 'valid' && frame.mobileId !== undefined) {
					void this.mobileWarmLeases.setLease(frame.mobileId, warmLease.request);
				}
				return;
			}
			this.handleFsInbound(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] fs request failed', err));
		}
	}

	private async handleAgentAction(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		if (mobileId === undefined) {
			return;
		}
		let msg: { t?: unknown; id?: unknown; token?: unknown; requestId?: unknown; epoch?: unknown; text?: unknown; setting?: unknown; value?: unknown; parts?: unknown; delayMs?: unknown; windowId?: unknown; readyMarker?: unknown };
		let interactionAccepted = false;
		try {
			msg = JSON.parse(payload.toString());
		} catch {
			return;
		}
		const sendMessage = msg.t === 'action/sendMessage' && typeof msg.text === 'string'
			&& typeof msg.windowId === 'number' && Number.isInteger(msg.windowId);
		const claudeSetting = msg.t === 'action/claudeSetting' && (msg.setting === 'model' || msg.setting === 'effort')
			&& typeof msg.value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(msg.value)
			&& typeof msg.windowId === 'number' && Number.isInteger(msg.windowId);
		const interaction = msg.t === 'action/interaction' && Array.isArray(msg.parts) && msg.parts.length > 0 && msg.parts.length <= 500
			&& msg.parts.every(part => typeof part === 'string' && part.length <= 10_000)
			&& typeof msg.delayMs === 'number' && Number.isInteger(msg.delayMs) && msg.delayMs >= 0 && msg.delayMs <= 1_000
			&& (msg.readyMarker === undefined || (typeof msg.readyMarker === 'string' && msg.readyMarker.length > 0 && msg.readyMarker.length <= 64))
			&& typeof msg.windowId === 'number' && Number.isInteger(msg.windowId);
		if ((!sendMessage && !interaction && !claudeSetting) || typeof msg.id !== 'number' || typeof msg.token !== 'string'
			|| typeof msg.requestId !== 'string' || typeof msg.epoch !== 'string') {
			return;
		}
		const instance = this.findAuthoritativePaneInstance(msg.id, msg.token);
		if (instance === undefined) {
			// shared processのイベントは全windowへ届く。対象ペインを所有しないwindowは
			// 拒否を返さず、tokenが一致する所有windowだけに処理を任せる。
			return;
		}
		const claim = await this.claimAgentAction(mobileId, msg.requestId, msg.token, msg.epoch);
		if (claim === 'expired') {
			return; // shared process側のtimeout応答がすでに要求元へ送られている
		}
		if (claim === 'stale') {
			this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-session', '操作対象のエージェントセッションが変わりました');
			return;
		}
		try {
			if (sendMessage) {
				const outcome = await paradisSendAgentMessageToTui(
					msg.text as string,
					(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
					async () => {
						const currentInstance = this.findAuthoritativePaneInstance(msg.id as number, msg.token as string);
						return currentInstance === instance && this.validateAgentAction(mobileId, msg.requestId as string, msg.token as string, msg.epoch as string, msg.id as number, msg.windowId as number);
					},
				);
				if (!outcome.executed) {
					this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-session', outcome.consumed ? 'メッセージの貼り付け後にエージェントセッションが変わりました' : '送信前にエージェントセッションが変わりました', outcome.consumed);
					return;
				}
			} else if (claudeSetting) {
				await this.modelSwitchGuard.execute(instance, `/${msg.setting as 'model' | 'effort'} ${msg.value as string}`,
					// クロージャ内では typeof ガードによる絞り込みが効かないため as で明示する（ガード済み）
					() => this.validateAgentAction(mobileId, msg.requestId as string, msg.token as string, msg.epoch as string, msg.id as number, msg.windowId as number));
				if (!(await this.validateAgentAction(mobileId, msg.requestId, msg.token, msg.epoch, msg.id, msg.windowId as number))) {
					this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-session', '設定変更中にClaude Codeセッションが変わりました');
					return;
				}
			} else {
				const parts = msg.parts as string[];
				// **最初の1打鍵を待たずに流さないこと。** TUI が選択肢リストへキーボードフォーカスを
				// 移す前に届いたキーは、リストではなく入力欄へ吸われて消える（Claude Code 2.1.223 で
				// 実測。3秒待てば通り、待たずに送ると入力欄に文字が残るだけで質問は動かない）。
				// キー列が1つだけの回答（単問・単一選択、承認の「はい」の先頭キー）は、これを落とすと
				// 拾い直す機会が無く、モバイル側には送信成功に見えたまま何も起きない。
				await this.waitForInteractionTarget(instance, msg.readyMarker as string | undefined, parts.length);
				for (let index = 0; index < parts.length; index++) {
					if (index > 0) {
						await new Promise<void>(resolve => setTimeout(resolve, msg.delayMs as number));
					}
					// **待ちを挟んだ後は必ず作り直しと差し替えを確かめる。** 先頭の打鍵にも待ちが
					// 入るようになったぶん、「待っている間にPCで答えられた／別の質問に変わった」
					// 窓が広がった。ここを飛ばすと、消えた質問の跡地へ数字を打ち込むことになり、
					// 続く Enter でそれがエージェントへのメッセージとして送信される。
					const currentInstance = this.findAuthoritativePaneInstance(msg.id, msg.token);
					if (currentInstance !== instance) {
						this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-session', '操作対象のターミナルが変わりました');
						return;
					}
					const continuation = await this.continueAgentInteraction(mobileId, msg.requestId, msg.token, msg.epoch, msg.id, msg.windowId as number);
					if (continuation === 'completed') {
						this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'interaction-completed', '回答対象は別の操作で完了しました');
						return;
					}
					if (continuation === 'stale') {
						this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-interaction', '回答対象の質問または承認要求が変わりました');
						return;
					}
					await instance.sendText(parts[index], false);
				}
				interactionAccepted = true;
			}
			this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'accepted');
		} catch {
			this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', claudeSetting ? 'confirmation-failed' : 'send-failed', claudeSetting ? 'Claude Codeの設定変更を確認できませんでした' : 'メッセージを送信できませんでした');
		} finally {
			if (interaction) {
				await this.finalizeAgentInteraction(mobileId, msg.requestId, msg.token, interactionAccepted ? 'accepted' : 'failed').catch(err => this.logService.warn('[paradisMobileRelay] finalize agent interaction failed', err));
			}
		}
	}

	/**
	 * 打鍵を流し始めてよい状態になるまで待つ。
	 *
	 * TUI は「質問を描く」のと「選択肢リストがキーボードフォーカスを取る」のが同時ではない。
	 * その隙間に届いたキーは**入力欄へ吸われて消える**（Claude Code 2.1.223 で実測。待たずに
	 * 送ると入力欄に文字が残るだけで質問は動かず、3秒待てば同じキーがそのまま通った）。
	 * 単問・単一選択のキー列は数字1つだけなので、これを落とすと後続で拾い直す機会が無い。
	 *
	 * 目印は質問自身の選択肢ラベル（{@link paradisQuestionReadyMarker}）。TUI のフッタ文言に
	 * 頼ると、表示が変わったときに黙って壊れる。
	 *
	 * 目印が無い場合と、待っても現れない場合は**そのまま流す**。ここは取りこぼしを減らすための
	 * ものであって、送信を止める門ではない（画面の読み取りに失敗して回答できなくなる方が悪い）。
	 */
	private async waitForInteractionTarget(instance: ITerminalInstance, readyMarker: string | undefined, partCount: number): Promise<void> {
		const startedAt = Date.now();
		const settle = () => new Promise<void>(resolve => setTimeout(resolve, INTERACTION_READY_SETTLE_MS));
		// この待ちが効いているかは本番でしか分からない。目印を見つけられたのか、時間切れだったのか、
		// そもそも目印が無かったのかを残さないと、「まだ落ちる」ときに次の一手を決められない。
		//
		// **これは renderer 発なので、届く保証がまだない**（このプロジェクトでは renderer 由来の
		// transaction が一度も観測できていない。原因は未特定）。レース説そのものの判定は
		// PC側（shared process）の `agentQuestion.answer-settled` に載せた `safe_ms_since_question`
		// で行う。こちらは届けば「目印の待ちが効いたか」という一段細かい話が読める、という位置づけ。
		const record = (outcome: 'marker-seen' | 'timed-out' | 'no-marker') => {
			runInParadisSpan('agentQuestion', 'inject-wait', {
				safe_outcome: outcome,
				safe_wait_ms: Date.now() - startedAt,
				// 1つだけの回答（単問・単一選択、承認）は取りこぼすと拾い直せない。
				safe_key_parts: partCount,
			}, () => { });
		};
		if (readyMarker === undefined) {
			// 目印を作れない回答（承認など）は、少なくとも先頭を0msで叩かない。
			// 承認の「はい」は `1` に続けて Enter を送るので、先頭が入力欄へ吸われると
			// **Enterがその `1` をエージェントへのメッセージとして送信してしまう**。
			await settle();
			record('no-marker');
			return;
		}
		const deadline = startedAt + INTERACTION_READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (paradisScreenShowsMarker(paradisVisibleTerminalText(instance), readyMarker)) {
				// 描かれてからフォーカスが移るまでのわずかな隙間を越えるための一拍。
				await settle();
				record('marker-seen');
				return;
			}
			await new Promise<void>(resolve => setTimeout(resolve, INTERACTION_READY_POLL_MS));
		}
		// 目印が見つからないまま時間切れ。ここは取りこぼしを減らすためのものであって
		// 送信を止める門ではないので、そのまま流す（画面の読み取りに失敗して回答できなくなる方が悪い）。
		await settle();
		record('timed-out');
	}

	private sendAgentActionResult(mobileId: string, id: number, token: string, requestId: string, status: 'accepted' | 'rejected', code?: string, message?: string, consumed?: boolean): void {
		this.sendFrame({
			ch: Channels.Agent, ws: undefined, seq: 0, mobileId,
			payload: VSBuffer.fromString(JSON.stringify({ t: 'action-result', id, token, requestId, status, ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}), ...(consumed === true ? { consumed: true } : {}) })),
		});
	}

	// --- ws（状態キー）の解決 ------------------------------------------------------

	/**
	 * ワークスペースID（リポジトリID or worktree状態キー）をルートURIへ解決する。
	 * scm / fs / ターミナル作成の全チャネルで共通に使う。
	 */
	private resolveWsRoot(ws: string): URI | undefined {
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		if (repo) {
			return repo.uri;
		}
		if (ws.startsWith('worktree:')) {
			for (const r of this.workspaceSwitchService.repositories) {
				for (const worktree of this.worktreeService.getWorktrees(r.id)) {
					if (paradisWorktreeStateKey(worktree.uri) === ws) {
						return worktree.uri;
					}
				}
			}
		}
		return undefined;
	}

	/**
	 * ワークスペースID → 通知タイトルに出す名前。
	 *
	 * worktree はリポジトリ名を冠さず worktree 名だけを返す。タイトルはロック画面で
	 * 太字1行しか与えられず、頭にリポジトリ名を置くと肝心の worktree 名が先に切れるため
	 * （どのリポジトリかは本文と遷移先で分かる）。
	 */
	private wsNotifyName(ws: string): string | undefined {
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		if (repo) {
			return repo.name;
		}
		for (const r of this.workspaceSwitchService.repositories) {
			for (const worktree of this.worktreeService.getWorktrees(r.id)) {
				if (paradisWorktreeStateKey(worktree.uri) === ws) {
					return worktree.name;
				}
			}
		}
		// 状態キー（`worktree:file:///…`）をそのまま見出しにはしない。呼び出し側が
		// ターミナル名へ落とすので、名前が引けなかったことをそのまま伝える。
		return undefined;
	}

	// --- scm チャネル -----------------------------------------------------------

	/**
	 * SCM 操作 (git 実行) の対象リポジトリ/worktree の URI。
	 *
	 * scheme は file・vscode-remote のどちらでもよい — git を実際にどのマシンで動かすかは
	 * `runGit` コールバック側 (paradisChannelHostResolver) が URI の scheme/authority から
	 * 解決する。ここで file に絞ると SSH 接続先のリポジトリが SCM 操作から丸ごと外れてしまう。
	 * ただし別ホスト・未接続中の vscode-remote まで通すと、絶対パスが一致する手元の無関係な
	 * フォルダへ誤って到達しうるため、`isReachableWorkspaceUri` で弾く。
	 */
	private repoUriForWs(ws: string): URI | undefined {
		const root = this.resolveWsRoot(ws);
		return root && this.isReachableWorkspaceUri(root) ? root : undefined;
	}

	private async handleScmInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		let msg: ScmInbound;
		try {
			msg = JSON.parse(decoder.decode(payload.buffer)) as ScmInbound;
		} catch {
			return;
		}
		const sendReply = (replyPayload: Uint8Array) => {
			this.sendFrame({ ch: Channels.Scm, ws: undefined, seq: 0, payload: VSBuffer.wrap(replyPayload), mobileId: mobileId || undefined });
		};
		const jsonReply = (body: object) => encoder.encode(JSON.stringify({ id: msg.id, ...body }));
		const reply = (body: object) => {
			sendReply(jsonReply(body));
		};
		const replyCompressed = async (body: object) => {
			const json = jsonReply(body);
			const responseEncoding = msg.t === 'diff' || msg.t === 'xlsxDiff' ? msg.responseEncoding : undefined;
			sendReply(await paradisEncodeJsonResponsePayload('scm', msg.t, responseEncoding, json));
		};
		// worktree作成系は特定ワークスペースに紐づかない（wsを持たない）ため、repoPath解決より先に処理する
		if (msg.t === 'worktreeForm' || msg.t === 'createWorktree') {
			try {
				if (msg.t === 'worktreeForm') {
					reply({ t: 'worktreeForm', ...(await this.getWorktreeCreateForm()) });
				} else {
					if (typeof msg.repo !== 'string' || msg.repo.length === 0) {
						reply({ error: 'repo is required' });
						return;
					}
					const result = await this.createWorktree({
						repositoryId: msg.repo,
						...(typeof msg.name === 'string' ? { name: msg.name } : {}),
						...(typeof msg.branch === 'string' ? { branch: msg.branch } : {}),
						...(typeof msg.base === 'string' ? { baseRef: msg.base } : {}),
						...(typeof msg.prompt === 'string' ? { prompt: msg.prompt } : {}),
						...(typeof msg.agent === 'string' ? { agentId: msg.agent } : {}),
						...(typeof msg.model === 'string' ? { modelId: msg.model } : {}),
						...(typeof msg.effort === 'string' ? { effortId: msg.effort } : {}),
						...(typeof msg.permission === 'string' ? { permissionId: msg.permission } : {}),
						...(typeof msg.runSetup === 'boolean' ? { runSetup: msg.runSetup } : {}),
					});
					reply({ t: 'createWorktree', ...result });
				}
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// スペースのメモ。git実行を伴わないため repoPath 解決より先に処理する
		if (msg.t === 'noteGet' || msg.t === 'noteSet') {
			if (typeof msg.ws !== 'string' || msg.ws.length === 0) {
				reply({ error: 'ws is required' });
				return;
			}
			// 未知のワークスペースキーでメモ領域を増やされないよう、実在するスペースだけを受ける
			// （launchAgent 等と同じく resolveWsRoot で確認する）
			if (this.resolveWsRoot(msg.ws) === undefined) {
				reply({ error: `unknown workspace: ${msg.ws}` });
				return;
			}
			if (msg.t === 'noteSet') {
				if (typeof msg.text !== 'string') {
					reply({ error: 'text is required' });
					return;
				}
				this.spaceNotesService.write(msg.ws, msg.text);
			}
			reply({ t: 'note', ws: msg.ws, text: this.spaceNotesService.read(msg.ws) });
			return;
		}
		// 既存ワークスペースへのエージェント起動。git実行を伴わないため repoPath 解決より先に処理する
		if (msg.t === 'launchAgent') {
			try {
				if (typeof msg.agent !== 'string' || msg.agent.length === 0) {
					reply({ error: 'agent is required' });
					return;
				}
				const root = this.resolveWsRoot(msg.ws);
				if (root === undefined) {
					reply({ error: `unknown workspace: ${msg.ws}` });
					return;
				}
				await this.launchAgentInWorkspace({
					rootUri: root,
					stateKey: msg.ws,
					agentId: msg.agent,
					...(typeof msg.prompt === 'string' ? { prompt: msg.prompt } : {}),
					...(typeof msg.model === 'string' ? { modelId: msg.model } : {}),
					...(typeof msg.effort === 'string' ? { effortId: msg.effort } : {}),
					...(typeof msg.permission === 'string' ? { permissionId: msg.permission } : {}),
				});
				this.pushState();
				reply({ t: 'launchAgent' });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// コマンドプリセットの一覧と実行。git 実行を伴わないため repoPath 解決より先に処理する
		if (msg.t === 'presets' || msg.t === 'runPreset') {
			// IPC 境界の防御。隣の noteGet / launchAgent と同じ厳しさで受ける
			// （型が違うと resolveWsRoot の中で例外になり、応答を返さないまま終わってしまう）。
			if (typeof msg.ws !== 'string' || msg.ws.length === 0) {
				reply({ error: 'ws is required' });
				return;
			}
			if (msg.t === 'runPreset' && (typeof msg.key !== 'string' || msg.key.length === 0 || typeof msg.signature !== 'string')) {
				reply({ error: 'key and signature are required' });
				return;
			}
			try {
				const root = this.resolveWsRoot(msg.ws);
				if (root === undefined) {
					reply({ error: `unknown workspace: ${msg.ws}` });
					return;
				}
				// キャッシュではなく毎回読み直す（getPresetsForFolder）。モバイルが見ているスペースは
				// PC 側でアクティブとは限らず、キャッシュはアクティブなフォルダの解決結果を指すため。
				const presets = await this.presetService.getPresetsForFolder(root);
				// 区別語は切り詰める前の一覧全体で決める（PC版の一覧・ボタンと同じ見え方にする）
				const qualifiers = paradisPresetQualifiers(presets);
				if (msg.t === 'presets') {
					reply({
						t: 'presets', ws: msg.ws,
						presets: presets.slice(0, PRESET_MAX_ENTRIES).map(preset => paradisDescribePresetForMobile(preset, qualifiers)),
						...(presets.length > PRESET_MAX_ENTRIES ? { truncated: true } : {}),
					});
					return;
				}
				const preset = presets.find(candidate => candidate.key === msg.key);
				if (preset === undefined) {
					// 一覧を撮ってから実行するまでの間に PC 側で消された・改名された場合。
					// モバイルは一覧を取り直せば追従できるので、その旨だけ返す。
					reply({ error: `unknown preset: ${msg.key}` });
					return;
				}
				// **実行の直前に、いまディスクにある定義から署名を作り直して突き合わせる。**
				// 一覧を見せてから押されるまでの間に .paracode.json が書き換わっていれば、
				// 手元で確認した内容とは別物なので走らせない（PC 版の autoRun と同じ考え方）。
				// モバイル側の承認記録もこの署名なので、承認を経ていない実行もここで落ちる。
				if (paradisPresetMobileSignature(preset) !== msg.signature) {
					reply({ error: 'preset changed', code: 'signature-mismatch' });
					return;
				}
				// 実行で増えたターミナルを拾ってモバイルへ返す（実行後にそこへ切り替えるため）。
				// **前後の差分では見ない。** 1タスクごとにプロセスの起動を待つので実行は実時間で
				// 数秒かかり、その間にPCの操作や別のモバイル要求が作ったターミナルまで混ざる。
				// 作った本人（runPreset）に教えてもらう。
				const createdIds: number[] = [];
				await this.presetService.runPreset(preset, {
					cwd: root,
					stateKey: msg.ws,
					// モバイルからは必ず新しいターミナルで実行する。layout: current のプリセットは
					// 「PC 側でアクティブなターミナル」へ送る挙動だが、そのターミナルはモバイルからは
					// 見えていないので、手元で見えていない作業中の端末を汚す事故になる。
					forceNewTerminal: true,
					onDidCreateTerminal: instanceId => createdIds.push(instanceId),
				});
				const created = createdIds
					.map(instanceId => this.terminalIdentityService.getTerminalKey(instanceId))
					.filter((key): key is string => key !== undefined);
				this.pushState();
				// 手元を離れた PC で任意のコマンドが走る操作なので、成功も記録に残す
				// （失敗だけを残すと、あとから「誰がいつ何を流したか」がターミナルの
				// スクロールバックにしか無い状態になる）。コマンド本文はログに書かない。
				this.logService.info(`[paradisMobileRelay] ran preset ${preset.key} in ${msg.ws} (${created.length} terminals)`);
				reply({ t: 'runPreset', ws: msg.ws, created, ...paradisDescribePresetForMobile(preset, qualifiers) });
			} catch (err) {
				this.logService.warn('[paradisMobileRelay] preset request failed', err);
				reply({ error: String(err) });
			}
			return;
		}
		const repoUri = this.repoUriForWs(msg.ws);
		if (!repoUri) {
			reply({ error: `unknown workspace: ${msg.ws}` });
			return;
		}
		try {
			if (msg.t === 'status') {
				const [status, branch] = await Promise.all([
					this.runGit(repoUri, ['status', '--porcelain=v1']),
					this.runGit(repoUri, ['rev-parse', '--abbrev-ref', 'HEAD']),
				]);
				const files = status.stdout.split('\n').filter(l => l.length > 3).map(line => ({
					// porcelain v1: XY <path> （リネームは "old -> new"）
					x: line[0],
					y: line[1],
					path: line.slice(3).includes(' -> ') ? line.slice(3).split(' -> ')[1] : line.slice(3),
				}));
				reply({ t: 'status', branch: branch.stdout.trim(), files });
			} else if (msg.t === 'diff') {
				const args = msg.staged ? ['diff', '--cached'] : ['diff'];
				if (msg.path) {
					args.push('--', msg.path);
				}
				const result = await this.runGit(repoUri, args);
				// 未追跡ファイルは diff に出ないため、空なら内容そのものを差分風に返す
				let diff = result.stdout;
				if (!diff && msg.path) {
					const read = await this.readWorkspaceFile(msg.ws, msg.path);
					if (read !== undefined) {
						diff = read.split('\n').map(l => `+${l}`).join('\n');
					}
				}
				await replyCompressed({ t: 'diff', diff });
			} else if (msg.t === 'commit') {
				if (!msg.message.trim()) {
					reply({ error: 'empty commit message' });
					return;
				}
				if (msg.all) {
					const addResult = await this.runGit(repoUri, ['add', '-A']);
					if (addResult.code !== 0) {
						reply({ error: addResult.stderr || 'git add failed' });
						return;
					}
				}
				const result = await this.runGit(repoUri, ['commit', '-m', msg.message]);
				if (result.code !== 0) {
					reply({ error: result.stderr || result.stdout || 'git commit failed' });
				} else {
					reply({ t: 'commit', output: result.stdout.trim() });
					this.refreshBranches();
				}
			} else if (msg.t === 'xlsxDiff') {
				// Excel差分: HEAD(git:スキーマ、git拡張のFSプロバイダ経由) vs 作業ツリーを
				// PC版差分ビューアと同じ計算・描画でHTML化して返す。
				const modified = await this.resolveWorkspacePathReal(msg.ws, msg.path);
				if (!modified) {
					reply({ error: `invalid path: ${msg.path}` });
					return;
				}
				// git: スキームの FileSystemProvider は git 拡張（workspace kind）が処理するため、
				// SSH 接続中はリモート側で解決される。fsPath は常にこのウィンドウ（ローカル）の
				// OS で区切りを付け替えるため、接続先へ渡すと区切りが化ける。
				const modifiedGitQueryPath = modified.scheme === Schemas.file ? modified.fsPath : modified.path;
				const original = modified.with({ scheme: 'git', query: JSON.stringify({ path: modifiedGitQueryPath, ref: 'HEAD' }) });
				const html = await renderSpreadsheetDiffMobileHtml(this.fileService, this.sharedProcessService, original, modified, 'HEAD', '作業ツリー');
				await replyCompressed({ t: 'xlsxDiff', html });
			} else if (msg.t === 'log') {
				const limit = Math.min(Math.max(Math.trunc(msg.limit ?? 10), 1), 100);
				const skip = Math.max(Math.trunc(msg.skip ?? 0), 0);
				// limit+1件取得して切り詰めることで、追加ページの有無(hasMore)を1回のgit logで判定する
				// %ct(committer dateのepoch秒)が相対時刻表示の主データ。モバイル側が表示のたびに
				// 再計算するので取得時点のスナップショットが古くならない（%arだと整形済み文字列が
				// 固定される上、author date基準のためrebaseしたコミットが実際より古く見える）。
				// %arは旧バージョンのモバイルアプリ向けフォールバックとして当面残す。
				const result = await this.runGit(repoUri, ['log', '--skip', String(skip), '-n', String(limit + 1), '--pretty=format:%H%x09%ct%x09%ar%x09%s']);
				// コミット0件のリポジトリも exit 128 になるため、実エラーは「非ゼロ かつ stderr あり」で判定する
				if (result.code !== 0 && result.stderr.trim() && !/does not have any commits yet/.test(result.stderr)) {
					reply({ error: result.stderr.trim() });
					return;
				}
				const all = result.stdout.split('\n').filter(l => l.includes('\t')).map(line => {
					const [hash, ct, when, ...subject] = line.split('\t');
					const at = Number(ct) * 1000;
					return { hash, when, subject: subject.join('\t'), ...(Number.isFinite(at) && at > 0 ? { at } : {}) };
				});
				const hasMore = all.length > limit;
				const commits = hasMore ? all.slice(0, limit) : all;
				// リモートのWeb URLが分かればモバイル側でコミットページへ飛べるようにする。
				// remoteが無い/失敗してもログ本体の応答は返す（履歴表示を巻き添えにしない）。
				const remote = await this.runGit(repoUri, ['remote', 'get-url', 'origin']).catch(() => undefined);
				const webUrl = remote && remote.code === 0 ? remoteToWebUrl(remote.stdout.trim()) : undefined;
				reply({ t: 'log', commits, hasMore, ...(webUrl ? { webUrl } : {}) });
			} else if (msg.t === 'commitFiles') {
				// ハッシュ以外（オプションやrev式）を渡させない。`git show` は引数次第で
				// ファイル内容も出せるサブコマンドなので、40桁以内の16進に厳格に絞る
				if (!/^[0-9a-f]{4,40}$/i.test(msg.hash)) {
					reply({ error: 'invalid commit hash' });
					return;
				}
				const result = await this.runGit(repoUri, ['show', '--name-status', '--pretty=format:', msg.hash]);
				if (result.code !== 0) {
					reply({ error: result.stderr.trim() || 'git show failed' });
					return;
				}
				const files = result.stdout.split('\n').filter(l => l.includes('\t')).map(line => {
					const parts = line.split('\t');
					// リネーム(R100等)は "R100<TAB>old<TAB>new" なので新パスを採用する
					return { status: parts[0][0] ?? '?', path: parts[parts.length - 1] };
				});
				reply({ t: 'commitFiles', files });
			} else {
				// 新しいモバイルアプリが古いPCへ未知のサブタイプを送った場合に、無応答のまま
				// タイムアウトさせず即座にエラーを返す（将来の互換フェイルセーフ）
				reply({ error: `unsupported request: ${(msg as { t: string }).t}` });
			}
		} catch (err) {
			reply({ error: String(err) });
		}
	}

	// --- fs チャネル ------------------------------------------------------------

	/**
	 * 相対パスに加え、シンボリックリンク経由でのワークスペース外脱出も検査する
	 * （設計書 §8）。'list'の子要素フィルタだけでは対象自体やパス途中のシンボリックリンクを
	 * 防げないため、実パスを解決してリポジトリルート配下に収まっているかを確認する。
	 */
	private async resolveWorkspacePathReal(ws: string, relPath: string): Promise<URI | undefined> {
		const root = this.resolveWsRoot(ws);
		if (!root) {
			return undefined;
		}
		return paradisResolveMobileWorkspacePath(this.fileService, root, relPath);
	}

	private async readWorkspaceFile(ws: string, relPath: string): Promise<string | undefined> {
		const uri = await this.resolveWorkspacePathReal(ws, relPath);
		if (!uri) {
			return undefined;
		}
		try {
			const content = await this.fileService.readFile(uri, { length: FS_READ_LIMIT });
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	/**
	 * PCの現行カラーテーマそのままのシンタックスハイライトHTMLを生成する。
	 * トークン色は tokenizeToString が付ける mtk クラス + カラーマップCSSで再現し、
	 * 背景/前景はテーマのエディタ色を添える。失敗時は undefined（モバイル側はプレーン表示）。
	 */
	private async highlightFile(uri: URI, text: string): Promise<{ html: string; css: string; bg?: string; fg?: string; highlightTruncated?: boolean } | undefined> {
		try {
			// TextMate文法は拡張機構経由で登録されるため、登録完了を待ってから言語解決する
			await this.extensionService.whenInstalledExtensionsRegistered();
			const truncated = text.length > HIGHLIGHT_SOURCE_LIMIT;
			const source = truncated ? text.slice(0, HIGHLIGHT_SOURCE_LIMIT) : text;
			const newlineIndex = source.indexOf('\n');
			const firstLine = newlineIndex === -1 ? source : source.slice(0, newlineIndex);
			const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(uri, firstLine);
			const html = await tokenizeToString(this.languageService, source, languageId);
			const colorMap = TokenizationRegistry.getColorMap();
			const css = colorMap ? generateTokensCSSForColorMap(colorMap) : '';
			const theme = this.themeService.getColorTheme();
			return {
				html,
				css,
				bg: theme.getColor(editorBackground)?.toString(),
				fg: theme.getColor(editorForeground)?.toString(),
				...(truncated ? { highlightTruncated: true } : {}),
			};
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] highlight failed', err);
			return undefined;
		}
	}

	/**
	 * Markdownフェンスのコード断片をPCの現行テーマでハイライトする（highlightFile の断片版）。
	 * 言語はフェンスの言語名（`ts` / `typescript` 等）から解決する。名前で引けない場合は
	 * 拡張子として解釈し、それでも不明ならプレーンテキスト扱い（着色なしのHTMLが返る）。
	 */
	private async highlightSnippet(text: string, lang: string | undefined): Promise<{ html: string; css: string; bg?: string; fg?: string } | undefined> {
		if (typeof text !== 'string' || text.length === 0 || text.length > HIGHLIGHT_SOURCE_LIMIT) {
			return undefined;
		}
		await this.extensionService.whenInstalledExtensionsRegistered();
		let languageId: string | null = null;
		if (typeof lang === 'string' && lang.length > 0 && lang.length < 32) {
			const cleaned = lang.trim().toLowerCase();
			languageId = this.languageService.getLanguageIdByLanguageName(cleaned);
			if (!languageId) {
				// フェンス名が言語名でない場合は拡張子として解決する（`ts` → typescript 等）
				languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(`/snippet.${cleaned.replace(/[^a-z0-9+#-]/g, '')}`), undefined);
			}
		}
		const html = await tokenizeToString(this.languageService, text, languageId);
		const colorMap = TokenizationRegistry.getColorMap();
		const css = colorMap ? generateTokensCSSForColorMap(colorMap) : '';
		const theme = this.themeService.getColorTheme();
		return {
			html,
			css,
			bg: theme.getColor(editorBackground)?.toString(),
			fg: theme.getColor(editorForeground)?.toString(),
		};
	}

	private async handleFsInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		let msg: FsInbound;
		const binaryUpload = paradisDecodeBinaryFsUpload(payload.buffer);
		if (binaryUpload !== undefined) {
			msg = binaryUpload;
		} else {
			try {
				msg = JSON.parse(decoder.decode(payload.buffer)) as FsInbound;
			} catch {
				return;
			}
		}
		const sendReply = (replyPayload: Uint8Array) => {
			this.sendFrame({ ch: Channels.Fs, ws: undefined, seq: 0, payload: VSBuffer.wrap(replyPayload), mobileId: mobileId || undefined });
		};
		const jsonReply = (body: object) => encoder.encode(JSON.stringify({ id: msg.id, ...body }));
		const reply = (body: object) => {
			sendReply(jsonReply(body));
		};
		const replyCompressed = async (body: object) => {
			const json = jsonReply(body);
			const responseEncoding = msg.t === 'read' || msg.t === 'xlsx' ? msg.responseEncoding : undefined;
			const encoded = await paradisEncodeJsonResponsePayload('fs', msg.t, responseEncoding, json);
			// gzip交渉が効かない場合や、非UTF-8バイト/制御文字のJSONエスケープ膨張で
			// FrameMuxの再結合上限を超えると、フレームが再結合されずソケットごと切断される
			// （黙って表示が乱れるだけでは済まない）。実サイズをここで検査して弾く。
			if (encoded.length > FS_RESPONSE_PAYLOAD_LIMIT) {
				// allow-any-unicode-next-line
				sendReply(jsonReply({ error: `このファイルは転送できる上限（${FS_RESPONSE_PAYLOAD_LIMIT / 1024 / 1024}MB）を超えています。テキストとして扱えない内容の可能性があります。` }));
				return;
			}
			sendReply(encoded);
		};
		const replyCacheable = async (body: { readonly t: string } & Record<string, unknown>) => {
			const cacheEncoding = msg.t === 'read' || msg.t === 'xlsx' ? msg.cacheEncoding : undefined;
			const ifContentHash = msg.t === 'read' || msg.t === 'xlsx' ? msg.ifContentHash : undefined;
			await replyCompressed(await paradisContentHashResponse(cacheEncoding, ifContentHash, body));
		};
		const replyBinary = (type: ParadisBinaryFsResponseType, size: number, data: Uint8Array): boolean => {
			const responseEncoding = msg.t === 'pdf' || msg.t === 'docx' || msg.t === 'media' ? msg.responseEncoding : undefined;
			const encoded = paradisEncodeNegotiatedBinaryFsResponse(responseEncoding, type, msg.id, size, data);
			if (encoded === undefined) {
				return false;
			}
			this.sendFrame({ ch: Channels.Fs, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoded), mobileId: mobileId || undefined });
			return true;
		};
		// 画像アップロード（エージェントへの添付用）。ワークスペースを汚さないよう
		// userData 配下の専用ディレクトリへ保存し、フルパスを返す（モバイル側がPTYへ
		// パスを貼り付け、エージェントCLIがそのパスの画像を読む）。パスは取らないため
		// パス解決の前に処理する。ファイル名はサニタイズし、脱出の余地を残さない。
		if (msg.t === 'upload') {
			try {
				const encodedLength = typeof msg.data === 'string' ? msg.data.length : msg.base64Length;
				if (encodedLength === undefined || encodedLength > UPLOAD_BASE64_LIMIT || (msg.data instanceof Uint8Array && msg.data.byteLength > UPLOAD_DECODED_LIMIT)) {
					// allow-any-unicode-next-line
					reply({ error: `ファイルが大きすぎます。添付は ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB までです。` });
					return;
				}
				const content = typeof msg.data === 'string' ? decodeBase64(msg.data) : VSBuffer.wrap(msg.data);
				// 同ミリ秒の連続アップロードで上書きしないよう乱数サフィックスを付ける
				const target = paradisCreateMobileUploadTarget(this.environmentService.userRoamingDataHome, msg.name);
				await this.fileService.writeFile(target, content);
				reply({ t: 'upload', path: target.fsPath });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// ccusage 使用量ダッシュボード。ワークスペースに紐付かないため、パス解決の前に処理する。
		if (msg.t === 'usage') {
			try {
				const data = await this.fetchUsageDashboard(!!msg.bypassCache);
				reply({ t: 'usage', data });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// PARA-PATCH: RTK節約データのモバイル配信。usage と同じくワークスペース非依存。
		if (msg.t === 'rtk') {
			try {
				const data = await this.fetchRtkSavings(!!msg.bypassCache);
				reply({ t: 'rtk', data });
			} catch (err) {
				// 未インストールは内部マーカー入りの英文で来る。そのまま見せない。
				reply({
					error: isParadisRtkNotFoundError(err)
						? localize('paradis.mobile.rtkNotFound', "rtk が見つかりません。PC（SSH 接続中は接続先）にインストールすると節約量を見られます。")
						: String(err)
				});
			}
			return;
		}
		// AIリミット(Rate Limit)。usage と同じくワークスペース非依存(閲覧専用。追加・再ログインはPC側のみ)。
		if (msg.t === 'limits') {
			try {
				const data = await this.fetchLimitsSnapshot(!!msg.bypassCache);
				reply({ t: 'limits', data });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// GitHub API利用状況。usage/limits と同じくワークスペース非依存(閲覧専用)。
		if (msg.t === 'github') {
			try {
				const data = await this.fetchGithubMetrics(!!msg.bypassCache);
				reply({ t: 'github', data });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// PC本体のリソース使用量(「システム」画面)。usage/limits/github と同じくワークスペース非依存。
		// ドロワーに常時出る3値は desktop state 経由で別途届くので、こちらは内訳を見るときだけ呼ばれる。
		if (msg.t === 'sysres') {
			try {
				const data = await this.fetchResourceReport(!!msg.bypassCache);
				reply({ t: 'sysres', data });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// スペースごとのディスク使用量（「システム」画面のボリューム内訳）。
		// sysres の6秒ポーリングとは別系統。あちらへ混ぜると、数十秒かかる計測の完了待ちで
		// CPU/メモリの表示まで固まる。
		if (msg.t === 'spacedisk') {
			try {
				const data = await this.fetchSpaceDisk(!!msg.bypassCache);
				reply({ t: 'spacedisk', data });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// テキスト断片のハイライト（エージェントチャットのコードブロック用）。ファイルの
		// highlight と同じく Monaco トークナイザ + 現行テーマのカラーマップで生成する。
		// 失敗はエラーでなく空応答（モバイル側はプレーン表示にフォールバック）。
		if (msg.t === 'hl') {
			try {
				const result = await this.highlightSnippet(msg.text, msg.lang);
				reply({ t: 'hl', ...(result ?? {}) });
			} catch (err) {
				this.logService.warn('[paradisMobileRelay] snippet highlight failed', err);
				reply({ t: 'hl' });
			}
			return;
		}
		// 検索（find/grep）はパスでなくクエリを取るため、パス解決の前に処理する。
		// 実行は ripgrep（shared process、または SSH 接続先なら REH サーバー）。
		// ワークスペースルート起点なので脱出の余地はない。
		if (msg.t === 'find' || msg.t === 'grep') {
			const root = this.resolveWsRoot(msg.ws);
			if (!root || !this.isReachableWorkspaceUri(root)) {
				reply({ error: `unknown workspace: ${msg.ws}` });
				return;
			}
			try {
				if (msg.t === 'find') {
					const result = await this.searchFiles(root, msg.query, 100);
					reply({ t: 'find', files: result.files, truncated: result.truncated });
				} else {
					const result = await this.searchText(root, msg.query, 200);
					reply({ t: 'grep', matches: result.matches, truncated: result.truncated });
				}
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		if (msg.t === 'resolveLink') {
			const root = this.resolveWsRoot(msg.ws);
			// paradisResolveExternalPath・fileService は vscode-remote を素通しするので、
			// file に限定する理由はない。
			if (!root || !this.isReachableWorkspaceUri(root) || typeof msg.path !== 'string' || msg.path.length === 0 || msg.path.length > 4_096 || msg.path.includes('\0')) {
				reply({ error: 'invalid file link' });
				return;
			}
			try {
				const normalizeRelative = (input: string): string | undefined => {
					const segments: string[] = [];
					for (const segment of input.replace(/\\/g, '/').split('/')) {
						if (segment.length === 0 || segment === '.') { continue; }
						if (segment === '..') {
							if (segments.length === 0) { return undefined; }
							segments.pop();
						} else {
							segments.push(segment);
						}
					}
					return segments.join('/');
				};
				const rawPath = msg.path.trim();
				const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(rawPath) || /^\\\\/.test(rawPath);
				const posixAbsolute = rawPath.startsWith('/');
				let relativePath: string | undefined;
				if (windowsAbsolute || posixAbsolute) {
					// ワークスペースと同じ名前空間へ写してから比較する。URI.file だと UNC で開いた
					// ワークスペースに対して常に不一致になり、相対候補へ落ちてしまう
					const absoluteUri = paradisResolveExternalPath(root, rawPath);
					if (absoluteUri && extUriBiasedIgnorePathCase.isEqualOrParent(absoluteUri, root)) {
						relativePath = extUriBiasedIgnorePathCase.relativePath(root, absoluteUri);
					}
					// `/src/file.ts` はワークスペースルート基準で生成されることもある。
					// 実絶対パスがroot外の場合だけ、先頭/を外した相対候補として扱う。
					if (relativePath === undefined && posixAbsolute) {
						relativePath = normalizeRelative(rawPath.slice(1));
					}
				} else {
					relativePath = normalizeRelative(rawPath);
				}
				if (relativePath === undefined || relativePath.length === 0) {
					reply({ error: 'file link is outside the workspace' });
					return;
				}
				const uri = await this.resolveWorkspacePathReal(msg.ws, relativePath);
				if (uri === undefined || (await this.fileService.stat(uri)).isDirectory) {
					reply({ error: 'file link does not point to a file' });
					return;
				}
				reply({ t: 'resolveLink', path: relativePath });
			} catch {
				reply({ error: 'file link could not be resolved' });
			}
			return;
		}
		// ここまでで処理されなかった = このPCが知らないサブタイプ。パス解決へ落とすと
		// `invalid path: undefined` という無関係なエラーが出るため、scmチャネルと同じ形で
		// 「対応していない」と返す（新しいモバイルアプリ × 古いPC の組み合わせ用のフェイルセーフ）。
		// 判定に `ws` を混ぜてはいけない。モバイル側は fs チャネルの全リクエストへ
		// `ws` を必ず注入するため、`ws === undefined` は成立せずガードが死ぬ。
		// ここへ落ちてくる正規のサブタイプは必ず `path` を持つので、path だけで判る。
		if (msg.path === undefined) {
			reply({ error: `unsupported request: ${(msg as { t: string }).t}` });
			return;
		}
		const uri = await this.resolveWorkspacePathReal(msg.ws, msg.path);
		if (!uri) {
			reply({ error: `invalid path: ${msg.path}` });
			return;
		}
		try {
			if (msg.t === 'xlsx') {
				// シート単位の遅延読み込み(sheet省略時は先頭)。シート一覧はモバイルの
				// ネイティブタブに使われ、切替時に該当sheetだけ再要求される。
				const result = await renderSpreadsheetMobileSheet(this.fileService, this.sharedProcessService, uri, typeof msg.sheet === 'number' ? msg.sheet : 0);
				await replyCacheable({ t: 'xlsx', html: result.html, sheets: result.sheets, sheet: result.sheet });
			} else if (msg.t === 'pdf') {
				// PDF はバイナリのまま base64 で返す（'read' の UTF-8 デコード経路はバイナリを壊すため使えない）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `PDF が大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				// 標準base64（パディング付き）。モバイル側は expo-file-system の Base64 エンコーディング指定で
				// ネイティブデコードしながらファイルへ書くため、JSでのデコードは発生しない。
				const size = stat.size ?? 0;
				if (!replyBinary('pdf', size, content.value.buffer)) {
					reply({ t: 'pdf', data: encodeBase64(content.value), size });
				}
			} else if (msg.t === 'docx') {
				// Word文書もバイナリのまま base64 で返す（レンダリングはモバイル側の WebView が
				// PC版ビューアと同じ vendored docx-preview で行う。PC側でHTML化しないのは、
				// docx-preview がDOM前提でタブストップ計算等が表示環境のフォント計測に依存するため）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `Word 文書が大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				const size = stat.size ?? 0;
				if (!replyBinary('docx', size, content.value.buffer)) {
					reply({ t: 'docx', data: encodeBase64(content.value), size });
				}
			} else if (msg.t === 'media') {
				// 画像・動画・音声もバイナリのまま base64 で返す（表示はモバイル側。画像は data URI、
				// 動画/音声はキャッシュファイル経由で WKWebView のネイティブ再生を使う）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `ファイルが大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				const size = stat.size ?? 0;
				if (!replyBinary('media', size, content.value.buffer)) {
					reply({ t: 'media', data: encodeBase64(content.value), size });
				}
			} else if (msg.t === 'list') {
				const stat = await this.fileService.resolve(uri);
				const entries = (stat.children ?? [])
					.filter(c => !c.isSymbolicLink) // シンボリックリンク越えの読み取りを防止（設計書 §8）
					.map(c => ({ name: c.name, dir: c.isDirectory, size: c.size }))
					.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
				reply({ t: 'list', entries });
			} else if (msg.t === 'read') {
				const stat = await this.fileService.stat(uri);
				const content = await this.fileService.readFile(uri, { length: FS_READ_LIMIT });
				const text = content.value.toString();
				const body: { t: 'read' } & Record<string, unknown> = { t: 'read', content: text, truncated: (stat.size ?? 0) > FS_READ_LIMIT, size: stat.size ?? 0 };
				if (msg.highlight) {
					const highlighted = await this.highlightFile(uri, text);
					if (highlighted) {
						Object.assign(body, highlighted);
					}
				}
				await replyCacheable(body);
			}
		} catch (err) {
			reply({ error: String(err) });
		}
	}

	private async handleTerminalInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		let msg: TermInbound;
		try {
			msg = JSON.parse(decoder.decode(payload.buffer)) as TermInbound;
		} catch {
			return;
		}
		if (msg.protocolVersion !== PARADIS_MOBILE_PROTOCOL_VERSION || typeof msg.desktopEpoch !== 'string' || typeof msg.operationId !== 'string' || mobileId === undefined) {
			return;
		}
		const complete = (status: ParadisMobileTerminalOperationStatus) => this.completeTerminalOperation(mobileId, msg.operationId, status);
		if (msg.t === 'create') {
			// モバイルからの新規ターミナル作成。ws指定時はそのリポジトリ/worktreeをcwdにする。
			const ws = msg.ws;
			if (typeof ws !== 'string' || ws.length === 0) {
				await complete('terminal-not-found');
				return;
			}
			const root = this.resolveWsRoot(ws);
			if (root === undefined) {
				await complete('terminal-not-found');
				return;
			}
			// 作成時点でのPC側アクティブスコープ。指定wsがこれと一致（または未指定）なら
			// PCの現在の作業ワークスペース宛なので、そのままエディタタブとして見える。
			const activeStateKey = this.workspaceSwitchService.activeStateKey;
			try {
				// モバイル発の端末は常にエディタ領域に作る（PC側の手動作成分とパネルで混ざらないようにする）。
				const instance = await this.terminalService.createTerminal({ cwd: root, location: TerminalLocation.Editor });
				if (ws !== activeStateKey) {
					// PC側で非表示のワークスペース向け: 既定のタグ付け（アクティブスコープ所属）を
					// 指定wsへ付け替える。アクティブ外なので assignInstanceScope が即 park し、
					// そのワークスペースへ切り替えたときにだけ表示される。
					// エディタターミナルの park は persistentProcessId を鍵に台帳へ載せるため、
					// PTY が起動し切る前に assign すると park されずタブが現スコープに残ってしまう
					// （パネルのグループ park はIDに依存しないので従来は不要だった）。
					// あわせて createTerminal は openEditor の完了を待たないため、先に開き切ってから
					// park させる（detachInstance が先行すると、進行中の openEditor が
					// 実体のない入力を開いてしまう）。
					// PTY 起動が失敗すると processReady は解決しないため、待ち切らない場合でも操作は
					// 成功として返す（未完了のままだとモバイルが再試行して二重作成になる）。
					// 待ち切れなくても操作は成功として返す（未完了だとモバイルが再試行して
					// 二重作成になる）。ただし黙って進むと、PTY が遅い環境で park 台帳に
					// 載らず端末が見えなくなる過去の症状が再発しても記録が残らない。
					if (await raceTimeout(instance.processReady, TERMINAL_CREATE_READY_TIMEOUT_MS) === undefined) {
						reportParadisDiagnosticError('owned', 'mobile-terminal', 'create-not-ready', new Error('PTY was not ready before parking the terminal'), {
							phase: 'create',
							duration_ms: TERMINAL_CREATE_READY_TIMEOUT_MS,
						});
					}
					await this.terminalEditorService.openEditor(instance);
					this.terminalScopeService.assignInstanceScope(instance.instanceId, ws);
				} else {
					// PCのアクティブws向け: 既定タグ付けのままアクティブに残る。
					this.terminalService.setActiveInstance(instance);
				}
				this.pushState();
				await complete('accepted');
			} catch (err) {
				this.logService.warn('[paradisMobileRelay] createTerminal failed', err);
				reportParadisDiagnosticError('owned', 'mobile-terminal', 'create-failed', err, { phase: 'create' });
				await complete('failed');
			}
			return;
		}
		// 寸法の申告が不正でも attach 自体は通す（寸法合わせが効かないだけで済ませる）。
		// ここで attach ごと失敗させると、モバイル・PCの上下限がずれた将来の版で
		// 「ターミナルが一切見えない」という壊れ方をする。単独の viewport だけは弾く。
		if (typeof msg.terminalKey !== 'string'
			|| (msg.t === 'scroll' && !(['up', 'down'].includes(msg.dir)
				&& typeof msg.lines === 'number' && Number.isSafeInteger(msg.lines)
				&& msg.lines > 0 && msg.lines <= TERM_SCROLL_MAX_LINES))
			|| (msg.t === 'viewport' && !paradisIsValidTerminalViewportMessage(msg))
			|| (msg.t === 'attach' && (typeof msg.epoch !== 'number' || !Number.isInteger(msg.epoch)))
			|| (msg.t === 'ack' && (typeof msg.epoch !== 'number' || !Number.isInteger(msg.epoch) || typeof msg.seq !== 'number' || !Number.isInteger(msg.seq)))
			|| (msg.t === 'input'
				&& typeof msg.data !== 'string'
				&& typeof msg.text !== 'string'
				&& !(typeof msg.key === 'string' && ['up', 'down', 'right', 'left'].includes(msg.key)))) {
			await complete('failed');
			return;
		}
		// park 中（他ワークスペースのターミナル）にもモバイルからattach/入力できるようにする
		const instanceId = this.terminalIdentityService.getInstanceId(msg.terminalKey);
		const instance = instanceId === undefined ? undefined : this.allInstances().find(i => i.instanceId === instanceId);
		if (!instance) {
			await complete('terminal-not-found');
			return;
		}
		const id = instance.instanceId;
		const subscriptionKey = this.termSubscriptionKey(id, mobileId);
		try {
			if (msg.t === 'attach') {
				// モバイルごとに独立した同期状態を持ち、同じ端末の購読を奪い合わない。
				let subscribers = this.terminalSubscribers.get(id);
				if (subscribers === undefined) {
					subscribers = new Set();
					this.terminalSubscribers.set(id, subscribers);
				}
				subscribers.add(mobileId);
				// epoch付きattach（同期プロトコル対応クライアント）は世代状態を作り直す。
				this.clearTermSync(subscriptionKey);
				this.termSyncStates.delete(subscriptionKey);
				this.termSyncStates.set(subscriptionKey, {
					epoch: msg.epoch, seq: 0, inflight: [], unackedChars: 0,
					...(msg.dataEncoding === PARADIS_TERMINAL_BINARY_DATA_ENCODING ? { dataEncoding: PARADIS_TERMINAL_BINARY_DATA_ENCODING } : {}),
					suspended: false, droppedWhileSuspended: false,
					pending: [], pendingChars: 0, coalesceTimer: undefined, resizeTimer: undefined,
				});
				// 画面寸法の申告はスナップショットより先に反映する。ここで PTY を細くしておくと、
				// 直後のスナップショットが既に新しい寸法で撮られ、モバイルが一度も
				// 「PC幅のまま潰れた画面」を描かずに済む。
				this.setTerminalViewport(instance, id, mobileId,
					paradisIsValidTerminalViewportMessage(msg) ? paradisReadTerminalViewport(msg) : undefined);
				this.sendTerminalSnapshot(instance, id, mobileId, 'attach');
				if (this.attachedTerminals.has(id)) {
					await complete('accepted');
					return;
				}
				const store = new DisposableStore();
				const relayConsumer = (data: string) => this.sendTermData(id, data);
				store.add(instance.onData(paradisCreateTerminalOutputConsumer(relayConsumer, undefined)!));
				store.add(instance.onExit(() => {
					for (const subscriber of this.terminalSubscribers.get(id) ?? []) {
						const key = this.termSubscriptionKey(id, subscriber);
						const epoch = this.termSyncStates.get(key)?.epoch;
						this.clearTermSync(key);
						this.termSyncStates.delete(key);
						this.termViewports.delete(key);
						this.sendTerm(id, subscriber, { t: 'exit', ...(epoch !== undefined ? { epoch } : {}) });
					}
					this.attachedTerminals.deleteAndDispose(id);
					this.terminalSubscribers.delete(id);
					// 終了しても instance が生き続ける経路がある（waitOnExit 付きの端末、
					// タスクの再実行など）。台帳から消すだけだと、その端末は細い override を
					// 抱えたまま二度と解除されないため、必ず解除してから消す。
					this.clearTerminalViewport(instance, id);
					this.updateViewportLeaseSweeper();
				}));
				this.attachedTerminals.set(id, store);
			} else if (msg.t === 'viewport') {
				// attach したまま画面寸法だけ変わった（回転・キーボード開閉・設定変更）。
				this.setTerminalViewport(instance, id, mobileId, paradisReadTerminalViewport(msg));
			} else if (msg.t === 'detach') {
				this.clearTermSync(subscriptionKey);
				this.termSyncStates.delete(subscriptionKey);
				const subscribers = this.terminalSubscribers.get(id);
				subscribers?.delete(mobileId);
				if (subscribers?.size === 0) {
					this.attachedTerminals.deleteAndDispose(id);
					this.terminalSubscribers.delete(id);
				}
				// 見るのをやめたら PC 側の寸法へ戻す（残る購読者が居ればその寸法で決め直す）。
				this.setTerminalViewport(instance, id, mobileId, undefined);
			} else if (msg.t === 'ack') {
				this.handleTerminalAck(instance, id, mobileId, msg);
			} else if (msg.t === 'input') {
				await this.handleTerminalInput(instance, msg);
			} else if (msg.t === 'scroll') {
				await this.handleTerminalScroll(instance, msg);
			} else if (msg.t === 'rename') {
				if (typeof msg.title !== 'string') {
					await complete('failed');
					return;
				}
				// 制御文字（改行・Bidi override等）はタブ表示のなりすまし・崩れの元になるため除去する。
				const title = msg.title.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e]/g, '').trim().slice(0, 200);
				if (title.length > 0) {
					await instance.rename(title);
					// モバイルには楽観更新が無く、この再送が届くまで古い名前が出たままになる。
					// タイトル変更イベントは見た目用の遅い経路（500ms）へ振ってあるので、
					// ユーザーが自分で押した操作についてはここで構造変化と同じ速さに戻す。
					this.pushStateSoon();
				} else {
					await complete('failed');
					return;
				}
			} else if (msg.t === 'close') {
				// モバイル側で既に破壊的操作の確認ダイアログを経ているため、PC側の
				// confirmOnKill確認（safeDisposeTerminal）は挟まず直接閉じる。挟むと、
				// PCが無人の間はモバイルから応答できない確認ダイアログで永久にハングする。
				instance.dispose(TerminalExitReason.User);
			} else if (msg.t === 'ackStatus') {
				// PCのフォーカス中自動既読（paradisAgentStatus.contribution.ts）と同じ経路。
				// shared processの_paneStatusesがクリアされ、ポーラー経由でホーム一覧の表示も
				// アイドルへ戻り、通知履歴のdismiss（dispatchAgentDismiss）も自動で走る。
				const token = this.getPaneTokenForTerminalHint(instance.instanceId);
				if (token !== undefined) {
					await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call('acknowledgePaneStatus', [token]);
				} else {
					await complete('failed');
					return;
				}
			} else {
				await complete('failed');
				return;
			}
			await complete('accepted');
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] terminal execution failed', err);
			await complete('failed');
		}
	}

	/**
	 * モバイルからのターミナル入力を端末モードに合わせて送る。
	 * - key: application cursor keys モード中は SS3（ESC O A 等）、通常は CSI（ESC [ A 等）。
	 *   モバイル側は端末モードを知らないため、モード判定はPC側で行う（vim / less 等で矢印が
	 *   効かなくなる問題の対策）
	 * - text: bracketed paste モード中は ESC[200~...ESC[201~ で包む（sendText が判定）。
	 *   複数行テキストが1行目で実行されるのを防ぐ
	 * - data: 生のまま送る（従来動作）
	 */
	private async handleTerminalInput(instance: ITerminalInstance, msg: { data?: string; key?: TermSemanticKey; text?: string; execute?: boolean }): Promise<void> {
		if (msg.key !== undefined) {
			const finalChar = { up: 'A', down: 'B', right: 'C', left: 'D' }[msg.key];
			if (finalChar !== undefined) {
				const applicationMode = instance.xterm?.raw.modes.applicationCursorKeysMode === true;
				await instance.sendText(applicationMode ? `\x1bO${finalChar}` : `\x1b[${finalChar}`, false);
				return;
			}
			// 未知のキー名（将来の拡張）は data フォールバックへ落とす（モバイルは key と
			// 等価な生シーケンスを data に常時併載する契約）。
		}
		if (msg.text !== undefined) {
			await instance.sendText(msg.text, msg.execute === true, true);
		} else if (msg.data !== undefined) {
			// 生入力を送る（改行はモバイル側が明示的に送る）。
			// /model・/effort 切替の注入時は確認ダイアログ自動確定ウォッチを張る。
			this.modelSwitchGuard.maybeArm(instance, msg.data);
			await instance.sendText(msg.data, false);
		}
	}

	/**
	 * あるモバイルの画面寸法の申告を差し替え、その端末のPTY寸法を決め直す。
	 *
	 * PTYの寸法は1組しか持てないので、同じ端末を複数のモバイルが見ているときは最小へ倒す
	 * （`paradisResolveTerminalViewport`）。申告が1つも無くなったら PC 側の寸法へ戻す。
	 *
	 * 寸法を渡す手段に `setFixedDimensions()` ではなく `setOverrideDimensions()` を使うのは、
	 * 前者が QuickInput で対話的に値を聞く実装で外から値を渡せないため。後者は
	 * `ITerminalInstance` の公開APIで、`forceExactSize` を立てると `cols`/`rows` の getter が
	 * レイアウト幅を無視して指定値を返し、そこから `_resize()` → PTY の TIOCSWINSZ まで流れる。
	 * パネル／エディタ領域のどちらに居ても同じ経路なので、置き場所による分岐は要らない。
	 */
	private setTerminalViewport(instance: ITerminalInstance, id: number, mobileId: string, viewport: IParadisMobileTerminalViewport | undefined): void {
		const subscriptionKey = this.termSubscriptionKey(id, mobileId);
		// 購読していないモバイルの申告は保持しない（誰にも読まれないまま台帳に残るのを防ぐ）。
		if (viewport === undefined || this.terminalSubscribers.get(id)?.has(mobileId) !== true) {
			this.termViewports.delete(subscriptionKey);
		} else {
			// 同じ値の再申告（リースの更新）でも時刻だけは必ず進める。
			this.termViewports.set(subscriptionKey, { instanceId: id, viewport, renewedAt: Date.now() });
		}
		this.updateViewportLeaseSweeper();
		this.applyTerminalViewport(instance, id);
	}

	/** いま購読中のモバイル全員の申告からPTY寸法を決め、instanceへ反映する。 */
	private applyTerminalViewport(instance: ITerminalInstance, id: number): void {
		const subscribers = this.terminalSubscribers.get(id) ?? [];
		const resolved = paradisResolveTerminalViewport(
			[...subscribers].map(subscriber => this.termViewports.get(this.termSubscriptionKey(id, subscriber))?.viewport),
		);
		if (resolved === undefined) {
			this.clearTerminalViewport(instance, id);
			return;
		}
		// 拡張機能のPseudoterminalは自分で寸法を配信する（ProcessPropertyType.OverrideDimensions が
		// 同じ口を使う）。奪うと拡張側の表示が壊れるため触らない。
		if (instance.shellLaunchConfig.customPtyImplementation !== undefined) {
			return;
		}
		// PC側でその端末に「固定寸法」（Set Fixed Dimensions）を設定してある場合、cols/rows の
		// getter が _fixedCols/_fixedRows を先に返すため、この申告は無言で無視される。
		// PC側の明示設定を尊重する側なので、これは意図した挙動。
		// rows に 0 を渡すと `ITerminalInstance` の rows getter が override を無視して
		// レイアウト由来の行数へフォールバックする（terminalInstance.ts の `_dimensionsOverride.rows`
		// 判定が falsy を通す）。「桁だけ合わせる」設定はこの性質を使い、PC側のターミナルが
		// 表示領域より縦に長くなって下が切れるのを避ける。
		const dimensions = { cols: resolved.cols, rows: resolved.rows ?? 0 };
		this.termOverriddenInstanceIds.add(id);
		// リースの更新は同じ寸法で届く。値が変わっていなければ触らない（同値でも
		// setOverrideDimensions は PTY への IPC まで走るため、20秒ごとに端末数ぶん積み上がる）。
		const applied = this.termAppliedDimensions.get(id);
		if (applied?.cols === dimensions.cols && applied.rows === dimensions.rows) {
			return;
		}
		this.termAppliedDimensions.set(id, dimensions);
		instance.setOverrideDimensions({ ...dimensions, forceExactSize: true }, true);
	}

	/** 自分が掛けた寸法の上書きだけを解除する（拡張機能が握っている override は触らない）。 */
	private clearTerminalViewport(instance: ITerminalInstance, id: number): void {
		if (this.termOverriddenInstanceIds.delete(id)) {
			this.restoreInstanceDimensions(instance);
		}
	}

	/**
	 * 申告のリースを掃く周期タイマーを、申告の有無に合わせて開始／停止する。
	 * 申告が1つも無い間はタイマーを回さない（常時起動のプロセスなので、無駄な起床を作らない）。
	 */
	private updateViewportLeaseSweeper(): void {
		// dispose 済みに cancelAndSet すると BugIndicatingError を投げる（IntervalTimer の仕様）。
		// dispose 後に in-flight のterminalメッセージが着地する経路があるため、ここで止める。
		if (this._store.isDisposed) {
			return;
		}
		const shouldRun = this.termViewports.size > 0;
		if (shouldRun === this.viewportLeaseSweeperRunning) {
			return;
		}
		this.viewportLeaseSweeperRunning = shouldRun;
		if (shouldRun) {
			this.viewportLeaseSweeper.cancelAndSet(() => this.sweepExpiredViewports(), TERM_VIEWPORT_SWEEP_MS);
		} else {
			this.viewportLeaseSweeper.cancel();
		}
	}

	/**
	 * 更新が途絶えた申告を捨て、その端末の寸法を決め直す。
	 *
	 * これが「PCのターミナルが細いまま戻らない」に対する最後の砦。モバイルの
	 * オフライン検知は half-open ソケットで働かないことがあるため、そちらには依存しない。
	 */
	private sweepExpiredViewports(): void {
		const deadline = Date.now() - TERM_VIEWPORT_LEASE_MS;
		const staleInstanceIds = new Set<number>();
		for (const [key, entry] of [...this.termViewports]) {
			if (entry.renewedAt > deadline) {
				continue;
			}
			this.termViewports.delete(key);
			staleInstanceIds.add(entry.instanceId);
		}
		if (staleInstanceIds.size === 0) {
			this.updateViewportLeaseSweeper();
			return;
		}
		this.logService.info(`[paradisMobileRelay] terminal viewport lease expired for ${staleInstanceIds.size} terminal(s); restoring PC dimensions`);
		const byId = new Map(this.allInstances().map(instance => [instance.instanceId, instance]));
		for (const instanceId of staleInstanceIds) {
			const instance = byId.get(instanceId);
			if (instance !== undefined) {
				this.applyTerminalViewport(instance, instanceId);
			} else {
				// 端末自体が消えている。台帳だけ落として override の追跡も終わらせる。
				this.termOverriddenInstanceIds.delete(instanceId);
				this.termAppliedDimensions.delete(instanceId);
			}
		}
		this.updateViewportLeaseSweeper();
	}

	/**
	 * 端末をPC側のレイアウト由来の寸法へ戻す。
	 *
	 * 2段階で解除する。`setOverrideDimensions(undefined)` は「forceExactSize の override が
	 * 掛かっていて、かつ実寸を一度も持っていない端末（`_cols`/`_rows` が 0）」のとき、直前の
	 * override の値を実寸として焼き付ける（terminalInstance.ts の分岐）。そのまま解除すると、
	 * 一度も表示されていない端末にスマホの桁数と `rows: 0` が焼き付き、自己修復しない。
	 * forceExactSize を外した無害な override を一度挟むと、この分岐を踏まずに済む。
	 */
	private restoreInstanceDimensions(instance: ITerminalInstance): void {
		// 適用済みの記録も必ず落とす。残すと、次に同じ寸法を申告されたときに
		// 「変わっていない」と判定して二度と適用しなくなる。
		this.termAppliedDimensions.delete(instance.instanceId);
		instance.setOverrideDimensions({ cols: instance.maxCols, rows: instance.maxRows }, false);
		instance.setOverrideDimensions(undefined, true);
	}

	/**
	 * 全ターミナルの寸法上書きを解除する。切断・dispose の経路から必ず通す。
	 * detach が届かないまま切れた場合（アプリの強制終了・圏外・バックグラウンド落ち）に
	 * PC のターミナルが細いまま取り残されるのを防ぐ、最後の砦。
	 */
	clearAllTerminalViewports(): void {
		this.termViewports.clear();
		this.updateViewportLeaseSweeper();
		if (this.termOverriddenInstanceIds.size === 0) {
			return;
		}
		const overridden = [...this.termOverriddenInstanceIds];
		this.termOverriddenInstanceIds.clear();
		const byId = new Map(this.allInstances().map(instance => [instance.instanceId, instance]));
		for (const id of overridden) {
			const instance = byId.get(id);
			if (instance !== undefined) {
				this.restoreInstanceDimensions(instance);
			}
		}
	}

	/**
	 * モバイルのスワイプによるスクロール。
	 *
	 * 代替スクリーン（TUI）にはスクロールバックが無いので、端末を巻き戻すのではなく
	 * アプリへ「上/下」を伝える必要がある。
	 *
	 * アプリが実際にSGRマウスホイール（DECSET 1006）で待ち受けているときだけ、実物のホイール
	 * イベント（`CSI < 64/65 ; col ; row M`）を送る。矢印キーで代用しないのは、Claude Code
	 * 実機で確認済みの実測（node-pty + 生バイト注入、SGRマウストラッキング有効時に上矢印×5を
	 * 送ってもPTY出力が1バイトも変化しなかった）のとおり、マウストラッキング中のTUIは矢印キー
	 * でのスクロールを実装していないことが多いため。
	 *
	 * SGRが有効かどうかは `instance.xterm.raw.modes.mouseTrackingMode`（公開API）だけでは
	 * 判定できない。マウストラッキングそのものは有効でもSGR拡張座標（1006）は別のDECSETで、
	 * 例えば vim の `mouse=a` は、接続先の xterm.js が DA2 応答で報告するバージョン
	 * （このリポジトリが同梱する版は 276）が 277 未満だと legacy encoding のまま SGR を
	 * 使わない。ncurses系（htop等）の既定 terminfo も同様。この状態でSGRを送ると
	 * Esc+`[<64;...M` がそのまま生のキー入力として解釈され、無関係な操作（vimなら中央行
	 * ジャンプ、htopならソート切替）を引き起こす。
	 *
	 * そこで xterm.js 内部（`_core._inputHandler._mouseStateService.activeEncoding`）を覗いて
	 * 実際に 'SGR' が有効なときだけホイールを送る。公開APIではないが、upstream 自身が同じ
	 * `_core` 経由のアクセスを既存パターンとして持っている
	 * （`browser/xterm/xtermTerminal.ts:285-288` の `ITerminalWithCore`/`IXtermCore`）。
	 * `@xterm/headless` で実測して到達可能なことを確認済み（1000/1002/1003/1006を流すと
	 * `activeEncoding` は `'SGR'`、1006無しの `mouse=a` 相当だと `'DEFAULT'` のまま）。
	 * 読めない・想定と違う値のときは安全側（矢印キー）へ倒す。
	 *
	 * 座標はカーソル位置を使わない。Claude Code のカーソルは下部の入力欄にあり、そこを指すと
	 * 「入力欄の上でホイールを回した」ことになりかねないため、画面中央付近を指す固定値にする。
	 *
	 * 行数はモバイルの申告（スワイプ量から逆算した「行数」）をそのままホイール刻み数として
	 * 送らない。ホイール1刻みは多くのTUIで数行分（慣習的に3行）進むため、そのまま送ると
	 * 矢印キー経路の約3倍スクロールしてしまう（`TERM_SCROLL_LINES_PER_WHEEL_TICK` で割る）。
	 *
	 * SGRが確認できない（マウストラッキング無し、`x10` 等）ときは、`less`/`vim` など従来どおり
	 * 矢印キー変換に倣う（本家のマウスホイールも代替バッファでは同じことをしている＝xterm の
	 * MouseService が矢印キーへ変換する）。
	 */
	private async handleTerminalScroll(instance: ITerminalInstance, msg: { dir: 'up' | 'down'; lines: number }): Promise<void> {
		const lines = Math.min(msg.lines, TERM_SCROLL_MAX_LINES);
		const xterm = instance.xterm;
		if (xterm !== undefined && paradisIsSgrMouseEncodingActive(xterm.raw)) {
			const buttonCode = msg.dir === 'up' ? 64 : 65;
			const row = Math.max(1, Math.floor(xterm.raw.rows / 2));
			const wheelTicks = Math.max(1, Math.ceil(lines / TERM_SCROLL_LINES_PER_WHEEL_TICK));
			const sequence = `\x1b[<${buttonCode};1;${row}M`;
			await instance.sendText(sequence.repeat(wheelTicks), false);
			return;
		}
		const finalChar = msg.dir === 'up' ? 'A' : 'B';
		const applicationMode = xterm?.raw.modes.applicationCursorKeysMode === true;
		const sequence = applicationMode ? `\x1bO${finalChar}` : `\x1b[${finalChar}`;
		await instance.sendText(sequence.repeat(lines), false);
	}

	/** まとめ送りタイマーと保留バッファのみ破棄する（snapshot送信時用。resizeTimerは別ライフサイクル）。 */
	private clearTermCoalesce(sync: TermSyncState): void {
		if (sync.coalesceTimer !== undefined) {
			clearTimeout(sync.coalesceTimer);
			sync.coalesceTimer = undefined;
		}
		sync.pending = [];
		sync.pendingChars = 0;
	}

	/**
	 * 同期プロトコル状態のタイマー・保留バッファを全て破棄する（map のエントリ自体は
	 * 消さない。detach/exit 側で必要に応じて delete する）。
	 */
	private termSubscriptionKey(id: number, mobileId: string): string {
		return `${mobileId}\0${id}`;
	}


	private clearTermSync(key: string): void {
		const sync = this.termSyncStates.get(key);
		if (!sync) {
			return;
		}
		this.clearTermCoalesce(sync);
		if (sync.resizeTimer !== undefined) {
			clearTimeout(sync.resizeTimer);
			sync.resizeTimer = undefined;
		}
	}

	/**
	 * pty出力1チャンクの転送。同期プロトコル有効時はまとめ送り＋フロー制御を通す。
	 * suspend中は破棄し（ptyは止めない）、ACKが追いついた時点のスナップショットで追いつく。
	 */
	private sendTermData(id: number, data: string): void {
		for (const mobileId of this.terminalSubscribers.get(id) ?? []) {
			this.queueTermData(id, mobileId, data);
		}
	}

	private queueTermData(id: number, mobileId: string, data: string): void {
		const sync = this.termSyncStates.get(this.termSubscriptionKey(id, mobileId));
		if (!sync) {
			return;
		}
		paradisQueueTerminalRelayOutput(
			sync,
			data,
			() => this.flushTermData(id, mobileId),
			() => { sync.coalesceTimer = setTimeout(() => this.flushTermData(id, mobileId), TERM_COALESCE_MS); },
		);
	}

	/** まとめ送りバッファを1フレームとして送信し、未ACK残量が閾値を超えたらsuspendする。 */
	private flushTermData(id: number, mobileId: string): void {
		const sync = this.termSyncStates.get(this.termSubscriptionKey(id, mobileId));
		if (!sync) {
			return;
		}
		if (sync.coalesceTimer !== undefined) {
			clearTimeout(sync.coalesceTimer);
			sync.coalesceTimer = undefined;
		}
		if (sync.pendingChars === 0 || !this.terminalSubscribers.get(id)?.has(mobileId)) {
			sync.pending = [];
			sync.pendingChars = 0;
			return;
		}
		const data = sync.pending.join('');
		sync.pending = [];
		sync.pendingChars = 0;
		const seq = ++sync.seq;
		sync.inflight.push({ seq, chars: data.length });
		sync.unackedChars += data.length;
		this.sendTerm(id, mobileId, { t: 'data', data, epoch: sync.epoch, seq });
		if (sync.unackedChars > TERM_HIGH_WATERMARK_CHARS) {
			sync.suspended = true;
		}
	}

	/** モバイルからのACK。未ACK残量を減らし、suspend中でLOWまで追いついたらsnapshotで再同期する。 */
	private handleTerminalAck(instance: ITerminalInstance, id: number, mobileId: string, msg: { epoch: number; seq: number }): void {
		const sync = this.termSyncStates.get(this.termSubscriptionKey(id, mobileId));
		if (!sync || sync.epoch !== msg.epoch) {
			return; // 旧世代のACKは無視（再attach直後の混在で正常に起きる）
		}
		while (sync.inflight.length > 0 && sync.inflight[0].seq <= msg.seq) {
			sync.unackedChars -= sync.inflight[0].chars;
			sync.inflight.shift();
		}
		if (sync.suspended && sync.unackedChars <= TERM_LOW_WATERMARK_CHARS) {
			sync.suspended = false;
			if (sync.droppedWhileSuspended) {
				sync.droppedWhileSuspended = false;
				// 破棄していた間の出力はもう送れないので、最新画面のスナップショットで追いつく
				// （moshの「中間状態スキップ」に相当。スクロールバックの完全性より最新画面を優先）。
				this.sendTerminalSnapshot(instance, id, mobileId, 'flow');
			}
		}
	}

	/**
	 * attach中ターミナルのリサイズ後の再同期をスケジュールする（ドラッグ中の連射を
	 * デバウンスし、寸法確定後にスナップショット1回へ収斂させる）。
	 */
	private scheduleResizeResync(instance: ITerminalInstance): void {
		const id = instance.instanceId;
		for (const mobileId of this.terminalSubscribers.get(id) ?? []) {
			const sync = this.termSyncStates.get(this.termSubscriptionKey(id, mobileId));
			if (!sync) {
				continue;
			}
			if (sync.resizeTimer !== undefined) {
				clearTimeout(sync.resizeTimer);
			}
			sync.resizeTimer = setTimeout(() => {
				sync.resizeTimer = undefined;
				if (this.terminalSubscribers.get(id)?.has(mobileId)) {
					this.sendTerminalSnapshot(instance, id, mobileId, 'resize');
				}
			}, TERM_RESIZE_SNAPSHOT_DELAY_MS);
		}
	}

	/**
	 * attach したモバイルへ、現在の端末画面をVTスナップショットとして送る。
	 * serialize addon が使えない場合はプレーンテキスト末尾へフォールバックする（従来動作）。
	 * 同期プロトコル有効時は epoch/seq と適用すべき cols/rows・unicode幅版を同梱し、
	 * モバイルが「reset→resize→write」を原子的に適用できるようにする。
	 */
	private sendTerminalSnapshot(instance: ITerminalInstance, id: number, mobileId: string, reason: TermSnapshotReason): void {
		const subscriptionKey = this.termSubscriptionKey(id, mobileId);
		const expectedSync = this.termSyncStates.get(subscriptionKey);
		if (expectedSync === undefined) {
			return;
		}
		// 送る履歴の量は理由ごとに変える。モバイルはスナップショットを受けるたびに端末を
		// リセットして書き戻すので、**ここに載せなかった履歴はモバイル側から失われる**。
		//  - attach: 初めて中身を受け取るので従来どおり全部（1000行）
		//  - resize: attach 直後にも必ず走るため 0 にはできない（送ったばかりの履歴を消す）。
		//            水位を超えない範囲に減らす
		//  - flow:   追いつきは「スクロールバックの完全性より最新画面を優先」する経路なので 0
		const scrollback = reason === 'attach' ? TERM_SNAPSHOT_SCROLLBACK_ROWS
			: reason === 'resize' ? TERM_RESIZE_SNAPSHOT_SCROLLBACK_ROWS
				: 0;
		this.serializeTerminalSnapshot(instance, scrollback).then(snapshot => {
			// serialize解決を待つ間に detach された場合は送らない。
			if (!this.terminalSubscribers.get(id)?.has(mobileId)) {
				return;
			}
			let data = snapshot;
			if (data === undefined) {
				const contents = instance.xterm?.getContentsAsText();
				if (!contents) {
					return;
				}
				const tail = contents.length > TERM_SCROLLBACK_LIMIT ? contents.slice(-TERM_SCROLLBACK_LIMIT) : contents;
				data = tail.endsWith('\n') ? tail : tail + '\r\n';
			}
			const sync = this.termSyncStates.get(subscriptionKey);
			if (sync !== expectedSync) {
				return;
			}
			// snapshotはバッファ全体を置き換えるため、まとめ送り待ちの生データは破棄してよい
			// （serialize前の書き込みバリアでPC側xtermに反映済み＝snapshotに含まれている。
			// 送るだけ帯域の無駄になる）。resizeTimer はここでは触らない（serialize待ちの間に
			// 発生した新しいリサイズの再同期予約を消してしまうため）。
			this.clearTermCoalesce(sync);
			const seq = ++sync.seq;
			sync.inflight.push({ seq, chars: data.length });
			sync.unackedChars += data.length;
			if (sync.unackedChars > TERM_HIGH_WATERMARK_CHARS) {
				// 巨大snapshot直後も水位ルールを一貫させる（モバイルはsnapshotを即ACKするため
				// 詰まらない。ACKが来るまでの生ストリームはdrop→追いつき時に再snapshot）。
				sync.suspended = true;
			}
			const dims = instance.cols > 0 && instance.rows > 0 ? { cols: instance.cols, rows: instance.rows } : {};
			const unicode = instance.xterm?.raw.unicode.activeVersion;
			this.recordSnapshotMetric(reason, data.length);
			this.sendTerm(id, mobileId, { t: 'data', data, snapshot: true, epoch: sync.epoch, seq, ...dims, ...(unicode ? { unicode } : {}) });
		}).catch(err => this.logService.warn('[paradisMobileRelay] scrollback sync failed', err));
	}

	/**
	 * PC側xtermの現画面をVTシーケンスへシリアライズする。代替バッファ（TUIの全画面）・
	 * カーソル位置・色・モードを復元できる。serialize addon は端末ごとに一度だけ load する。
	 */
	private async serializeTerminalSnapshot(instance: ITerminalInstance, scrollback: number = TERM_SNAPSHOT_SCROLLBACK_ROWS): Promise<string | undefined> {
		const xterm = instance.xterm;
		if (!xterm) {
			return undefined;
		}
		const raw = xterm.raw;
		let addon = this.serializeAddons.get(raw);
		if (!addon) {
			const Ctor = await this.xtermAddonImporter.importAddon('serialize');
			const loaded = new Ctor();
			raw.loadAddon(loaded);
			addon = loaded;
			this.serializeAddons.set(raw, loaded);
		}
		// 書き込みキューのバリア: onData で届いたがPC側xtermがまだパースしていない出力を
		// 反映しきってからシリアライズする。これが無いと「直前の1チャンクがsnapshotにも
		// 後続ストリームにも含まれない」欠落窓ができる（snapshot送信時にまとめ送り待ちの
		// 生データを破棄する前提条件でもある）。
		// 端末dispose等でコールバックが発火しない場合に備え、上限付きで待つ
		// （タイムアウト時は現時点のバッファでシリアライズする＝従来動作相当）。
		await Promise.race([
			new Promise<void>(resolve => raw.write('', () => resolve())),
			timeout(1000),
		]);
		// 通常バッファのスクロールバックは行数で抑える（代替バッファ=TUIは常に全体が含まれる）。
		return addon.serialize({ scrollback });
	}

	private sendTerm(id: number, mobileId: string, msg: TermOutbound): void {
		const terminalKey = this.terminalIdentityService.getTerminalKey(id);
		if (terminalKey === undefined) {
			return;
		}
		const binaryPayload = msg.t === 'data'
			? paradisEncodeNegotiatedBinaryTerminalData(
				this.termSyncStates.get(this.termSubscriptionKey(id, mobileId))?.dataEncoding,
				{
					terminalKey, epoch: msg.epoch, seq: msg.seq,
					...(msg.snapshot === true ? { snapshot: true } : {}),
					...(msg.cols !== undefined ? { cols: msg.cols } : {}),
					...(msg.rows !== undefined ? { rows: msg.rows } : {}),
					...(msg.unicode !== undefined ? { unicode: msg.unicode } : {}),
				},
				msg.data,
			)
			: undefined;
		const payload = binaryPayload ?? encoder.encode(JSON.stringify({ ...msg, terminalKey }));
		this.sendFrame({ ch: Channels.Terminal, ws: undefined, seq: 0, payload: VSBuffer.wrap(payload), mobileId });
	}
}

/**
 * git remote のURLをブラウザで開けるWeb URLへ変換する。
 * 例: git@github.com:owner/repo.git → https://github.com/owner/repo
 */
function remoteToWebUrl(remote: string): string | undefined {
	if (!remote) {
		return undefined;
	}
	let url = remote;
	const scpMatch = url.match(/^(?:ssh:\/\/)?git@(?<host>[^:/]+)[:/](?<repoPath>.+)$/);
	if (scpMatch?.groups) {
		url = `https://${scpMatch.groups.host}/${scpMatch.groups.repoPath}`;
	}
	if (!/^https?:\/\//.test(url)) {
		return undefined;
	}
	// リモートURLに認証情報が埋まっていることがある（x-access-token:<token>@github.com 等）。
	// トークンをモバイルへ送らない・ブラウザURLに露出させないため必ず除去する。
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		url = parsed.toString();
	} catch {
		return undefined;
	}
	return url.replace(/\/$/, '').replace(/\.git$/, '');
}
