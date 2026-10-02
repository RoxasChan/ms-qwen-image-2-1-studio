/* Qwen-Image-2.1 Studio — 前端逻辑 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ModelScope 实测上限：prompt 超过 4000 字符会被拒绝
// （返回 "invalid prompt or prompt length more than 4000"）
// 官方规范要求的 400-500 词描述约 2600-2900 字符，正好留有余量。
const PROMPT_MAX = 4000;
// 超过此长度即视为逼近红线，前端给出预警
const PROMPT_WARN = 3600;

const state = {
  mode: 't2i',
  refImages: [], // { dataUrl, name } —— 创作台的参考图，交给生图模型
  hasApiKey: false,
  optimizer: { mode: 'llm', apiKey: '', baseUrl: '', model: '' },
  convs: [], // 提示词对话列表（持久化在后端）
  activeConvId: '',
  // 当前对话锁定的参考图 —— 交给**视觉模型**"看"的就是这几张。
  // 存的是 { name, file, w, h, bytes } 引用（文件在服务端 inputs/ 下），
  // **不含 base64**：显示走 /inputs/<file>，送给模型由服务端读盘组装。
  // 与创作台的 refImages 刻意分开：创作台换图不影响已锁定的对话。
  convImages: [],
  rules: null, // /api/rules：官方规范文件的真实元信息（文件名 / sha256 / 大纲）
  lastOptimized: '',
  polling: null,
  generating: false,
  history: [],
  previewUrl2Item: new Map(),
  // 生成作业（一次多张 + 服务端后台推进）。前端只是观察者：
  //   jobs         —— /api/jobs 的最新快照，右栏任务列表与结果区都从这里渲染
  //   activeJobId  —— 当前正在跑的作业（由服务端 status==='running' 推出）
  //   attachedJobId—— 结果区正在显示哪个作业
  //   attachLock   —— 用户手动点选过的作业；有值时轮询**不再**自动切回进行中的那批
  //   jobsSeen     —— 已播报过收尾的作业 id（多批并行时按作业去重，且刷新后不重播）
  jobs: [],
  activeJobId: '',
  attachedJobId: '',
  attachLock: '',
  jobsSeen: null,
};

/* ================= 通用工具 ================= */

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  // 停留时间随内容长度自适应：诊断类提示（"解析不了域名，该怎么排查"）可能上百字，
  // 固定 5.2 秒根本读不完；短提示也保持原来的节奏。
  const dur = type === 'err'
    ? Math.min(12000, 4200 + String(msg || '').length * 70)
    : 3200;
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, dur);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    json = { ok: false, error: `HTTP ${res.status}` };
  }
  return json;
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

const MODE_LABEL = { t2i: '文生图', i2i: '图生图', edit: '图像编辑', inpaint: '局部重绘' };

/* ================= 导航 ================= */

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    $$('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $(`#view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'history') loadHistory();
  });
});

function gotoView(name) {
  const btn = $(`.nav-item[data-view="${name}"]`);
  if (btn) btn.click();
}

/* ================= 模式切换 ================= */

$$('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.mode-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.mode = tab.dataset.mode;
    $('#refCard').style.display = state.mode === 't2i' ? 'none' : 'block';
    $('#maskCard').style.display = state.mode === 'inpaint' ? 'block' : 'none';
    // 注意：创作台模式与提示词对话使用的规范类型**互相独立**。
    // 早期版本在这里同步切换提示词结构提示，导致「在改图模式下聊文生图提示词」
    // 会被套上编辑规范，故该同步已移除。
    updateKindHint();
    if (state.mode === 't2i') {
      $('#drop').textContent =
        '点击或拖拽图片到此处上传 · 支持多张（最多 10 张）· 编辑模式建议第 1 张为原图';
    } else if (state.mode === 'i2i') {
      $('#drop').textContent =
        '上传参考图（可多张）· 模型会保持主体特征，按提示词重构画面';
    } else if (state.mode === 'inpaint') {
      $('#drop').textContent =
        '上传 1 张待编辑的原图 · 下方可涂白做掩码，或用彩色自由圈选套住要改的目标';
    } else {
      $('#drop').textContent =
        '上传待编辑原图（第 1 张为原图，其余可作为参考图）· 用指令式提示词描述修改';
    }
    // 局部重绘只支持单张原图：切过来时自动丢弃多余图片
    if (state.mode === 'inpaint' && state.refImages.length > 1) {
      state.refImages = state.refImages.slice(0, 1);
      renderThumbs();
      toast('局部重绘只需 1 张原图，已保留第 1 张');
    }
    if (state.mode === 'inpaint') syncPaintImage();
    if (state.mode === 'inpaint') $('#fileInput').removeAttribute('multiple');
    else $('#fileInput').setAttribute('multiple', '');
  });
});

/* ================= 图片压缩（上传前的体积检测） =================
   两条路径的目标不同，不能一把尺子量：
   · 创作台参考图 —— 要交给生图模型，必须保住画质，只在超限时才压到单边 2048；
   · 对话锁定图   —— 要交给视觉模型"看懂画面在讲什么"，压到单边 1024 就够。

   透明通道保护：PNG 透明素材若转成 JPEG，alpha 会被填成黑色。所以先抽样探测
   是否真有透明区域，有就继续输出 PNG，绝不静默毁掉抠好的素材。

   ⚠️ 体积预算必须与**服务端**对齐。服务端对单张 dataURL 有硬上限
   （server.js 的 CONV_IMG_DATAURL_MAX = 900000 字符），前端产出的图若超过它，
   服务端会**静默丢弃**，界面表现为「已锁定 1 张」与「服务端只接受了 0 张」同时弹出。
   本项目就踩过这个坑：PNG 分支的预算给到了 1.68MB，是服务端上限的 2.5 倍。 */

// 创作台参考图（交给生图模型）
const REF_MAX_SIDE = 2048; // 生图接口单边上限
const REF_MAX_BYTES = 3 * 1024 * 1024;
const REF_JPEG_QUALITY = 0.92;

// 对话锁定图（交给视觉模型）
const LOCK_MAX_SIDE = 1024;
const LOCK_MAX_BYTES = 420 * 1024;
const LOCK_JPEG_QUALITY = 0.82;
const CONV_MAX_IMAGES = 6; // 与服务端上限保持一致

// 服务端单张 dataURL 字符上限，必须与 server.js 的 CONV_IMG_DATAURL_MAX 同步。
// 前端要**提前**卡在这个水位，否则会出现「前端报成功、服务端全丢」的分裂结果。
const SERVER_DATAURL_MAX = 900000;
const SERVER_DATAURL_MAX_BYTES = Math.floor((SERVER_DATAURL_MAX * 3) / 4); // base64 膨胀 4/3

const REF_PREP = { maxSide: REF_MAX_SIDE, maxBytes: REF_MAX_BYTES, quality: REF_JPEG_QUALITY };
const LOCK_PREP = { maxSide: LOCK_MAX_SIDE, maxBytes: LOCK_MAX_BYTES, quality: LOCK_JPEG_QUALITY };

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

/**
 * 抽样探测**真正的**透明区域（全量扫描 2K 图太慢，256×256 采样足够判断）。
 *
 * 判据不能是「存在 alpha < 250 的像素」：模型产出的 RGBA PNG 在柔边与抗锯齿处
 * 普遍带 alpha 239~254 的值，视觉上完全不透明，却会被判成透明图 —— 于是锁定图
 * 继续走 PNG 而不走 JPEG，体积大 11 倍（实测 955KB vs 86KB），
 * 直接超出服务端单张上限、被整张丢弃。
 *
 * 改判据为「明显透明的像素占比超过 1%」：真正抠好的素材是大片 alpha≈0，必然命中；
 * 柔边噪点则不会误伤。
 */
const ALPHA_CLEAR_MAX = 128; // 低于此值才算"明显透明"
const ALPHA_CLEAR_RATIO = 0.01; // 明显透明像素的占比阈值

function hasTransparency(img) {
  try {
    const w = Math.min(img.naturalWidth, 256);
    const h = Math.min(img.naturalHeight, 256);
    if (!w || !h) return false;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let clear = 0;
    let total = 0;
    for (let i = 3; i < d.length; i += 4) {
      total += 1;
      if (d[i] < ALPHA_CLEAR_MAX) clear += 1;
    }
    return total > 0 && clear / total > ALPHA_CLEAR_RATIO;
  } catch (e) {
    // 取不到像素时按不透明处理：宁可产出更小的 JPEG，也不要因为一张
    // 读不出像素的图而卡在 PNG 上撞服务端上限。
    return false;
  }
}

function scaleTo(img, maxSide, mime, quality) {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const ratio = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * ratio));
  const h = Math.max(1, Math.round(sh * ratio));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = c.toDataURL(mime, quality);
  return { dataUrl, w, h, bytes: Math.round(dataUrl.length * 0.75) };
}

/**
 * 体积检测 + 按需压缩。尺寸与体积都在限内时**原样返回**，绝不无谓重编码
 * （重编码会掉画质，也会抹掉原始 EXIF/色彩信息）。
 * @returns {Promise<{dataUrl,w,h,bytes,originalBytes,compressed,keptAlpha}>}
 */
async function prepareImage(dataUrl, file, opt) {
  const { maxSide, maxBytes, quality } = opt;
  const originalBytes = file ? file.size : Math.round(dataUrl.length * 0.75);

  let img;
  try {
    img = await loadImage(dataUrl);
  } catch (e) {
    // 解不开就原样交出去（后端仍会做格式与体积校验）
    return { dataUrl, w: 0, h: 0, bytes: originalBytes, originalBytes, compressed: false };
  }

  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const overSide = Math.max(sw, sh) > maxSide;
  const overBytes = originalBytes > maxBytes;
  const overServerLimit = dataUrl.length > SERVER_DATAURL_MAX;
  if (!overSide && !overBytes && !overServerLimit) {
    return { dataUrl, w: sw, h: sh, bytes: originalBytes, originalBytes, compressed: false };
  }

  const alpha = hasTransparency(img);
  const mime = alpha ? 'image/png' : 'image/jpeg';
  let out = scaleTo(img, maxSide, mime, quality);

  if (!alpha) {
    // 先逐级降质量
    let q = quality;
    while (out.bytes > maxBytes && q > 0.55) {
      q = Math.max(0.55, q - 0.12);
      out = scaleTo(img, maxSide, 'image/jpeg', q);
    }
    // 仍超标再缩尺寸
    let side = maxSide;
    while (out.bytes > maxBytes && side > 512) {
      side = Math.round(side * 0.75);
      out = scaleTo(img, side, 'image/jpeg', q);
    }
  } else {
    // PNG 透明图不能降质量，只能缩尺寸。
    // 预算取 LOCK 目标与**服务端硬上限**中的较小值：只按 maxBytes*4 会放到 1.68MB，
    // 是服务端上限的 2.5 倍，产出必然被丢弃。
    const pngBudget = Math.min(maxBytes * 4, SERVER_DATAURL_MAX_BYTES);
    let side = maxSide;
    while (out.bytes > pngBudget && side > 512) {
      side = Math.round(side * 0.75);
      out = scaleTo(img, side, 'image/png');
    }
  }

  // 通用兜底：无论走哪个分支，都不允许突破服务端单张上限。
  // 这是最后一道闸门 —— 突破上限的图会被服务端**静默丢弃**，用户只看到一句
  // 语焉不详的"服务端只接受了 0 张"，远不如在这里缩掉尺寸。
  let guardSide = maxSide;
  while (out.dataUrl.length > SERVER_DATAURL_MAX && guardSide > 256) {
    guardSide = Math.round(guardSide * 0.7);
    out = scaleTo(img, guardSide, mime, quality);
  }

  return { ...out, originalBytes, compressed: true, keptAlpha: alpha };
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 压缩后给用户一句可核对的结果说明 */
function compressionNote(res, what) {
  if (!res.compressed) return '';
  return `${what} ${fmtBytes(res.originalBytes)} → ${fmtBytes(res.bytes)}${
    res.keptAlpha ? '（保留透明通道）' : ''
  }`;
}

/* ================= 参考图上传 ================= */

// 参考图张数上限。**接口硬上限是 4**（第 5 张起直接 HTTP 400：
// "image_url count 5 exceeds maximum limit of 4"）。官方模型卡写的是「最多 10 张
// 参考图」，那是模型自身能力；经 ModelScope 推理 API 只放行 4 张。
// 以前这里按文档写成 10，会让用户上传 5 张后在提交阶段莫名失败。
const MAX_REF = 4;

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.refImages.forEach((im, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `<img src="${im.dataUrl}" alt="" /><span class="tag">#${
      i + 1
    }</span><button class="del" title="移除">✕</button>`;
    d.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      state.refImages.splice(i, 1);
      renderThumbs();
      if (state.mode === 'inpaint') syncPaintImage();
    });
    d.querySelector('img').addEventListener('click', () => openViewer(im.dataUrl, im.name));
    box.appendChild(d);
  });
  // 参考图数量会决定「编辑图片提示词」对话是否可用，顺手刷新提示条
  updateKindHint();
}

async function readFiles(files) {
  const list = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;

  // 局部重绘只需要 1 张原图：再次上传即替换（画布会随之重建）
  if (state.mode === 'inpaint') {
    const f = list[list.length - 1];
    try {
      const raw = await readAsDataURL(f);
      const im = await prepareImage(raw, f, REF_PREP);
      state.refImages = [{ dataUrl: im.dataUrl, name: f.name, w: im.w, h: im.h, bytes: im.bytes }];
      renderThumbs();
      syncPaintImage();
      const note = compressionNote(im, '原图');
      if (note) toast(note, 'ok');
    } catch (e) {
      toast(e.message || '图片读取失败', 'err');
    }
    if (list.length > 1) toast('局部重绘只需 1 张原图，已采用最后选择的一张');
    return;
  }

  const room = MAX_REF - state.refImages.length;
  if (room <= 0) return toast(`最多上传 ${MAX_REF} 张参考图`, 'err');
  const picked = list.slice(0, room);
  if (list.length > room) toast(`已达上限，仅添加前 ${room} 张`, 'err');

  // 逐张做体积检测：尺寸与体积都在限内就原样保留，超了才压
  let savedTotal = 0;
  for (const f of picked) {
    try {
      const raw = await readAsDataURL(f);
      const before = f.size;
      const im = await prepareImage(raw, f, REF_PREP);
      state.refImages.push({ dataUrl: im.dataUrl, name: f.name, w: im.w, h: im.h, bytes: im.bytes });
      if (im.compressed) savedTotal += Math.max(0, before - im.bytes);
      renderThumbs();
    } catch (e) {
      toast(`「${f.name}」读取失败`, 'err');
    }
  }
  if (savedTotal > 0) toast(`图片过大，已自动压缩，共节省 ${fmtBytes(savedTotal)}`, 'ok');
}

$('#drop').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  readFiles(e.target.files);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((ev) =>
  $('#drop').addEventListener(ev, (e) => {
    e.preventDefault();
    $('#drop').classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  $('#drop').addEventListener(ev, (e) => {
    e.preventDefault();
    $('#drop').classList.remove('over');
  })
);
$('#drop').addEventListener('drop', (e) => readFiles(e.dataTransfer.files));

/* ================= 局部重绘：蒙版画笔 / 圈选标注 =================
 *
 * 画布分辨率 = 原图比例，单边压到 2048 内并取 16 的倍数 —— 与接口的 size
 * 约束一致，这样导出的原图/掩码和请求尺寸完全对齐，不会因缩放导致掩码错位。
 *
 * 两次实测结论（2026-09）：
 *   1. 掩码是必要条件。不带掩码时模型会把新内容随机放到画面任意位置
 *      （对照实验中「加长椅」跑到了右上角）；带掩码才精确落在标记区域。
 *   2. 涂抹用白色标注实测比红色更干净，故涂抹的默认色是白色。
 *   另：接口接收输入图的字段名是 image_url，写成 image 会被静默丢弃。
 *
 * 这里其实住着**两种不同的标注方式**，官方把它们分开举例，别混为一谈：
 *   · 涂抹（painted region）：画笔涂白 → 模型重画涂白处。单色即可。
 *   · 圈选（annotations）：在原图上画**封闭的圈**把目标套住，**一种颜色对应
 *     一条修改指令**；提示词按颜色逐个说明改什么，末尾声明标注线不要渲染。
 *     圈不必是圆 —— 沿物体轮廓随手绕一圈才是原意（详见 isRegionStroke）。
 * 两者可同时用在一张图上（涂白 + 几处彩色圈），提示词里各自点名即可。
 */

/**
 * 圈选标注的调色板。
 *
 * 官方「圈选」示例是在原图上画**蓝、红、绿三种颜色的框**，提示词里按颜色逐个
 * 说明要改什么，结尾再声明标注线不要渲染出来。所以颜色不是装饰，而是**画面与
 * 提示词之间的那把钥匙** —— 少一种颜色就少一条指令，说错颜色就改错地方。
 *
 * 名字要和用户在提示词里写的字面一致，所以中文名集中放这里，界面徽标、
 * 指令骨架、提交前体检三处共用，避免各写一套「蓝 / 蓝色」而对不上。
 * `en` 供体检时识别英文提示词（official_edit 规范允许用户用英文写）。
 */
const MARK_COLORS = [
  { hex: '#ffffff', name: '白色', en: 'white' },
  { hex: '#1e6bff', name: '蓝色', en: 'blue' },
  { hex: '#ff3b30', name: '红色', en: 'red' },
  { hex: '#17b26a', name: '绿色', en: 'green' },
  { hex: '#ffb020', name: '黄色', en: 'yellow' },
  { hex: '#a855f7', name: '紫色', en: 'purple' },
  { hex: '#00c2d1', name: '青色', en: 'cyan' },
];

/** 颜色值 → 调色板条目（认不出来时保留原值，便于自定义色不出错） */
function markColorMeta(hex) {
  const h = String(hex || '').toLowerCase();
  return MARK_COLORS.find((c) => c.hex === h) || { hex: h, name: h || '未知色', en: '' };
}

/**
 * 笔刷 / 线宽按**像素**取值，不再按画布宽度的百分比。
 *
 * 百分比的老毛病：同一个档位换张图就变了 —— 1152px 宽的图上「最小 1%」是 12px，
 * 想顺着物体轮廓描一条细线根本做不到（用户实测反馈的就是这个 12px）。
 *
 * 滑块本身是 0–100 的「档位」，映射到像素走**对数**曲线：
 *   档位 0 → 1px、25 → 4px、50 → 20px、100 → 400px。
 * 用线性滑块摆不下 1–400 这个跨度：低端几步就跨过 1/2/3/4px，
 * 在一个两百来像素宽的轨道上根本选不中，而这几像素恰恰是描轮廓最常用的档。
 */
const BRUSH_MIN = 1;
const BRUSH_MAX = 400;
const BRUSH_DEFAULT_RATIO = 0.08; // 首次建画布时按宽度的 8% 取默认值（沿用旧版手感）

function brushPxFromStep(step) {
  const t = Math.max(0, Math.min(100, Number(step) || 0)) / 100;
  const px = BRUSH_MIN * Math.pow(BRUSH_MAX / BRUSH_MIN, t);
  return Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, Math.round(px)));
}

function brushStepFromPx(px) {
  const p = Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, Math.round(Number(px) || BRUSH_MIN)));
  // 反查最近的一档。对数曲线取整后不是一一对应（50px 落在档位 64.8 上），
  // 拿公式直接取整会让滑块位置与显示值差一两个像素。101 档全扫一遍，几微秒的事，
  // 换来的是「滑块在哪、线就是多粗」这件事永远对得上。
  let best = 0;
  let bestGap = Infinity;
  for (let s = 0; s <= 100; s++) {
    const gap = Math.abs(brushPxFromStep(s) - p);
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  return best;
}

const paint = {
  img: null, // 已解码的原图
  srcKey: '', // 当前原图的 dataUrl，用于判断是否需要重建画布
  w: 0,
  h: 0,
  // 每条标记都带**自己画下那一刻的颜色**，三种几何：
  //   自由笔画 { tool:'brush'|'eraser', color, size, pts:[{x,y}] }
  //   自由圈选 { tool:'lasso',           color, size, pts:[{x,y}] }  ← 收笔时闭合成环
  //   矩形框   { tool:'rect',            color, size, a:{x,y}, b:{x,y} }
  // 颜色记在条目上而不是全局，多色圈选才能在同一次提交里各自出各自的样子。
  strokes: [],
  cur: null,
  tool: 'brush',
  brushPx: 8, // 笔刷 / 线宽，单位像素
  // 用户是否亲手调过线宽。调过之后换图不再重置 —— 好不容易调出来的细线
  // 不该因为换了张参考图就被冲掉。
  brushTouched: false,
  color: '#ffffff',
};

function paintReady() {
  return !!(paint.img && paint.w && paint.h);
}

/** 由「拖拽起止两点」定义的形状（只有矩形框） */
function isDragShape(s) {
  return !!s && s.tool === 'rect';
}

/**
 * 圈选类标记 = **封闭区域**：矩形框 / 自由圈选。
 *
 * 注意「圈选」不等于「画圆」。官方示例里它是把目标**套起来的一个封闭圈**，
 * 形状随意 —— 顺着物体轮廓绕一圈才是它要的语义。原来这里放的是 circle
 * （正圆 + 正椭圆），等于把「圈选」读成了「圆形」：一个正圆既套不住细长的
 * 物体，又会把旁边不相关的东西一起框进来，被框到的部分就会跟着被改掉。
 */
function isRegionStroke(s) {
  return !!s && (s.tool === 'rect' || s.tool === 'lasso');
}

/** 一处标记的外接尺寸，用来判「是不是误触」 */
function strokeSpan(s) {
  const pts = isDragShape(s) ? [s.a, s.b] : s.pts || [];
  if (!pts.length) return 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return Math.max(x1 - x0, y1 - y0);
}

/** 把鼠标/触摸位置换算为画布内部坐标 */
function paintPos(e) {
  const c = $('#paintCanvas');
  const r = c.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    x: ((e.clientX - r.left) / r.width) * paint.w,
    y: ((e.clientY - r.top) / r.height) * paint.h,
  };
}

/**
 * 在给定 context 上绘制标记。
 * 橡皮默认用 destination-out 擦掉已有标记 —— 底图在另一个图层，所以不会被擦伤。
 *
 * @param color 兜底颜色。条目自带的 `s.color` 优先 —— 多色圈选就靠这一条：
 *   蓝色圈和红色圈在同一次绘制里各出各的颜色，导出图才带得上两种颜色。
 * @param opts.forceColor 强制覆盖所有标记的颜色（优先于 `s.color`）。
 *   独立掩码要的就是这个：它只认「白 = 重画」，画圈时用的蓝红绿必须全部抹平，
 *   否则带着彩色进掩码，模型会把它当成「图的颜色」而不是「要重画的区域」。
 * @param opts.fillShapes 封闭区域是否填实。
 *   涂抹叠加方式给**人眼与模型**看的是"圈起来"这个动作，所以画成轮廓（圈选）；
 *   独立掩码方式里白色必须是**实心区域**，否则模型只会重画那圈线本身（甜甜圈）。
 *   同一个几何形状，两种提交路径渲染方式不同，就是这个参数控制的。
 * @param opts.eraseAs 橡皮改成「用这个颜色涂回去」而不是擦除。
 *   独立掩码的底是**黑色**，那里必须这么办：destination-out 会在黑底上擦出
 *   透明洞，导出的掩码既不是白也不是黑，模型拿到一片说不清的像素。
 * @param opts.minWidth 线宽的**下限**，只给屏幕预览用（见 previewMinWidth）。
 *   导出路径一律不传，线宽严格等于设定的像素值 —— 画细线是画细线，
 *   不能因为屏幕上要多看几眼就把送出去的标注加粗。
 */
function paintStrokes(ctx, strokes, color, opts) {
  const fillShapes = !!(opts && opts.fillShapes);
  const eraseAs = (opts && opts.eraseAs) || null;
  const force = (opts && opts.forceColor) || null;
  const minW = (opts && opts.minWidth) || 0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    const erasing = s.tool === 'eraser';
    const ink = erasing && eraseAs ? eraseAs : force || s.color || color;
    const w = Math.max(s.size, minW);
    ctx.globalCompositeOperation = erasing && !eraseAs ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = w;
    if (isRegionStroke(s)) {
      ctx.beginPath();
      if (s.tool === 'rect') {
        const x = Math.min(s.a.x, s.b.x);
        const y = Math.min(s.a.y, s.b.y);
        ctx.rect(x, y, Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
      } else {
        // 自由圈选：沿采样点连线，**收笔闭合**。
        // 不闭合的话画面里只是一个开口线团，模型无从判断「这个区域」指哪一侧。
        const pts = s.pts;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
      }
      if (fillShapes) ctx.fill();
      else ctx.stroke();
    } else if (s.pts.length === 1) {
      // 单击：画一个圆点，否则单点笔画不可见
      ctx.beginPath();
      ctx.arc(s.pts[0].x, s.pts[0].y, w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(s.pts[0].x, s.pts[0].y);
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** 仅含标记的透明画布（各条标记用自己的颜色） */
function buildMarkCanvas(color) {
  const c = document.createElement('canvas');
  c.width = paint.w;
  c.height = paint.h;
  paintStrokes(c.getContext('2d'), paint.strokes, color);
  return c;
}

/** 涂抹 / 圈选方式提交用：标记以各自的不透明色压在原图上（单张图） */
function buildPaintedCanvas() {
  const c = document.createElement('canvas');
  c.width = paint.w;
  c.height = paint.h;
  const ctx = c.getContext('2d');
  ctx.drawImage(paint.img, 0, 0, paint.w, paint.h);
  ctx.drawImage(buildMarkCanvas(paint.color), 0, 0);
  return c;
}

/**
 * 独立掩码方式提交用：黑底白块，白 = 重绘区（封闭区域在这里填实）。
 *
 * ⚠️ 这条路会把**所有颜色抹成白色** —— 不论画的时候用了蓝红绿，掩码里只认
 * 「白 = 要重画」。所以多色圈选必须走「涂抹叠加」，否则颜色全丢。
 */
function buildMaskCanvas() {
  const c = document.createElement('canvas');
  c.width = paint.w;
  c.height = paint.h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, paint.w, paint.h);
  paintStrokes(ctx, paint.strokes, '#ffffff', {
    fillShapes: true,
    eraseAs: '#000000',
    forceColor: '#ffffff',
  });
  return c;
}

/** 原图按画布分辨率重绘（用于独立掩码方式，保证两张图尺寸一致） */
function buildBaseCanvas() {
  const c = document.createElement('canvas');
  c.width = paint.w;
  c.height = paint.h;
  c.getContext('2d').drawImage(paint.img, 0, 0, paint.w, paint.h);
  return c;
}

function paintBrushPx() {
  return Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, Math.round(paint.brushPx || BRUSH_MIN)));
}

/**
 * 屏幕预览的「最小可见宽度」。
 *
 * 画布的内部尺寸常常远大于它的显示尺寸（1152px 的画布可能只摆在 640px 宽的框里），
 * 一条 1px 的线等比缩下来只剩 0.5px 不到，再叠上 0.72 的预览透明度，肉眼基本看不见 ——
 * 于是「线太细」会被误判成「没画上」。所以预览层给一个按缩放比算出来的下限，
 * 约等于 1.2 个 CSS 像素。
 *
 * ⚠️ **只作用于屏幕预览**：导出走 buildMarkCanvas / buildPaintedCanvas / buildMaskCanvas，
 * 它们都不传 minWidth，线宽严格等于滑块上的像素值 —— 屏幕上看着略粗、成片里是细线，
 * 这是有意的取舍：看得见才画得准。
 */
function previewMinWidth(c) {
  const rect = c.getBoundingClientRect();
  if (!c.width || !rect.width) return 0;
  const scale = c.width / rect.width; // 内部像素 : CSS 像素
  return scale > 1 ? 1.2 * scale : 0;
}

/**
 * 按颜色归并已画的**封闭区域** —— 「一种颜色 = 一条修改指令」的直接体现。
 *
 * 自由涂抹（画笔）不参与归并：官方把「涂抹」和「圈选」当成两种标注方式，
 * 只有封闭区域才需要在提示词里按颜色点名。画笔的落坑检查在
 * annotationAdvisories() 里单独做。
 */
function markSummary() {
  const map = new Map();
  for (const s of paint.strokes) {
    if (!isRegionStroke(s)) continue;
    const hex = String(s.color || '').toLowerCase();
    if (!map.has(hex)) {
      const meta = markColorMeta(hex);
      map.set(hex, { hex, name: meta.name, en: meta.en, count: 0 });
    }
    map.get(hex).count++;
  }
  return [...map.values()];
}

/** 圈选清单：把「哪种颜色画了几处」摊开给用户看，提示词就照着这个写 */
function renderMarkBar(groups) {
  const bar = $('#markBar');
  const box = $('#markChips');
  const list = groups || markSummary();
  if (!list.length) {
    bar.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  box.innerHTML = list
    .map(
      (g) =>
        `<span class="mark-chip"><i style="background:${g.hex}"></i>${g.name}` +
        `${g.count > 1 ? ` × ${g.count} 处` : ''}</span>`
    )
    .join('');
}

/**
 * 按已画的颜色生成一段指令骨架，结构照官方「圈选」示例：
 * **先说哪个颜色区域、再说改成什么**，最后一句声明标注线不得渲染。
 *
 * 最后那句是必需的 —— 少了它，画上去的标注线会原样留在成片里
 * （官方 FAQ 专门有一条在讲这个）。同色多处官方写作「将两处绿色圈选
 * 区域内的…」，所以这里也带上处数。
 */
function annotationSkeleton() {
  const list = markSummary();
  if (!list.length) return '';
  const body = list
    .map((g) => `将${g.count > 1 ? `${g.count}处` : ''}${g.name}圈选区域内的___改为___`)
    .join('；');
  const names = list.map((g) => g.name).join('、');
  return `${body}；${names}标注线不得渲染在图像中。`;
}

/** 提示词里是否已经声明「标注线不要渲染出来」 */
function hasExclusionClause(text) {
  const s = String(text || '');
  return (
    /标注线不得渲染|标注线不.{0,4}渲染|标注.{0,8}不.{0,6}渲染/.test(s) ||
    /\b(annotation|marker|box|line)s?\b[^.]{0,40}\b(not|never|should not|must not|do not)\b[^.]{0,20}\brender/i.test(s)
  );
}

/** 提示词里有没有点名这个颜色（中英文都认，规范允许英文写） */
function promptNamesColor(text, group) {
  const s = String(text || '').toLowerCase();
  if (s.includes(group.name)) return true;
  return !!(group.en && new RegExp(`\\b${group.en}\\b`).test(s));
}

/**
 * 圈选 / 涂抹工作流的落坑体检。
 *
 * 只**如实提醒**，绝不替用户改提示词 —— 提示词是用户的东西，悄悄改掉比不改更糟：
 * 他会以为发出去的是自己写的那句，结果历史里存的却是另一段。
 * 三个坑都会白花钱，所以值得在提交前说清楚：
 *   1. 「独立掩码」把所有颜色抹成白 —— 多色圈选走这条路等于颜色全丢；
 *   2. 提示词没按颜色点名 —— 模型不知道该改哪一处；
 *   3. 少了排除标注线那句 —— 成片里会留着标注线。
 */
function annotationAdvisories(text, submitMode) {
  const out = [];
  const regions = markSummary();
  const brushColors = [
    ...new Set(paint.strokes.filter((s) => s.tool === 'brush').map((s) => String(s.color || '').toLowerCase())),
  ];

  if (regions.length && submitMode === 'separate') {
    out.push(
      '当前提交方式是「独立掩码」，所有颜色都会被抹成白色 —— 多种颜色分不开。多色圈选请改用「涂抹叠加」。'
    );
  }
  if (regions.length) {
    const unnamed = regions.filter((g) => !promptNamesColor(text, g));
    if (unnamed.length) {
      out.push(
        `提示词里没提到${unnamed.map((g) => g.name).join('、')} —— 模型不知道该改这一处，` +
          '每个颜色都要单独说明改成什么（可用下方「生成指令骨架」）。'
      );
    }
    if (!hasExclusionClause(text)) {
      out.push(
        '结尾少了「…标注线不得渲染在图像中」—— 少了这句，画上去的标注线会留在成片里。'
      );
    }
  }
  for (const hex of brushColors) {
    const meta = markColorMeta(hex);
    if (!promptNamesColor(text, meta)) {
      out.push(`画面里有${meta.name}涂抹，但提示词没提到「${meta.name}标记区域」要补什么。`);
    }
  }
  return out;
}

/** 把体检结果写进画笔卡（随输入实时更新） */
function refreshAnnotationAdvice() {
  const el = $('#markAdvice');
  if (!el) return;
  const mode = $('#maskSubmit').value;
  const list = annotationAdvisories($('#prompt').value, mode);
  if (!list.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = list.map((t) => `<div class="mark-advisory"><span class="w">⚠︎</span>${t}</div>`).join('');
}

function redrawPaint() {
  const c = $('#paintCanvas');
  $('#brushVal').textContent = paintReady() ? `${paintBrushPx()} px` : '—';
  $('#maskMeta').textContent = paintReady()
    ? `${paint.w}×${paint.h} · ${paint.strokes.length ? `已标记 ${paint.strokes.length} 处` : '尚未标记'}`
    : '';
  $('#undoMaskBtn').disabled = !paint.strokes.length;
  $('#clearMaskBtn').disabled = !paint.strokes.length;
  renderMarkBar();
  refreshAnnotationAdvice();
  if (!c.width || !c.height) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const all = paint.cur ? paint.strokes.concat([paint.cur]) : paint.strokes;
  paintStrokes(ctx, all, paint.color, { minWidth: previewMinWidth(c) });
  // 屏幕上半透明以便对准位置；导出时始终用完整不透明的标记
  c.style.opacity = all.length ? '0.72' : '0';
}

function clearPaintCanvas() {
  const c = $('#paintCanvas');
  c.width = 0;
  c.height = 0;
  $('#paintBase').removeAttribute('src');
  $('#paintEmpty').style.display = 'flex';
  $('#paintEmpty').textContent = '先在上方上传一张待重绘的原图';
  redrawPaint();
}

let paintLoadToken = 0;

/** 让画布跟随参考图变化 */
function syncPaintImage() {
  const first = state.refImages[0];
  if (!first) {
    paint.img = null;
    paint.srcKey = '';
    paint.strokes = [];
    paint.cur = null;
    clearPaintCanvas();
    return;
  }
  if (first.dataUrl === paint.srcKey) return; // 同一张图，无需重建

  const token = ++paintLoadToken;
  const img = new Image();
  img.onload = () => {
    if (token !== paintLoadToken) return; // 加载期间又换了图，丢弃这次结果
    const k = Math.min(1, SIDE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    paint.w = clampSide(img.naturalWidth * k);
    paint.h = clampSide(img.naturalHeight * k);
    paint.img = img;
    paint.srcKey = first.dataUrl;
    paint.strokes = [];
    paint.cur = null;

    const c = $('#paintCanvas');
    c.width = paint.w;
    c.height = paint.h;
    $('#paintBase').src = first.dataUrl;
    $('#paintEmpty').style.display = 'none';

    // 线宽单位是像素，所以「8%」这种跟着画布走的默认值得在建画布时换算一次，
    // 否则大图上默认线会细得不像话（用户原本夸的是粗笔迹涂掩码省事）。
    // 只在用户没亲手调过的时候给默认值 —— 换张图就把他调好的 1px 冲掉是不可接受的。
    if (!paint.brushTouched) {
      const raw = Math.round(paint.w * BRUSH_DEFAULT_RATIO);
      // 算出来的值必须**吸附到滑块真能给出的档位**上。对数曲线取整后有些像素值
      // 根本没有对应档位（例如 51px，邻居只有 49 和 52），不吸附的话标签写 51、
      // 用户一动滑块就跳到 52，看着像「改了一下反而变大」。
      const step = brushStepFromPx(raw);
      paint.brushPx = brushPxFromStep(step);
      $('#brushSize').value = String(step);
    }

    // 生成尺寸自动对齐原图比例，否则重绘结果会被拉变形
    $('#customW').value = paint.w;
    $('#customH').value = paint.h;

    const srcRatio = img.naturalWidth / img.naturalHeight;
    const outRatio = paint.w / paint.h;
    if (Math.abs(srcRatio - outRatio) / srcRatio > 0.05) {
      toast(`原图 ${img.naturalWidth}×${img.naturalHeight} 比例过于特殊，已取整为 ${paint.w}×${paint.h}（接口要求 16 的倍数），可能有轻微形变`, 'err');
    }
    redrawPaint();
  };
  img.onerror = () => toast('原图解码失败，请换一张图片', 'err');
  img.src = first.dataUrl;
}

/* ---------- 画布交互 ---------- */

(function bindPaintCanvas() {
  const c = $('#paintCanvas');

  c.addEventListener('pointerdown', (e) => {
    if (!paintReady()) return;
    const p = paintPos(e);
    if (!p) return;
    e.preventDefault();
    try {
      c.setPointerCapture(e.pointerId);
    } catch (err) {}
    // 矩形框只记录起止两点，拖动过程中实时变形的几何由 a→b 推导；
    // 其余（画笔 / 橡皮 / 自由圈选）都记采样点，自由圈选在收笔时闭合成环
    const base = { tool: paint.tool, color: paint.color, size: paintBrushPx() };
    paint.cur = isDragShape({ tool: paint.tool })
      ? { ...base, a: p, b: p }
      : { ...base, pts: [p] };
    redrawPaint();
  });

  c.addEventListener('pointermove', (e) => {
    if (!paint.cur) return;
    const p = paintPos(e);
    if (!p) return;
    if (isDragShape(paint.cur)) {
      paint.cur.b = p;
      redrawPaint();
      return;
    }
    const last = paint.cur.pts[paint.cur.pts.length - 1];
    // 抽稀：位移不足 1px 的点不记录，避免笔画点数失控
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
    paint.cur.pts.push(p);
    redrawPaint();
  });

  const finish = (e) => {
    if (!paint.cur) return;
    const cur = paint.cur;
    paint.cur = null;
    try {
      c.releasePointerCapture(e.pointerId);
    } catch (err) {}
    // 标记太小时当作误触丢弃 —— 否则会在画面上留下一个几乎看不见的点，
    // 而导出图上那一小块颜色又会被模型当成一处真要改的区域。
    // 自由圈选额外要求至少 3 个采样点，否则连不成封闭区域。
    if (isRegionStroke(cur) && (strokeSpan(cur) < 6 || (cur.tool === 'lasso' && cur.pts.length < 3))) {
      redrawPaint();
      return;
    }
    paint.strokes.push(cur);
    redrawPaint();
  };
  c.addEventListener('pointerup', finish);
  c.addEventListener('pointercancel', finish);
})();

$$('#brushSeg .seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    $$('#brushSeg .seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const prev = paint.tool;
    paint.tool = b.dataset.tool;
    $('#paintCanvas').style.cursor = paint.tool === 'eraser' ? 'cell' : 'crosshair';

    // 从涂抹工具切到圈选工具、且当前还是白色时，自动换成第一个没用过的彩色。
    // 白色是「涂抹掩码」的颜色，模型把它读作"重画这里"；而圈选要靠颜色跟提示词
    // 对号入座，白线在浅色画面上既看不清、也说不清指的是哪一处。
    // 只在**换工具**这一刻动颜色：用同一个圈选工具连画几处时颜色保持不变 ——
    // 同色套多处（官方示例里的"两处绿色"）本来就是合法用法。
    if (isRegionStroke({ tool: paint.tool }) && !isRegionStroke({ tool: prev }) && paint.color === '#ffffff') {
      const used = new Set(markSummary().map((g) => g.hex));
      const next = MARK_COLORS.find((c) => c.hex !== '#ffffff' && !used.has(c.hex));
      if (next) {
        paint.color = next.hex;
        $('#markColor').value = next.hex;
        toast(`已切到圈选工具，标记颜色自动换成${next.name}（白色留给涂抹掩码，可在「标记颜色」里改回）`);
      }
    }
    syncMaskHint();
    redrawPaint();
  });
});

$('#brushSize').addEventListener('input', () => {
  paint.brushPx = brushPxFromStep($('#brushSize').value);
  paint.brushTouched = true;
  redrawPaint();
});

// 窗口尺寸变了，画布的显示尺寸跟着变、缩放比也就变了，重算一次最小可见宽度。
// 不然拉窄窗口后细线会显示得比 1px 还细，看上去像是标记丢了。
let paintResizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(paintResizeTimer);
  paintResizeTimer = setTimeout(redrawPaint, 120);
});

$('#markColor').addEventListener('change', () => {
  paint.color = $('#markColor').value;
  syncMaskHint();
  redrawPaint();
});

/** 把已画的颜色翻成一段指令骨架塞进提示词 —— 用户点的，不是自动的 */
$('#markTemplateBtn').addEventListener('click', () => {
  const skel = annotationSkeleton();
  if (!skel) return toast('先用「自由圈选」或「矩形框」套住要改的区域，再生成指令骨架', 'err');
  const ta = $('#prompt');
  const cur = ta.value.trim();
  // 已有内容就另起一行追加：直接覆盖会把用户写了一半的提示词吃掉
  ta.value = cur ? `${cur}\n${skel}` : skel;
  updatePromptLen();
  refreshAnnotationAdvice();
  ta.focus();
  toast('已插入指令骨架，请把 ___ 换成具体内容', 'ok');
});

$('#hideMask').addEventListener('change', () => {
  $('#paintCanvas').classList.toggle('is-hidden', $('#hideMask').checked);
});

$('#undoMaskBtn').addEventListener('click', () => {
  if (!paint.strokes.length) return;
  paint.strokes.pop();
  redrawPaint();
});

$('#clearMaskBtn').addEventListener('click', () => {
  if (!paint.strokes.length) return;
  paint.strokes = [];
  paint.cur = null;
  redrawPaint();
  toast('标记已清空');
});

$('#maskSubmit').addEventListener('change', () => {
  syncMaskHint();
  refreshAnnotationAdvice();
});

/**
 * 画笔卡的说明。这里其实有两种标注方式，官方分开举例，所以文案也分开讲 ——
 * 以前只讲了一种（把「圈选」说成"用圆圈标注"），结果把圈选读成了画圆。
 */
function syncMaskHint() {
  const painted = $('#maskSubmit').value === 'painted';
  const groups = markSummary();
  const parts = [];

  parts.push(
    painted
      ? '提交时把标记以<b>不透明色</b>压在原图上（单张图）。'
      : '提交 <b>原图 + 黑白掩码</b> 两张图，原图不被涂改；掩码里白色区域 = 重绘范围；实测会在输出中留下轻微亮色痕迹，在意成片干净度建议用「涂抹叠加」。'
  );
  parts.push(
    '<b>涂抹</b>（画笔）：在提示词里指明「白色标记区域」要补什么。'
  );
  parts.push(
    '<b>圈选</b>（自由圈选 / 矩形框）：按住拖拽，把要改的目标<b>套进一个封闭的圈</b>里 ——' +
      '<b>不必是圆形</b>，沿物体轮廓随手绕一圈就行。<b>一种颜色对应一条修改指令</b>：' +
      '在提示词里按颜色逐个说明改什么，<b>结尾要声明标注线不要渲染出来</b>，否则线会留在成片里。'
  );
  // 两条提交路径对颜色的处理完全不同，说反了就是白花钱
  parts.push(
    painted
      ? '圈选在「涂抹叠加」里画成<b>轮廓</b>（保留颜色，模型靠颜色分辨各处）；在「独立掩码」里会被自动<b>填实</b>，但<b>所有颜色都会变成白色</b>。'
      : '<b>⚠︎ 独立掩码把所有颜色抹成白色</b>，多种颜色在这里分不开 —— <b>多色圈选请改用「涂抹叠加」</b>。'
  );
  if (groups.length) {
    parts.push(
      `当前已圈 <b>${groups.length}</b> 种颜色：<b>${groups
        .map((g) => `${g.name}${g.count > 1 ? ` × ${g.count} 处` : ''}`)
        .join('、')}</b>，可按「生成指令骨架」一键写进提示词。`
    );
  }
  $('#maskHint').innerHTML = parts.join(' ');
}
syncMaskHint();

/* ================= 参数控件 ================= */

// ModelScope 实测：宽高必须各自落在 [64, 2048] 区间内（单边上限，非总像素上限）
// 超出会返回 "height/width must be integer in [64,2048]"
const SIDE_MIN = 64;
const SIDE_MAX = 2048;
// 一次最多生成几张。**必须与服务端 JOB_MAX_COUNT 保持一致** ——
// 服务端会再夹一次，这里只是为了别让用户选到一个注定被砍的值。
const GEN_MAX_COUNT = 4;

// 采样参数的接口边界（都是实测出来的，与服务端常量一一对应）。
// 越界不是被忽略，而是接口直接 400，所以两端都要夹。
const API_STEPS_MIN = 1;
const API_STEPS_MAX = 50; // 滑块原本放到 100，>50 必定被拒
const API_GUIDANCE_MIN = 1.0;
const API_GUIDANCE_MAX = 20.0;
const API_SEED_MIN = -1; // -1 = 随机
const API_SEED_MAX = 2147483647;

const SIZES = [
  { label: '1:1 方图 1024×1024', w: 1024, h: 1024 },
  { label: '2:3 竖版 1024×1536', w: 1024, h: 1536 },
  { label: '3:2 横版 1536×1024', w: 1536, h: 1024 },
  { label: '16:9 宽屏 1536×864', w: 1536, h: 864 },
  { label: '9:16 手机 864×1536', w: 864, h: 1536 },
  // 2K 档：受单边 2048 限制，长边取满 2048
  { label: '2K 1:1 2048×2048', w: 2048, h: 2048 },
  { label: '2K 2:3 竖版 1360×2048', w: 1360, h: 2048 },
  { label: '2K 3:2 横版 2048×1360', w: 2048, h: 1360 },
  { label: '2K 16:9 2048×1152', w: 2048, h: 1152 },
  { label: '2K 9:16 手机 1152×2048', w: 1152, h: 2048 },
];

(function initSizes() {
  const sel = $('#sizePreset');
  SIZES.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = s.label;
    sel.appendChild(o);
  });
  sel.value = '0';
})();

function bindSlider(id, valId, digits = 0) {
  const el = $(id);
  const out = $(valId);
  const sync = () => {
    out.textContent = digits ? Number(el.value).toFixed(digits) : el.value;
  };
  el.addEventListener('input', sync);
  sync();
}

bindSlider('#steps', '#stepsVal');
bindSlider('#guidance', '#guidanceVal', 1);

function updatePromptLen() {
  const n = $('#prompt').value.length;
  const el = $('#promptLen');
  el.textContent = `${n} / ${PROMPT_MAX}`;
  if (n > PROMPT_MAX) {
    el.style.color = 'var(--danger)';
    el.textContent = `${n} / ${PROMPT_MAX} · 超出上限，将被接口拒绝`;
  } else if (n > PROMPT_WARN) {
    el.style.color = '#d29922';
    el.textContent = `${n} / ${PROMPT_MAX} · 逼近上限`;
  } else {
    el.style.color = '';
  }
}

$('#prompt').addEventListener('input', () => {
  updatePromptLen();
  refreshAnnotationAdvice();
});

$('#resetBtn').addEventListener('click', () => {
  $('#prompt').value = '';
  $('#negativePrompt').value = '';
  $('#seed').value = '';
  $('#customW').value = '';
  $('#customH').value = '';
  $('#steps').value = 30;
  $('#guidance').value = 4;
  $('#sizePreset').value = '0';
  $('#outputFormat').value = 'RGB';
  $('#promptLen').textContent = `0 / ${PROMPT_MAX}`;
  $('#promptLen').style.color = '';
  bindSlider('#steps', '#stepsVal');
  bindSlider('#guidance', '#guidanceVal', 1);
  loraRows = [];
  renderLoraRows();
  toast('参数已重置');
});

/* ================= LoRA 适配器 =================

   接口参数名 `loras`，形如 {"<仓库 id>": 权重}。

   它**真实生效**，不是摆设 —— 2026-09-25 实测：同一 prompt / size / steps / seed，
   唯一变量是 loras，出图逐字节不同（301,292 B vs 314,148 B，sha256 不同）。
   校验发生在服务端「下载该 LoRA」这一步，所以 id 写错不是"悄悄不用它"，
   而是整个请求失败（`apiInferModelDownload call failed ... 模型不存在`）。
   因此这里宁可先拦住，也不要让用户提交后拿到一句看不懂的报错。

   关于「点一下就载入魔搭的 LoRA 列表」：做不了，且已实测确认。
   魔搭的公开接口 /openapi/v1/models 存在，但**所有查询参数都被忽略**
   （Name / Keyword / Query / Search / 分页 / 排序，九种写法返回同一份固定列表，
   total_count 是整站量），站内搜索接口 /api/v1/muse/models 需要登录态（401）。
   所以改为两件离线就能做、且正好贴合手工流程的事：
   ① 粘贴社区页面链接 → 自动解析出 id（原来要精确选到 id 再复制）；
   ② 记住用过的 id，「最近用过」里点一下就填。 */

const LORA_MAX = 6;
const LORA_SUM_TOL = 0.01;
const LORA_RECENT_KEY = 'qwen.lora.recent';
const LORA_ID_RE = /^[\w.\-]+\/[\w.\-]+$/;

let loraRows = []; // [{ id, weight }]

/** 从「整条社区链接」或「裸 id」里取出 org/name */
function parseLoraId(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/[^/]+\//i, ''); // 去掉协议与域名
  s = s.replace(/^models\//i, ''); // 去掉 /models/ 前缀
  s = s.split(/[?#]/)[0];
  const parts = s.split('/').filter(Boolean);
  if (parts.length >= 2) return parts[0] + '/' + parts[1];
  return '';
}

function loraRecent() {
  try {
    const a = JSON.parse(localStorage.getItem(LORA_RECENT_KEY) || '[]');
    return Array.isArray(a)
      ? a.filter((x) => typeof x === 'string' && LORA_ID_RE.test(x)).slice(0, 8)
      : [];
  } catch (e) {
    return [];
  }
}

function rememberLora(id) {
  if (!LORA_ID_RE.test(id)) return;
  const next = [id].concat(loraRecent().filter((x) => x !== id)).slice(0, 8);
  try {
    localStorage.setItem(LORA_RECENT_KEY, JSON.stringify(next));
  } catch (e) {}
  renderLoraRecent();
}

function renderLoraRecent() {
  const box = $('#loraRecent');
  box.innerHTML = '';
  const list = loraRecent();
  if (!list.length) return;
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = '最近用过：';
  box.appendChild(label);
  list.forEach((id) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lora-chip';
    b.textContent = id;
    b.title = '填入 ' + id;
    b.addEventListener('click', () => {
      if (loraRows.some((r) => r.id === id)) return toast('这个 LoRA 已经在列表里了', 'err');
      addLoraRow(id);
    });
    box.appendChild(b);
  });
}

function loraSum() {
  return loraRows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
}

function updateLoraSum() {
  const el = $('#loraSum');
  if (!loraRows.length) {
    el.textContent = '';
    el.className = 'hint';
    return;
  }
  const sum = loraSum();
  const ok = Math.abs(sum - 1) <= LORA_SUM_TOL;
  const filled = loraRows.every((r) => String(r.id || '').trim() !== '');
  el.textContent =
    loraRows.length + '/' + LORA_MAX + ' 个 · 权重和 ' + sum.toFixed(2) + (ok ? ' ✓' : ' ≠ 1.0');
  el.className = 'hint ' + (ok && filled ? 'lora-sum-ok' : 'lora-sum-bad');
}

function renderLoraRows() {
  const box = $('#loraList');
  box.innerHTML = '';
  if (!loraRows.length) {
    const d = document.createElement('div');
    d.className = 'lora-empty';
    d.textContent = '未使用 LoRA。需要时点下方「添加 LoRA」，或从「最近用过」里选一个。';
    box.appendChild(d);
  }
  loraRows.forEach((row, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'lora-row';

    const id = document.createElement('input');
    id.type = 'text';
    id.placeholder = 'org/name，或直接粘贴魔搭社区链接';
    id.value = row.id;
    id.addEventListener('input', () => {
      row.id = id.value;
      updateLoraSum();
    });
    // 失焦时把链接收敛成 id —— 用户常常整条 URL 复制过来
    id.addEventListener('blur', () => {
      const parsed = parseLoraId(id.value);
      if (parsed && parsed !== id.value.trim()) {
        id.value = parsed;
        row.id = parsed;
      }
      updateLoraSum();
    });

    const w = document.createElement('input');
    w.type = 'number';
    w.min = '0';
    w.max = '1';
    w.step = '0.05';
    w.value = String(row.weight);
    w.title = '权重（全部 LoRA 之和必须为 1.0）';
    w.addEventListener('input', () => {
      row.weight = Number(w.value);
      updateLoraSum();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-sm lora-del';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      loraRows.splice(i, 1);
      renderLoraRows();
    });

    wrap.appendChild(id);
    wrap.appendChild(w);
    wrap.appendChild(del);
    box.appendChild(wrap);
  });
  $('#loraAdd').disabled = loraRows.length >= LORA_MAX;
  updateLoraSum();
}

function addLoraRow(prefill) {
  if (loraRows.length >= LORA_MAX) return toast('最多 ' + LORA_MAX + ' 个 LoRA', 'err');
  // 第一个默认 1.0；之后按剩余额度补，让"和 = 1.0"尽量一开始就成立
  const used = loraSum();
  const weight = loraRows.length === 0 ? 1 : Math.max(0, Number((1 - used).toFixed(2)));
  loraRows.push({ id: prefill || '', weight });
  renderLoraRows();
  if (!prefill) {
    const inputs = $$('#loraList .lora-row input[type="text"]');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  }
}

/** 提交前的本地校验：与服务端同一套规则，先拦下来给句人话 */
function collectLoras() {
  const rows = loraRows.filter((r) => String(r.id || '').trim() !== '');
  if (!rows.length) return { ok: true, value: null };

  const out = {};
  let sum = 0;
  for (const r of rows) {
    const id = parseLoraId(r.id) || String(r.id).trim();
    if (!LORA_ID_RE.test(id)) {
      return { ok: false, error: 'LoRA 标识「' + r.id + '」不是合法的仓库 id（形如 org/name）' };
    }
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      return { ok: false, error: 'LoRA「' + id + '」重复填写' };
    }
    const w = Number(r.weight);
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      return { ok: false, error: 'LoRA「' + id + '」的权重需要在 0 ~ 1 之间' };
    }
    out[id] = w;
    sum += w;
  }
  if (Math.abs(sum - 1) > LORA_SUM_TOL) {
    return { ok: false, error: 'LoRA 权重之和为 ' + sum.toFixed(2) + '，接口要求必须等于 1.0' };
  }
  return { ok: true, value: out };
}

$('#loraAdd').addEventListener('click', () => addLoraRow());
renderLoraRows();
renderLoraRecent();

$('#toChatBtn').addEventListener('click', async () => {
  gotoView('chat');
  let conv = activeConv();
  if (!conv) conv = await newConversation('t2i', { silent: true });
  if (!conv) return;

  if (!state.refImages.length) {
    toast('创作台还没有参考图：可直接在锁定图区上传，或先回创作台上传', 'ok');
    return;
  }

  const n = Math.min(state.refImages.length, CONV_MAX_IMAGES);
  const cur = state.convImages.length;

  // 无论对话里有没有图都先问一句：锁定的图会真正发给模型，
  // 不该由「跳转」这个动作悄悄替你决定这个对话用哪些图。
  const msg = cur
    ? `要把创作台的 ${n} 张图片带入本对话吗？\n\n` +
      `本对话当前已锁定 ${cur} 张，带入后将替换它们。\n` +
      `创作台的图片本身不受影响，随时可以再带一次。`
    : `要把创作台的 ${n} 张图片带入本对话吗？\n\n` +
      `带入后改写时会把它们交给模型「看」—— 编辑类提示词需要这一步。\n` +
      `选「取消」则本对话暂不绑定图片，之后可在锁定图区手动添加。`;

  if (!confirm(msg)) {
    toast('未带入图片，可在锁定图区随时添加', 'ok');
    return;
  }
  await lockFromStudio();
});

/* ================= 生成流程 ================= */

/** 把尺寸夹到合法区间，并返回是否发生了调整 */
function clampSide(v) {
  const n = Math.round(Number(v) / 16) * 16;
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, n));
}

function getParams() {
  const preset = SIZES[Number($('#sizePreset').value) || 0];
  let w = Number($('#customW').value) || preset.w;
  let h = Number($('#customH').value) || preset.h;

  // Qwen-Image-2.1 要求尺寸为 16 的倍数，且单边必须落在 [64, 2048]
  const rawW = w;
  const rawH = h;
  w = clampSide(w);
  h = clampSide(h);

  const seedRaw = $('#seed').value.trim();
  // 步数与引导系数的合法区间由接口决定，这里先夹一次，避免发出去被 400。
  // （字段名也是坑：接口认 `steps` / `guidance`，不认 num_inference_steps / guidance_scale。）
  const steps = Math.max(API_STEPS_MIN, Math.min(API_STEPS_MAX, Number($('#steps').value) || 0));
  const guidance = Math.max(
    API_GUIDANCE_MIN,
    Math.min(API_GUIDANCE_MAX, Number($('#guidance').value) || 0)
  );
  return {
    mode: state.mode,
    prompt: $('#prompt').value.trim(),
    negativePrompt: $('#negativePrompt').value.trim(),
    width: w,
    height: h,
    clamped: rawW !== w || rawH !== h,
    rawWidth: rawW,
    rawHeight: rawH,
    steps,
    guidance,
    seed: seedRaw === '' ? null : Number(seedRaw),
    // 语义开关：接口没有输出格式参数，模型恒定输出 RGBA 容器，
    // 画面是否透明只能靠提示词，服务端会按官方句式补齐。
    transparent: $('#outputFormat').value === 'RGBA',
    // 一次生成几张。接口没有批量参数，服务端会拆成 N 个独立任务（各自计费）。
    count: Math.max(1, Math.min(GEN_MAX_COUNT, Number($('#countPreset').value) || 1)),
    // 是否落盘 —— 现在落盘在服务端后台完成，前端不再逐张调 /api/save
    autoSave: $('#autoSave').checked,
    // 参考图文件名，服务端写历史时要记
    sourceImages: state.refImages.map((x) => x.name),
    images: state.mode === 'inpaint' ? buildInpaintImages() : state.refImages.map((x) => x.dataUrl),
  };
}

/**
 * 局部重绘的提交图。
 *   painted  — 单张：标记压在原图上的合成图
 *   separate — 两张：原图 + 黑白掩码（尺寸一致，避免掩码错位）
 * 统一用 PNG，避免 JPEG 噪点污染掩码边缘。
 */
function buildInpaintImages() {
  if (!paintReady() || !paint.strokes.length) return [];
  if ($('#maskSubmit').value === 'separate') {
    return [buildBaseCanvas().toDataURL('image/png'), buildMaskCanvas().toDataURL('image/png')];
  }
  return [buildPaintedCanvas().toDataURL('image/png')];
}

function setProgress(text, show = true) {
  $('#progress').classList.toggle('show', show);
  $('#progressText').textContent = text;
}

function setBusy(b) {
  state.generating = b;
  $('#generateBtn').disabled = b;
  $('#generateBtn').textContent = b ? '生成中…' : '开始生成';
}

$('#generateBtn').addEventListener('click', async () => {
  const p = getParams();
  if (!p.prompt) return toast('请先填写提示词', 'err');
  if (!state.hasApiKey) {
    toast('尚未配置 API Key，正在跳转个人信息页', 'err');
    return gotoView('profile');
  }
  if (p.mode === 'inpaint') {
    if (!paintReady()) return toast('局部重绘需要先上传 1 张原图', 'err');
    if (!paint.strokes.length) return toast('请先在图上涂抹或圈选出要重绘的区域', 'err');
    const groups = markSummary();
    const submitMode = $('#maskSubmit').value;
    // 「独立掩码」提交的是 [原图, 黑白掩码] —— 颜色在这条路上根本到不了模型。
    // 画了好几种颜色却走这条路，等于把「一处一改」的意图整段抹平：钱照样扣，
    // 结果却对不上。这一种组合是**表达不出来的**，所以直接拦下（改一个下拉即可继续），
    // 其余情况只提醒不拦 —— 提示词怎么写是用户的自由。
    if (submitMode === 'separate' && groups.length > 1) {
      return toast(
        `已用 ${groups.length} 种颜色圈出不同区域，但「独立掩码」会把它们全部抹成白色，` +
          '模型分不出哪一处要改什么 —— 请把提交方式改成「涂抹叠加」再生成',
        'err'
      );
    }
    for (const t of annotationAdvisories(p.prompt, submitMode)) toast(t, 'err');
  }
  // LoRA：id 写错会让接口在下载模型那步直接失败，所以先按同一套规则拦一次
  const lora = collectLoras();
  if (!lora.ok) return toast(lora.error, 'err');
  p.loras = lora.value;
  if (p.mode !== 't2i' && p.images.length === 0) {
    return toast('该模式需要至少上传 1 张图片', 'err');
  }
  if (p.prompt.length > PROMPT_MAX) {
    return toast(`提示词 ${p.prompt.length} 字符，超出上限 ${PROMPT_MAX}，请精简后再生成`, 'err');
  }
  // 种子越界接口会直接 400（"seed must be in [-1, 2147483647]"），先拦下来给句人话
  if (p.seed !== null && (p.seed < API_SEED_MIN || p.seed > API_SEED_MAX || !Number.isFinite(p.seed))) {
    return toast(`随机种子需在 ${API_SEED_MIN} ~ ${API_SEED_MAX} 之间（-1 或留空 = 随机）`, 'err');
  }
  if (p.clamped) {
    toast(
      `尺寸 ${p.rawWidth}×${p.rawHeight} 超出单边上限 ${SIDE_MAX}，已自动调整为 ${p.width}×${p.height}`,
      'err'
    );
  }

  setBusy(true);
  $('#resultArea').innerHTML = '';
  $('#resultEmpty').style.display = 'block';
  $('#resultEmpty').textContent = '正在提交任务…';
  setProgress('正在提交任务到 ModelScope…');

  try {
    const sub = await api('/api/generate', { method: 'POST', body: JSON.stringify(p) });
    if (!sub.ok) {
      // 409 = 已有作业在跑。与其干瞪一句报错，不如直接把那个作业接到结果区来
      if (sub.jobId) {
        state.attachLock = '';
        state.attachedJobId = sub.jobId;
        await pollJobs();
      }
      throw new Error(sub.error || '任务提交失败');
    }

    // 服务端会回传「实际发出去的参数」与调整说明。接口对越界参数是硬报错、
    // 对未知参数是静默忽略，用户本来无从察觉，所以这里如实说出来。
    if (sub.note) toast(sub.note, 'err');
    // 提交成功后把这一批 LoRA 记进「最近用过」，下次点一下就填
    if (p.loras) Object.keys(p.loras).forEach(rememberLora);

    // 提交请求本身已经结束 → 立刻解锁按钮。
    // 任务是在**服务端**跑的，没理由让按钮一直显示"生成中…"——那正是
    // "前一个任务不结束就没法提交下一个"的来源（现在是允许多批并行的）。
    setBusy(false);

    // 新作业：解除"手工钉住"，让结果区跟它走
    state.attachLock = '';
    state.attachedJobId = sub.jobId;
    setProgress(`已提交 ${sub.count || 1} 个任务，后台生成中…`);
    await pollJobs(); // 立刻拉一次，不必等下一个轮询周期
  } catch (e) {
    setProgress('', false);
    setBusy(false);
    if (!state.activeJobId) {
      $('#resultEmpty').style.display = 'block';
      $('#resultEmpty').textContent = `提交失败：${e.message || '未知错误'}`;
    }
    toast(e.message || '提交失败', 'err');
  }
});

/* ================= 作业观察：一次多张 + 服务端后台推进 =================

   任务的推进权已经搬到服务端（服务端自己轮询、自己落盘），前端只做**观察**：
   · 结果区   —— 跟随"当前关注的作业"，逐张出现，未完成的显示占位
   · 右栏列表 —— 所有作业的进度，一眼看清哪批排在第几张

   所以这里没有任何"下载图片"的代码：浏览器只负责问状态、显示结果。 */

const JOB_BADGE = { running: '进行中', done: '已完成', partial: '部分失败', failed: '失败', cancelled: '已取消' };

/** 相对时间：刚刚 / 12 分钟前 / 14:32 */
function fmtWhen(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  const dt = new Date(ts);
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

/** 一张图的地址：已保存走本地 /outputs；文件已被删除的返回空，交给占位渲染 */
function jobSrc(it) {
  if (it.missing) return '';
  if (it.file) return `/outputs/${it.file}`;
  return it.url || '';
}

/**
 * 种子的显示。`-1` 表示"没指定，交给接口随机" ——
 * 直接显示 -1 会让人以为"好几张共用了同一个种子"（实际含义正好相反），所以一律写"随机"。
 */
function fmtSeed(v) {
  if (v === null || v === undefined || v === '') return '随机';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? String(n) : '随机';
}

/* ================= 批内相似度自检 =================

   用户报过「一次出 4 张，结果几乎一样」。但"看起来像"和"真出了同一张图"是两码事，
   光靠肉眼分不出来 —— 所以这里**量一下**：把本批已落盘的图按 dHash（差值哈希）两两比，
   距离 0 才是完全同一张。作业卡会直接写出结论，不用再猜。

   标尺（2026-09-29 用本机 40 张真实历史图实测，dHash 64 位）：
     · 同 seed、同参数重跑        → 0        （接口确实认 seed）
     · 同提示词、不同次生成        → 15 ~ 17  （构图相近，但确实不是同一张）
     · 不同提示词的随机对照 3907 对 → 中位 31
   所以 ≤ 4 判为"几乎同一张"，否则只报告"最像的两张差多少"。 */

const DHASH_N = 8; // 8x8 → 64 位
const DHASH_SAME = 4; // ≤ 4/64 视为同一张
const dhashCache = new Map(); // src -> Promise<string|null>

function dhashOf(img) {
  const c = document.createElement('canvas');
  c.width = DHASH_N + 1;
  c.height = DHASH_N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  let px;
  try {
    px = ctx.getImageData(0, 0, c.width, c.height).data;
  } catch (e) {
    return null; // 取不到像素（画布被污染等）—— 静默放弃，绝不因此打断界面
  }
  const gray = [];
  for (let i = 0; i < px.length; i += 4) {
    gray.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
  }
  let bits = '';
  for (let r = 0; r < DHASH_N; r++) {
    for (let col = 0; col < DHASH_N; col++) {
      const a = gray[r * (DHASH_N + 1) + col];
      const b = gray[r * (DHASH_N + 1) + col + 1];
      bits += a > b ? '1' : '0';
    }
  }
  return bits;
}

function dhashFor(src) {
  if (dhashCache.has(src)) return dhashCache.get(src);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(dhashOf(img));
    img.onerror = () => resolve(null);
    img.src = src;
  });
  dhashCache.set(src, p);
  return p;
}

function hamDist(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** 两两比一遍，返回最像的一对（含距离） */
async function batchSimilarity(job) {
  const ok = job.items.filter((i) => i.status === 'succeeded' && i.file).slice(0, 8);
  if (ok.length < 2) return null;
  const hashes = await Promise.all(ok.map((i) => dhashFor(jobSrc(i))));
  let best = null;
  for (let a = 0; a < hashes.length; a++) {
    for (let b = a + 1; b < hashes.length; b++) {
      const d = hamDist(hashes[a], hashes[b]);
      if (d === null) continue;
      if (!best || d < best.d) best = { d, a: ok[a].index, b: ok[b].index };
    }
  }
  return best;
}

/** 结果区占位（生成中 / 失败）—— 空着会让用户以为"没反应" */
function renderPh(text, kind) {
  const div = document.createElement('div');
  div.className = 'result-item result-ph' + (kind ? ' ' + kind : '');
  const span = document.createElement('span');
  span.textContent = text;
  div.appendChild(span);
  $('#resultArea').appendChild(div);
}

/** 把某个作业渲染进"本次生成结果"区（含未完成占位） */
function renderJobResults(job) {
  const area = $('#resultArea');
  if (!area || !job) return;
  area.innerHTML = '';
  const items = [...job.items].sort((a, b) => a.index - b.index);
  for (const it of items) {
    const src = jobSrc(it);
    if (it.status === 'succeeded' && src) {
      // 查看器/结果卡片要认 width/height 这些字段，组装一份最简 meta
      const as = {
        file: it.file || null,
        width: it.width ?? job.params.width ?? null,
        height: it.height ?? job.params.height ?? null,
        size: it.bytes ?? null,
        createdAt: job.createdAt,
        mode: job.params.mode,
        steps: job.params.steps,
        guidance: job.params.guidance,
        seed: it.seed,
      };
      if (it.file) {
        renderResult(it.file, as, it.file);
      } else {
        state.previewUrl2Item.set(src, { temp: true });
        renderResult(src, { temp: true }, '未保存 · 临时预览');
      }
    } else if (it.missing) {
      renderPh(`第 ${it.index + 1} 张已被删除（记录仍在历史里）`);
    } else if (it.status === 'failed') {
      renderPh(`第 ${it.index + 1} 张失败：${it.error || '未知错误'}`, 'err');
    } else if (it.status === 'cancelled') {
      renderPh(`第 ${it.index + 1} 张已停止跟踪`);
    } else {
      renderPh(`第 ${it.index + 1} 张生成中…`);
    }
  }
  $('#resultEmpty').style.display = items.length ? 'none' : 'block';
}

/** 结果区跟随某个作业。（无 job 对象时先记 id，等下一次轮询数据到了再渲染） */
function attachJob(id) {
  state.attachedJobId = id || '';
  const job = (state.jobs || []).find((j) => j.id === state.attachedJobId);
  if (job) renderJobResults(job);
}

async function cancelJob(id) {
  if (!confirm('停止跟踪这个任务？\n\n注意：已经在 ModelScope 上排队或执行的任务无法取消，额度不会退回。')) return;
  const r = await api('/api/job/cancel', { method: 'POST', body: JSON.stringify({ id }) });
  if (!r.ok) return toast(r.error || '取消失败', 'err');
  toast('已停止跟踪该任务');
  pollJobs();
}

/** 右栏的一张作业卡 */
function jobCardEl(job) {
  const el = document.createElement('div');
  el.className = 'job-item clickable' + (job.status === 'running' ? ' active' : '');

  const total = job.items.length;
  const done = job.items.filter((i) => i.status === 'succeeded').length;
  const failed = job.items.filter((i) => i.status === 'failed').length;
  const pct = total ? Math.round(((done + failed) / total) * 100) : 0;

  const top = document.createElement('div');
  top.className = 'job-top';
  top.innerHTML =
    `<span class="job-badge ${job.status === 'running' ? 'run' : job.status}">${
      JOB_BADGE[job.status] || job.status
    }</span>` +
    `<span class="job-count">${done}/${total} 张</span>` +
    `<span class="job-when">${fmtWhen(job.createdAt)}</span>`;
  el.appendChild(top);

  const pr = document.createElement('div');
  pr.className = 'job-prompt';
  pr.textContent = job.params.prompt || '（无提示词）';
  el.appendChild(pr);

  const bar = document.createElement('div');
  bar.className = 'job-progress';
  bar.innerHTML = `<i style="width:${pct}%"></i>`;
  el.appendChild(bar);

  const thumbs = document.createElement('div');
  thumbs.className = 'job-thumbs';
  for (const it of [...job.items].sort((a, b) => a.index - b.index)) {
    const src = jobSrc(it);
    const t = document.createElement('div');
    if (it.status === 'succeeded' && src) {
      t.className = 'job-thumb';
      t.title = `第 ${it.index + 1} 张 · seed ${fmtSeed(it.seed)} · 点击放大`;
      t.dataset.src = src;
      const img = document.createElement('img');
      img.src = src;
      img.loading = 'lazy';
      img.alt = '';
      t.appendChild(img);
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        openViewer(src, it.file || `第 ${it.index + 1} 张`, null);
      });
    } else {
      // 这里要区分四种"没有图"的原因，否则被删掉的文件会显示成"生成中"，永远转下去
      const label = it.missing
        ? '已删除'
        : it.status === 'failed'
          ? '失败'
          : it.status === 'cancelled'
            ? '已停止'
            : '生成中';
      t.className = 'job-thumb' + (it.status === 'failed' ? ' failed' : '');
      t.title = it.error || (it.missing ? '这张图已被删除（历史记录仍在）' : label);
      const mini = document.createElement('span');
      mini.className = 'mini';
      mini.textContent = label;
      t.appendChild(mini);
    }
    thumbs.appendChild(t);
  }
  el.appendChild(thumbs);

  // 一次多张时量化"最像的两张有多像"：用户真正想知道的是「是不是出了同一张」，
  // 这件事必须用数字回答，肉眼"看着像"没有说服力。
  if (job.count > 1 && job.status !== 'running') {
    const sim = document.createElement('div');
    sim.className = 'job-sim';
    sim.textContent = '正在比对本批出图…';
    el.appendChild(sim);
    batchSimilarity(job).then((r) => {
      if (!el.isConnected) return; // 卡片已被重渲染掉，别再改它
      if (!r) {
        sim.remove();
        return;
      }
      const pair = `第 ${r.a + 1}、${r.b + 1} 张`;
      if (r.d <= DHASH_SAME) {
        sim.className = 'job-sim job-sim-bad';
        sim.textContent = `⚠️ ${pair}几乎完全相同（相似度 ${r.d}/64）——只有这种情况才需要重跑`;
      } else {
        sim.textContent = `本批最像的是${pair}（相似度 ${r.d}/64，越小越像；不同提示词通常约 31）`;
      }
    });
  }

  const acts = document.createElement('div');
  acts.className = 'job-actions';
  const info = document.createElement('span');
  info.className = 'job-info';
  info.textContent = failed ? `${done} 张成功 · ${failed} 张失败` : `${done}/${total} 张已完成`;
  acts.appendChild(info);
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost btn-sm';
  if (job.status === 'running') {
    btn.textContent = '停止跟踪';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelJob(job.id);
    });
  } else {
    btn.textContent = '查看结果';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.attachLock = job.id;
      attachJob(job.id);
      gotoView('studio');
    });
  }
  acts.appendChild(btn);
  el.appendChild(acts);

  if (job.error) {
    const err = document.createElement('div');
    err.className = 'job-err';
    err.textContent = job.error;
    el.appendChild(err);
  }

  // 点卡片本身 = 结果区切到这个作业（并钉住，避免轮询又切回进行中的那批）
  el.addEventListener('click', () => {
    state.attachLock = job.id;
    attachJob(job.id);
  });
  return el;
}

function renderJobs() {
  const box = $('#jobsList');
  if (!box) return;
  const jobs = state.jobs || [];
  const running = jobs.filter((j) => j.status === 'running').length;
  $('#jobsMeta').textContent = jobs.length ? (running ? `${running} 进行中` : `${jobs.length} 条`) : '';
  box.innerHTML = '';
  if (!jobs.length) {
    const empty = document.createElement('div');
    empty.className = 'jobs-empty';
    empty.innerHTML = '还没有生成任务<br />提交后会在这里看到每张的进度';
    box.appendChild(empty);
    return;
  }
  for (const job of jobs) box.appendChild(jobCardEl(job));
}

/**
 * 进度条、结果区跟随，以及每个作业各自播报一次收尾。
 *
 * 允许**多批并行**之后，这里不能再拿"有没有作业在跑"一刀切：
 * · 生成按钮**不因后台有任务而禁用** —— 禁用就是"上一批不跑完不能提交下一批"
 * · 结果区跟随最新一批（列表按时间倒序），用户手工钉住别的批次时不抢
 * · 收尾播报按作业去重：一批结束了就播一次，别的批次还在跑也照播
 */
function syncJobUi() {
  const jobs = state.jobs || [];
  const running = jobs.filter((j) => j.status === 'running');

  // 首次拿到列表时，把已经存在的作业都视为"已播报" ——
  // 否则刷新页面会把历史里所有作业齐刷刷弹一遍 toast。
  if (!state.jobsSeen) state.jobsSeen = new Set(jobs.map((j) => j.id));

  for (const job of jobs) {
    if (job.status === 'running' || state.jobsSeen.has(job.id)) continue;
    state.jobsSeen.add(job.id);
    announceJob(job);
  }

  if (running.length) {
    const active = running[0];
    state.activeJobId = active.id;
    const total = active.items.length;
    const done = active.items.filter((i) => i.status === 'succeeded').length;
    const failed = active.items.filter((i) => i.status === 'failed').length;
    const more = running.length > 1 ? `（另有 ${running.length - 1} 批并行）` : '';
    setProgress(`后台生成中… ${done + failed}/${total} 已结束 · 成功 ${done}${more}`);
    // 结果区自动跟随它，除非用户手动钉住了别的作业
    if (!state.attachLock) attachJob(active.id);
    return;
  }

  // 全部跑完了：把进度条收掉（只在"有→无"那一次动，不必每轮都清）
  if (state.activeJobId) {
    state.activeJobId = '';
    setProgress('', false);
  }
}

/** 一个作业收尾了：给一句人话汇总，并把结果区切过去 */
function announceJob(job) {
  const done = job.items.filter((i) => i.status === 'succeeded').length;
  const failed = job.items.filter((i) => i.status === 'failed').length;
  if (job.status === 'cancelled') toast('已停止跟踪该任务');
  else if (failed === 0) toast(`生成完成：${done}/${job.items.length} 张`, 'ok');
  else if (done) toast(`完成 ${done} 张 · 失败 ${failed} 张`, 'err');
  else toast(`全部失败：${(job.items.find((i) => i.error) || {}).error || '未知错误'}`, 'err');
  if (!state.attachLock) renderJobResults(job);
  if ($('#view-history').classList.contains('active')) loadHistory();
}

/** 拉一次作业列表。页面不可见时跳过 —— 反正任务在服务端跑，回来再看即可。 */
async function pollJobs() {
  if (document.hidden) return;
  try {
    const r = await api('/api/jobs');
    if (!r || !r.ok) return;
    state.jobs = r.jobs || [];
    renderJobs();
    syncJobUi();
  } catch (e) {
    /* 网络抖动忽略，下一轮再来 */
  }
}

function renderResult(src, item, capText) {
  const div = document.createElement('div');
  div.className = 'result-item';
  const isTemp = item.temp;
  div.innerHTML = `
    <img src="${isTemp ? src : `/outputs/${src}`}" alt="" loading="lazy" />
    <div class="cap">
      <span>${capText}</span>
      <span>${item.width ? `${item.width}×${item.height}` : ''}</span>
    </div>`;
  div.addEventListener('click', () =>
    openViewer(isTemp ? src : `/outputs/${src}`, capText, item)
  );
  $('#resultArea').appendChild(div);
}

/* ================= 图片查看器（点击外部关闭） ================= */

function openViewer(src, name, item) {
  $('#viewerImg').src = src;
  const meta = item && !item.temp ? item : null;
  $('#viewerInfo').innerHTML = meta
    ? `<span>${name} · ${fmtBytes(meta.size)} · ${fmtTime(meta.createdAt)}</span>
       <span>${MODE_LABEL[meta.mode] || meta.mode} · ${meta.width}×${meta.height} · steps ${
        meta.steps ?? '—'
      } · cfg ${meta.guidance ?? '—'} · seed ${fmtSeed(meta.seed)}</span>`
    : `<span>${name || '预览'}</span><span>点击图片以外区域关闭</span>`;
  $('#viewer').classList.add('show');
}

function closeViewer() {
  $('#viewer').classList.remove('show');
  $('#viewerImg').src = '';
}

// 点击遮罩关闭，点击图片框本身不关闭
$('#viewer').addEventListener('click', (e) => {
  if (!e.target.closest('#viewerFrame')) closeViewer();
});
$('#viewerClose').addEventListener('click', closeViewer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeViewer();
});

/* ================= 提示词对话（多会话 + 显式指定规范类型） =================

   设计要点：

   1. 类型 kind 由用户在每个对话里显式选择，并存进对话本身，**绝不从创作台模式推断**。
      旧实现是 `state.mode === 't2i' ? 't2i' : 'edit'`：在图生图 / 图像编辑 / 局部重绘
      模式下聊文生图提示词，会被套上编辑规范去改写，产出与预期完全对不上号。

   2. 每条消息也带 kind。构造多轮上下文时只取与当前类型一致的消息，
      所以中途切换类型不会让两份规范的产物互相污染。

   3. 对话持久化在 data/conversations.json，刷新与重启都不丢，可新建 / 重命名 / 删除。

   界面右侧展示的规范信息全部来自 /api/rules 返回的真实文件指纹与大纲，
   不再使用任何手写摘要 —— 手写摘要会与官方规范漂移（本项目就踩过这个坑）。 */

const KIND_LABEL = { t2i: '文生图', edit: '编辑图片' };
const KIND_RULE = { t2i: 'Image Prompt Rewriting', edit: 'Edit Prompt Enhancer' };
const KIND_RULE_FILE = { t2i: 'official_t2i.md', edit: 'official_edit.md' };

function activeConv() {
  return state.convs.find((c) => c.id === state.activeConvId) || null;
}

/** 当前对话的规范类型（唯一来源，不再看 state.mode） */
function convKind() {
  const c = activeConv();
  return c && c.kind === 'edit' ? 'edit' : 't2i';
}

/**
 * 当前对话是否启用「附加规则」。
 * 附加规则是**项目自写**的补充条款（透明图句式 / 主体提取），因为官方两份规范
 * 都没有覆盖这两件事。它作为独立的第二条 system 消息追加，官方规范原文一字不动，
 * 所以这是一个纯追加的开关，关掉即与之前完全一致。
 */
function convExtra() {
  const c = activeConv();
  return !!(c && c.extra === true);
}

/* ---------- 当前对话锁定的参考图 ----------
   锁定图是"送给视觉模型看"的那组图，与创作台的 refImages 分开存放：
   创作台换图不会影响已经锁好的对话。 */

/**
 * 同步 state.convImages 为当前对话锁定的图片。
 *
 * 图片现在以 inputs/ 下的文件名引用存在，对话列表返回的就是完整信息，
 * 因此**不再需要为了取图额外请求一次详情** —— 这是落盘带来的直接简化。
 * （旧实现因为列表刻意剥掉 base64，切对话时必须再拉一次 GET /:id。）
 */
function ensureConvImages(conv) {
  state.convImages = conv && Array.isArray(conv.images) ? conv.images.slice() : [];
}

/** 锁定图的显示地址：服务端已落盘的用 /inputs/，尚未保存的本地图退回落 dataURL */
function convImageSrc(im) {
  if (!im) return '';
  return im.file ? `/inputs/${encodeURIComponent(im.file)}` : im.dataUrl || '';
}

/**
 * 保存锁定图（整组替换语义，传空数组即清空）。
 *
 * 服务端会**静默丢弃**超出单张体积 / 张数上限的图，所以这里必须把
 * 真实的保留结果回给调用方，由调用方决定给用户看什么 ——
 * 早期版本在这里无条件 toast「已锁定 N 张」，于是同一时刻既弹成功又弹失败
 * （截图实证：上方红条「服务端只接受了 0 张」，下方绿条「已锁定 1 张图片到当前对话」）。
 *
 * @returns {Promise<{ok:boolean, kept:number, sent:number, error?:string}>}
 */
async function saveConvImages(conv, imgs) {
  if (!conv) return { ok: false, kept: 0, sent: 0, error: '对话不存在' };

  const list = (imgs || []).slice(0, CONV_MAX_IMAGES);
  // 两种形态：本地刚压缩好的新图带 dataUrl（服务端会落盘），
  // 服务端此前返回的引用只有 file（原样沿用，避免每次 PATCH 重写文件）。
  const payload = list.map((im) =>
    im.file
      ? { name: im.name, file: im.file, w: im.w || 0, h: im.h || 0 }
      : { name: im.name, dataUrl: im.dataUrl, w: im.w || 0, h: im.h || 0 }
  );
  renderConvList();

  const r = await api(`/api/conversations/${conv.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ images: payload }),
  });
  if (!r || !r.ok) {
    return { ok: false, kept: 0, sent: list.length, error: (r && r.error) || '锁定图片保存失败' };
  }

  // 一律以服务端返回的引用列表为准。
  // 只有服务端知道哪些图真的落了盘、文件名是什么，本地那份 dataUrl 到此使命结束。
  // （不再自行推算"保留前 N 张"——服务端丢的是不合法的那几张，未必都在尾部。）
  let kept = list.length;
  if (r.item && Array.isArray(r.item.images)) {
    conv.images = r.item.images;
    kept = r.item.images.length;
    if (state.activeConvId === conv.id) state.convImages = r.item.images.slice();
  }
  renderLockImages();
  renderConvList();
  return { ok: true, kept, sent: list.length };
}

/** 把创作台的参考图压缩后锁定到当前对话 */
async function lockFromStudio(opts = {}) {
  const conv = activeConv();
  if (!conv) return false;
  if (!state.refImages.length) {
    if (!opts.silent) toast('创作台还没有参考图', 'err');
    return false;
  }

  const src = state.refImages.slice(0, CONV_MAX_IMAGES);
  const out = [];
  for (const im of src) {
    try {
      // 按视觉模型的需要压（创作台那份是给生图模型的，规格不同）
      const p = await prepareImage(im.dataUrl, null, LOCK_PREP);
      out.push({ name: im.name, dataUrl: p.dataUrl, w: p.w, h: p.h, bytes: p.bytes });
    } catch (e) {
      /* 单张失败就跳过，不阻塞其余 */
    }
  }
  if (!out.length) {
    if (!opts.silent) toast('图片处理失败，未能锁定', 'err');
    return false;
  }

  state.convImages = out;
  const res = await saveConvImages(conv, out);
  renderLockImages();

  if (!opts.silent) {
    if (!res.ok) {
      toast(res.error || '锁定图片保存失败', 'err');
    } else if (res.kept === out.length) {
      const extra = state.refImages.length - out.length;
      toast(
        `已锁定 ${out.length} 张图片到当前对话${extra > 0 ? `（创作台另有 ${extra} 张超出上限未锁定）` : ''}`,
        'ok'
      );
    } else if (res.kept > 0) {
      toast(`只锁定成功 ${res.kept}/${out.length} 张，其余超出单张体积或张数上限被丢弃`, 'err');
    } else {
      toast(`锁定失败：${out.length} 张图全部超出服务端单张上限被丢弃，请换更小的图`, 'err');
    }
  }
  return res.ok && res.kept > 0;
}

/** 在对话里直接上传锁定图 */
async function addLockImages(files) {
  const conv = activeConv();
  if (!conv) return;
  const all = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
  if (!all.length) return;

  const room = CONV_MAX_IMAGES - state.convImages.length;
  if (room <= 0) return toast(`一个对话最多锁定 ${CONV_MAX_IMAGES} 张图片`, 'err');
  const list = all.slice(0, room);
  if (all.length > room) toast(`已达上限，仅添加前 ${room} 张`, 'err');

  let compressed = 0;
  let saved = 0;
  for (const f of list) {
    try {
      const raw = await readAsDataURL(f);
      const p = await prepareImage(raw, f, LOCK_PREP);
      state.convImages.push({ name: f.name, dataUrl: p.dataUrl, w: p.w, h: p.h, bytes: p.bytes });
      if (p.compressed) {
        compressed += 1;
        saved += Math.max(0, f.size - p.bytes);
      }
      renderLockImages();
    } catch (e) {
      toast(`「${f.name}」处理失败`, 'err');
    }
  }
  const res = await saveConvImages(conv, state.convImages);
  if (!res.ok) {
    toast(res.error || '锁定图片保存失败', 'err');
  } else if (res.kept < res.sent) {
    toast(`服务端只接受 ${res.kept}/${res.sent} 张，其余超出单张体积或张数上限被丢弃`, 'err');
  }
  if (compressed) toast(`已压缩 ${compressed} 张图片，节省 ${fmtBytes(saved)}`, 'ok');
}

/** 渲染锁定图区 */
function renderLockImages() {
  const box = $('#lockThumbs');
  if (!box) return;
  const imgs = state.convImages || [];
  const cnt = $('#lockCount');
  if (cnt) cnt.textContent = imgs.length ? `${imgs.length} / ${CONV_MAX_IMAGES}` : '';

  box.innerHTML = '';
  if (!imgs.length) {
    const kind = convKind();
    const d = document.createElement('div');
    d.className = 'lock-empty';
    d.textContent =
      kind === 'edit'
        ? '还没有锁定图片 · 编辑类提示词需要它'
        : '还没有锁定图片 · 文生图可留空';
    box.appendChild(d);
  } else {
    imgs.forEach((im, i) => {
      const d = document.createElement('div');
      d.className = 'lock-thumb';
      const src = convImageSrc(im);
      d.innerHTML =
        `<img src="${src}" alt="" />` +
        `<span class="tag">#${i + 1}</span>` +
        `<button class="del" title="从本对话移除">✕</button>`;
      d.querySelector('.del').addEventListener('click', async (e) => {
        e.stopPropagation();
        state.convImages.splice(i, 1);
        renderLockImages();
        await saveConvImages(activeConv(), state.convImages);
      });
      d.querySelector('img').addEventListener('click', () => openViewer(src, im.name));
      box.appendChild(d);
    });
  }
  updateKindHint();
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 接口 ---------- */

async function loadConversations() {
  const r = await api('/api/conversations');
  if (!r || !r.ok) {
    toast((r && r.error) || '对话记录加载失败', 'err');
    return;
  }
  state.convs = r.items || [];
  state.activeConvId = r.activeId || (state.convs[0] ? state.convs[0].id : '');
  if (!state.convs.length) {
    // 首次使用：自动开一个文生图对话，用户进来就能直接说话
    await newConversation('t2i', { silent: true });
    return;
  }
  ensureConvImages(activeConv()); // 同步：图片引用已在对话列表里，无需再拉详情
  renderConvList();
  renderActiveConv();
}

async function newConversation(kind = 't2i', opts = {}) {
  const r = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ kind }) });
  if (!r || !r.ok) {
    toast((r && r.error) || '新建对话失败', 'err');
    return null;
  }
  state.convs = r.items || [r.item];
  state.activeConvId = r.activeId || (r.item && r.item.id) || '';
  state.lastOptimized = '';
  state.convImages = []; // 新对话默认不锁定任何图片
  renderConvList();
  renderActiveConv();
  if (!opts.silent) {
    toast(`已新建${KIND_LABEL[kind]}对话`, 'ok');
    setTimeout(() => $('#chatInput').focus(), 60);
  }
  return r.item || activeConv();
}

/** 保存对话（消息 / 标题 / 类型）。服务端会在首次写入时按首条需求自动命名 */
async function persistConv(conv, patch) {
  const r = await api(`/api/conversations/${conv.id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r || !r.ok) {
    toast((r && r.error) || '对话保存失败', 'err');
    return;
  }
  if (r.item) {
    conv.title = r.item.title;
    conv.updatedAt = r.item.updatedAt;
    const local = state.convs.find((c) => c.id === conv.id);
    if (local) {
      local.title = r.item.title;
      local.updatedAt = r.item.updatedAt;
    }
  }
  renderConvList();
  updateChatScope();
}

async function selectConversation(id) {
  if (!id || state.activeConvId === id) return;
  state.activeConvId = id;
  state.lastOptimized = '';
  renderConvList();
  // 锁定图已是文件名引用，对话列表里就有，直接同步即可
  ensureConvImages(activeConv());
  renderActiveConv();
  api('/api/conversations/active', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }).catch(() => {});
}

async function renameConversation(conv) {
  const name = prompt('重命名对话：', conv.title);
  if (name === null) return;
  const title = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title || title === conv.title) return;
  conv.title = title;
  await persistConv(conv, { title });
  renderConvList();
  updateChatScope();
  toast('已重命名', 'ok');
}

async function deleteConversation(conv) {
  const n = conv.messages.length;
  if (!confirm(`删除对话「${conv.title}」？\n\n${n ? `其中 ${n} 条消息会一并删除，` : ''}不可恢复。`)) return;

  const r = await api(`/api/conversations/${conv.id}`, { method: 'DELETE' });
  if (!r || !r.ok) return toast((r && r.error) || '删除失败', 'err');

  state.convs = r.items || [];
  state.activeConvId = r.activeId || '';
  state.lastOptimized = '';
  if (!state.convs.length) {
    await newConversation('t2i', { silent: true });
  } else {
    ensureConvImages(activeConv());
    renderConvList();
    renderActiveConv();
  }
  toast('对话已删除', 'ok');
}

/** 切换当前对话使用的规范类型 */
async function setConvKind(kind) {
  const conv = activeConv();
  if (!conv || conv.kind === kind) return;
  const others = conv.messages.filter((m) => m.kind !== kind).length;
  conv.kind = kind;
  renderActiveConv();
  await persistConv(conv, { kind });
  toast(
    others
      ? `已切换到「${KIND_LABEL[kind]}」规范，之前 ${others} 条其它类型的消息不再带入上下文`
      : `已切换到「${KIND_LABEL[kind]}」规范`,
    'ok'
  );
}

/** 切换附加规则（透明图句式 / 主体提取）。属于对话级设置，随对话保存 */
async function setConvExtra(on) {
  const conv = activeConv();
  if (!conv) {
    $('#extraRule').checked = false;
    return toast('请先新建或选择一个对话', 'err');
  }
  conv.extra = on;
  renderRuleInfo();
  await persistConv(conv, { extra: on });
  renderConvList();
  toast(
    on
      ? '已启用附加规则：透明图句式 / 主体提取（作为第二条 system 消息，官方规范原文不变）'
      : '已关闭附加规则，改写行为回到只依据官方规范',
    'ok'
  );
}

/* ---------- 渲染：对话列表 ---------- */

function renderConvList() {
  const box = $('#convList');
  if (!box) return;
  box.innerHTML = '';
  if (!state.convs.length) {
    const d = document.createElement('div');
    d.className = 'conv-empty';
    d.textContent = '还没有对话，点上方「新建对话」开始';
    box.appendChild(d);
    return;
  }
  state.convs.forEach((c) => {
    const item = document.createElement('div');
    item.className = `conv-item${c.id === state.activeConvId ? ' active' : ''}`;
    item.dataset.id = c.id;
    const n = c.messages.length;
    const k = c.kind === 'edit' ? 'edit' : 't2i';
    item.innerHTML =
      `<div class="conv-top">` +
      `<span class="conv-kind${k === 'edit' ? ' edit' : ''}">${KIND_LABEL[k]}</span>` +
      `<span class="conv-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</span>` +
      `</div>` +
      `<div class="conv-bottom">` +
      `<span class="conv-meta">${n ? `${n} 条` : '空'}${
        (c.images || []).length ? ` · 锁定 ${c.images.length} 图` : ''
      }${c.extra ? ' · 附加规则' : ''} · ${fmtClock(c.updatedAt)}</span>` +
      `<button class="conv-op" data-op="rename">重命名</button>` +
      `<button class="conv-op del" data-op="del">删除</button>` +
      `</div>`;
    box.appendChild(item);
  });
}

$('#convList').addEventListener('click', (e) => {
  const item = e.target.closest('.conv-item');
  if (!item) return;
  const conv = state.convs.find((c) => c.id === item.dataset.id);
  if (!conv) return;
  const op = e.target.closest('[data-op]');
  if (op && op.dataset.op === 'rename') return void renameConversation(conv);
  if (op && op.dataset.op === 'del') return void deleteConversation(conv);
  selectConversation(conv.id);
});

$('#convNew').addEventListener('click', () => {
  const kind = convKind(); // 沿用当前类型，符合"继续做同一类提示词"的常见意图
  newConversation(kind);
});

/* ---------- 渲染：规范信息 ---------- */

function renderRuleInfo() {
  const box = $('#ruleInfo');
  if (!box) return;
  const kind = convKind();
  const meta = state.rules && state.rules.rules ? state.rules.rules[kind] : null;
  const want = KIND_RULE_FILE[kind];

  // 附加规则（项目自写，非官方）：只报事实 —— 文件在不在、这次开没开
  const ex = state.rules && state.rules.extraRule;
  const exOn = convExtra();
  const viewExtra = $('#viewExtraRuleBtn');
  if (viewExtra) viewExtra.hidden = !(ex && ex.exists);
  const extraHtml =
    `<div class="divider"></div>` +
    `<div class="rule-row"><span>附加规则</span><span>${
      ex && ex.exists ? (exOn ? '已启用' : '未启用') : '未安装'
    }</span></div>` +
    (ex && ex.exists
      ? `<div class="rule-row"><span>文件</span><span>${escapeHtml(ex.path)}</span></div>` +
        `<div class="rule-row"><span>大小</span><span>${ex.bytes} B · ${ex.lines} 行</span></div>` +
        (exOn
          ? `<div class="rule-row"><span>指纹</span><span title="${ex.sha256}">${ex.sha256.slice(
              0,
              12
            )}</span></div>` +
            `<div class="rule-row"><span>说明</span><span>透明图句式 · 主体提取</span></div>`
          : `<div class="rule-row"><span>说明</span><span>勾选「附加规则」后随请求发送</span></div>`)
      : `<div class="rule-row"><span>说明</span><span>缺 extra_transparent_subject.md</span></div>`);

  if (!meta || !meta.exists) {
    box.innerHTML =
      `<div class="rule-missing">未读取到 <b>${want}</b>，无法按官方规范改写。<br>` +
      `请把官方规范文件放到 <code>data/rules/${want}</code> 后刷新页面。</div>` +
      extraHtml;
    return;
  }

  const outline = (meta.outline || [])
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join('');

  box.innerHTML =
    `<div class="rule-row"><span>类型</span><span>${KIND_RULE[kind]}</span></div>` +
    `<div class="rule-row"><span>文件</span><span>${escapeHtml(meta.path)}</span></div>` +
    `<div class="rule-row"><span>大小</span><span>${meta.bytes} B · ${meta.lines} 行</span></div>` +
    `<div class="rule-row"><span>指纹</span><span title="${meta.sha256}">${meta.sha256.slice(0, 12)}</span></div>` +
    (outline ? `<ul class="rule-outline">${outline}</ul>` : '') +
    extraHtml;
}

async function loadRules() {
  try {
    const r = await api('/api/rules');
    if (r && r.ok) state.rules = r;
  } catch (e) {
    /* 后端不可用时保持 state.rules 为 null，卡片会显示缺失提示 */
  }
  renderRuleInfo();
  updateExtraSeg(); // 附加规则文件缺失时要禁用开关

  const miss = [];
  if (!state.rules || !state.rules.rules) return;
  if (!state.rules.rules.t2i.exists) miss.push('official_t2i.md');
  if (!state.rules.rules.edit.exists) miss.push('official_edit.md');
  if (miss.length) toast(`缺少官方规范文件：${miss.join('、')}，提示词优化将不可用`, 'err');
}

async function viewRuleSource(kind) {
  const k = kind || convKind();
  const r = await api(`/api/rules/${k}/source`);
  if (!r || !r.ok) return toast((r && r.error) || '读取规范原文失败', 'err');
  const isExtra = k === 'extra';
  $('#textModalTitle').textContent = `${r.meta.file} · ${
    isExtra ? '附加规则原文（项目自写）' : '官方规范原文'
  }`;
  $('#textModalMeta').textContent = `${r.meta.bytes} B · ${r.meta.lines} 行 · sha256 ${r.meta.sha256.slice(
    0,
    12
  )}`;
  $('#textModalBody').textContent = r.text;
  $('#textModal').classList.add('show');
}

$('#viewRuleBtn').addEventListener('click', () => viewRuleSource());
$('#viewExtraRuleBtn').addEventListener('click', () => viewRuleSource('extra'));
$('#extraRule').addEventListener('change', (e) => setConvExtra(!!e.target.checked));
$('#textModalClose').addEventListener('click', () => $('#textModal').classList.remove('show'));
$('#textModal').addEventListener('click', (e) => {
  if (!e.target.closest('.textmodal-box')) $('#textModal').classList.remove('show');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#textModal').classList.remove('show');
});


/* --- 官方规范优化（调用后端 /api/optimize） --- */

/** 按官方契约重建「模型输出格式」的 JSON。
 *  两份规范都明文要求模型按这个格式回复：t2i 两个字段，edit 三个字段。
 *  给模型看的历史轮次、以及界面上要查看/存档/迁移的形态，都用它。 */
function envelopeOf(result, kind) {
  const k = kind || result.kind || 't2i';
  const obj = { rewritten_prompt: result.prompt || '', wh_ratio: result.whRatio || '' };
  if (k === 'edit') obj.ratio_follow = result.ratioFollow || '';
  return JSON.stringify(obj);
}

/** 还原历史消息给模型看到的形态：assistant 一侧是规范要求的 JSON 输出 */
function historyContent(m, kind) {
  if (m.role === 'user') return m.text;
  if (!m.result) return m.text;
  return envelopeOf(m.result, kind);
}

async function officialOptimize(userText, conv, kind) {
  // 送给模型"看"的是本对话锁定的图，不是创作台当前的图 ——
  // 这样之后在创作台换图、删图，都不会让这个对话的编辑指令失真。
  // 判据用 file：锁定图已落盘为文件引用，本地不再持有 base64。
  const lock = (state.convImages || []).filter((im) => im && im.file);
  if (kind === 'edit' && lock.length === 0) {
    throw new Error(
      '编辑规范要求模型能"看到"输入图：请先把参考图锁定到本对话（点「从创作台带入」或直接上传），再重新发送'
    );
  }

  // 只取与本轮规范类型一致的历史消息 —— 换过类型的旧消息一律不参与上下文，
  // 这样两份规范的产物不会互相污染（这是"提示词不按官方规范"的主要成因之一）。
  const past = conv.messages.filter((m) => m.kind === kind);
  const tail = past[past.length - 1];
  if (tail && tail.role === 'user' && tail.text === userText) past.pop();

  const history = past
    .slice(-6)
    .map((m) => ({ role: m.role, content: historyContent(m, kind) }))
    .filter((h) => h.content);

  const r = await api('/api/optimize', {
    method: 'POST',
    body: JSON.stringify({
      kind, // 显式提交；服务端不会再从图片数量之类的地方猜类型
      text: userText,
      images: lock.map((im) => im.name), // 仅供服务端生成"本次输入图片"的文字说明
      // 不再提交 imageData：图片已落在 inputs/，由服务端按 convId 读盘，
      // 前端与服务端各持一份 base64 只会带来"两边不一致"的分裂风险。
      convId: conv.id,
      history,
      // 附加规则（透明图句式 / 主体提取）：对话级开关，服务端据此追加第二条 system 消息
      extra: conv.extra === true,
    }),
  });

  if (!r.ok) throw new Error(r.error || '优化失败');

  // 带了图却没生效，说明格式或体积被拦下了 —— 必须让用户知道，
  // 否则会误以为模型"看过图"了，实际拿到的是盲写的提示词。
  if (lock.length && !r.visionUsed) {
    throw new Error(
      `图片未能送达模型${r.visionNote ? `（${r.visionNote}）` : ''}：请重新锁定图片后重试`
    );
  }

  const wh = r.whRatio || '';
  const rf = r.ratioFollow || '';
  const ruleTag = r.ruleFile
    ? `依据 ${r.ruleFile}${r.ruleSha ? `（${r.ruleSha}）` : ''}`
    : '依据官方规范';
  // 附加规则生效时把文件名与指纹一并写进卡片元信息，便于事后核对这条是按什么改写的
  const extraTag = r.extra ? ` · 附加 ${r.extra.file}（${r.extra.sha}）` : '';

  return {
    prompt: r.prompt,
    whRatio: wh,
    ratioFollow: rf,
    kind: r.kind,
    ruleFile: r.ruleFile || '',
    ruleSha: r.ruleSha || '',
    extraFile: (r.extra && r.extra.file) || '',
    note:
      `${ruleTag} · ${KIND_RULE[r.kind] || r.kind}` +
      (r.visionUsed ? ` · 已把 ${r.visionImageCount} 张图交给模型` : ' · 未附图') +
      extraTag +
      (wh ? ` · 比例 ${wh}` : '') +
      (rf ? ` · 跟随 ${rf}` : ''),
  };
}

/** 把 wh_ratio 自动同步到创作台的尺寸预设 */
function applyRatio(whRatio) {
  if (!whRatio) return;
  const m = String(whRatio).match(/(\d+)\s*[:：]\s*(\d+)/);
  if (!m) return;
  const rw = Number(m[1]);
  const rh = Number(m[2]);
  const target = rw / rh;

  // 先找内置预设里最接近的比例
  let bestIdx = -1;
  let bestDiff = Infinity;
  SIZES.forEach((s, i) => {
    const d = Math.abs(s.w / s.h - target);
    if (d < bestDiff) {
      bestDiff = d;
      bestIdx = i;
    }
  });

  // 比例吻合（误差 < 2%）则直接用预设，否则按 1024 基准计算自定义宽高
  if (bestDiff < 0.02 && bestIdx >= 0) {
    $('#sizePreset').value = String(bestIdx);
    $('#customW').value = '';
    $('#customH').value = '';
  } else {
    const base = 1024;
    let w;
    let h;
    if (target >= 1) {
      w = Math.round((base * target) / 16) * 16;
      h = base;
    } else {
      w = base;
      h = Math.round(base / target / 16) * 16;
    }
    // 控制在合理范围内
    const scale = Math.min(1, SIDE_MAX / Math.max(w, h));
    w = Math.max(SIDE_MIN, Math.round((w * scale) / 16) * 16);
    h = Math.max(SIDE_MIN, Math.round((h * scale) / 16) * 16);
    $('#customW').value = w;
    $('#customH').value = h;
  }
}

/* --- 对话 UI --- */

function welcomeText(kind) {
  if (kind === 'edit') {
    return (
      '这是「编辑图片提示词」对话，按官方 Edit Prompt Enhancer 规范改写。\n\n' +
      '用法：\n' +
      '1. 把要编辑的图片锁定到本对话：点下方「从创作台带入」或「上传」（多图时规范要求用 <image1>、<image2> 指代）\n' +
      '2. 用中文说清楚要改什么，例如：\n' +
      '· 把旗袍的颜色改成酒红色，其他保持不变\n' +
      '· 把背景换成海边，人物和衣服保持不变\n' +
      '· 用图2的色调重画图1\n\n' +
      '锁定的图片会真正随消息发给模型 —— 它能"看到"画面里实际有什么，所以保留声明是具体的（金色滚边、黄色盲道砖…）而不是笼统的"其余不变"。\n\n' +
      '我会输出可直接提交的编辑指令，并给出 wh_ratio 或 ratio_follow（两者互斥）。'
    );
  }
  return (
    '这是「文生图提示词」对话，按官方 Image Prompt Rewriting 规范改写。\n\n' +
    '直接描述你想要的画面即可，例如：\n' +
    '· 逆光下的亚洲女性人像，2:3 竖版，电影感柔光\n' +
    '· 一个透明背景的水彩猫咪素材\n' +
    '· 一张咖啡馆菜单海报，标题写 "Morning Brew"\n\n' +
    '不满意就继续说「再暗一点」「换成 3D 风格」，我会在同一份规范下继续迭代。\n\n' +
    '要做改图提示词，请点右上角切到「编辑图片提示词」或新建一个对话 —— 两条规范不要混在同一个对话里。'
  );
}

/** 当前对话已累积的轮次（只统计与本类型一致的 user 消息） */
function chatTurns() {
  const conv = activeConv();
  if (!conv) return 0;
  const k = conv.kind === 'edit' ? 'edit' : 't2i';
  return conv.messages.filter((m) => m.role === 'user' && m.kind === k).length;
}

function scrollChat() {
  const log = $('#chatLog');
  log.scrollTop = log.scrollHeight;
}

/** 刷新头部「当前对话 + 上下文规模」 */
function updateChatScope() {
  const label = $('#chatScope');
  if (!label) return;
  const conv = activeConv();
  const dot = $('#chatScopeDot');
  if (!conv) {
    label.textContent = '未选择对话';
    if (dot) dot.classList.remove('on');
    return;
  }
  const n = chatTurns();
  label.textContent = `《${conv.title}》 · ${n} 轮上下文 · ${KIND_LABEL[convKind()]}规范`;
  if (dot) dot.classList.toggle('on', n > 0);
}

function updateKindSeg() {
  const kind = convKind();
  $$('#kindSeg .kind-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
}

/** 附加规则开关的显示状态。文件缺失时禁用并说明原因 ——
 *  勾了却发不出去，比不让勾更糟。 */
function updateExtraSeg() {
  const box = $('#extraRule');
  if (!box) return;
  const meta = state.rules && state.rules.extraRule;
  const missing = !!(meta && meta.exists === false);
  box.checked = convExtra();
  box.disabled = missing;
  const label = box.closest('label');
  if (label) {
    label.title = missing
      ? '缺少附加规则文件 data/rules/extra_transparent_subject.md，无法启用'
      : '把项目自写的补充条款（透明图句式 / 主体提取）作为第二条 system 消息追加，官方规范原文一字不动';
  }
}

/* ---------- 编辑意图识别 ----------
   为什么需要它：编辑规范要求「所有判断来自画面里实际存在的东西」。
   用户没给图却提"把这张图改成…"时，模型看不到画面只能盲写，
   产出的保留声明必然是笼统、不可靠的。这种时候要主动提醒补图。 */

const EDIT_VERBS = [
  '改成', '改为', '换成', '换掉', '替换', '去掉', '去除', '移除', '删除',
  '加上', '添加', '增加', '抠图', '抠掉', '换背景', '换脸', '扩图', '扩展',
  '合成', '拼合', '修图', '精修', '调色', '上色', '美化', '重绘', '局部重绘',
  '消除', '抹除', '擦除', '补全', '修改', '改一下', '改成', '变幻', '变',
];
const IMAGE_REF_WORDS = [
  '这张图', '这张照片', '这张图片', '该图', '上图', '原图', '参考图',
  '图片', '照片', '这张', '此图', '这张画',
];

/**
 * 判断一段需求是不是"图像编辑"性质。
 * strong = 既有编辑动词、又明确指向某张图 —— 误报率最低，才值得打断用户。
 */
function detectEditIntent(text) {
  const raw = String(text || '');
  const s = raw.toLowerCase();
  if (!s.trim()) return { isEdit: false, strong: false, verbs: [], refs: [] };
  const verbs = EDIT_VERBS.filter((v) => s.includes(v));
  const refs = IMAGE_REF_WORDS.filter((v) => s.includes(v.toLowerCase()));
  return { isEdit: verbs.length > 0, strong: verbs.length > 0 && refs.length > 0, verbs, refs };
}

/** 编辑规范必须有输入图，缺图时提前提示，省得白跑一次调用。
 *  只在用户**正在写东西**时提醒：空对话一打开就跳黄条太吵，
 *  而真正缺图的硬性拦截放在发送时（sendChat）做，不会漏。 */
function updateKindHint() {
  const el = $('#kindHint');
  if (!el) return;
  const draft = ($('#chatInput') && $('#chatInput').value) || '';
  if (!draft.trim()) {
    el.hidden = true;
    return;
  }

  const kind = convKind();
  const locked = state.convImages.length;
  const studio = state.refImages.length;
  const intent = detectEditIntent(draft);

  let msg = '';
  if (!locked && !studio) {
    if (kind === 'edit') {
      msg =
        '编辑规范要求模型能"看到"输入图：请点下方「从创作台带入 / 上传」把图锁定到本对话。' +
        (intent.isEdit ? '（你的描述正是在改图，这一步不能省）' : '');
    } else if (intent.isEdit) {
      msg =
        '你的描述看起来是「图像编辑」，但本对话当前是文生图规范、且没有图片。' +
        '图像编辑必须让模型看到画面：建议先锁定要编辑的图片，并把右上角类型切到「编辑图片提示词」。';
    }
  } else if (kind === 'edit' && !locked && studio) {
    msg = `创作台已有 ${studio} 张参考图，但尚未锁定到本对话 —— 发送时会自动带入并交给模型"看"。`;
  } else if (kind === 't2i' && locked) {
    msg =
      `已锁定 ${locked} 张图：文生图规范没有 <imageN> 的概念，这些图只作为风格与内容参照，不会写进提示词正文。` +
      (intent.isEdit ? '（你的描述像是"改图"，改图请把类型切到「编辑图片提示词」）' : '');
  }
  el.hidden = !msg;
  el.textContent = msg;
}

function msgEl(role, text) {
  const d = document.createElement('div');
  d.className = `msg ${role === 'user' ? 'user' : 'ai'}`;
  d.textContent = text;
  return d;
}

/** 按数据重建当前对话的消息流（切换对话 / 改类型后调用） */
function renderActiveConv() {
  const log = $('#chatLog');
  const conv = activeConv();
  log.innerHTML = '';
  if (conv) {
    if (!conv.messages.length) {
      log.appendChild(msgEl('assistant', welcomeText(conv.kind === 'edit' ? 'edit' : 't2i')));
    } else {
      conv.messages.forEach((m) => {
        if (m.role === 'assistant' && m.result) log.appendChild(promptCardEl(m.result));
        else log.appendChild(msgEl(m.role, m.text));
      });
    }
  }
  scrollChat();
  updateKindSeg();
  updateExtraSeg();
  updateChatScope();
  renderLockImages(); // 内部会顺带刷新 kindHint
  renderRuleInfo();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 优化结果卡片。做成"返回元素"而不是"直接追加"，
 *  这样切换对话、切换类型后可以按数据把整个消息流重新渲染出来。 */
function promptCardEl(result) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.style.maxWidth = '100%';
  wrap.style.width = '100%';
  wrap.style.padding = '0';
  wrap.style.background = 'transparent';
  wrap.style.border = 'none';

  const ratioChips =
    (result.whRatio ? `<span class="tagm">wh_ratio ${result.whRatio}</span>` : '') +
    (result.ratioFollow ? `<span class="tagm">ratio_follow ${result.ratioFollow}</span>` : '');

  // 把本次实际使用的规范文件标进标题，任何时候都能看出这条是照哪份规范写的
  const lbl = result.ruleFile
    ? `优化后提示词 · ${result.ruleFile}`
    : `优化后提示词 · ${result.kind === 'edit' ? 'Edit' : 'T2I'} 规范`;

  wrap.innerHTML = `
    <div class="msg ai prompt">
      <span class="lbl">${escapeHtml(lbl)}</span>${escapeHtml(result.prompt)}
      <span class="meta">${escapeHtml(result.note || '')}</span>
    </div>
    ${ratioChips ? `<div class="chips" style="margin-top:8px">${ratioChips}</div>` : ''}
    <div class="row" style="margin-top:10px">
      <button class="btn btn-sm" data-act="use">填入创作台</button>
      <button class="btn btn-ghost btn-sm" data-act="gen">填入并生成</button>
      <button class="btn btn-ghost btn-sm" data-act="copy">复制正文</button>
      <button class="btn btn-ghost btn-sm" data-act="json">官方 JSON</button>
    </div>`;

  wrap.querySelector('[data-act="use"]').addEventListener('click', () => {
    applyPrompt(result);
    toast('已填入创作台', 'ok');
  });
  wrap.querySelector('[data-act="gen"]').addEventListener('click', () => {
    applyPrompt(result);
    gotoView('studio');
    setTimeout(() => $('#generateBtn').click(), 120);
  });
  wrap.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(result.prompt);
      toast('已复制提示词正文（可直接生图）', 'ok');
    } catch (e) {
      toast('复制失败，请手动选择复制', 'err');
    }
  });
  // 官方契约形态：规范要求「模型回复」用的就是它 —— 存档、迁移、喂回模型都用这个
  wrap.querySelector('[data-act="json"]').addEventListener('click', () => {
    $('#textModalTitle').textContent =
      `官方规范输出格式 · ${(result.kind || 't2i') === 'edit' ? 'Edit（三字段）' : 'T2I（两字段）'}`;
    $('#textModalMeta').textContent =
      '这是规范要求「模型回复」使用的格式。rewritten_prompt 才是提示词正文 —— ' +
      '送进生图接口前要把正文取出来，不要把外壳一起发过去。';
    $('#textModalBody').textContent = envelopeOf(result);
    $('#textModal').classList.add('show');
  });

  return wrap;
}

function applyPrompt(result) {
  $('#prompt').value = result.prompt;
  state.lastOptimized = result.prompt;
  updatePromptLen();
  if (result.whRatio) applyRatio(result.whRatio);
  gotoView('studio');
}

async function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;

  let conv = activeConv();
  if (!conv) {
    conv = await newConversation('t2i', { silent: true });
    if (!conv) return;
  }
  let kind = conv.kind === 'edit' ? 'edit' : 't2i';

  // 情况一：没给图，但说的是"改图" —— 盲写的典型入口，先问清再动手
  if (kind === 't2i' && state.convImages.length === 0) {
    const intent = detectEditIntent(text);
    if (intent.strong) {
      const goEdit = confirm(
        `你的需求看起来是「图像编辑」（${intent.verbs.slice(0, 3).join('、')}…），但当前：\n\n` +
          `· 本对话用的是「文生图提示词」规范\n` +
          `· 还没有锁定任何图片，模型看不到画面\n\n` +
          `编辑规范要求所有判断来自画面里实际存在的东西，没有图只能盲写。\n\n` +
          `「确定」→ 切到「编辑图片提示词」并提供图片\n` +
          `「取消」→ 忽略，仍按文生图规范改写`
      );
      if (goEdit) {
        await setConvKind('edit');
        kind = 'edit';
        // 创作台已经有图就直接带过来，省一次手工操作
        if (state.refImages.length) await lockFromStudio({ silent: true });
        if (!state.convImages.length) {
          $('#chatLog').appendChild(
            msgEl(
              'assistant',
              '这看起来是图像编辑需求，但还没有可编辑的图片。\n\n请先提供图片：\n' +
                '· 点下方「上传」直接选图（不必离开本页）\n' +
                '· 或点「从创作台带入」把创作台已上传的图锁定过来\n\n' +
                '有了图之后，模型才能真正"看到"画面，写出可靠的编辑指令。'
            )
          );
          scrollChat();
          updateKindHint();
          return;
        }
      }
    }
  }

  const convId = conv.id; // 记住本次请求属于哪个对话

  // 情况二：确认走编辑规范，但对话里确实没有图 → 问一句再决定，别浪费一次调用
  if (kind === 'edit' && state.convImages.length === 0) {
    if (state.refImages.length) {
      const n = Math.min(state.refImages.length, CONV_MAX_IMAGES);
      const ok = confirm(
        `本对话还没有绑定图片。\n\n` +
          `要把创作台里的 ${n} 张图锁定到本对话并开始改写吗？\n` +
          `锁定后模型才能真正"看到"画面；选「取消」则本次不发送，你可以先在锁定图区自行挑选。`
      );
      if (!ok) return;
      await lockFromStudio({ silent: true });
      if (state.convImages.length) toast(`已锁定创作台的 ${state.convImages.length} 张图`, 'ok');
    }
    if (state.convImages.length === 0) {
      updateKindHint();
      return toast(
        '编辑图片提示词需要图片：请先在「创作台」上传参考图，或在锁定图区直接上传',
        'err'
      );
    }
  }

  input.value = '';
  conv.messages.push({ role: 'user', kind, ts: Date.now(), text });
  $('#chatLog').appendChild(msgEl('user', text));
  scrollChat();

  const thinking = msgEl('assistant', `正在按 ${KIND_RULE[kind]} 规范重写…`);
  thinking.style.opacity = '0.6';
  $('#chatLog').appendChild(thinking);
  scrollChat();

  // 先落库用户消息（顺带由服务端按首条需求自动命名对话）
  await persistConv(conv, { messages: conv.messages });

  try {
    const result = await officialOptimize(text, conv, kind);
    thinking.remove();

    const target = state.convs.find((c) => c.id === convId);
    if (!target) {
      toast('该对话已被删除，本次结果未保存', 'err');
      return;
    }

    state.lastOptimized = result.prompt;
    target.messages.push({
      role: 'assistant',
      kind,
      ts: Date.now(),
      text: '',
      result: {
        prompt: result.prompt,
        whRatio: result.whRatio,
        ratioFollow: result.ratioFollow,
        note: result.note,
        ruleFile: result.ruleFile,
        ruleSha: result.ruleSha,
      },
    });
    await persistConv(target, { messages: target.messages });

    if (state.activeConvId === convId) {
      $('#chatLog').appendChild(promptCardEl(target.messages[target.messages.length - 1].result));
      scrollChat();
      updateChatScope();
    } else {
      // 请求期间用户切走了对话：结果归属原对话，只提示，不往当前对话里塞
      renderConvList();
      toast(`结果已保存到《${target.title}》`, 'ok');
    }
  } catch (e) {
    thinking.remove();
    $('#chatLog').appendChild(
      msgEl('assistant', `优化失败：${e.message}${optimizeHint(e.message)}`)
    );
    scrollChat();
  }
}

/**
 * 按失败的真实原因给出对症提示。
 *
 * 历史教训：这里原先**无条件**追加「提示词优化需要可用的 API Key」，
 * 于是某次 DNS 故障（getaddrinfo ENOTFOUND api-inference.modelscope.cn）
 * 被显示成 Key 问题，把排查方向完全带偏 —— 用户据此反复检查 Key 与模型名，
 * 而真正的病因在网络解析。错误提示必须跟着真实原因走，不能一句话包打天下。
 */
function optimizeHint(rawMsg) {
  const m = String(rawMsg || '');

  // 服务端已经给出明确指引（确实没配 Key），不必重复追加
  if (/请先到「个人信息」页填写 API Key/.test(m)) return '';

  // 服务端已经翻译成可执行的话（含"已自动兜底"这类关键信息），再叠一层泛泛的建议
  // 只会把真话淹没。实测过一次教训：同一件事被两层各说一遍，用户反而更懵。
  if (/域名解析失败|连接被拒绝或中断|请求超时/.test(m)) return '';

  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|getaddrinfo|fetch failed|socket hang up|network/i.test(
      m
    )
  ) {
    return (
      '\n\n这是网络或 DNS 解析问题，与 API Key 无关。可依次排查：' +
      '\n1. 浏览器能否正常打开 https://www.modelscope.cn' +
      '\n2. 是否开着代理 / DNS 工具，尝试重启它' +
      '\n3. 稍等片刻重试（瞬时解析失败会自行恢复）'
    );
  }
  if (/401|403|Unauthorized|Forbidden|invalid.{0,12}api.{0,2}key|api.{0,2}key.{0,12}invalid|鉴权|未授权/i.test(m)) {
    return '\n\nAPI Key 无效或未获授权，请到「个人信息」页检查。';
  }
  if (/429|rate.?limit|quota|额度|余额不足/i.test(m)) {
    return '\n\n请求过于频繁或额度不足，请稍后重试，或到「个人信息」页查看余额。';
  }
  if (/50[234]|超时|timed? ?out/i.test(m)) {
    return '\n\n模型服务暂时不可用或响应超时，稍后重试通常即可。';
  }
  return '';
}

$('#chatSend').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
// 边打字边判断意图：像是在"改图"却没有图片时，提前把提示挂出来（不用等发送）
let hintTimer = null;
$('#chatInput').addEventListener('input', () => {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateKindHint, 260);
});
$$('#kindSeg .kind-btn').forEach((b) => {
  b.addEventListener('click', () => setConvKind(b.dataset.kind));
});
$('#applyPromptBtn').addEventListener('click', () => {
  if (!state.lastOptimized) return toast('还没有优化结果', 'err');
  applyPrompt({ prompt: state.lastOptimized, whRatio: '' });
  toast('已填入创作台', 'ok');
});

/* ---------- 锁定图区：带入 / 上传 / 清空 ---------- */

$('#lockFromStudio').addEventListener('click', () => lockFromStudio());

$('#lockAdd').addEventListener('click', () => $('#lockFile').click());
$('#lockFile').addEventListener('change', async (e) => {
  await addLockImages(e.target.files);
  e.target.value = '';
});

$('#lockClear').addEventListener('click', async () => {
  const conv = activeConv();
  if (!conv || !state.convImages.length) return;
  if (
    !confirm(
      `清空本对话锁定的 ${state.convImages.length} 张图片？\n\n对话记录与已产出的提示词都不受影响，只是之后改写会退回"看不见画面"的状态。`
    )
  ) {
    return;
  }
  state.convImages = [];
  renderLockImages();
  await saveConvImages(conv, []);
  toast('已清空锁定图片', 'ok');
});

/* ================= 历史 ================= */

async function loadHistory() {
  const r = await api('/api/history');
  state.history = r.ok ? r.items || [] : [];
  renderHistory();
}

$('#histRefresh').addEventListener('click', () => {
  loadHistory();
  toast('已刷新');
});
$('#histSearch').addEventListener('input', renderHistory);

function renderHistory() {
  const kw = $('#histSearch').value.trim().toLowerCase();
  const list = state.history.filter((it) => {
    if (!kw) return true;
    return (
      (it.prompt || '').toLowerCase().includes(kw) ||
      (it.file || '').toLowerCase().includes(kw)
    );
  });

  const grid = $('#historyGrid');
  grid.innerHTML = '';
  $('#histEmpty').style.display = list.length ? 'none' : 'block';
  if (!list.length) {
    $('#histEmpty').innerHTML = kw
      ? '<b>没有匹配的作品</b>换个关键词试试'
      : '<b>还没有作品</b>生成并保存后，作品会出现在这里';
    return;
  }

  for (const it of list) {
    const card = document.createElement('div');
    card.className = 'hist-card' + (it.missing ? ' is-missing' : '');
    card.innerHTML = `
      <div class="hist-thumb">
        ${
          it.missing
            ? '<div class="thumb-missing">图片文件已丢失</div>'
            : `<img src="/outputs/${it.file}" alt="" loading="lazy" />`
        }
        <span class="badge">${MODE_LABEL[it.mode] || it.mode}</span>
      </div>
      <div class="hist-body">
        <div class="hist-name">${it.file}</div>
        <div class="hist-prompt">${escapeHtml(it.prompt || '（无提示词）')}</div>
        <div class="hist-meta">
          <span class="tagm">${it.width || '?'}×${it.height || '?'}</span>
          <span class="tagm">steps ${it.steps ?? '—'}</span>
          <span class="tagm">cfg ${it.guidance ?? '—'}</span>
          <span class="tagm">seed ${fmtSeed(it.seed)}</span>
          ${it.transparent ? '<span class="tagm">透明背景</span>' : ''}
          ${it.missing ? '<span class="tagm tagm-warn">图片已丢失，元数据保留</span>' : ''}
        </div>
      </div>
      <div class="hist-actions">
        <button class="btn btn-ghost btn-sm" data-a="save" ${it.missing ? 'disabled' : ''}>下载</button>
        <button class="btn btn-ghost btn-sm" data-a="copy">复制提示词</button>
        <button class="btn btn-danger btn-sm" data-a="del">删除</button>
      </div>`;

    // 文件缺失时不打开查看器（避免 404 空白视图），但仍可复制提示词
    if (!it.missing) {
      card
        .querySelector('.hist-thumb')
        .addEventListener('click', () => openViewer(`/outputs/${it.file}`, it.file, it));
    }

    card.querySelector('[data-a="save"]').addEventListener('click', () => {
      if (it.missing) return;
      const a = document.createElement('a');
      a.href = `/outputs/${it.file}`;
      a.download = it.file;
      a.click();
    });
    card.querySelector('[data-a="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(it.prompt || '');
        toast('提示词已复制', 'ok');
      } catch (e) {
        toast('复制失败', 'err');
      }
    });
    card.querySelector('[data-a="del"]').addEventListener('click', async () => {
      if (!confirm(`确定删除 ${it.file} ？图片文件会一并删除。`)) return;
      const r = await api(`/api/history/${it.id}`, { method: 'DELETE' });
      if (r.ok) {
        toast('已删除');
        loadHistory();
      } else {
        toast(r.error || '删除失败', 'err');
      }
    });

    grid.appendChild(card);
  }
}

/* ================= 个人信息 ================= */

async function loadConfig() {
  const c = await api('/api/config');
  if (!c.ok) return;
  state.hasApiKey = !!c.hasApiKey;
  state.optimizer = c.optimizer || state.optimizer;
  $('#keyMasked').textContent = c.hasApiKey ? `当前已保存：${c.apiKeyMasked}` : '尚未配置';
  updateKeyStatus(c.hasApiKey);

  $('#optBaseUrl').value = state.optimizer.baseUrl || '';
  $('#optModel').value = state.optimizer.model || '';
  $('#optApiKey').value = state.optimizer.apiKey || '';
  $('#engineInfo').textContent = `官方规范引擎 · ${state.optimizer.model || 'Qwen/Qwen3-8B'}`;

  if (c.hasApiKey) refreshBalance();
}

function updateKeyStatus(ok) {
  const dot = $('#keyDot');
  const txt = $('#keyStatus');
  const side = $('#sideStatus');
  dot.className = `status-dot ${ok ? 'dot-ok' : 'dot-idle'}`;
  txt.textContent = ok ? 'Key 已配置' : '未配置';
  side.innerHTML = ok
    ? '<span class="status-dot dot-ok"></span>Key 已配置'
    : '<span class="status-dot dot-idle"></span>未配置 Key';
}

$('#toggleKey').addEventListener('click', () => {
  const el = $('#apiKey');
  const isPw = el.type === 'password';
  el.type = isPw ? 'text' : 'password';
  $('#toggleKey').textContent = isPw ? '隐藏' : '显示';
});

$('#saveKeyBtn').addEventListener('click', async () => {
  const key = $('#apiKey').value.trim();
  if (!key) return toast('请先粘贴 API Key', 'err');
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
  if (r.ok) {
    state.hasApiKey = true;
    updateKeyStatus(true);
    $('#apiKey').value = '';
    $('#keyMasked').textContent = `当前已保存：${r.apiKeyMasked}`;
    toast('Key 已保存', 'ok');
    refreshBalance();
  } else {
    toast(r.error || '保存失败', 'err');
  }
});

$('#verifyBtn').addEventListener('click', async () => {
  const typed = $('#apiKey').value.trim();
  const r = await api('/api/verify', {
    method: 'POST',
    body: JSON.stringify({ apiKey: typed }),
  });
  if (r.ok) {
    toast(`${r.message} · 可用魔豆 ${r.available ?? '—'}`, 'ok');
    updateKeyStatus(true);
  } else {
    toast(`校验失败：${r.error}`, 'err');
    updateKeyStatus(false);
  }
});

$('#clearKeyBtn').addEventListener('click', async () => {
  if (!confirm('确定清除已保存的 API Key？')) return;
  const r = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ clearApiKey: true }),
  });
  if (r.ok) {
    state.hasApiKey = false;
    updateKeyStatus(false);
    $('#keyMasked').textContent = '尚未配置';
    $('#balAvailable').textContent = '—';
    $('#balTotal').textContent = '—';
    $('#balFrozen').textContent = '—';
    $('#balMeter').style.width = '0%';
    toast('已清除');
  }
});

async function refreshBalance() {
  if (!state.hasApiKey) return;
  $('#balAvailable').textContent = '…';
  const r = await api('/api/balance');
  if (!r.ok) {
    toast(r.error || '额度查询失败', 'err');
    $('#balAvailable').textContent = '—';
    return;
  }
  $('#balAvailable').textContent = r.available ?? '—';
  $('#balTotal').textContent = r.total ?? '—';
  $('#balFrozen').textContent = r.frozen ?? '—';
  if (typeof r.available === 'number' && r.dailyMax) {
    const pct = Math.max(0, Math.min(100, (r.available / r.dailyMax) * 100));
    $('#balMeter').style.width = `${pct}%`;
  }
}

$('#refreshBalance').addEventListener('click', refreshBalance);

// 复制作者邮箱（本地服务是 secure context，clipboard 可用；失败则提示手动复制）
$('#copyMailBtn').addEventListener('click', async () => {
  const mail = '6800400@qq.com';
  try {
    await navigator.clipboard.writeText(mail);
    toast('邮箱已复制', 'ok');
  } catch (e) {
    toast(`复制失败，请手动复制：${mail}`, 'err');
  }
});

$('#saveOptBtn').addEventListener('click', async () => {
  const optimizer = {
    apiKey: $('#optApiKey').value.trim(),
    baseUrl: $('#optBaseUrl').value.trim(),
    model: $('#optModel').value.trim(),
  };
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ optimizer }) });
  if (r.ok) {
    state.optimizer = r.optimizer;
    $('#engineInfo').textContent = `官方规范引擎 · ${optimizer.model || 'Qwen/Qwen3-8B'}`;
    toast('引擎配置已保存', 'ok');
  }
});

/* ================= 初始化 ================= */

loadConfig();
loadHistory();
loadRules(); // 官方规范元信息：文件名 / 大小 / sha256 / 大纲
loadConversations(); // 提示词对话记录，无记录时自动开一个
pollJobs(); // 接上服务端可能还在跑的作业（刷新页面 / 重开标签页都能接回来）
setInterval(pollJobs, 3000);
// 页面不可见时 pollJobs 直接返回（任务在服务端跑，不必空转）；
// 回到前台立刻补一次，避免看到过期状态。
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollJobs();
});
setInterval(() => {
  // 每 60 秒静默刷新额度
  if (state.hasApiKey && $('#view-profile').classList.contains('active')) refreshBalance();
}, 60000);
