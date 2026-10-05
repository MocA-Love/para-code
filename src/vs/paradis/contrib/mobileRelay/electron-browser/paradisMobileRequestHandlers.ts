/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { paradisHasMobileCapability } from '../common/paradisMobileCompat.js';
import { paradisRedactMobileReplyError } from '../common/paradisMobileOutputRedaction.js';
import { PARADIS_MOBILE_BUILTIN_REQUEST_KINDS } from '../common/paradisMobileRequestKinds.js';
import { IParadisGitResult } from '../common/paradisMobileRelay.js';

/**
 * モバイルから届く scm / fs の**新しい種類**を、`paradisMobileWorkspaceProvider.ts` を触らずに
 * 別ファイルで受けるための登録表（Orca W2-17 と同じ土台 L0）。
 *
 * 使い方:
 * 1. 新しいファイルで {@link registerParadisMobileRequestHandler} を呼ぶ（モジュールの最上位で1回）
 * 2. そのファイルを `paradisMobileRequestHandlerRegistrations.ts` から副作用 import する（1行）
 * 3. PC がその種類を受けられることを capability で広告する（`paradisMobileCompat.ts` の
 *    `ParadisMobileCapability` と `PARADIS_MOBILE_PC_CAPABILITIES` に1行ずつ）。アプリは
 *    広告が無い PC にはその種類を送らない（ボタンごと出さない）
 *
 * 既存の種類（`status` / `diff` / `read` など provider が自分の分岐で持っているもの）は登録できない
 * （`PARADIS_MOBILE_BUILTIN_REQUEST_KINDS`、登録すると例外）。provider は既存の分岐で処理しなかった
 * 要求だけを登録表へ回す。scm はスペースの検査（unknown workspace）より前に回すので、`ws` を持たない
 * 種類も登録できる。
 *
 * 受け取る前に shared process がウィンドウと Renderer の世代・`protocolVersion`・`desktopEpoch` を
 * 検査済み（`paradisMobileRelayService.ts` の handleWindowFrame）。形の検査は各処理が自分で行う
 * （モバイルは信用しない相手として扱う）。
 */

export type ParadisMobileRequestChannel = 'scm' | 'fs';

/** モバイルから届いた要求。`id` は応答の宛先、`t` は種類。残りは種類ごとに各処理が検査する。 */
export interface IParadisMobileRequest {
	readonly t: string;
	readonly id: string;
	/** スペースに紐づく要求ならそのスペースの id（`sourceId`）。 */
	readonly ws?: string;
	readonly [key: string]: unknown;
}

/** 処理に渡す、この要求の文脈。 */
export interface IParadisMobileRequestContext {
	readonly channel: ParadisMobileRequestChannel;
	/** 要求を送ってきたモバイル。 */
	readonly mobileId: string | undefined;
	/**
	 * `ws` を解決したスペースのルート（このウィンドウから届くものだけ。SSH 先も含む）。
	 * `ws` が無い・知らない・届かないなら `undefined`。
	 */
	readonly root: URI | undefined;
	/** `{ id, ...body }` をこのモバイルへ返す。エラーは `{ error: '...' }` で返す（アプリは reject にする）。 */
	reply(body: object): void;
	/** `id` を付けずにこのモバイルへ送る（アプリ側は `onPcMessage` で受ける）。 */
	push(body: { readonly t: string; readonly [key: string]: unknown }): void;
	/**
	 * 組み立て済みのバイト列をそのままこのモバイルへ送る（`fs-binary-v1` のように、応答の id を中に持つ形を
	 * 自分で作る処理だけが使う。JSON の応答は {@link reply} を使う）。
	 */
	sendBytes(payload: Uint8Array): void;
	/** {@link root} で git を実行する。git のサブコマンドは shared process の許可リストで制限される。 */
	runGit(args: readonly string[]): Promise<IParadisGitResult>;
	/** スペースの中の相対パスを、シンボリックリンクで外へ出ていないことを確かめて URI にする。 */
	resolvePath(relativePath: string): Promise<URI | undefined>;
	/** 要求を送ってきたモバイルがその capability を広告しているか（W2-17 より前のアプリは false）。 */
	hasMobileCapability(name: string): Promise<boolean>;
	/**
	 * このモバイルとのセッションで話している版（窓の中で古い方）。オフラインなら `undefined`。
	 * PC から送る形を版で変えるときに使う（今は版 3 しか無いので常に 3）。
	 */
	mobileWireVersion(): Promise<number | undefined>;
	/** 手元の状態（ターミナルの一覧など）をすぐモバイルへ送り直す（ターミナルを作った直後など）。 */
	pushState(): void;
	/** 各スペースのブランチ名を読み直し、変わっていれば状態を送り直す（コミット・pull の後など）。 */
	refreshBranches(): void;
}

export interface IParadisMobileRequestHandler {
	/**
	 * 要求を処理する。`accessor` は**同期的な先頭部分でだけ**使える（`await` の後で `accessor.get` を
	 * 呼ぶと例外になる。VS Code の `invokeFunction` と同じ制約）。
	 * 例外を投げると `{ error }` で応答する。
	 */
	handle(accessor: ServicesAccessor, request: IParadisMobileRequest, context: IParadisMobileRequestContext): Promise<void> | void;
}

/** provider が登録表を引くときに渡す、ウィンドウ側の道具。 */
export interface IParadisMobileRequestHost {
	invokeFunction<R>(fn: (accessor: ServicesAccessor) => R): R;
	resolveRoot(ws: string): URI | undefined;
	runGit(root: URI, args: readonly string[]): Promise<IParadisGitResult>;
	resolvePath(ws: string, relativePath: string): Promise<URI | undefined>;
	getMobileCapabilities(mobileId: string): Promise<readonly string[] | undefined>;
	getMobileWireVersion(mobileId: string): Promise<number | undefined>;
	send(channel: ParadisMobileRequestChannel, mobileId: string | undefined, payload: Uint8Array): void;
	/** 状態をすぐ送り直す（無ければ何もしない。変化の知らせでいずれ送られる）。 */
	pushState?(): void;
	/** ブランチ名を読み直す（無ければ何もしない）。 */
	refreshBranches?(): void;
}

const handlers = new Map<string, IParadisMobileRequestHandler>();

function handlerKey(channel: ParadisMobileRequestChannel, kind: string): string {
	return `${channel}\u0000${kind}`;
}

/**
 * 新しい種類の処理を登録する。既存の種類（provider が持っているもの）と、同じ種類の二重登録は例外
 * （既存の処理を黙って置き換えない。2つの担当が同じ名前を選んだ事故も早く見つける）。
 */
export function registerParadisMobileRequestHandler(channel: ParadisMobileRequestChannel, kind: string, handler: IParadisMobileRequestHandler): IDisposable {
	if (PARADIS_MOBILE_BUILTIN_REQUEST_KINDS[channel].includes(kind)) {
		throw new Error(`Mobile request kind is handled by the provider itself: ${channel}/${kind}`);
	}
	const key = handlerKey(channel, kind);
	if (handlers.has(key)) {
		throw new Error(`Mobile request handler already registered: ${channel}/${kind}`);
	}
	handlers.set(key, handler);
	return toDisposable(() => {
		if (handlers.get(key) === handler) {
			handlers.delete(key);
		}
	});
}

const encoder = new TextEncoder();

/** provider が JSON として読んだ要求のうち、登録された種類のものだけを取り出す。 */
function findRegisteredRequest(channel: ParadisMobileRequestChannel, message: unknown): { readonly request: IParadisMobileRequest; readonly handler: IParadisMobileRequestHandler } | undefined {
	if (message === null || typeof message !== 'object' || Array.isArray(message)) {
		return undefined;
	}
	const candidate = message as Record<string, unknown>;
	if (typeof candidate.t !== 'string') {
		return undefined;
	}
	const handler = handlers.get(handlerKey(channel, candidate.t));
	if (handler === undefined || typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 200
		|| (candidate.ws !== undefined && typeof candidate.ws !== 'string')) {
		return undefined;
	}
	return { request: candidate as IParadisMobileRequest, handler };
}

/**
 * 登録された種類なら処理して true を返す。provider は、既存の分岐で処理しなかった要求（すでに JSON として
 * 読んだもの）についてだけ、チャネルごとに1か所でこれを呼ぶ。
 */
export function paradisDispatchMobileRequest(channel: ParadisMobileRequestChannel, message: unknown, mobileId: string | undefined, host: IParadisMobileRequestHost): boolean {
	const found = findRegisteredRequest(channel, message);
	if (found === undefined) {
		return false;
	}
	const { request, handler } = found;
	const root = request.ws !== undefined ? host.resolveRoot(request.ws) : undefined;
	const send = (body: object) => host.send(channel, mobileId, encoder.encode(JSON.stringify(body)));
	const context: IParadisMobileRequestContext = {
		channel,
		mobileId,
		root,
		// id は本文より後に置く（処理が本文に id を入れても応答の宛先を変えさせない）。
		// error には出口で伏せ字を当てる（処理が git の stderr をそのまま返しても資格情報を出さない）
		reply: body => send({ ...paradisRedactMobileReplyError(body), id: request.id }),
		push: body => send(body),
		sendBytes: payload => host.send(channel, mobileId, payload),
		runGit: args => root !== undefined ? host.runGit(root, args) : Promise.reject(new Error(`unknown workspace: ${request.ws ?? ''}`)),
		resolvePath: relativePath => request.ws !== undefined ? host.resolvePath(request.ws, relativePath) : Promise.resolve(undefined),
		hasMobileCapability: async name => mobileId !== undefined && paradisHasMobileCapability(await host.getMobileCapabilities(mobileId), name),
		mobileWireVersion: async () => mobileId !== undefined ? host.getMobileWireVersion(mobileId) : undefined,
		pushState: () => host.pushState?.(),
		refreshBranches: () => host.refreshBranches?.(),
	};
	// 例外の文には git の出力（remote の URL の資格情報など）が混ざりうる。伏せ字は context.reply の出口で当てる
	const fail = (error: unknown) => context.reply({ error: error instanceof Error ? error.message : String(error) });
	try {
		const result = host.invokeFunction(accessor => handler.handle(accessor, request, context));
		if (result instanceof Promise) {
			result.catch(fail);
		}
	} catch (error) {
		fail(error);
	}
	return true;
}
