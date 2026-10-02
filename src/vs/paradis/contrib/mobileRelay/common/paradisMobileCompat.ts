/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC ⇔ モバイルの公開ワイヤの互換の窓と、機能（capability）の広告（Orca W2-17）。
 *
 * **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）が相対パスで直接 import し、
 * PC とアプリで同じ判定を使う（同じ関数なので、両側の結論が食い違わない）。何かを import すると
 * アプリのバンドルに VS Code 本体が引きずり込まれて壊れる。
 *
 * 版の上げ方（NOTES.md「PC とアプリの互換の窓」に同じ規則）:
 * - 任意項目・新しいメッセージの種類・無視できるイベントを**足すだけなら版を上げない**。
 *   代わりに capability を1つ足し、相手が広告しているときだけ使う
 * - メッセージや必須項目の削除、既存項目の意味（単位・null の可否）の変更、フレーミング・暗号・
 *   認証の変更をしたときだけ {@link PARADIS_MOBILE_PROTOCOL_VERSION} を上げる
 * - 上げても古い相手と話し続けられるなら、`MIN_COMPATIBLE_*` は据え置く（窓が広がる）。
 *   古い相手を切るときだけ `MIN_COMPATIBLE_*` を上げる
 */

/** この版（PC・アプリ共通）が話す公開ワイヤの版。 */
export const PARADIS_MOBILE_PROTOCOL_VERSION = 3;
/** PC がまだ受け入れる、いちばん古いアプリの版（PC がビルド時に決める）。 */
export const PARADIS_MOBILE_MIN_COMPATIBLE_MOBILE = 3;
/** アプリがまだ受け入れる、いちばん古い PC の版（アプリがビルド時に決める）。 */
export const PARADIS_MOBILE_MIN_COMPATIBLE_PC = 3;

/**
 * capability の名前。`<領域>.<機能>.v<N>` の小文字で書く（例 `scm.push.v1`）。
 * 意味を変えるときは名前を変えずに `v<N>` を上げ、古い名前は相手が使わなくなるまで広告し続ける。
 *
 * 足すときは、ここに名前を足し、実装した側の一覧（{@link PARADIS_MOBILE_PC_CAPABILITIES} /
 * {@link PARADIS_MOBILE_APP_CAPABILITIES}）にも足す。
 */
export const ParadisMobileCapability = {
	/** State を gzip で受け取れる / 送れる（従来の `stateEncoding` の交渉と同じ意味）。 */
	StateGzip: 'state.gzip.v1',
	/** ターミナルの epoch / seq / ack による同期。 */
	TermSync: 'term.sync.v1',
	/** fs のアップロードを 2 進で運べる（従来の `fsUploadEncoding: 'fs-binary-v1'` と同じ意味）。 */
	FsUploadBinary: 'fs.upload-binary.v1',
	/** 音声通知の MP3 をリレー経由で配る（従来の `voiceClips: 'relay-v1'` と同じ意味）。 */
	VoiceClips: 'voice.clips.v1',
	/** スペースのメモの版（`updatedAt`）と、noteSet の `base` / `op`（W2-16。`paradisMobileSpaceNoteSet.ts`）。 */
	NoteCas: 'note.cas.v1',
	/** 差分レビューの確認済みの印を PC に保存する（W2-14。`reviewGet` / `reviewSet`）。 */
	ReviewStore: 'review.store.v1',
	/** 差分の行へのメモと、エージェントへの送信（W2-28。`reviewNoteAdd` など）。 */
	ReviewNotes: 'review.notes.v1',
	/** 確認済みのファイルだけのステージ（W2-28。`reviewStage`）。 */
	ReviewStage: 'review.stage.v1',
	/** fs の `openUrl` で、URL を PC の内蔵ブラウザで開ける（W2-31。スマホのターミナルで押した localhost など）。 */
	BrowserOpenUrl: 'browser.open-url.v1',
	/** fs の `resolveLink` が任意の `terminalKey` を受け、そのターミナルの作業フォルダを基準に相対パスを解く（W2-31）。 */
	FsResolveLinkTerminal: 'fs.resolve-link.terminal.v1',
	/** PC の［PC の幅に戻す］: PC は `viewport-revoked` を送り `viewport` の `reclaim` を受ける／アプリはそれを受けて［再び合わせる］を出す（W2-19）。 */
	TermViewportTakeback: 'term.viewport.takeback.v1',
	/** 承認に PC の画面の番号付きの選択肢で答えられる（agent の `approval-options` と `opt:<n>`。W2-21）。 */
	AgentApprovalOptions: 'agent.approval.options.v1',
	/** 会話の古い発言をさかのぼって読める（agent の `history`。W2-30）。 */
	AgentHistoryPage: 'agent.history.page.v1',
	/** 終わった会話を開き直して続きを頼める（scm の `agentSessions` / `agentSessionPreview` / `agentSessionResume`。W2-29）。 */
	AgentResume: 'agent.resume.v1',
	/** status の `upstream` / `ahead` / `behind` と、`push` / `fetch` / `pull`（W2-15。`paradisMobileScmSync.ts`）。 */
	ScmSync: 'scm.sync.v1',
	/** `commitSafe`（失敗したらステージを戻して要約を返す）と `commitFix`（エージェントに直してもらう）（W2-15）。 */
	ScmCommitRecover: 'scm.commit-recover.v1',
	/** ファイルごとの `stage` / `unstage`（W2-15）。 */
	ScmStageFile: 'scm.stage-file.v1',
	/** `prView`（PR の状態と CI のチェック）と `prFixChecks`（W2-36。`paradisMobilePullRequest.ts`）。 */
	PrView: 'pr.view.v1',
	/** `prMerge`（見た時点の head に固定してマージ）（W2-36）。 */
	PrMerge: 'pr.merge.v1',
	/** notify の `visibility` に `visibility-ack` を返し、裏に回ったスマホへはプッシュで送る（W2-34。`paradisMobileVisibility.ts`）。 */
	BackgroundGrace: 'conn.background-grace.v1',
	/** browser の `input` の `kind: 'key'`（Enter・Backspace・Tab・矢印・Esc など。`paradisMobileBrowserKeys.ts`）。 */
	BrowserKeys: 'browser.keys.v1',
	/** agent の snapshot / delta の任意項目 `monitors`（Claude Code の Monitor の一覧。`paradisAgentMonitors.ts`）。 */
	AgentMonitors: 'agent.monitors.v1',
	/** browser の `targets` の `windowId` / `ws` で、そのスペースのページだけを返す。fs の `openUrl` の `ws`（`paradisMobileBrowserProtocol.ts`）。 */
	BrowserSpace: 'browser.space.v1',
	/** browser の通知 `page`（URL・題名・読み込み中・戻る/進むの可否）と入力 `stop` / `open`。 */
	BrowserPage: 'browser.page.v1',
	/** browser の通知 `focus`（ページの入力欄のフォーカスと中身）と入力 `replace`。 */
	BrowserFocus: 'browser.focus.v1',
	/** fs の要求 `bookmarks` と通知 `bookmarksChanged`（PC の内蔵ブラウザのブックマーク）。 */
	BrowserBookmarks: 'browser.bookmarks.v1',
	/** fs の `list` の各項目に任意の `ignored: true`（.gitignore で無視されている。ファイルの一覧で名前を灰にする）。 */
	FsIgnored: 'fs.ignored.v1',
	/** fs の `iconTheme`（PC で選んでいるファイルアイコンのテーマの対応表）と `iconSvgs`（アイコンの SVG）。 */
	FsIconTheme: 'fs.icon-theme.v1',
	/** noteSet の `op` の `kind: 'remove'`（チェック項目の削除）と `kind: 'edit'`（チェック項目の文言の書き換え）。 */
	NoteTaskOps: 'note.task-ops.v1',
	/** scm の `fileAt`（HEAD・インデックス・作業ツリーにあるファイルのバイト列。差分の画面の「表示」・画像の比較・Office の Raw に使う）。 */
	ScmFileAt: 'scm.file-at.v1',
	/** scm の `wordDiff`（PC の Word 差分を、スペースの中のパスと比べる側の指定だけで頼める。差分の画面の「差分」）。 */
	ScmWordDiff: 'scm.word-diff.v1',
} as const;

/** この PC のビルドが実装している capability。State の `capabilities` で広告する。 */
export const PARADIS_MOBILE_PC_CAPABILITIES: readonly string[] = [
	ParadisMobileCapability.StateGzip,
	ParadisMobileCapability.TermSync,
	ParadisMobileCapability.FsUploadBinary,
	ParadisMobileCapability.VoiceClips,
	ParadisMobileCapability.NoteCas,
	ParadisMobileCapability.ReviewStore,
	ParadisMobileCapability.ReviewNotes,
	ParadisMobileCapability.ReviewStage,
	ParadisMobileCapability.BrowserOpenUrl,
	ParadisMobileCapability.FsResolveLinkTerminal,
	ParadisMobileCapability.TermViewportTakeback,
	ParadisMobileCapability.AgentApprovalOptions,
	ParadisMobileCapability.AgentHistoryPage,
	ParadisMobileCapability.AgentResume,
	ParadisMobileCapability.ScmSync,
	ParadisMobileCapability.ScmCommitRecover,
	ParadisMobileCapability.ScmStageFile,
	ParadisMobileCapability.PrView,
	ParadisMobileCapability.PrMerge,
	ParadisMobileCapability.BackgroundGrace,
	ParadisMobileCapability.BrowserKeys,
	ParadisMobileCapability.AgentMonitors,
	ParadisMobileCapability.BrowserSpace,
	ParadisMobileCapability.BrowserPage,
	ParadisMobileCapability.BrowserFocus,
	ParadisMobileCapability.BrowserBookmarks,
	ParadisMobileCapability.FsIgnored,
	ParadisMobileCapability.FsIconTheme,
	ParadisMobileCapability.NoteTaskOps,
	ParadisMobileCapability.ScmFileAt,
	ParadisMobileCapability.ScmWordDiff,
];

/** このアプリのビルドが実装している capability。State の要求の `capabilities` で広告する。 */
export const PARADIS_MOBILE_APP_CAPABILITIES: readonly string[] = [
	ParadisMobileCapability.StateGzip,
	ParadisMobileCapability.TermSync,
	ParadisMobileCapability.FsUploadBinary,
	ParadisMobileCapability.VoiceClips,
	ParadisMobileCapability.TermViewportTakeback,
	ParadisMobileCapability.AgentApprovalOptions,
	ParadisMobileCapability.AgentHistoryPage,
	ParadisMobileCapability.AgentResume,
	// PC はこれを見て、欄の中身を含む `focus` の通知を送る（古いアプリには送らない）。
	ParadisMobileCapability.BrowserFocus,
];

/** 受け取る capability の上限。相手は信用しない前提で、表を無制限に膨らませない。 */
const MAX_CAPABILITIES = 128;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.v[1-9][0-9]{0,3}$/;
const MAX_CAPABILITY_LENGTH = 64;

/**
 * 相手から届いた `capabilities` を読む。
 *
 * - 配列でなければ `undefined`（＝この取り決めより前の相手。何も持っていないのと同じに扱う）
 * - 名前の形に合わない値・長すぎる値・重複は黙って捨てる（未知の値で落ちないように）
 */
export function paradisParseMobileCapabilities(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result: string[] = [];
	for (const candidate of value) {
		if (result.length >= MAX_CAPABILITIES) {
			break;
		}
		if (typeof candidate === 'string' && candidate.length <= MAX_CAPABILITY_LENGTH && CAPABILITY_PATTERN.test(candidate) && !result.includes(candidate)) {
			result.push(candidate);
		}
	}
	return result;
}

/**
 * 相手がその capability を広告しているか。
 *
 * `undefined`（広告しない古い相手）は「何も持っていない」とみなして false。
 * この取り決めより後に足す機能はすべて capability で守るので、古い相手には出さないのが正しい。
 */
export function paradisHasMobileCapability(capabilities: readonly string[] | undefined, name: string): boolean {
	return capabilities !== undefined && capabilities.includes(name);
}

/** 互換の判定に渡す、両側の版。`unknown` のまま渡してよい（形の検査はここでする）。 */
export interface IParadisMobileCompatInput {
	/** アプリが話す版（State の要求の `protocolVersion`）。 */
	readonly mobileProtocolVersion: unknown;
	/** アプリが求める PC の最低版（State の要求の `minCompatiblePc`）。無ければ W2-17 より前のアプリ。 */
	readonly mobileMinCompatiblePc: unknown;
	/** PC が話す版（State の `protocolVersion`）。 */
	readonly pcProtocolVersion: unknown;
	/** PC が求めるアプリの最低版（State の `minCompatibleMobile`）。無ければ W2-17 より前の PC。 */
	readonly pcMinCompatibleMobile: unknown;
}

export type ParadisMobileCompatVerdict =
	| {
		readonly kind: 'ok';
		/**
		 * 個々の操作のメッセージ（term / scm / fs の `protocolVersion`）に書く版。
		 * 窓の中で版が違うときは、古い方の版で話す。
		 */
		readonly wireVersion: number;
	}
	| {
		readonly kind: 'blocked';
		/** `mobile-too-old` ならアプリを、`pc-too-old` なら PC の Para Code を更新する。 */
		readonly reason: 'mobile-too-old' | 'pc-too-old';
		readonly mobileProtocolVersion: number;
		readonly pcProtocolVersion: number;
	};

function validVersion(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * PC とアプリが話せるか、話せないならどちらを更新すべきかを決める。PC とアプリの両方が呼ぶ。
 *
 * - `minCompatible*` を送らない相手（W2-17 より前）は、これまでどおり**版の完全一致しか受け付けない**
 *   とみなす（実際に古い PC は `protocolVersion !== 3` を拒み、古いアプリは `!== 3` を捨てる）。
 *   同じ版なら今までどおり通る
 * - 版が読めない相手は版 0（最も古い）とみなす
 * - 両方の条件に引っかかるときは「アプリが古い」を優先する（PC 側の打ち切りを優先するため）
 */
export function paradisEvaluateMobileCompat(input: IParadisMobileCompatInput): ParadisMobileCompatVerdict {
	const mobileVersion = validVersion(input.mobileProtocolVersion) ?? 0;
	const pcVersion = validVersion(input.pcProtocolVersion) ?? 0;
	const pcMinMobile = validVersion(input.pcMinCompatibleMobile);
	const mobileMinPc = validVersion(input.mobileMinCompatiblePc);
	const blocked = (reason: 'mobile-too-old' | 'pc-too-old'): ParadisMobileCompatVerdict => ({ kind: 'blocked', reason, mobileProtocolVersion: mobileVersion, pcProtocolVersion: pcVersion });

	// PC がアプリに求める条件
	if (mobileVersion < (pcMinMobile ?? pcVersion)) {
		return blocked('mobile-too-old');
	}
	// アプリが PC に求める条件
	if (pcVersion < (mobileMinPc ?? mobileVersion)) {
		return blocked('pc-too-old');
	}
	// 窓を知らない古い相手は、自分より新しい版も受け付けない
	if (mobileMinPc === undefined && pcVersion > mobileVersion) {
		return blocked('mobile-too-old');
	}
	if (pcMinMobile === undefined && mobileVersion > pcVersion) {
		return blocked('pc-too-old');
	}
	return { kind: 'ok', wireVersion: Math.min(mobileVersion, pcVersion) };
}

/**
 * PC が、個々の操作のメッセージ（term / scm / fs）に書かれた `protocolVersion` を受け付けるか。
 * 窓の中の版（{@link PARADIS_MOBILE_MIN_COMPATIBLE_MOBILE} 以上、自分の版以下）だけを通す。
 */
export function paradisIsAcceptedMobileWireVersion(value: unknown): boolean {
	const version = validVersion(value);
	return version !== undefined && version >= PARADIS_MOBILE_MIN_COMPATIBLE_MOBILE && version <= PARADIS_MOBILE_PROTOCOL_VERSION;
}
