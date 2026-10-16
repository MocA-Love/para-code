/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「終わらせて更新」で接続先のターミナルを止めるのは、ウィンドウの終了処理の中（UI の状態を保存した後）。
//
// 押した直後に止めると、まだ生きているウィンドウでタブが閉じ（`terminalEditorInput.ts` の終了で閉じる
// 処理）、空になったグループが畳まれ（`closeEmptyGroups`）、その畳まれた形が終了時に保存される。更新の
// 後にペインが欠けるのはこのため。押した時点では止める端末の番号と、更新の後に起こし直すシェルへ渡す
// 引き継ぎ（作業フォルダ・手で付けた名前）を控えるだけにする。終了処理の中では端末が先に片付けられて
// 一覧から消えていることがあるので、番号は押した時点のものを使う。

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { TitleEventSource } from '../../../../platform/terminal/common/terminal.js';
import { IWillShutdownEventDefaultJoiner, ShutdownReason } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisRestartedTerminalCarryOver, IParadisRestartedTerminalLaunch } from '../../workspaceSwitch/common/paradisTerminalLaunchPreparers.js';
import { paradisIsUpdateQuitApproved } from './paradisUpdateTerminals.js';

/** 止めたタブを、更新の後に起こし直すシェルへ引き継ぐもの。 */
export interface IParadisUpdateCarryOver {
	/** 端末の nonce。revive をまたいでも変わらない。 */
	readonly nonce: string;
	/** 止めた時点の作業フォルダ（接続先のパス）。分からなければ無し。 */
	readonly cwd?: string;
	/** 手で付けた名前。 */
	readonly name?: string;
}

/** 引き継ぎを作るのに読む、端末の値。 */
export interface IParadisUpdateCarryOverSource {
	readonly shellIntegrationNonce: string;
	readonly cwd?: string;
	readonly persistentTitle: string;
	readonly persistentTitleSource: TitleEventSource;
}

/**
 * 端末の引き継ぎ。名前は手で付けたもの（`Api`）だけを残す。シェルやエージェントが出した題まで
 * 名前として渡すと、新しいシェルの題の更新が止まり（`terminalInstance.ts` の `_setTitle`）、中が空の
 * シェルに「Claude · …」が出続ける。
 */
export function paradisDescribeUpdateCarryOver(terminal: IParadisUpdateCarryOverSource): IParadisUpdateCarryOver | undefined {
	if (!terminal.shellIntegrationNonce) {
		return undefined;
	}
	const cwd = terminal.cwd ? terminal.cwd : undefined;
	const name = terminal.persistentTitleSource === TitleEventSource.Api && terminal.persistentTitle ? terminal.persistentTitle : undefined;
	return {
		nonce: terminal.shellIntegrationNonce,
		...(cwd !== undefined ? { cwd } : {}),
		...(name !== undefined ? { name } : {}),
	};
}

/** 引き継ぎの置き場（ワークスペースごと）。次の起動で読んだら消す。 */
export const PARADIS_UPDATE_CARRY_OVER_STORAGE_KEY = 'paradis.updateTerminals.carryOver';

/** これより古い引き継ぎは使わない（更新が行われず、ずっと後に開いたときに古い値を当てない）。 */
const CARRY_OVER_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * 起動してから引き継ぎを当てる期間。最初の復元で起こし直すシェルだけに当てる。同じ nonce の端末が
 * 後で別の理由で起こし直されたときに、古いフォルダ・名前を当てない。
 */
const CARRY_OVER_RESOLVE_WINDOW_MS = 5 * 60 * 1000;

interface IStoredCarryOver {
	readonly at: number;
	readonly authority: string;
	/** 控えた版（`product.commit`）。版が変わっていなければ更新は行われていないので当てない。 */
	readonly commit?: string;
	readonly terminals: readonly IParadisUpdateCarryOver[];
}

export function paradisSerializeUpdateCarryOver(authority: string, commit: string | undefined, terminals: readonly IParadisUpdateCarryOver[], now: number): string {
	const stored: IStoredCarryOver = { at: now, authority, ...(commit !== undefined ? { commit } : {}), terminals };
	return JSON.stringify(stored);
}

/**
 * 読み戻す。接続先が違う・古い・壊れている・版が変わっていない（更新が行われずに閉じた・再読み込み
 * した）ときは空。nonce ごとに引ける形で返す。
 */
export function paradisParseUpdateCarryOver(raw: string | undefined, authority: string | undefined, commit: string | undefined, now: number): Map<string, IParadisUpdateCarryOver> {
	const result = new Map<string, IParadisUpdateCarryOver>();
	if (raw === undefined || authority === undefined) {
		return result;
	}
	let parsed: Partial<IStoredCarryOver> | undefined;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return result;
	}
	if (typeof parsed?.at !== 'number' || parsed.authority !== authority || !Array.isArray(parsed.terminals) || now < parsed.at || now - parsed.at > CARRY_OVER_LIFETIME_MS) {
		return result;
	}
	if (commit !== undefined && parsed.commit === commit) {
		return result;
	}
	for (const terminal of parsed.terminals) {
		if (typeof terminal?.nonce !== 'string' || terminal.nonce.length === 0) {
			continue;
		}
		result.set(terminal.nonce, {
			nonce: terminal.nonce,
			...(typeof terminal.cwd === 'string' && terminal.cwd.length > 0 ? { cwd: terminal.cwd } : {}),
			...(typeof terminal.name === 'string' && terminal.name.length > 0 ? { name: terminal.name } : {}),
		});
	}
	return result;
}

/**
 * 控えた作業フォルダを、接続先の URI のパスの形にする。Windows の接続先は `C:\work` の形で返るので、
 * `/C:/work` にする（authority のある URI のパスは `/` で始まらなければならない）。
 */
export function paradisUpdateCarryOverFolderPath(cwd: string): string {
	const path = /^[a-zA-Z]:[\\/]/.test(cwd) ? cwd.replace(/\\/g, '/') : cwd;
	return path.startsWith('/') ? path : `/${path}`;
}

/** 作業フォルダが接続先にまだあるかを確かめる口（`IFileService` が満たす）。 */
export interface IParadisCarryOverFolderProbe {
	stat(resource: URI): Promise<{ readonly isDirectory: boolean }>;
}

/**
 * 更新の後の最初の起動で、前の起動が控えた引き継ぎを当てる。読んだら置き場からは消す（次の起動へ
 * 持ち越さない）。1つの端末に当てるのは1回だけで、起動から
 * {@link CARRY_OVER_RESOLVE_WINDOW_MS} を過ぎたら当てない。
 */
export class ParadisUpdateCarryOverReader {

	/** 置き場から読んで消す。当てるものが無ければ undefined。 */
	static read(storageService: IStorageService, authority: string | undefined, commit: string | undefined, now: number): ParadisUpdateCarryOverReader | undefined {
		const terminals = paradisParseUpdateCarryOver(storageService.get(PARADIS_UPDATE_CARRY_OVER_STORAGE_KEY, StorageScope.WORKSPACE), authority, commit, now);
		storageService.remove(PARADIS_UPDATE_CARRY_OVER_STORAGE_KEY, StorageScope.WORKSPACE);
		return authority !== undefined && terminals.size > 0 ? new ParadisUpdateCarryOverReader(authority, terminals, now) : undefined;
	}

	private constructor(
		private readonly authority: string,
		private readonly terminals: Map<string, IParadisUpdateCarryOver>,
		private readonly readAt: number,
	) { }

	/**
	 * そのタブの引き継ぎ。作業フォルダは接続先に今もあるときだけ渡す（無いフォルダではシェルが起動に
	 * 失敗する。渡さなければスペースのフォルダか upstream の既定で起きる）。
	 */
	async resolve(launch: IParadisRestartedTerminalLaunch, probe: IParadisCarryOverFolderProbe, logService: ILogService, now: number): Promise<IParadisRestartedTerminalCarryOver | undefined> {
		if (now < this.readAt || now - this.readAt > CARRY_OVER_RESOLVE_WINDOW_MS) {
			this.terminals.clear();
			return undefined;
		}
		const entry = launch.remoteAuthority === this.authority ? this.terminals.get(launch.nonce) : undefined;
		if (entry === undefined) {
			return undefined;
		}
		this.terminals.delete(launch.nonce);
		let cwd: URI | undefined;
		if (entry.cwd !== undefined) {
			const folder = URI.from({ scheme: Schemas.vscodeRemote, authority: this.authority, path: paradisUpdateCarryOverFolderPath(entry.cwd) });
			const isFolder = await probe.stat(folder).then(stat => stat.isDirectory, () => false);
			if (isFolder) {
				cwd = folder;
			} else {
				logService.info(`[paradisUpdateTerminals] the folder terminal ${launch.instanceId} was in before the update is gone; starting its new shell elsewhere`);
			}
		}
		return { ...(cwd !== undefined ? { cwd } : {}), ...(entry.name !== undefined ? { name: entry.name } : {}) };
	}
}

/** {@link ParadisRemoteUpdateStop} が使う、ウィンドウ側の操作。 */
export interface IParadisRemoteUpdateStopHost {
	/** このウィンドウで接続先の端末を止めるか（設定が `never` のもの、接続先の常駐の中のものは止めない）。 */
	shouldStop(): boolean;
	/** 止める端末の番号（このウィンドウのものと、この PC が前に残したもの）。 */
	collectIds(): Promise<readonly number[]>;
	/** 今このウィンドウにある接続先の端末の番号。終了処理の中で、控えた後に開いたものを足すのに使う。 */
	liveIds(): readonly number[];
	/** このウィンドウのタブの引き継ぎを控える。 */
	recordCarryOver(): void;
	/** 控えた引き継ぎを消す。 */
	forgetCarryOver(): void;
	/** 番号の端末を止める。返事を待ち、止めた本数を返す。 */
	stop(ids: readonly number[]): Promise<number>;
}

/** 終了処理の合図のうち、ここで使うもの。 */
export interface IParadisUpdateStopShutdownEvent {
	readonly reason: ShutdownReason;
	join(promise: Promise<void>, joiner: IWillShutdownEventDefaultJoiner): void;
}

/**
 * 「終わらせて更新」の止め方。押したとき（{@link arm}）は控えるだけで、止めるのは終了処理の中
 * （{@link joinOnShutdown}）。
 */
export class ParadisRemoteUpdateStop {

	private armed: readonly number[] | undefined;

	constructor(
		private readonly host: IParadisRemoteUpdateStopHost,
		private readonly now: () => number = Date.now,
	) { }

	/** 控えているか（終了処理の中で止めるか）。 */
	get isArmed(): boolean {
		return this.armed !== undefined;
	}

	/** 「終わらせて更新」を押したとき。止める番号と引き継ぎを控える。ここでは止めない。 */
	async arm(): Promise<void> {
		this.disarm();
		if (!this.host.shouldStop()) {
			return;
		}
		const ids = await this.host.collectIds();
		this.armed = ids;
		this.host.recordCarryOver();
	}

	/** 更新が取り消された・閉じるのが取り消されたとき。控えたものを捨てる。 */
	disarm(): void {
		if (this.armed === undefined) {
			return;
		}
		this.armed = undefined;
		this.host.forgetCarryOver();
	}

	/**
	 * 終了処理の中で、控えた番号を止める。UI の状態は同じ合図の中で先に保存されている
	 * （`desktop.main.ts` の保存は、この contribution より前に合図を受け取る）。止める約束を閉じる処理へ
	 * join する。控えていない・「終わらせて更新」の合図が切れていれば何もせず false。
	 *
	 * 止めるのはアプリの終了（`QUIT`）のときだけ。合図が生きている間でも、ウィンドウを閉じる・
	 * 再読み込み（別のウィンドウが終了を取り消した、更新が黙って失敗した）では止めず、控えを捨てる
	 * （残すはずの端末を、知らせずに止めない）。
	 *
	 * 止めるのは控えた番号と、今ある端末の番号の和。控えた後に開いた端末も更新で取り残されるため。
	 */
	joinOnShutdown(event: IParadisUpdateStopShutdownEvent, joiner: IWillShutdownEventDefaultJoiner, wrap: (stopping: Promise<number>) => Promise<void>): boolean {
		const armed = this.armed;
		if (armed === undefined) {
			return false;
		}
		if (event.reason !== ShutdownReason.QUIT || !paradisIsUpdateQuitApproved(this.now())) {
			this.disarm();
			return false;
		}
		this.armed = undefined;
		const ids = [...new Set([...armed, ...this.host.liveIds()])];
		if (ids.length > 0) {
			event.join(wrap(this.host.stop(ids)), joiner);
		}
		return true;
	}
}
