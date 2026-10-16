/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐の端末の引き取りを、起動時の1回だけでなく、後からもやり直せるようにする。
//
// なぜ要るのか（SSH 先で起きる）:
//
//   1. 更新前の版のサーバー A が、窓の去った後も端末を見たまま残る。窓が行儀よく離れれば
//      A は手を離す（`paradisDaemonTerminalProcess.ts` の `paradisLetGo`）が、回線が落ちた・
//      アプリが落ちたなどで離れる合図が届かないと、A は見たままになる
//   2. 更新後の版のサーバー B の pty ホストは、起動時に1回だけ引き取り、見られている端末を飛ばす
//   3. やがて A が居なくなる（古い版のサーバーを止めた、A が自分で終わった）と、端末は誰にも
//      見られずに常駐に残る。今までは B の pty ホストが起き直すまで、誰も引き取らなかった
//
// ここでは、飛ばした端末（別の相手が見ている）を覚えておき、空いたら引き取る。きっかけは
// 3つ: 見回り（30 秒ごと、覚えている間だけ）、古い版のサーバーを止めた直後、窓からの依頼。
//
// もう1つ、**飛ばした端末のタブ配置を守る**。B の窓は自分の配置を保存し、そのスペースの常駐の
// 端末を B は1本も持たないので、その配置が常駐の配置を丸ごと上書きする。上書きされると、後で
// 引き取れても A の時のタブ配置は戻らない。だから飛ばした端末が居るスペースは、常駐に書く配置へ
// 起動時に読んだ A の分を足し続ける（`paradisTerminalLayoutStore.ts`）。

import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisPtyAdoptionRun, IParadisPtyHandoverReport, ParadisPtyAdoptTrigger } from '../common/paradisPtyHandover.js';
import { IParadisPtyHost } from '../common/paradisPtyProtocol.js';
import { IParadisAdoptionTarget, paradisAdoptIntoPtyService } from './paradisAdoptIntoPtyService.js';
import { paradisRecordAdoptionRun, paradisTakePtyHandoverReport } from './paradisPtyHandoverJournal.js';
import { IParadisAdoptedTerminal } from './paradisTerminalAdoption.js';
import { paradisRecordAdoption } from './paradisReattachTally.js';
import { paradisIdOfHandle, paradisKnownHandles, paradisPtyDaemonConnection } from './paradisTerminalProcessFactory.js';

/** 別の相手が見ている端末が空いたかを見に行く間隔。覚えている端末がある間だけ回す。 */
const PARADIS_READOPT_POLL_MS = 30_000;

let target: IParadisAdoptionTarget | undefined;
let logService: ILogService | undefined;

/** 別の相手が見ているので飛ばした端末（handle → スペース）。 */
const foreign = new Map<number, string>();
/** 飛ばした端末が居るスペースの、起動時に常駐が持っていた配置（handle で書かれたもの）。 */
const foreignLayouts = new Map<string, string>();

/** 引き取りは1本ずつ走らせる。並ぶと同じ端末を二重に載せる。 */
let queue: Promise<unknown> = Promise.resolve();
let pollTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 起動時の引き取り。`ptyHostMain.ts` から1回だけ呼ぶ。以後の引き取り直しの相手もここで覚える。
 */
export async function paradisAdoptAtStartup(ptyService: IParadisAdoptionTarget, host: IParadisPtyHost, log: ILogService): Promise<void> {
	target = ptyService;
	logService = log;
	const result = await enqueue(() => run('startup', ptyService, host, log));
	// 起動時の結果は、起こし直しの数と一緒にウィンドウが送る（`paradisReattachTally.ts`）。
	paradisRecordAdoption({ reachable: result.reachable, adopted: result.adopted, skipped: result.foreign + result.failed });
}

/**
 * 別の相手が見ていた端末が空いていれば引き取る。常駐を使っていなければ何もせず undefined。
 */
export function paradisReadoptFromDaemon(trigger: ParadisPtyAdoptTrigger): Promise<IParadisPtyAdoptionRun | undefined> {
	const connection = paradisPtyDaemonConnection();
	if (!connection || !target || !logService) {
		return Promise.resolve(undefined);
	}
	const ptyService = target;
	const log = logService;
	return enqueue(() => run(trigger, ptyService, connection.host, log));
}

/** 前回からの記録。常駐を使っておらず、記録も無ければ undefined。 */
export function paradisTakeHandoverReport(): IParadisPtyHandoverReport | undefined {
	const daemon = paradisPtyDaemonConnection() !== undefined;
	if (!daemon && target === undefined) {
		return undefined;
	}
	return paradisTakePtyHandoverReport({ daemon, foreignHeld: foreign.size });
}

/**
 * そのスペースで別の相手が見ている端末と、その端末が載っていた配置。常駐へ配置を書くときに足す。
 */
export function paradisForeignLayoutFor(workspaceId: string): { readonly raw: string; readonly handles: ReadonlySet<number> } | undefined {
	const raw = foreignLayouts.get(workspaceId);
	if (raw === undefined) {
		return undefined;
	}
	const handles = new Set<number>();
	for (const [handle, owner] of foreign) {
		if (owner === workspaceId) {
			handles.add(handle);
		}
	}
	return handles.size > 0 ? { raw, handles } : undefined;
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
	const next = queue.then(work, work);
	queue = next.catch(() => undefined);
	return next;
}

async function run(trigger: ParadisPtyAdoptTrigger, ptyService: IParadisAdoptionTarget, host: IParadisPtyHost, log: ILogService): Promise<IParadisPtyAdoptionRun> {
	const startedAt = Date.now();
	const outcome = await paradisAdoptIntoPtyService(ptyService, host, log, trigger === 'startup' ? undefined : { known: paradisKnownHandles(), idOf: paradisIdOfHandle });
	const result: IParadisPtyAdoptionRun = {
		trigger,
		reachable: outcome.reachable,
		adopted: outcome.adopted,
		foreign: outcome.foreign.length,
		failed: outcome.failed,
		finished: outcome.finished,
		layouts: outcome.layouts,
		durationMs: Date.now() - startedAt,
	};
	// 見回りで何も起きなかった回は記録しない。30 秒ごとに空の記録が積み上がるだけになる。
	if (trigger !== 'poll' || result.adopted > 0 || result.failed > 0 || !result.reachable) {
		paradisRecordAdoptionRun(result);
	}
	if (outcome.reachable) {
		await rememberForeign(outcome.foreign, host, log);
	}
	schedulePoll();
	return result;
}

/** 飛ばした端末を覚え直す。空いた・消えたものは忘れ、新しく飛ばしたスペースの配置を読んでおく。 */
async function rememberForeign(current: readonly IParadisAdoptedTerminal[], host: IParadisPtyHost, log: ILogService): Promise<void> {
	foreign.clear();
	for (const terminal of current) {
		foreign.set(terminal.summary.handle, terminal.metadata.workspaceId);
	}
	const spaces = new Set(foreign.values());
	for (const workspaceId of [...foreignLayouts.keys()]) {
		if (!spaces.has(workspaceId)) {
			foreignLayouts.delete(workspaceId);
		}
	}
	for (const workspaceId of spaces) {
		if (workspaceId.length === 0 || foreignLayouts.has(workspaceId)) {
			// 一度読んだら読み直さない。以後は常駐の配置にこちらの窓の分も混ざっている。
			continue;
		}
		try {
			const raw = await host.getLayout(workspaceId);
			if (raw !== undefined && raw.length > 0) {
				foreignLayouts.set(workspaceId, raw);
			}
		} catch (error) {
			log.trace('[ParadisPtyHost] could not read the layout of terminals another pty host is watching', error);
		}
	}
}

function schedulePoll(): void {
	if (pollTimer !== undefined) {
		clearTimeout(pollTimer);
		pollTimer = undefined;
	}
	if (foreign.size === 0) {
		return;
	}
	pollTimer = setTimeout(() => {
		pollTimer = undefined;
		void paradisReadoptFromDaemon('poll').catch(error => logService?.warn('[ParadisPtyHost] looking for terminals another pty host let go of failed', error));
	}, PARADIS_READOPT_POLL_MS);
}
