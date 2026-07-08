# ブラウザミラー WebRTC 化 設計（案3 本実装）

2026-07-09 起工。スパイク2件は検証済み（`memory/para-code-mobile-relay.md` 参照）。
Phase 3（TURN）まで自律実装の承認済み。

## 決定事項

- **シグナリングは既存 browser チャネル**に `webrtc-offer / webrtc-answer / webrtc-ice / webrtc-stop` を追加。
  relay / protocol は無変更。E2E(SAS検証済み)経由なので MITM 耐性を継承。
- **PC側ストリーマは renderer**（WebRTCスタックがrendererにしか無い）。
  新規: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileWebrtcStreamer.ts`
  （browserMirror ではなく mobileRelay contrib 内。eslint のレイヤールールと
  contribution からの配線を単純にするため）
- **arm は shared process が行う**（app.ts への新規パッチ不要）:
  1. shared の `paradisMobileRelayService.ts` が browser フレームの JSON を覗き
     `t` が `webrtc-` 始まりなら renderer へ転送（`_onInboundFrame.fire`）。
     `webrtc-offer` のときは転送前に `cdpFrames.armMirrorCapture(targetId)` を呼ぶ。
  2. electron-main の `paradisCdpTargetService.ts`（既に shared へ ProxyChannel 公開済み）に
     `armMirrorCapture(targetId)` を追加 → `paradisBrowserMirrorCapture.ts` のモジュール状態
     （armedTargetId + TTL 15s、one-shot consume）を設定。
  3. 既存の app.ts ハンドラ内 `paradisResolveMirrorCaptureFrame()` が armed 状態を消費し、
     `webContents.fromDevToolsTargetId(targetId).mainFrame` を返す（env スパイク経路は残す）。
- **renderer streamer**: offer受信 → `getDisplayMedia({video:true,audio:false})` →
  `RTCPeerConnection` に addTrack → answer/ice を browser チャネルで返す。
  mobileIdごとに1ピア。connectionState failed/closed でトラック停止・破棄。
  ウィンドウ reload で消滅するのは仕様（モバイル側がタイムアウトでJPEGへフォールバック）。
- **モバイル**: `react-native-webrtc@124.0.7`（recvonly、カメラ/マイクプロンプト無し）。
  - 型の罠: `event-target-shim` を pnpm overrides で 5.x に固定（d.ts が
    `event-target-shim/index` を import しており 6.x は exports にサブパスが無い）
  - `src/webrtcMirror.ts`（新規）: offer作成(recvonly transceiver)→送信→answer/ice処理→
    MediaStream を返す。10s で確立しなければ諦めて JPEG 継続（フォールバック）
  - `browserPanel.tsx`: start() 時に WebRTC を先行試行、確立したら `RTCView`、
    失敗/切断で既存 JPEG ミラー表示へ。タップ/スワイプの座標マッピングは共通
    （フレーム寸法は track settings または既存 frame メタから取得）
- **STUN**: `stun:stun.cloudflare.com:3478`（Phase 1）。
- **TURN（Phase 3）**: Cloudflare Realtime の純TURNのみ（SFUはDTLS終端するため禁止）。
  relay worker.ts に credential 発行（40-60行）。iceServers へ動的注入。

## シグナリングメッセージ（browser チャネル JSON）

- mobile→PC: `{t:'webrtc-offer', id, targetId, sdp}` / `{t:'webrtc-ice', candidate}` / `{t:'webrtc-stop'}`
- PC→mobile: `{t:'webrtc-answer', id, sdp}` / `{t:'webrtc-ice', candidate}` / `{t:'webrtc-error', id, error}`

`id` は既存 browser チャネルの要求応答と同じ相関ID。ice はストリーム（id無し）。

## フェーズ

1. **P1**: 上記一式（STUNのみ）。シミュレータ＋同一LANで実機確認
2. **P2**: フォールバック磨き込み（active prop での停止/再開、iOSバックグラウンド復帰の再ネゴ、
   非表示WebContentsViewで映像が止まる場合は既存 CDP push/JPEG 経路へ自動切替）
3. **P3**: TURN（Cloudflare Realtime 有効化 + credential 発行 + 実機キャリア回線確認）

## 注意

- app/mobile はネイティブ再ビルド必須（pod install から）
- 追加バイナリ数十MB
- `NSMicrophoneUsageDescription` 等は文字列だけ置く（静的解析対策、実際には使わない）
