/**
 * Qwen-Image-2.1 Studio — 本地后端服务
 * 零第三方依赖：静态托管 + ModelScope API 代理 + 本地文件读写
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
// 历史回写前的滚动备份：历史元数据（提示词/参数）不可再生，
// 图片丢了还能重出，元数据丢了就没了，所以永远保留上一版。
const HISTORY_BAK_FILE = path.join(DATA_DIR, 'history.bak.json');

const MS_BASE = 'https://api-inference.modelscope.cn';
const MS_WEB = 'https://modelscope.cn';
const MODEL_ID = 'Qwen/Qwen-Image-2.1';
const PORT = Number(process.env.PORT) || 5178;

// ModelScope 生图接口对 prompt 的硬限制。
// 文档写作 2000，但实测 3000 可通过、5000 被拒，
// 真实阈值为 4000（报错信息：invalid prompt or prompt length more than 4000）。
const PROMPT_HARD_LIMIT = 4000;
// 规范要求 400-500 词 ≈ 2600-2900 字符；超过此值即主动压缩，留出安全余量。
const PROMPT_SAFE_TARGET = 3200;

// 官方提示词规范（来自 Qwen-Image-2.1 官方 system prompt）
const RULES_DIR = path.join(ROOT, 'data', 'rules');
const RULE_FILES = {
  t2i: path.join(RULES_DIR, 'official_t2i.md'),
  edit: path.join(RULES_DIR, 'official_edit.md'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ---------------- 工具函数 ---------------- */

function ensureDirs() {
  for (const d of [PUBLIC_DIR, OUTPUTS_DIR, DATA_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

async function readJson(file, fallback) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return fallback;
  }
}

// 原子写：先写临时文件再重命名，避免半截 JSON
async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** 写历史（唯一入口）：覆盖前留一份滚动备份，任何一次误写都可回退 */
async function writeHistory(list) {
  try {
    await fsp.copyFile(HISTORY_FILE, HISTORY_BAK_FILE);
  } catch (e) {
    /* 首次写入时源文件不存在，无需备份 */
  }
  await writeJson(HISTORY_FILE, list);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

async function setConfig(patch) {
  const cur = getConfig();
  const next = { ...cur, ...patch };
  await writeJson(CONFIG_FILE, next);
  return next;
}

async function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 通用 HTTPS 请求（返回 {status, headers, body:Buffer}） */
function requestUrl(urlStr, { method = 'GET', headers = {}, body = null, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`非法 URL: ${urlStr}`));
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 向 ModelScope 发起 JSON API 调用 */
async function msApi(urlStr, { method = 'GET', apiKey, body = null, taskType = null, timeout } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (taskType) headers['X-ModelScope-Task-Type'] = taskType;
  const res = await requestUrl(urlStr, {
    method,
    headers,
    body: body ? Buffer.from(JSON.stringify(body), 'utf8') : null,
    timeout,
  });
  let json = null;
  const text = res.body.toString('utf8');
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { _raw: text.slice(0, 800) };
  }
  return { status: res.status, json };
}

function pickKey(provided) {
  const key = (provided || '').trim();
  if (key) return key;
  return (getConfig().apiKey || '').trim();
}

/* ---------------- 业务：文件名与历史 ---------------- */

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 生成 yyyymmdd####.png，#### 为当日递增序号，从 0001 开始 */
async function nextOutputName(ext = 'png') {
  const prefix = localDateStr();
  const files = await fsp.readdir(OUTPUTS_DIR).catch(() => []);
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d{4})\\.[a-z]+$`, 'i');
  for (const f of files) {
    const m = f.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const seq = max + 1;
  return {
    filename: `${prefix}${String(seq).padStart(4, '0')}.${ext}`,
    seq,
    dateStr: prefix,
  };
}

/* ---------------- 路由处理 ---------------- */

// GET /api/config  — 读取本地配置（不回传完整 key）
function handleGetConfig(res) {
  const cfg = getConfig();
  const key = (cfg.apiKey || '').trim();
  sendJson(res, 200, {
    ok: true,
    hasApiKey: !!key,
    apiKeyMasked: key ? `${key.slice(0, 6)}${'*'.repeat(Math.max(0, key.length - 10))}${key.slice(-4)}` : '',
    optimizer: cfg.optimizer || { mode: 'local', apiKey: '', baseUrl: '', model: '' },
  });
}

// POST /api/config  — 保存配置
async function handleSaveConfig(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '配置格式错误' });
  }
  const patch = {};
  if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
    patch.apiKey = payload.apiKey.trim();
  }
  if (payload.clearApiKey === true) patch.apiKey = '';
  if (payload.optimizer && typeof payload.optimizer === 'object') {
    const o = payload.optimizer;
    patch.optimizer = {
      mode: o.mode === 'llm' ? 'llm' : 'local',
      apiKey: typeof o.apiKey === 'string' ? o.apiKey.trim() : '',
      baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl.trim() : '',
      model: typeof o.model === 'string' ? o.model.trim() : '',
    };
  }
  await setConfig(patch);
  return handleGetConfig(res);
}

// GET /api/balance?key=xxx — 查询魔豆余额
async function handleBalance(req, res, url) {
  const key = pickKey(url.searchParams.get('key'));
  if (!key) return sendJson(res, 400, { ok: false, error: '尚未配置 API Key' });
  try {
    const { status, json } = await msApi(`${MS_WEB}/openapi/v1/magicubes/balance`, {
      apiKey: key,
      timeout: 30000,
    });
    if (status !== 200 || json.success === false) {
      const msg = json.message || json.error || `HTTP ${status}`;
      return sendJson(res, status === 401 ? 401 : 400, { ok: false, error: `鉴权或查询失败：${msg}` });
    }
    const d = json.data || {};
    return sendJson(res, 200, {
      ok: true,
      total: d.total_balance ?? null,
      available: d.available_balance ?? null,
      frozen: d.frozen_amount ?? null,
      dailyMax: 250,
    });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `网络错误：${e.message}` });
  }
}

// POST /api/verify — 校验 Key 是否可用（顺便确认端点）
async function handleVerify(req, res) {
  const raw = await readBody(req);
  let payload = {};
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch (e) {}
  const key = pickKey(payload.apiKey);
  if (!key) return sendJson(res, 400, { ok: false, error: '尚未配置 API Key' });
  try {
    const r = await msApi(`${MS_WEB}/openapi/v1/magicubes/balance`, { apiKey: key, timeout: 30000 });
    if (r.status === 200 && r.json.success !== false) {
      const d = r.json.data || {};
      return sendJson(res, 200, {
        ok: true,
        message: 'Key 校验通过',
        available: d.available_balance ?? null,
        total: d.total_balance ?? null,
      });
    }
    return sendJson(res, 200, {
      ok: false,
      error: r.json.message || r.json.error || `HTTP ${r.status}`,
    });
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: `网络错误：${e.message}` });
  }
}

// GET /api/history — 读取历史
// 图片文件缺失时只标记 missing，绝不自动删除记录：历史元数据不可再生，
// 静默剪枝会造成不可逆损失。删除一律走 DELETE /api/history/:id 显式操作。
async function handleHistory(res) {
  const list = await readJson(HISTORY_FILE, []);
  let statusChanged = false;
  const items = list.map((item) => {
    const missing = !(item.file && fs.existsSync(path.join(OUTPUTS_DIR, item.file)));
    if (!!item.missing !== missing) statusChanged = true;
    return { ...item, missing };
  });
  if (statusChanged) await writeHistory(items);
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  sendJson(res, 200, { ok: true, items });
}

// DELETE /api/history/:id — 删除记录（同时删除图片文件）
async function handleDeleteHistory(res, id, keepFile) {
  const list = await readJson(HISTORY_FILE, []);
  const target = list.find((x) => x.id === id);
  if (!target) return sendJson(res, 404, { ok: false, error: '记录不存在' });
  const next = list.filter((x) => x.id !== id);
  await writeHistory(next);
  if (!keepFile && target.file) {
    const fp = path.join(OUTPUTS_DIR, path.basename(target.file));
    await fsp.unlink(fp).catch(() => {});
  }
  sendJson(res, 200, { ok: true });
}

/**
 * POST /api/generate — 提交生图任务（异步返回 task 信息由前端轮询）
 * body: { apiKey?, mode, prompt, negativePrompt, width, height, steps, guidance,
 *         seed, outputFormat, watermark, images: [dataURL...], loras? }
 */
async function handleGenerate(req, res) {
  const raw = await readBody(req);
  let p;
  try {
    p = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求格式错误' });
  }
  const key = pickKey(p.apiKey);
  if (!key) return sendJson(res, 400, { ok: false, error: '尚未配置 API Key，请先到「个人信息」页填写' });
  if (!p.prompt || !String(p.prompt).trim()) {
    return sendJson(res, 400, { ok: false, error: '提示词不能为空' });
  }

  const mode = ['t2i', 'i2i', 'edit'].includes(p.mode) ? p.mode : 't2i';

  // 组装 ModelScope 请求体
  const payload = {
    model: MODEL_ID,
    prompt: String(p.prompt),
  };
  if (p.negativePrompt && String(p.negativePrompt).trim()) {
    payload.negative_prompt = String(p.negativePrompt);
  }
  // 尺寸：Qwen-Image-2.1 只认 `size` 字符串（"WxH"）。
  // 实测：传 width/height 会被接口静默忽略，模型退回默认纵向比例（760x1280）。
  // 约束：宽高各自必须在 [64, 2048] 内（单边上限，非总像素上限），且为 16 的倍数。
  if (p.width && p.height) {
    const clamp = (v) => {
      const n = Math.round(Number(v) / 16) * 16;
      return Math.max(64, Math.min(2048, n));
    };
    const w = clamp(p.width);
    const h = clamp(p.height);
    payload.size = `${w}x${h}`;
  } else if (p.size) {
    payload.size = String(p.size);
  }
  if (p.steps) payload.num_inference_steps = Number(p.steps);
  if (p.guidance !== undefined && p.guidance !== null && p.guidance !== '') {
    payload.guidance_scale = Number(p.guidance);
  }
  if (p.seed !== undefined && p.seed !== null && p.seed !== '') {
    payload.seed = Number(p.seed);
  }
  if (p.watermark === true) payload.watermark = true;

  // 图生图 / 编辑：把参考图以 dataURL 形式提交
  const imgs = Array.isArray(p.images) ? p.images.filter((x) => typeof x === 'string' && x.startsWith('data:')) : [];
  if (imgs.length) {
    payload.image = imgs.length === 1 ? imgs[0] : imgs.slice(0, 10);
  }

  try {
    const { status, json } = await msApi(`${MS_BASE}/v1/images/generations`, {
      method: 'POST',
      apiKey: key,
      taskType: 'image_generation',
      body: payload,
      timeout: 90000,
    });
    // ModelScope 兼容两种异步返回：header 里带 task_id，或 body.task_id
    const taskId = json.task_id || json.data?.task_id;
    if (status >= 400 || !taskId) {
      const msg =
        json.message ||
        json.error?.message ||
        json.error ||
        json._raw ||
        `提交失败 HTTP ${status}`;
      return sendJson(res, 400, { ok: false, error: String(msg).slice(0, 500) });
    }
    sendJson(res, 200, { ok: true, taskId });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: `网络错误：${e.message}` });
  }
}

// GET /api/task?id=xxx — 轮询任务状态
async function handleTask(req, res, url) {
  const key = pickKey(url.searchParams.get('key'));
  const taskId = (url.searchParams.get('id') || '').trim();
  if (!key) return sendJson(res, 400, { ok: false, error: '尚未配置 API Key' });
  if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task id' });
  try {
    const { status, json } = await msApi(`${MS_BASE}/v1/tasks/${encodeURIComponent(taskId)}`, {
      apiKey: key,
      taskType: 'image_generation',
      timeout: 60000,
    });
    if (status >= 400) {
      return sendJson(res, 400, {
        ok: false,
        error: String(json.message || json.error || `HTTP ${status}`).slice(0, 400),
      });
    }
    const st = (json.task_status || json.status || '').toUpperCase();
    const urls = json.output_images || json.result?.urls || json.result?.url || [];
    const urlList = Array.isArray(urls) ? urls : [urls];
    sendJson(res, 200, {
      ok: true,
      status: st,
      error: json.error || json.message || null,
      images: urlList.filter(Boolean),
      metrics: json.metrics || json.task_metrics || null,
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: `网络错误：${e.message}` });
  }
}

/**
 * POST /api/save — 下载远程图片并存到 outputs/yyyymmdd####.png，写入历史
 * body: { url, meta:{...} }
 */
async function handleSave(req, res) {
  const raw = await readBody(req);
  let p;
  try {
    p = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求格式错误' });
  }
  if (!p.url || !/^https?:\/\//.test(p.url)) {
    return sendJson(res, 400, { ok: false, error: '缺少合法的图片 URL' });
  }

  let imgBuf;
  try {
    const r = await requestUrl(p.url, { timeout: 180000 });
    if (r.status !== 200 || !r.body || r.body.length < 100) {
      return sendJson(res, 400, { ok: false, error: `图片下载失败 HTTP ${r.status}` });
    }
    imgBuf = r.body;
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `下载失败：${e.message}` });
  }

  // 需求要求统一 .png 命名；非 PNG 内容时用 sharp 不可用则直接原样落盘为 .png
  const { filename, seq, dateStr } = await nextOutputName('png');
  const filePath = path.join(OUTPUTS_DIR, filename);
  await fsp.writeFile(filePath, imgBuf);

  // 读回真实像素尺寸：接口可能忽略尺寸参数并退回默认比例，需如实记录
  const actual = readPngSize(imgBuf);
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const requested = meta.width && meta.height ? { w: meta.width, h: meta.height } : null;
  const mismatch = !!(requested && actual && (actual.w !== requested.w || actual.h !== requested.h));

  const id = crypto.randomUUID();
  const item = {
    id,
    file: filename,
    seq,
    dateStr,
    size: imgBuf.length,
    createdAt: Date.now(),
    mode: meta.mode || 't2i',
    model: MODEL_ID,
    prompt: meta.prompt || '',
    negativePrompt: meta.negativePrompt || '',
    // 记录真实尺寸，便于排查"参数没生效"
    width: actual ? actual.w : meta.width || null,
    height: actual ? actual.h : meta.height || null,
    requestedWidth: requested ? requested.w : null,
    requestedHeight: requested ? requested.h : null,
    dimensionMismatch: mismatch,
    steps: meta.steps ?? null,
    guidance: meta.guidance ?? null,
    seed: meta.seed ?? null,
    outputFormat: actual && actual.colorType === 6 ? 'RGBA' : 'RGB',
    watermark: !!meta.watermark,
    sourceImages: Array.isArray(meta.sourceImages) ? meta.sourceImages : [],
    durationMs: meta.durationMs ?? null,
  };

  const list = await readJson(HISTORY_FILE, []);
  list.unshift(item);
  await writeHistory(list);

  sendJson(res, 200, { ok: true, item, path: `outputs/${filename}` });
}

/** 从 PNG/JPEG 头部读取真实像素尺寸与色彩类型 */
function readPngSize(buf) {
  try {
    // PNG: 签名 8 字节 + IHDR 长度4 + 'IHDR'4 + 宽4 + 高4
    if (
      buf.length > 26 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25] };
    }
    // JPEG: 扫描 SOF 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), colorType: 2 };
        }
        i += 2 + len;
      }
    }
  } catch (e) {
    /* 读取失败则返回 null，不影响主流程 */
  }
  return null;
}

/* ---------------- 官方提示词优化 ---------------- */

/** 读取官方规范文件（带缓存） */
const _ruleCache = {};
function readRule(kind) {
  const file = RULE_FILES[kind] || RULE_FILES.t2i;
  if (_ruleCache[file]) return _ruleCache[file];
  try {
    const txt = fs.readFileSync(file, 'utf8');
    _ruleCache[file] = txt;
    return txt;
  } catch (e) {
    return null;
  }
}

/** 推断任务类型：给了图片 → edit；纯文字 → t2i */
function inferTaskKind(body) {
  const n = Array.isArray(body.images) ? body.images.filter(Boolean).length : 0;
  if (n > 0) return 'edit';
  // 文字里出现明确的改图动词，也判为 edit
  if (/(改图|修图|换成|替换|去掉|移除|删除掉|加上|扩图|延伸|换背景|换脸|换装|风格迁移|P到|放到|合成|保持.{0,6}不变)/.test(String(body.text || ''))) {
    return 'edit';
  }
  return 't2i';
}

/** 解析模型返回，容错提取 JSON */
function parseOptimizerOutput(raw, kind) {
  let text = String(raw || '').trim();

  // 去掉可能的 markdown 代码块围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  };

  let obj = tryParse(text);

  // 退一步：抓第一个 {...} 再试
  if (!obj) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }

  // 再退一步：JSON 字符串里含未转义换行 / 制表符，做一次修复后重试
  if (!obj) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const repaired = m[0].replace(/"((?:[^"\\]|\\.)*)"/g, (full) =>
        full.replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t')
      );
      obj = tryParse(repaired);
    }
  }

  // 最后兜底：用正则分别抽取字段（应对 JSON 严重破损）
  if (!obj) {
    const getField = (name) => {
      const re = new RegExp(`"${name}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,|\\})`);
      const mm = text.match(re);
      return mm ? mm[1] : '';
    };
    const rp = getField('rewritten_prompt');
    if (rp) {
      obj = {
        rewritten_prompt: rp,
        wh_ratio: getField('wh_ratio'),
        ratio_follow: getField('ratio_follow'),
      };
    }
  }

  if (obj && typeof obj === 'object' && obj.rewritten_prompt) {
    let prompt = String(obj.rewritten_prompt);

    // 规范要求：单段连续文本，不含换行
    prompt = prompt.replace(/\r\n|\r|\n/g, ' ').replace(/\s{2,}/g, ' ');

    // 清理可能混入描述正文的比例/分辨率信息（规范明确禁止）
    prompt = prompt.replace(
      /\s*[（(]?(?:resolution|aspect ratio|aspect|比例|尺寸)\s*[:：]?\s*\d+\s*[:：]\s*\d+[)）]?/gi,
      ''
    );
    prompt = prompt.replace(/\s*\b\d{3,4}\s*[x×]\s*\d{3,4}\b\s*/gi, ' ');
    prompt = prompt.replace(/\s*\b(?:2K|4K|8K)\b\s*/gi, ' ');

    // 清理常见质量词（规范明确禁止）
    prompt = prompt.replace(
      /,?\s*\b(?:masterpiece|best quality|award-winning|award winning|ultra[- ]?detailed|highly detailed|8k uhd|photorealistic quality)\b/gi,
      ''
    );

    prompt = prompt.replace(/\s{2,}/g, ' ').replace(/^[,;\s]+|[,;\s]+$/g, '').trim();

    if (prompt) {
      const wh = String(obj.wh_ratio || '').trim();
      const rf = String(obj.ratio_follow || '').trim();

      // 规范化比例字段：校验 W:H 格式
      const whOk = /^\d+\s*[:：]\s*\d+$/.test(wh) ? wh.replace(/\s/g, '').replace('：', ':') : '';
      const rfOk = /^<image\d+>$/.test(rf) ? rf : '';

      // 互斥兜底：两个都有值时保留 ratio_follow（编辑场景更常见）
      const finalWh = whOk && rfOk ? '' : whOk;

      return {
        ok: true,
        prompt,
        whRatio: finalWh,
        ratioFollow: rfOk,
        raw: text,
      };
    }
  }

  // 兜底：模型没按 JSON 输出，把正文当提示词（排除空 JSON 对象）
  const plain = text.replace(/^\s*\{\s*\}\s*$/, '').trim();
  if (plain) {
    return { ok: true, prompt: plain, whRatio: '', ratioFollow: '', raw: text, fallback: true };
  }
  return { ok: false, error: '优化结果为空，请重试' };
}

/**
 * POST /api/optimize — 按 Qwen-Image-2.1 官方规范优化提示词
 * body: { apiKey?, baseUrl?, model?, kind?:'t2i'|'edit', text, images?:[name...], history?:[{role,content}] }
 */
async function handleOptimize(req, res) {
  const raw = await readBody(req);
  let p;
  try {
    p = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求格式错误' });
  }

  const text = String(p.text || '').trim();
  if (!text) return sendJson(res, 400, { ok: false, error: '请先输入你的需求' });

  const kind = p.kind === 'edit' || p.kind === 't2i' ? p.kind : inferTaskKind(p);
  const rule = readRule(kind);
  if (!rule) {
    return sendJson(res, 500, {
      ok: false,
      error: `缺少官方规范文件 data/rules/official_${kind}.md，请确认文件存在`,
    });
  }

  const cfg = getConfig();
  const opt = cfg.optimizer || {};
  const apiKey = (p.apiKey || opt.apiKey || cfg.apiKey || '').trim();
  if (!apiKey) {
    return sendJson(res, 400, {
      ok: false,
      error: '提示词优化需要调用大模型，请先到「个人信息」页填写 API Key',
    });
  }

  // 规范文件本身即官方 system prompt，直接作为 system 消息
  const messages = [{ role: 'system', content: rule }];

  // 带上历史轮次，实现多轮迭代优化
  if (Array.isArray(p.history)) {
    for (const h of p.history.slice(-8)) {
      if (!h || !h.role || !h.content) continue;
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: String(h.content) });
      }
    }
  }

  // 编辑模式：补充输入图数量，让模型正确使用 <imageN> 标签
  const imgCount = Array.isArray(p.images) ? p.images.filter(Boolean).length : 0;
  let userContent = text;
  if (kind === 'edit') {
    userContent = `【本次输入图片数量：${imgCount} 张${
      imgCount >= 2 ? `，请使用 <image1>~<image${imgCount}> 标签引用` : ''
    }】\n\n用户指令：${text}`;
  }
  messages.push({ role: 'user', content: userContent });

  let baseUrl = (p.baseUrl || opt.baseUrl || 'https://api-inference.modelscope.cn/v1').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    return sendJson(res, 400, { ok: false, error: 'Base URL 格式不正确' });
  }
  const model = (p.model || opt.model || 'Qwen/Qwen3-8B').trim();

  const callModel = async (msgs) => {
    const { status, json } = await msApi(`${baseUrl}/chat/completions`, {
      method: 'POST',
      apiKey,
      body: { model, messages: msgs, temperature: 0.7, max_tokens: 4000, stream: false },
      timeout: 180000,
    });
    if (status >= 400) {
      const msg = json?.error?.message || json?.message || json?._raw || `HTTP ${status}`;
      throw new Error(`优化失败：${String(msg).slice(0, 300)}`);
    }
    const content =
      json?.choices?.[0]?.message?.content || json?.output?.text || json?.data?.[0]?.content || '';
    return parseOptimizerOutput(content, kind);
  };

  try {
    let parsed = await callModel(messages);

    // 规范要求的 400-500 词描述可能逼近接口上限；若超标则追加压缩指令重试一次
    if (parsed.ok && parsed.prompt.length > PROMPT_SAFE_TARGET) {
      const compressMsgs = messages.concat([
        {
          role: 'user',
          content:
            `上一次输出长度为 ${parsed.prompt.length} 字符，超过了接口可接受的安全长度。\n` +
            `请严格遵守以下约束重新输出，仍然只返回同样的 JSON 结构：\n` +
            `1. rewritten_prompt 必须控制在 ${PROMPT_SAFE_TARGET} 字符以内（这是硬性要求）；\n` +
            `2. 仍然保持官方规范的结构（开篇句 / 方位描述 / 光线句 / 收尾总括句）；\n` +
            `3. 精简手法：合并同类描述、删去次要细节、压缩修饰语，而不是删掉整个步骤；\n` +
            `4. 用户明确指定的文字内容、数量、颜色、位置必须完整保留，不得删减；\n` +
            `5. 不要输出任何解释文字，只输出 JSON。`,
        },
      ]);
      try {
        const retry = await callModel(compressMsgs);
        if (retry.ok && retry.prompt.length < parsed.prompt.length) {
          parsed = retry;
          parsed.compressed = true;
        }
      } catch (e) {
        // 压缩重试失败时保留首轮结果，由前端提示用户手工精简
      }
    }

    if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

    sendJson(res, 200, {
      ok: true,
      kind,
      prompt: parsed.prompt,
      whRatio: parsed.whRatio,
      ratioFollow: parsed.ratioFollow,
      model,
      chars: parsed.prompt.length,
      hardLimit: PROMPT_HARD_LIMIT,
      compressed: !!parsed.compressed,
      overLimit: parsed.prompt.length > PROMPT_HARD_LIMIT,
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || '优化失败' });
  }
}

// GET /api/rules — 返回规范文件是否存在及元信息
async function handlePluginConfig(res) {
  sendJson(res, 200, {
    ok: true,
    rules: {
      t2i: !!readRule('t2i'),
      edit: !!readRule('edit'),
    },
    model: MODEL_ID,
  });
}

/* ---------------- 提示词规则库（供前端「对话优化」使用） ---------------- */

const PROMPT_RULES = {
  model: MODEL_ID,
  source: 'https://modelscope.cn/models/Qwen/Qwen-Image-2.1',
  structure: ['主体 Subject', '外观/服饰 Attributes', '动作/姿态 Action', '环境/背景 Scene', '光线 Lighting', '镜头/构图 Camera', '风格 Style', '画质/文字 Quality&Text'],
  tips: [
    'Qwen-Image-2.1 建议使用自然语言长句描述，而非 Danbooru 标签堆叠，成图信息密度更高。',
    '需要中文文字排版时，把要出现的文字用英文引号包裹写进提示词，模型文字渲染能力很强。',
    '生成透明素材时，在提示词中明确 "transparent background, isolated on transparent background, alpha channel"。',
    '图像编辑时，用指令式句式：保持 X 不变，把 Y 改成 Z（Keep ... unchanged, change ... into ...）。',
    '多图合成时，用 "the person in image 1 / the product in image 2" 指明参考图。',
    '需要高清细节时补充 "highly detailed, sharp focus, photorealistic"；避免歧义副词。',
  ],
};

/* 尺寸预设统一由前端 public/app.js 的 SIZES 维护（单边上限 2048，见该处注释）。
   此处曾有一份未使用的 PRESETS 常量，其中 2048x3072 已超单边上限，故移除，避免误导。 */

/* ---------------- 静态文件 ---------------- */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // outputs 与 public 都可访问
  let filePath;
  if (rel.startsWith('/outputs/')) {
    filePath = path.join(OUTPUTS_DIR, path.basename(rel));
  } else {
    filePath = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  }

  const resolved = path.resolve(filePath);
  const allowed = [path.resolve(PUBLIC_DIR), path.resolve(OUTPUTS_DIR)];
  if (!allowed.some((a) => resolved.startsWith(a))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const st = await fsp.stat(resolved);
    if (!st.isFile()) throw new Error('not file');
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    fs.createReadStream(resolved).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname === '/api/config' && req.method === 'GET') return void handleGetConfig(res);
    if (pathname === '/api/config' && req.method === 'POST') return void (await handleSaveConfig(req, res));
    if (pathname === '/api/balance' && req.method === 'GET') return void (await handleBalance(req, res, url));
    if (pathname === '/api/verify' && req.method === 'POST') return void (await handleVerify(req, res));
    if (pathname === '/api/history' && req.method === 'GET') return void (await handleHistory(res));
    if (pathname.startsWith('/api/history/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      const keepFile = url.searchParams.get('keepFile') === '1';
      return void (await handleDeleteHistory(res, id, keepFile));
    }
    if (pathname === '/api/generate' && req.method === 'POST') return void (await handleGenerate(req, res));
    if (pathname === '/api/task' && req.method === 'GET') return void (await handleTask(req, res, url));
    if (pathname === '/api/save' && req.method === 'POST') return void (await handleSave(req, res));
    if (pathname === '/api/optimize' && req.method === 'POST') return void (await handleOptimize(req, res));
    if (pathname === '/api/rules' && req.method === 'GET') return void handlePluginConfig(res);

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '未知接口' });

    return void (await serveStatic(req, res, pathname));
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || '服务器内部错误' });
  }
});

ensureDirs();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Qwen-Image-2.1 Studio 已启动`);
  console.log(`  → http://127.0.0.1:${PORT}\n`);
  console.log(`  输出目录: ${OUTPUTS_DIR}`);
  console.log(`  配置目录: ${DATA_DIR}\n`);
});
