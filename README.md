# 降维打击模拟器

扮演高维文明，操控一颗行星的温度与气压，观察其上文明的兴衰；或投放二向箔把它压成二维，
或用引力把它挤碎。支持摄像头手势输入：**握拳 = 引力挤压，摊开手掌 = 二向箔投放**。

纯静态站点，无构建步骤。Three.js 自研 shader + MediaPipe 手势识别。

## 快速开始

```bash
bash fetch-assets.sh && python serve.py 8123
```

打开 http://localhost:8123 。`localhost` 属于安全上下文，摄像头可用。

`fetch-assets.sh` 拉的是两样二进制产物（合计约 18MB，不入 git）：MediaPipe 的 WASM
运行时和手势识别模型。脚本幂等，已存在就跳过。**不跑它页面也能开**——星球、滑块、
两种打击效果全部可用，只有摄像头手势会报「不可用」。

## 部署

拷贝整个目录到任意 Web 服务器即可，但有三件事必须确认：

**1. 必须 HTTPS。** `getUserMedia` 只在安全上下文下可用。纯 HTTP 域名下页面照常渲染、
滑块和按钮都能用，但摄像头会被浏览器直接拒绝（页面会显示「需 HTTPS」）。

**2. 二进制依赖要单独拉。** `models/*.task` 和 `vendor/wasm/` 都在 `.gitignore` 里，
部署后跑一次 `bash fetch-assets.sh`。

**3. MIME 类型要配对。** `.mjs` 和 `.wasm` 如果回错类型，ES module 导入和 WASM 实例化
都会静默失败。nginx 参考配置：

```nginx
types {
    text/javascript   js mjs;
    application/wasm  wasm;
}

gzip on;
gzip_types text/javascript application/wasm application/json text/css;
gzip_min_length 1024;
# .task 本身是 zip 包，再压无益
gzip_proxied any;

# 可选：为 MediaPipe 的 GPU delegate 开启跨源隔离
add_header Cross-Origin-Opener-Policy   same-origin;
add_header Cross-Origin-Embedder-Policy credentialless;
```

## 体积

| 阶段 | 传输量 | 说明 |
|---|---|---|
| 首屏 | **1.3 MB** | Three.js + 页面代码，星球立即可玩 |
| 点「开启摄像头」后 | +19 MB | MediaPipe 运行时 9.5MB + 模型 8.4MB |

手势模块走动态 `import()`，不开摄像头的访客永远不会下载这 19MB。
WASM 经 gzip 约 3MB，务必开压缩。

## 代码结构

```
index.html          HUD 结构
css/style.css       控制台样式。颜色叙事：琥珀=文明，冷蓝=观测者
js/planet.js        Three.js 场景与全部 shader（行星/大气/云层/二向箔/内核）
js/civ.js           文明状态演化与通讯记录
js/gesture.js       MediaPipe GestureRecognizer 封装
js/main.js          装配与主循环
vendor/             Three.js（入 git）、MediaPipe 运行时（fetch-assets.sh 拉取）
models/             手势模型（fetch-assets.sh 拉取）
serve.py            开发服务器。补了 .mjs / .wasm 的 MIME，内置 http.server 不认
```

## 实现要点

几个踩过的坑，改动前先读：

**行星网格永不旋转。** 自转是 shader 里偏移噪声采样实现的（`uSpin`）。这样物体空间的
坐标轴相对场景恒定，二向箔沿固定平面压缩才不会跟着转。想改自转方式前先想清楚这一点。

**二向箔沿 Y 轴塌缩到水平面，不是沿视线方向。** 正对相机压平是看不出来的——厚度归零
需要视差才能读出。塌缩到水平面 + 相机俯角掠射，才能看见那片薄片。相机在扫掠开始的
前 24% 就转到位，赶在箔片抵达行星之前。

**压平量是逐顶点算的**（`flatAmount()` 按顶点 x 相对箔片位置），所以扫掠中途会出现
「左半边已是二维画、右半边还是球体」的画面——那是整个效果最好的一帧。

**光源在 +X。** 箔片由 -X 扫向 +X，残留的三维半球必须留在受光面，否则最后剩下的是一
团黑影。

**`IcosahedronGeometry` 的 detail 是每面切 `(detail+1)²`，不是 `4^detail`。**
当前 detail 28 = 20×29² = 16820 面，碎片投影约 9px。

**云层和大气只压平、不碎裂。** 它们调 `flatten()` 而非 `deform()`，挤压时整体消散。
早期版本让它们走了碎片路径，结果整个云壳作为一个刚体在翻滚。

**碎片余温挂在「分离度」`burst` 上，不是总进度 `uShatter`。** 挂错了会让尚未裂开的
完整球体整颗自发光，配合 bloom 就是一个纯白圆盘。内核辉光同理，必须等碎片开始分离。

**碎片的翻滚轴 `aAxis` 与飞散方向 `aDir` 必须独立。** 共用一个的话碎片只会绕自己的
飞行轴自旋、始终正对镜头，看起来是一地彩纸屑。飞散速度用 `rnd³` 拉长尾，
少数冲得远、多数留在近处。

## 渲染管线

场景在**线性 HDR 空间**渲染，自发光项（城市灯火 / 岩浆 / 海洋高光 / 箔片 / 内核）
刻意输出大于 1.0 的值，由 `UnrealBloomPass` 提取溢出，最后 `OutputPass` 做 ACES
色调映射并转 sRGB。

**bloom 阈值 0.78 是个硬约束。** 漫反射的东西必须压在它之下——云层和冰面反照率本来
就高，一旦越线就会互相叠加糊成死白（早期版本云层亮度 1.19，密集云区直接烧成一片）。
改任何地表或云层亮度系数前，先算一下峰值会不会越过 0.78。

地形用 Ashima/Gustavson 的 3D simplex（换掉了原先手写的 hash 值噪声，那个有可见的
轴向网格伪影）。`terrain()` 是三层叠加：极低频的大陆尺度 + 域扭曲的中频 + 细节。
域扭曲是「糊块」和「有峡湾半岛的真实海岸线」的分水岭。

法线扰动的系数要当心。梯度量级约为 `1/E`，直接拿 `0.30/E` 当系数会得到 2.4 的扰动量，
单位法线被彻底打乱，日夜线消失、地表出现孤立黑斑。当前值 0.024 对应约 0.2 的扰动。

高程阈值（大陆架 / 岩石线 / 雪线）是按 `elev ~ N(0.5, 0.22)` 的分位数定的，
不能整体平移——雪线要落在前 3%，否则四分之一个星球会被雪盖住。

## 调参

`js/civ.js` 顶部是文明模型的常数（理想温度 288K、理想气压 1atm、基准人口）。
通讯记录的文案在 `_check()` 里，按触发条件排列。

`js/planet.js` 的 `setEnv()` 把温度气压映射到云量、大气密度和颜色；
`PLANET_FRAG` 里是地表配色与各种阈值（冰线、干旱度、沸腾、熔融）。
