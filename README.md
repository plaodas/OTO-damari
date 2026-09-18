# OTO溜まり

吹くと青いノイズ粒が流れ、夜光虫のような光と音が呼応する WebGL2 / WebAudio MVP です。WebGL2 必須です。half-float の速度場が使えない端末では、粒子は従来の漏斗式で動きます。

## 起動

```bash
npm install
npm run dev
```

表示された URL をブラウザで開き、最初に画面をタップしてください。タップをきっかけに WebAudio を有効化し、マイク使用許可を求めます。同じタップで粒子への衝撃と短いチリン音も発生します。

## 操作

| 吹く強さ | 音 | 粒子の反応 |
| --- | --- | --- |
| 弱い | チリン（Karplus–Strong + 薄いベル） | ふわっと光る |
| 中くらい | キラッ（KS胴体 + FM + 短いノイズ） | 流れ始め、水面が光る |
| 強い | シャラシャラ（ノイズ粒 + 時々KS） | 高速で流れて光の帯になる |
| タップ | 短い水滴KS | 周囲の粒子が弾ける |
| 左下の丸 | カメラ | 撮った像の暗い部分ほど粒子が密に集まり、被写体が点描として浮かぶ |

- 弱・中の音は吹き始めた瞬間だけ鳴ります
- 強は吹き続けているあいだ約16ms間隔で粒が連続します
- マイクを拒否すると吹きかけ検出だけが無効になり、粒子表示とタップ操作は継続します
- カメラ画像は低解像度化して端末のメモリ内だけで解析します。アップロード、ファイル保存、Web Storageへの保存は行わず、撮影または「閉じる」の直後にカメラを停止します
- カメラを開くと TensorFlow.js の MiDaS v2.1 small と人物マスクを読み込みます。粒子は輪郭線ではなく、写真の暗い部分ほど密な点描として集まります。人物がいれば背景は捨てます。モデルが読めない端末では輝度だけで点描します
- カメラ画面の「消す」で写真由来の粒子配置を解除できます

## 描画と品質

- 粒子は Transform Feedback で GPU 更新します。見た目は海中のプランクトン寄せで、スマホ約 900、PC 約 1,400 粒です
- 速度場は短辺 128、上限 256 の RGBA16F（`EXT_color_buffer_float`）です。Jacobi はスマホ 8 回、PC 16 回程度です
- `devicePixelRatio` とフレーム時間を見て格子と Jacobi 回数を落とします
- `gl_PointSize` 上限が小さい端末だけ、point sprite の代わりに instanced quad で描きます

## スマホで確認する場合

`getUserMedia` はセキュアコンテキストでのみ利用できます。PC の `localhost` は利用できますが、同一 LAN 上のスマホから `http://PCのIPアドレス:5173` を開く方法では、多くのブラウザでマイクが許可されません。HTTPS で配信するか、HTTPS 対応の開発トンネルを利用してください。

端末スピーカーの音をマイクが拾うと再反応することがあります。実機調整時はイヤホンを使うか、`main.js` の RMS 閾値を端末に合わせて調整してください。

コンソールから吹きレベルを模擬できます。

```js
__otoSetLevel(1) // チリン
__otoSetLevel(2) // キラッ
__otoSetLevel(3) // シャラシャラ
__otoSetLevel(null) // マイク入力へ戻す
```

## ホーム画面に追加（PWA）

HTTPS で開いたあと、ホーム画面に追加するとブラウザのアドレスバーと下部ツールバーが消えて全画面表示になります。Safari や Chrome のタブとして開いているあいだは、バーは残ります。

- iPhone / iPad（Safari）: 共有 → ホーム画面に追加
- Android（Chrome）: メニュー → アプリをインストール / ホーム画面に追加

アイコンから起動すると `standalone` 表示になります。iPhone のホームインジケータと時刻・電池のステータスバーはシステムの一部なので残ります。

## ビルド

```bash
npm run build
npm run preview
```

成果物は `dist/` に生成されます。

## 構成

```text
.
├── index.html
├── main.js
├── fluid.js
├── particles.js
├── photo-depth.js
├── photo-ml.js
├── gl.js
├── quality.js
├── public
│   ├── apple-touch-icon.png
│   ├── icons
│   ├── models
│   ├── manifest.webmanifest
│   └── sw.js
└── shaders
    ├── particle.vert.glsl
    ├── particle.frag.glsl
    ├── particle-update.vert.glsl
    ├── trail.vert.glsl
    ├── trail.frag.glsl
    └── fluid
```

粒子の位置と速度は GPU バッファで ping-pong します。描画は WebGL2 の point sprite（または instanced quad）と生成ノイズテクスチャを使用し、`gl.ONE, gl.ONE` の加算合成で発光させています。強吹き時だけ 1 フレーム遅れの位置で短い光跡を `gl.LINES` で重ねます。マイク RMS とスワイプは速度場への splat、漏斗は場への外力です。音源は AudioWorklet を使わず、Karplus–Strong、少量の FM、ループノイズのグレインを標準ノードで組み立てています。
