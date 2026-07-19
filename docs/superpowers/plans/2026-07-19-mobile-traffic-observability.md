# Paracode Mobile Traffic Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存通信を変更せず、明示的に有効化したPC開発環境でParacode MobileのE2Eフレーム量をチャネル別に計測する。

**Architecture:** PC側の非同期FrameMuxへ任意のbest-effort observerを追加し、Node側の独立した集計器へ方向・チャネル・サイズだけを渡す。Relay serviceは`PARADIS_MOBILE_TRAFFIC_DIAGNOSTICS=1`の時だけ集計器と60秒timerを作り、既存`ILogService`へ区間集計を出力する。

**Tech Stack:** TypeScript, VS Code shared process, WebCrypto FrameMux, Mocha/TDD, Expo iOS Simulator.

## Global Constraints

- プロトコルv3、暗号、nonce、seq、チャンク境界、送信順序を変更しない。
- 本文、workspace、terminal、mobile ID、パス、URLを記録しない。
- 環境変数未設定時は集計器、timer、observerを生成しない。
- observerとログ例外を通信処理へ伝播させない。
- ユーザー所有の未追跡ファイルを変更しない。
- コミット、プッシュ、マイグレーションを行わない。

---

### Task 1: FrameMux observerをTDDで追加する

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/common/paradisMobileMux.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/test/common/paradisMobileMux.test.ts`

**Interfaces:**
- Consumes: 既存`FrameMux`, `ChannelId`, `SecureChannel`。
- Produces: `IParadisMobileFrameTrafficSample`と任意`FrameMuxOptions.onTraffic(sample)`。

- [ ] **Step 1: 送信・受信サンプルの失敗テストを書く**

```typescript
const sent: IParadisMobileFrameTrafficSample[] = [];
const received: IParadisMobileFrameTrafficSample[] = [];
const receiver = new FrameMux(pcChannel, { sendSealed: () => { }, onTraffic: sample => received.push(sample) });
const sender = new FrameMux(mobileChannel, { sendSealed: sealed => receiver.receive(sealed), onTraffic: sample => sent.push(sample) });
await sender.send(Channels.State, new Uint8Array([1, 2, 3]));
assert.deepStrictEqual(sent.map(sample => [sample.direction, sample.channel, sample.payloadBytes]), [['sent', Channels.State, 3]]);
assert.deepStrictEqual(received.map(sample => [sample.direction, sample.channel, sample.payloadBytes]), [['received', Channels.State, 3]]);
```

- [ ] **Step 2: typecheckが通ることを確認してからテストを実行し、observer未実装による失敗を確認する**

Run: `npm run typecheck-client`

Expected: exit 0。

Run: `./scripts/test.sh --grep 'ParadisMobileMux traffic'`

Expected: traffic sample配列が空でFAIL。

- [ ] **Step 3: 最小のobserver通知を実装する**

```typescript
export interface IParadisMobileFrameTrafficSample {
	readonly direction: 'sent' | 'received';
	readonly channel: ChannelId;
	readonly payloadBytes: number;
	readonly sealedBytes: number;
	readonly more: boolean;
}
```

送信は`sendSealed`成功後、受信は`decodeFrame`成功後に通知し、callback例外を握りつぶす。

- [ ] **Step 4: observer例外と大容量チャンクのテストを追加し、REDからGREENを確認する**

Run: `npm run typecheck-client`

Expected: exit 0。

Run: `./scripts/test.sh --grep 'ParadisMobileMux traffic'`

Expected: 対象テストが全件PASS。

### Task 2: 匿名の区間集計器をTDDで追加する

**Files:**
- Create: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileTrafficDiagnostics.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileTrafficDiagnostics.test.ts`

**Interfaces:**
- Consumes: `IParadisMobileFrameTrafficSample`。
- Produces: `ParadisMobileTrafficDiagnostics.record(sample)`と`takeSnapshot()`。

- [ ] **Step 1: チャネル別加算とsnapshotリセットの失敗テストを書く**

```typescript
const diagnostics = new ParadisMobileTrafficDiagnostics();
diagnostics.record({ direction: 'sent', channel: Channels.Browser, payloadBytes: 100, sealedBytes: 136, more: true });
diagnostics.record({ direction: 'sent', channel: Channels.Browser, payloadBytes: 50, sealedBytes: 86, more: false });
assert.deepStrictEqual(diagnostics.takeSnapshot().channels.browser.sent, {
	frames: 2,
	messages: 1,
	payloadBytes: 150,
	sealedBytes: 222,
	relayPayloadBytes: 256,
});
assert.deepStrictEqual(diagnostics.takeSnapshot().channels, {});
```

- [ ] **Step 2: typecheck後に対象テストを実行し、クラス未実装による失敗を確認する**

Run: `npm run typecheck-client`

Expected: 実装前はimport解決エラーになるため、テストランナー実行前のRED証拠として記録する。

- [ ] **Step 3: 固定チャネル・方向だけを集計する最小実装を書く**

`relayPayloadBytes`は各フレームの`sealedBytes + 17`を加算する。snapshotは新しいplain objectを返して内部集計を空にする。

- [ ] **Step 4: typecheckと対象テストをGREENにする**

Run: `npm run typecheck-client`

Expected: exit 0。

Run: `./scripts/test.sh --grep 'ParadisMobileTrafficDiagnostics'`

Expected: 対象テストが全件PASS。

### Task 3: Relay serviceへ既定OFFで配線する

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileTrafficDiagnostics.test.ts`

**Interfaces:**
- Consumes: `process.env.PARADIS_MOBILE_TRAFFIC_DIAGNOSTICS`, `ParadisMobileTrafficDiagnostics`, `ILogService`。
- Produces: 60秒区間の`[paradisMobileRelay][traffic]`ローカルログ。

- [ ] **Step 1: 空snapshotを出力しない整形関数の失敗テストを書く**
- [ ] **Step 2: typecheck後にテストを実行し、未実装でREDを確認する**
- [ ] **Step 3: 環境変数が文字列`1`の時だけ集計器とtimerを作る**
- [ ] **Step 4: 新規`MobileSession`へobserverを渡し、送受信サンプルを同じ集計器へ記録する**
- [ ] **Step 5: 60秒ごとに非空snapshotだけを`ILogService.info`へJSONで出力する**
- [ ] **Step 6: disposeでtimerを解除し、ログ失敗を握りつぶす**
- [ ] **Step 7: typecheckと関連テストをGREENにする**

Run: `npm run typecheck-client`

Expected: exit 0。

Run: `./scripts/test.sh --grep 'ParadisMobileMux traffic|ParadisMobileTrafficDiagnostics'`

Expected: 対象テストが全件PASS。

### Task 4: 基準実測と最終検証を行う

**Files:**
- Review: `docs/superpowers/specs/2026-07-19-mobile-traffic-observability-design.md`
- Review: `src/vs/paradis/contrib/mobileRelay/common/paradisMobileMux.ts`
- Review: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileTrafficDiagnostics.ts`
- Review: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts`

**Interfaces:**
- Consumes: Task 1〜3の計測基盤、iOS Simulator、既存疑似モバイルハーネス。
- Produces: 最適化前のチャネル別基準値と回帰確認結果。

- [ ] **Step 1: `npm run typecheck-client`を実行する**
- [ ] **Step 2: 関連Mochaテストを実行する**
- [ ] **Step 3: `git diff --check`と対象差分を確認する**
- [ ] **Step 4: 環境変数なしで起動し、trafficログが出ないことを確認する**
- [ ] **Step 5: 環境変数ありでPCとiOS Simulatorを接続し、本文を含まない区間集計が出ることを確認する**
- [ ] **Step 6: foreground、Terminal、Agent、browser、background復帰を順に確認する**
- [ ] **Step 7: 実Relayとのペアリングが利用できない場合は疑似ハーネスでFrameMux経路を再現し、実回線基準値は未確認として分離する**
