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
  refImages: [], // { dataUrl, name }
  hasApiKey: false,
  optimizer: { mode: 'local', apiKey: '', baseUrl: '', model: '' },
  chat: [], // { role:'user'|'ai', text, kind }
  lastOptimized: '',
  polling: null,
  generating: false,
  history: [],
  previewUrl2Item: new Map(),
};

/* ================= 通用工具 ================= */

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, type === 'err' ? 5200 : 3200);
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

const MODE_LABEL = { t2i: '文生图', i2i: '图生图', edit: '图像编辑' };

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
    syncStructHint();
    if (state.mode === 't2i') {
      $('#drop').textContent =
        '点击或拖拽图片到此处上传 · 支持多张（最多 10 张）· 编辑模式建议第 1 张为原图';
    } else if (state.mode === 'i2i') {
      $('#drop').textContent =
        '上传参考图（可多张）· 模型会保持主体特征，按提示词重构画面';
    } else {
      $('#drop').textContent =
        '上传待编辑原图（第 1 张为原图，其余可作为掩码/参考）· 用指令式提示词描述修改';
    }
  });
});

/* ================= 参考图上传 ================= */

const MAX_REF = 10;

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
    });
    d.querySelector('img').addEventListener('click', () => openViewer(im.dataUrl, im.name));
    box.appendChild(d);
  });
}

function readFiles(files) {
  const list = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  const room = MAX_REF - state.refImages.length;
  if (room <= 0) return toast(`最多上传 ${MAX_REF} 张参考图`, 'err');
  list.slice(0, room).forEach((f) => {
    const reader = new FileReader();
    reader.onload = () => {
      state.refImages.push({ dataUrl: reader.result, name: f.name });
      renderThumbs();
    };
    reader.readAsDataURL(f);
  });
  if (list.length > room) toast(`已达上限，仅添加前 ${room} 张`, 'err');
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

/* ================= 参数控件 ================= */

// ModelScope 实测：宽高必须各自落在 [64, 2048] 区间内（单边上限，非总像素上限）
// 超出会返回 "height/width must be integer in [64,2048]"
const SIDE_MIN = 64;
const SIDE_MAX = 2048;

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

$('#prompt').addEventListener('input', updatePromptLen);

$('#resetBtn').addEventListener('click', () => {
  $('#prompt').value = '';
  $('#negativePrompt').value = '';
  $('#seed').value = '';
  $('#customW').value = '';
  $('#customH').value = '';
  $('#steps').value = 30;
  $('#guidance').value = 4;
  $('#sizePreset').value = '0';
  $('#watermark').checked = false;
  $('#promptLen').textContent = `0 / ${PROMPT_MAX}`;
  $('#promptLen').style.color = '';
  bindSlider('#steps', '#stepsVal');
  bindSlider('#guidance', '#guidanceVal', 1);
  toast('参数已重置');
});

$('#toChatBtn').addEventListener('click', () => gotoView('chat'));

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
  return {
    mode: state.mode,
    prompt: $('#prompt').value.trim(),
    negativePrompt: $('#negativePrompt').value.trim(),
    width: w,
    height: h,
    clamped: rawW !== w || rawH !== h,
    rawWidth: rawW,
    rawHeight: rawH,
    steps: Number($('#steps').value),
    guidance: Number($('#guidance').value),
    seed: seedRaw === '' ? null : Number(seedRaw),
    outputFormat: $('#outputFormat').value,
    watermark: $('#watermark').checked,
    images: state.refImages.map((x) => x.dataUrl),
  };
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
  if (p.mode !== 't2i' && p.images.length === 0) {
    return toast('该模式需要至少上传 1 张图片', 'err');
  }
  if (p.prompt.length > PROMPT_MAX) {
    return toast(`提示词 ${p.prompt.length} 字符，超出上限 ${PROMPT_MAX}，请精简后再生成`, 'err');
  }
  if (p.clamped) {
    toast(
      `尺寸 ${p.rawWidth}×${p.rawHeight} 超出单边上限 ${SIDE_MAX}，已自动调整为 ${p.width}×${p.height}`,
      'err'
    );
  }

  setBusy(true);
  const t0 = Date.now();
  $('#resultArea').innerHTML = '';
  $('#resultEmpty').style.display = 'block';
  $('#resultEmpty').textContent = '正在生成，请稍候…';

  let timer = setInterval(() => {
    $('#progressTime').textContent = `${((Date.now() - t0) / 1000).toFixed(0)}s`;
  }, 500);

  try {
    setProgress('正在提交任务到 ModelScope…');
    const sub = await api('/api/generate', { method: 'POST', body: JSON.stringify(p) });
    if (!sub.ok) throw new Error(sub.error || '任务提交失败');

    const taskId = sub.taskId;
    setProgress('任务已提交，正在生成图像…');

    const urls = await pollTask(taskId, t0);
    if (!urls.length) throw new Error('任务完成但未返回图片');

    setProgress('正在保存图片到 outputs…');
    $('#resultEmpty').style.display = 'none';

    for (const u of urls) {
      await saveAndRender(u, p, Date.now() - t0);
    }

    setProgress('完成 ✓', true);
    toast(`生成成功，已保存 ${urls.length} 张`, 'ok');
    setTimeout(() => setProgress('', false), 1600);
  } catch (e) {
    setProgress('', false);
    toast(e.message || '生成失败', 'err');
    $('#resultEmpty').style.display = 'block';
    $('#resultEmpty').textContent = `生成失败：${e.message || '未知错误'}`;
  } finally {
    clearInterval(timer);
    setBusy(false);
    $('#progressTime').textContent = '';
  }
});

async function pollTask(taskId, t0) {
  const deadline = t0 + 10 * 60 * 1000; // 10 分钟上限
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const r = await api(`/api/task?id=${encodeURIComponent(taskId)}`);
    if (!r.ok) throw new Error(r.error || '查询任务失败');

    const st = (r.status || '').toUpperCase();
    if (st === 'SUCCEED' || st === 'SUCCESS') return r.images || [];
    if (st === 'FAILED' || st === 'FAIL') {
      throw new Error(r.error ? String(r.error).slice(0, 300) : '任务执行失败');
    }
    setProgress(`生成中…（${st || 'PENDING'}）`);
  }
  throw new Error('等待超时（10 分钟），任务可能仍在排队，稍后可在历史中确认');
}

async function saveAndRender(remoteUrl, params, durationMs) {
  const autoSave = $('#autoSave').checked;
  let item = null;

  if (autoSave) {
    const r = await api('/api/save', {
      method: 'POST',
      body: JSON.stringify({
        url: remoteUrl,
        meta: {
          mode: params.mode,
          prompt: params.prompt,
          negativePrompt: params.negativePrompt,
          width: params.width,
          height: params.height,
          steps: params.steps,
          guidance: params.guidance,
          seed: params.seed,
          outputFormat: params.outputFormat,
          watermark: params.watermark,
          sourceImages: state.refImages.map((x) => x.name),
          durationMs,
        },
      }),
    });
    if (!r.ok) {
      toast(`保存失败：${r.error}`, 'err');
      return;
    }
    item = r.item;
    renderResult(item.file, item, item.file);
  } else {
    state.previewUrl2Item.set(remoteUrl, { temp: true });
    renderResult(remoteUrl, { temp: true }, '未保存 · 临时预览');
  }
  return item;
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
      } · cfg ${meta.guidance ?? '—'} · seed ${meta.seed ?? '随机'}</span>`
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

/* ================= 提示词优化引擎（官方规范） ================= */

// 侧栏展示：官方规范要点（源自 data/rules/official_*.md）
const STRUCT_T2I = [
  "Step 3 · 开篇句：媒介+风格+主体+背景/色调（约20词）",
  "Step 4 · 元素清单：8–14 个方位短语，覆盖四角与中心",
  "Step 5 · 走画面：按区域顺序或主体顺序逐处描述",
  "Step 6 · 文字设定：逐条给出位置/样式/内容，双语不混排",
  "Step 7 · 光线独立成句：光源、方向、质感、明暗",
  "Step 8 · 收尾一句总括：平衡、色调、风格、氛围",
];

const STRUCT_EDIT = [
  "属性解耦：只改用户点名的属性，其余保持输入保真",
  "身份最难变：人脸特征/商品设计/渲染媒介默认不变",
  "保留处模糊化：只写一句笼统的保留声明，避免重绘漂移",
  "多图必用标签：<image1> <image2>，禁止「图1」",
  "尺寸二选一：wh_ratio 与 ratio_follow 互斥",
  "语言双决策：描述散文语言 ≠ 画面内文字语言",
];

const OFFICIAL_RULES = [
  "提示词是一段约 400–500 词的英文观察式描述，不是逗号标签堆叠。",
  "禁止质量词：masterpiece / 8K / highly detailed / award-winning 一律不写。",
  "分辨率与比例不写进描述正文，只放在 wh_ratio 或 ratio_follow 字段。",
  "输出为单行严格 JSON，无 markdown 代码块、无前后缀文字。",
  "画面内文字用直双引号包裹并保持原语言；描述正文始终英文（编辑模式下随指令语言）。",
  "需求越短，越需要你补全画面 —— 描述长度不因需求简短而缩短。",
  "编辑时详细描述「要保留的东西」反而会让模型重绘漂移，只做笼统保留声明。",
  "比例必须为 16 的倍数；步数 30–50、引导系数 4–7 较常用。",
];

(function initChatSide() {
  const chips = $("#structChips");
  const render = (list) => {
    chips.innerHTML = "";
    list.forEach((s) => {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = s;
      chips.appendChild(c);
    });
  };
  render(STRUCT_T2I);
  window.__renderStruct = render;

  const ul = $("#ruleList");
  OFFICIAL_RULES.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
    ul.appendChild(li);
  });
})();

// 切换到编辑模式时同步侧栏结构提示
function syncStructHint() {
  if (window.__renderStruct) {
    window.__renderStruct(state.mode === "t2i" ? STRUCT_T2I : STRUCT_EDIT);
  }
}


/* --- 官方规范优化（调用后端 /api/optimize） --- */

async function officialOptimize(userText) {
  const kind = state.mode === 't2i' ? 't2i' : 'edit';
  const imgCount = state.refImages.length;
  if (kind === 'edit' && imgCount === 0) {
    throw new Error('编辑模式需要先在创作台上传参考图（最多 10 张）');
  }

  // 取最近的多轮对话作为迭代上下文
  const history = state.chat
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.text }))
    .filter((h) => h.content);

  const r = await api('/api/optimize', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      text: userText,
      images: state.refImages.map((x) => x.name),
      history,
    }),
  });

  if (!r.ok) throw new Error(r.error || '优化失败');

  // 规范化输出：提示词 + 比例字段
  const lines = [r.prompt];
  if (r.whRatio) lines.push(`\nwh_ratio: ${r.whRatio}`);
  if (r.ratioFollow) lines.push(`\nratio_follow: ${r.ratioFollow}`);

  return {
    prompt: r.prompt,
    whRatio: r.whRatio || '',
    ratioFollow: r.ratioFollow || '',
    kind: r.kind,
    display: lines.join(''),
    note:
      `已按官方 ${r.kind === 'edit' ? 'Edit Prompt Enhancer' : 'Image Prompt Rewriting'} 规范重写` +
      (r.whRatio ? ` · 比例 ${r.whRatio}` : '') +
      (r.ratioFollow ? ` · 跟随 ${r.ratioFollow}` : ''),
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

function pushMsg(role, text, kind = '') {
  const log = $('#chatLog');
  const d = document.createElement('div');
  d.className = `msg ${role} ${kind}`;
  if (kind === 'prompt') {
    d.innerHTML = `<span class="lbl">优化后提示词</span>${escapeHtml(text)}`;
  } else {
    d.textContent = text;
  }
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pushPromptCard(result) {
  const log = $('#chatLog');
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

  wrap.innerHTML = `
    <div class="msg ai prompt">
      <span class="lbl">优化后提示词 · ${result.kind === 'edit' ? 'Edit' : 'T2I'} 规范</span>${escapeHtml(
    result.prompt
  )}
      <span class="meta">${escapeHtml(result.note || '')}</span>
    </div>
    ${
      ratioChips
        ? `<div class="chips" style="margin-top:8px">${ratioChips}</div>`
        : ''
    }
    <div class="row" style="margin-top:10px">
      <button class="btn btn-sm" data-act="use">填入创作台</button>
      <button class="btn btn-ghost btn-sm" data-act="gen">填入并生成</button>
      <button class="btn btn-ghost btn-sm" data-act="copy">复制</button>
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
      toast('已复制到剪贴板', 'ok');
    } catch (e) {
      toast('复制失败，请手动选择复制', 'err');
    }
  });
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
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
  input.value = '';
  pushMsg('user', text);
  state.chat.push({ role: 'user', text });

  const kind = state.mode === 't2i' ? 't2i' : 'edit';
  const thinking = pushMsg(
    'ai',
    `正在按官方 ${kind === 'edit' ? 'Edit' : 'T2I'} 规范重写…`
  );
  thinking.style.opacity = '0.6';

  try {
    const result = await officialOptimize(text);
    thinking.remove();
    state.lastOptimized = result.prompt;
    // 以 JSON 形式入历史，便于模型理解上一版结果
    state.chat.push({
      role: 'assistant',
      text: JSON.stringify({ rewritten_prompt: result.prompt, wh_ratio: result.whRatio }),
    });
    pushPromptCard(result);
  } catch (e) {
    thinking.remove();
    pushMsg(
      'ai',
      `优化失败：${e.message}\n\n提示词优化需要可用的 API Key（在「个人信息」页配置）。`
    );
  }
}

$('#chatSend').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
$('#applyPromptBtn').addEventListener('click', () => {
  if (!state.lastOptimized) return toast('还没有优化结果', 'err');
  applyPrompt({ prompt: state.lastOptimized, negative: $('#negativePrompt').value });
  toast('已填入创作台', 'ok');
});

// 欢迎语
pushMsg(
  'ai',
  '你好，我是 Qwen-Image-2.1 提示词助手。\n\n直接说出你想要什么画面即可，我会按官方规则重写为高质量提示词。例如：\n· 逆光下的亚洲女性人像，2:3 竖版，电影感柔光\n· 一个透明背景的水彩猫咪素材\n· 把图1的海报文字改成 "Qwen-Image-2.1"\n\n结果不满意可以继续说「再暗一点」「换成 3D 风格」，我会在此基础上迭代。'
);

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
          <span class="tagm">seed ${it.seed ?? '随机'}</span>
          ${it.outputFormat === 'RGBA' ? '<span class="tagm">RGBA</span>' : ''}
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

// 检查官方规范文件是否就位
fetch('/api/rules')
  .then((r) => r.json())
  .then((r) => {
    if (!r || !r.ok) return;
    const miss = [];
    if (!r.rules?.t2i) miss.push('official_t2i.md');
    if (!r.rules?.edit) miss.push('official_edit.md');
    if (miss.length) {
      toast(`缺少官方规范文件：${miss.join('、')}，提示词优化将不可用`, 'err');
    }
  })
  .catch(() => {});

loadConfig();
loadHistory();
setInterval(() => {
  // 每 60 秒静默刷新额度
  if (state.hasApiKey && $('#view-profile').classList.contains('active')) refreshBalance();
}, 60000);
