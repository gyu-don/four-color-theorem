# 四色地図 — 近線形時間 4 彩色のデモ

巨大なランダム地図を作って編集し、そのたびに 4 色で塗り直すブラウザデモです。
彩色には次の論文のアルゴリズムを実装しています。

> Yuta Inoue, Ken-ichi Kawarabayashi, Atsuyuki Miyashita, Bojan Mohar, Carsten Thomassen, Mikkel Thorup,
> *The Four Color Theorem with Linearly Many Reducible Configurations and Near-Linear Time Coloring*,
> [arXiv:2603.24880](https://arxiv.org/abs/2603.24880) (FOCS 2026)

## 使い方

```sh
npm install
npm run build      # dist/index.html (単一の静的 HTML、外部リクエストなし) を生成
npm test           # テスト
```

`dist/index.html` をブラウザで開くだけで動きます(サーバ不要)。

- **生成**: セル数(〜200 万)、点の分布(一様ランダム / ゆらぎ格子 / ほぼ正六角格子)、1 領域あたりのセル数、シード。
- **編集**: 領域を広げる・新しい領域を描く・結合・分割、元に戻す / やり直す。編集のたびに全体を塗り直します。
- **表示**: ホイールでズーム、右ドラッグ / Space+ドラッグで移動。

## 仕組み

1. 点群の Delaunay 三角形分割(= Voronoi セルの隣接)を作り、同じラベルのセルの連結成分を「領域」とする。
2. 領域の隣接グラフを、平面埋め込み(rotation system)つきで求める (`src/map/regionGraph.ts`)。
3. 三角形分割にしてから 4 彩色する (`src/core/`)。
   - 互いに接しない可約配置(次数 3・4 の頂点と、集合 𝒟 の 8200 個)を 1 レベルぶんまとめて取り除き、
     空いたリングの内側を補助辺で埋めて、小さくなったグラフを再帰的に塗る。
   - 戻るときは、大域的な Kempe 変更でリングの彩色を「そのまま内側へ拡張できる」ものに変えてから配置を塗る。
4. 描画はポリゴンを描かず、画面のピクセルごとに最近傍サイトを求めて色を引く(セル数によらない)。

彩色はすべて Web Worker 内で行います。

### 論文との違い

- 可約配置は放電規則を使わず、𝒟 全体をトライで直接照合して探します。
- Kempe 変更の選び方は、論文 12 節の「Kempe レベル表 + 条件付き期待値法」ではなく、
  リングに触れる Kempe 鎖を少しずつ同時に探索し、小さな鎖の入れ替えだけで直せる組合せを確定していく方法です。
  UI で「ランダム (論文3.1節)」を選ぶと、3.1 節の完全ランダム版になります。
- 次数 4 の頂点は既定で、論文 13 節(補題 13.1 (ii))の「向かい合う 2 頂点の同一視」で処理します。
  「Kempe 変更のみ」を選ぶと 3.1 節どおり可約配置として扱います(数倍遅くなります)。
- 論文 13 節の一般の障害閉路(分離 3-, 4-, 5-閉路)による再帰は**実装していません**。
  可約配置がどこにも見つからない場合は残りを総当たりで塗ります(統計の「フォールバック頂点数」)。
  ランダムな地図・乱暴な編集・分離三角形だらけのグラフで試した範囲では一度も起きていませんが、
  最悪計算量 O(n log n) の保証はこの実装にはありません。

## 可約配置データ

`src/data/configs.ts` は [near-linear-4ct/reducible-configurations](https://github.com/near-linear-4ct/reducible-configurations)
(MIT License, Copyright (c) 2026 Yuta Inoue) の 8200 個の配置を詰め直したものです
(ライセンス文: `third_party/reducible-configurations-LICENSE`)。作り直すには:

```sh
sh scripts/fetch-configs.sh && npm run pack-configs && node scripts/verify-configs.mjs
```

## 開発用スクリプト

```sh
node --import tsx scripts/bench.ts uniform 200000   # ソルバ単体のベンチマーク (uniform | jitter | hex)
node --import tsx scripts/fuzz.ts 500 4000          # ランダムな地図 + 乱暴な編集を 4 通りの設定で解いて検証
```
