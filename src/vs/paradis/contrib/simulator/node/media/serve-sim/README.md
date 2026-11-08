# Vendored serve-sim

PARA-CODE: fork-owned directory (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

このディレクトリは npm の `serve-sim@0.1.49`（Apache-2.0, Copyright 2026 Evan Bacon, https://github.com/EvanBacon/serve-sim ）の公開物のうち、シミュレータのホストの子プロセス（`../../paradisSimulatorHostMain.ts`）が使う分だけを、手を加えずに置いたものです。ホストは serve-sim の CLI を起こさず、公開の export `serve-sim/middleware`（`dist/middleware.js` の `simMiddleware`）を組み込んで Unix ソケットだけで待ち受けます（q.html Q585 の D1）。

- `package.json` — `"type": "module"` が ESM として読むのに要る
- `LICENSE` — Apache-2.0 の全文。npm の公開物には入っていないので、GitHub のリポジトリのもの（2026-11-08 取得）を置いた。リポジトリに NOTICE は無い
- `dist/middleware.js` — ミドルウェア（bundle 済み。外から読むのは `ws` だけで、本体の `node_modules` のものを使う）
- `dist/native/serve-sim-native.node` — 映像と HID の N-API アドオン（Mach-O、universal）
- `dist/simduo/serve-sim-duo-hid` — iPhone Duo の開閉の補助（Mach-O）
- `dist/simax/serve-sim-ax-settings` — 表示の設定の補助（Mach-O）

カメラ（`dist/simcam/`）、3D の描画（`dist/simduo/serve-sim-duo-render`）、CLI（`dist/serve-sim.js`）、ソースは使わないので入れていない（q.html Q585 の D4）。`native.ts` は `dist/native/` から `../simduo/serve-sim-duo-hid` を引くので、`dist/` の下の並びは公開物のまま保つ。

リポジトリの `.gitignore` はすべての `dist` を無視するので、このフォルダの `.gitignore` で `dist/` だけ戻している。

## 更新手順

`build/paradis/simulator/vendorServeSim.ts` の版・tgz の sha256・ファイルごとの sha256 の表を直してから、次を実行する（tgz を落として sha256 を確かめ、必要な分だけ展開する）。

```sh
node build/paradis/simulator/vendorServeSim.ts
node build/paradis/simulator/vendorServeSim.ts --check   # 置いたファイルが表と同じか（通信しない）
```

版を上げたら、`../../../common/paradisSimulator.ts` の `PARADIS_SERVE_SIM_VERSION`、`ThirdPartyNotices.txt`、`NOTES.md` の「コメントを書けないファイルへの変更一覧」の版も直す。
