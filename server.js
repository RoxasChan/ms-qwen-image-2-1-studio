/**
 * Qwen-Image-2.1 Studio — 本地后端服务
 * 零第三方依赖：静态托管 + ModelScope API 代理 + 本地文件读写
 */
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
// 对话锁定的参考图（已压缩）落盘于此，对话 JSON 里只留文件名引用。
// 与 outputs/ 形成对称：一个存"模型产出的图"，一个存"喂给模型的图"。
// 好处：conversations.json 不再夹带 base64（6 张图原本能撑到 8MB），
// 列表接口天然变小，图片可被直接查看/替换/复用。
const INPUTS_DIR = path.join(ROOT, 'inputs');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
// 历史回写前的滚动备份：历史元数据（提示词/参数）不可再生，
// 图片丢了还能重出，元数据丢了就没了，所以永远保留上一版。
const HISTORY_BAK_FILE = path.join(DATA_DIR, 'history.bak.json');
// 生成作业（一次多张 + 后台轮询）的落盘位置。只存参数与任务 id，不存图片。
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

const MS_BASE = 'https://api-inference.modelscope.cn';
/* ModelScope 的「网页/业务」域名（余额、Key 校验走这里，生图不走）。
   ⚠️ 不要用裸域名 modelscope.cn 单打独斗：实测（2026-09-25）本机解析器
   （代理接管，指向 127.0.0.1）对裸域名稳定返回 getaddrinfo ENOTFOUND —— 20/20 全失败，
   而 www.modelscope.cn 20/20 成功；两者指向同一组 IP（47.92.141.220 / 39.99.133.195），
   用公网 DNS（8.8.8.8 / 223.5.5.5）查询裸域名也正常，说明**域名本身没问题**，
   是这台机器的解析路径对该域名不友好。nslookup 反而正常，因为它绕过 getaddrinfo，
   直接向系统 DNS（192.168.1.1）发查询 —— 这正是"nslookup 能通、程序报 ENOTFOUND"的原因。
   所以这里做成候选列表，按顺序试，谁先成功用谁，并缓存结果。 */
const MS_WEB_CANDIDATES = ['https://www.modelscope.cn', 'https://modelscope.cn'];
let msWebBase = ''; // 探测成功后缓存，避免每次都先撞一次失败的域名
const MODEL_ID = 'Qwen/Qwen-Image-2.1';
const PORT = Number(process.env.PORT) || 5178;

// ModelScope 生图接口对 prompt 的硬限制。
// 文档写作 2000，但实测 3000 可通过、5000 被拒，
// 真实阈值为 4000（报错信息：invalid prompt or prompt length more than 4000）。
const PROMPT_HARD_LIMIT = 4000;
// 规范要求 400-500 词 ≈ 2600-2900 字符；超过此值即主动压缩，留出安全余量。
const PROMPT_SAFE_TARGET = 3200;

/* ---------------- 生图接口参数真值表（2026-09-25 实测） ----------------
   这个接口对**未知参数一律静默忽略**：返回 200、任务 SUCCEED、不报错、不打日志，
   参数就是不生效。所以字段名写错的代价是「界面上的旋钮全是摆设」，肉眼看不出。
   下面每一条都是用一个越界值去打接口、看它是否报校验错误得出的：
   报错 = 字段被识别；HTTP 200 = 字段不存在。字段名以这里为准。

     字段名                实测范围              备注
     ------------------    ------------------    ----------------------------
     size                  "WxH"，单边 64~2048   传 width/height 被静默忽略
     steps                 [1, 50]               ✗ num_inference_steps 无效
     guidance              [1.0, 20.0]           ✗ guidance_scale 无效
     seed                  [-1, 2147483647]      -1 即随机
     negative_prompt       —                     guidance ≤ 1 时负向分支失效
     image_url             data URI 或数组       **最多 4 张**，第 5 张直接 400
     prompt                实测 4000 字符内      文档写 2000，偏保守
     loras                 {"repo_id": weight}   最多 6 个、权重和 1.0；**真实生效**
     prompt_extend         ✗ 不被识别            意外之喜：不会二次改写我们的提示词
     cfg_scale             ✗ 不被识别            DiffSynth 的名字不适用于本接口
     watermark             ✗ 不被识别            接口没有水印开关
     outputFormat          ✗ 不被识别            模型恒定输出 RGBA，详见下方注释

   另有两条容易误传的：
     - size 只要求 **16 的倍数**，不需要 32 对齐（1360x2048 原样接受，实测）
     - 不存在「输出格式」参数。模型 VAE 工作在 4 通道 RGBA 空间，**每张图都是
       RGBA 容器**（历史 16/16 colorType=6）；画面是否真的透明完全由提示词决定。
       官方模型卡为此给了固定句式（见 TRANSPARENT_* 常量）。                */

const API_SIZE_MIN = 64; // 单边下限
const API_SIZE_MAX = 2048; // 单边上限（是单边，不是总像素）
const API_SIZE_STEP = 16; // 必须是 16 的倍数
const API_STEPS_MIN = 1;
const API_STEPS_MAX = 50; // 注意：界面滑块曾放到 100，>50 会被接口 400
const API_GUIDANCE_MIN = 1.0;
const API_GUIDANCE_MAX = 20.0;
const API_SEED_MIN = -1; // -1 = 随机
const API_SEED_MAX = 2147483647;
const API_MAX_REF_IMAGES = 4; // 实测硬上限；曾按文档写成 10，第 5 张起必定 400

/* LoRA 适配器（字段名 `loras`）。
   官方文档与模型卡都把它写成可选参数，格式是 {"<仓库 id>": 权重} 的映射；
   单条也可以写成字符串。**它不是假开关** —— 2026-09-25 实测：传一个不存在的
   仓库 id，接口在提交阶段就去下载该 LoRA 并返回
   `apiInferModelDownload call failed ... [Model Exception] 模型不存在`（HTTP 500），
   说明字段确实被读取并执行。代价是：id 写错会让**整个请求失败**，
   而不是「悄悄不用 LoRA」，所以前端必须把这条讲清楚。
   约束（官方文档原文）：最多 6 个，权重系数之和必须为 1.0。 */
const API_MAX_LORAS = 6;
const LORA_WEIGHT_SUM_TOL = 0.01; // 浮点误差容忍度
const LORA_ID_RE = /^[\w.\-]+\/[\w.\-]+$/; // ModelScope 仓库 id 形如 org/name

/* 官方模型卡给出的透明图推荐句式。透明与否由提示词决定，没有接口开关，
   所以选「透明背景」时必须把这段拼进去 —— 光靠 size 或参数是拿不到透明通道的。
   https://modelscope.cn/models/Qwen/Qwen-Image-2.1 「Transparent Image Generation」 */
const TRANSPARENT_PREFIX = 'This is an RGBA image with transparency.';
const TRANSPARENT_SUFFIX = 'The image has alpha channel and the background is transparent.';
// 判断提示词是否已经表达过透明意图，避免重复拼接
const TRANSPARENT_HINT_RE = /\b(rgba|alpha\s*channel|transparent\s+background|with\s+transparency|transparent\s+layer)\b|透明背景|透明通道|抠图/i;

/* ---------------- 视觉输入 ----------------
   官方编辑规范要求「所有判断来自画面里实际存在的东西」。若只把图片数量当成
   一句文字告诉模型（"本次输入图片数量：1 张"），它没看到画面，只能做笼统的
   保留声明。这里把参考图按 OpenAI 兼容的多模态格式真正随消息发出。

   实测（deepseek-ai/DeepSeek-V4.1-Flash + official_edit.md 规范原文）：
   带图后模型能准确引用画面里真实存在的元素（金色滚边 / 盘扣 / 黄色盲道砖 …），
   输出仍是单行严格 JSON。注意：极小尺寸的占位图会被服务端降级导致模型"看不见"，
   所以前端必须传真实压缩图，不能传 1×1 之类的测试图。 */
const VISION_MAX_IMAGES = 6; // 单次送入模型的图片数上限
const VISION_IMG_MAX_CHARS = 900_000; // 单张 dataURL 字符上限（约 670KB 二进制）
const VISION_TOTAL_MAX_CHARS = 4_000_000; // 单次请求图片总字符上限

/**
 * 校验是否为受支持的图片 dataURL。
 * 图片字符串可达数百 KB，全量正则既慢又有回溯风险，改为校验前缀 + 首尾抽样。
 */
function isImageDataUrl(u) {
  if (typeof u !== 'string' || u.length < 64) return false;
  const m = /^data:image\/(?:png|jpeg|jpg|webp);base64,/.exec(u);
  if (!m) return false;
  const body = u.slice(m[0].length);
  const ok = (s) => /^[A-Za-z0-9+/=]+$/.test(s);
  return ok(body.slice(0, 200)) && ok(body.slice(-200));
}

// reasoning 模型会把预算花在思维链上，带图后思维链更长，需要更大的输出预算
const OPT_MAX_TOKENS = 4000; // 纯文本
const OPT_MAX_TOKENS_VISION = 6000; // 带图
const OPT_MAX_TOKENS_RETRY = 10000; // 首轮空结果后的重试

// 官方提示词规范（来自 Qwen-Image-2.1 官方 system prompt）
const RULES_DIR = path.join(ROOT, 'data', 'rules');
const RULE_FILES = {
  t2i: path.join(RULES_DIR, 'official_t2i.md'),
  edit: path.join(RULES_DIR, 'official_edit.md'),
};
/* 附加规则（不是官方规范，而是本项目自写的补充条款，覆盖官方两份规范没写的
   透明图句式与主体提取）。两份官方规范是用户提供的权威文件，一字不改；
   补充条款独立成文件，只有用户勾选时才作为**第二条 system 消息**追加发送。
   因此勾不勾选，官方规范原文的字节都不变。 */
const EXTRA_RULE_FILE = path.join(RULES_DIR, 'extra_transparent_subject.md');

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
  for (const d of [PUBLIC_DIR, OUTPUTS_DIR, INPUTS_DIR, DATA_DIR]) {
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

/* ---------------- DNS 兜底：本机解析器不可靠时自己找路 ---------------- */

/**
 * 为什么需要这个？
 *
 * 2026-09-26 实测：本机解析器（被代理工具接管，`dns.getServers()` 返回 `['127.0.0.1']`）
 * **只对某一个域名**返回 NXDOMAIN，而同一条根域下的其他域名解析得好好的：
 *
 *     getaddrinfo api-inference.modelscope.cn  → ENOTFOUND
 *     getaddrinfo www.modelscope.cn            → 39.99.133.195   ✅
 *     用公共 DNS 查 api-inference.modelscope.cn → 39.99.133.195 / 47.92.141.220 ✅
 *
 * 也就是说**域名本身一直存在**，坏的是本机这条解析路径。
 *
 * 而**浏览器的解析通道和 Node 不是一条**（浏览器自带 DoH / 走代理链路），
 * 于是必然出现「浏览器打得开、程序却报 ENOTFOUND」。用户据此会去反复检查
 * Key、模型名、额度，方向完全被带偏 —— 这个坑在本项目里已经反复出现。
 *
 * 处置：给每个出站请求挂一个自定义 lookup。
 *   1. **先走系统解析器** —— 用户的 hosts、内网 DNS、代理工具的解析意图优先，绝不抢跑；
 *   2. 只有它失败（或返回空）时，才用**独立的** c-ares Resolver 直接问公共 DNS。
 *
 * 只替换「域名 → IP」这一步：URL、Host 头、TLS SNI 全部保持原样，
 * 所以证书仍然按域名校验，不会因为直连 IP 而失效。
 *
 * ⚠️ 隐私权衡（必须说清楚）：兜底走的是**直连**，不经过用户的代理隧道。
 * 只有在系统解析器**已经失败**时才触发，此时那条路本来就不通；
 * 但如果用户需要靠代理隐藏来源，这个兜底会绕开它。所以：
 *   - 每次触发都打日志，不静默；
 *   - 可用环境变量 `MSQ_DNS_FALLBACK=off` 关闭，或用
 *     `MSQ_DNS_FALLBACK=1.1.1.1,8.8.8.8` 换成自己信任的服务器。
 */
const DNS_FALLBACK_ENV = String(process.env.MSQ_DNS_FALLBACK || '').trim();
const DNS_FALLBACK_OFF = /^(off|0|none|false)$/i.test(DNS_FALLBACK_ENV);
const DNS_FALLBACK_SERVERS = DNS_FALLBACK_OFF
  ? []
  : DNS_FALLBACK_ENV
    ? DNS_FALLBACK_ENV.split(',').map((s) => s.trim()).filter(Boolean)
    : ['119.29.29.29', '1.1.1.1', '223.5.5.5'];
const DNS_FALLBACK_TTL = 10 * 60 * 1000; // 兜底结果缓存 10 分钟，别每次都去问公共 DNS
const DNS_FALLBACK_TIMEOUT = 4000; // 兜底也不能拖死请求

const dnsFallbackCache = new Map(); // hostname -> { addrs, at }
const dnsFallbackNotified = new Set(); // 每个域名只告警一次，避免刷屏

/** 用独立的 c-ares resolver 问公共 DNS。绝不碰全局 dns.setServers()。 */
function resolveViaPublicDns(hostname) {
  const hit = dnsFallbackCache.get(hostname);
  if (hit && Date.now() - hit.at < DNS_FALLBACK_TTL) return Promise.resolve(hit.addrs);

  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    resolver.setServers(DNS_FALLBACK_SERVERS);

    const out = [];
    let left = 2;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (out.length) dnsFallbackCache.set(hostname, { addrs: out, at: Date.now() });
      resolve(out);
    };
    const timer = setTimeout(done, DNS_FALLBACK_TIMEOUT);
    if (timer.unref) timer.unref();

    // A 与 AAAA 同时问，谁先回来算谁；两个都回来才算完（宁可慢一点也不漏地址族）
    for (const [method, family] of [['resolve4', 4], ['resolve6', 6]]) {
      try {
        resolver[method](hostname, (err, list) => {
          if (!err && Array.isArray(list)) {
            for (const ip of list) out.push({ address: ip, family });
          }
          if (--left === 0) done();
        });
      } catch (e) {
        if (--left === 0) done();
      }
    }
  });
}

/**
 * 挂给 `net.connect` 的 lookup。签名要同时兼容两种调用方式：
 *   lookup(host, cb)                        —— 老的
 *   lookup(host, { family, all: true }, cb) —— Node 20+ 的 autoSelectFamily
 */
function dnsLookupWithRescue(hostname, options, callback) {
  let cb = callback;
  let opts = options;
  if (typeof options === 'function') {
    cb = options;
    opts = {};
  }
  opts = opts || {};
  const wantAll = opts.all === true;

  const reply = (addrs) => {
    if (!addrs.length) return false;
    if (wantAll) {
      cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
      return true;
    }
    const fam = Number(opts.family);
    const pick = (fam === 4 || fam === 6 ? addrs.find((a) => a.family === fam) : null) || addrs[0];
    cb(null, pick.address, pick.family);
    return true;
  };

  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (!err && addrs && addrs.length && reply(addrs)) return;

    // 兜底被显式关掉：如实说明，别假装试过
    if (!DNS_FALLBACK_SERVERS.length) {
      const e = err || new Error(`无法解析 ${hostname}`);
      e.host = hostname;
      e.dnsFallbackOff = true;
      return cb(e);
    }

    resolveViaPublicDns(hostname).then((out) => {
      if (!out.length) {
        // 两条路都失败 —— 这已经不是"本机解析器的毛病"，而是真没网 / 被拦死。
        // 造一个信息完整的错误，让文案层能区分这两种情况（否则用户会被
        // 建议去"重启代理"，但重启也没用）。
        const e = new Error(`域名解析失败（${hostname}）`);
        e.code = (err && err.code) || 'ENOTFOUND';
        e.host = hostname;
        e.dnsFallbackTried = true;
        e.cause = err;
        return cb(e);
      }
      if (!dnsFallbackNotified.has(hostname)) {
        dnsFallbackNotified.add(hostname);
        console.error(
          `[net] 本机解析器无法解析 ${hostname}（${(err && err.code) || '空结果'}），` +
            `已改用公共 DNS（${DNS_FALLBACK_SERVERS.join(' / ')}）解析为 ` +
            `${out.map((a) => a.address).join(', ')}。` +
            '建议检查本机 DNS / 代理工具设置；如需关闭兜底请设 MSQ_DNS_FALLBACK=off'
        );
      }
      if (!reply(out)) {
        const e = err || new Error(`无法解析 ${hostname}`);
        e.host = hostname;
        cb(e);
      }
    });
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
    // 必须按 URL 的协议选模块：以前写死 https + 443，于是把
    // "http://127.0.0.1:11434/v1"（Ollama / vLLM / LM Studio 的常见地址）
    // 当成了 TLS 连接，报出来的是一句与真实原因无关的握手错误。
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        timeout,
        // 解析域名时先尊重系统解析器，只有在它失败时才走公共 DNS 兜底（见上）
        lookup: dnsLookupWithRescue,
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

/**
 * 连接级瞬时故障：请求**尚未送达服务端**就失败了。
 *
 * 重试这类错误不会重复计费、也不会产生重复任务，所以可以安全重试。
 * 实测踩过的坑：本机 DNS 解析器（指向本地代理）会偶发解析不出来
 * `api-inference.modelscope.cn`，报 `getaddrinfo ENOTFOUND`，
 * 而该域名在公网上其实一直存在。这种情况重试一次基本就好了。
 *
 * ⚠️ 但重试治不了"解析器稳定拒绝某个域名"（2026-09-26 实测就是这种：
 * 同一个解析器对 `www.modelscope.cn` 正常、对这个域名稳定 NXDOMAIN，重试 3 次全败）。
 * 那种情况由 `dnsLookupWithRescue` 处理 —— 它会在系统解析器失败时
 * 用公共 DNS 兜底。这里的重试是**第二道**保险，两者不冲突。
 */
const RETRYABLE_NET_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

const MS_NET_RETRY = 2; // 额外重试次数（总共最多 3 次尝试）

function isRetryableNetErr(e) {
  const code = (e && (e.code || (e.cause && e.cause.code))) || '';
  if (RETRYABLE_NET_CODES.has(code)) return true;
  return /getaddrinfo|EAI_AGAIN|ENOTFOUND|socket hang up|ECONNREFUSED/i.test(
    String((e && e.message) || '')
  );
}

/**
 * **同一个 URL** 还值不值得再试一次？
 *
 * 与 isRetryableNetErr 的区别很关键，别合并：那个函数同时被两处用 ——
 *   ① `msApi` 重试**同一个** URL；
 *   ② `msWebApi` 失败后换到**另一个候选域名**。
 *
 * 对 ① 来说，如果本机解析器与公共 DNS 都失败了，再问同一个名字不可能突然通，
 * 不如立刻如实报错（每次兜底最长要等 4 秒，重试 3 轮就是十几秒白等）。
 * 对 ② 来说却完全值得一试：**换域名就是换一个解析目标**，A 解析不了不代表 B 也解析不了 ——
 * 这正是 MS_WEB_CANDIDATES 存在的理由（实测过 `modelscope.cn` 解析不了、
 * `www.modelscope.cn` 却正常）。所以候选切换必须继续走 isRetryableNetErr。
 */
function shouldRetrySameUrl(e) {
  if (e && e.dnsFallbackTried) return false;
  return isRetryableNetErr(e);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 向 ModelScope 发起 JSON API 调用（连接级故障自动重试） */
async function msApi(urlStr, { method = 'GET', apiKey, body = null, taskType = null, timeout } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (taskType) headers['X-ModelScope-Task-Type'] = taskType;

  let res = null;
  for (let attempt = 0; attempt <= MS_NET_RETRY; attempt++) {
    try {
      res = await requestUrl(urlStr, {
        method,
        headers,
        body: body ? Buffer.from(JSON.stringify(body), 'utf8') : null,
        timeout,
      });
      break;
    } catch (e) {
      // 只重试"根本没连上"这类错误；一旦服务端已响应，绝不重试。
      // 用 shouldRetrySameUrl 而不是 isRetryableNetErr：解析双路都失败时不必再问同一个名字。
      if (attempt >= MS_NET_RETRY || !shouldRetrySameUrl(e)) throw e;
      const wait = 400 * (attempt + 1);
      console.error(
        `[net] ${e.code || e.message} —— ${wait}ms 后重试（第 ${attempt + 2}/${MS_NET_RETRY + 1} 次）`
      );
      await sleep(wait);
    }
  }
  if (!res) throw new Error('网络请求失败');
  let json = null;
  const text = res.body.toString('utf8');
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { _raw: text.slice(0, 800) };
  }
  return { status: res.status, json };
}

/**
 * 向 ModelScope「网页/业务」端点发起调用（余额、Key 校验）。
 * 与 msApi 的区别：这里的域名在部分网络环境下会整片解析不出来，
 * 所以按 MS_WEB_CANDIDATES 依次尝试，**只在连接级故障时**才换域名 ——
 * 服务端已经给了响应（哪怕是 4xx/5xx）就说明域名是对的，再换没有意义。
 * 成功后缓存，后续请求直接命中。
 */
async function msWebApi(pathname, { apiKey, timeout = 30000 } = {}) {
  const order = msWebBase
    ? [msWebBase, ...MS_WEB_CANDIDATES.filter((h) => h !== msWebBase)]
    : MS_WEB_CANDIDATES.slice();
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const base = order[i];
    try {
      const r = await msApi(`${base}${pathname}`, { apiKey, timeout });
      if (msWebBase !== base) {
        msWebBase = base;
        console.log(`[net] ModelScope 业务域名确定为 ${base}`);
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (!isRetryableNetErr(e)) throw e; // 服务端已响应 → 域名没问题，别再换
      if (i < order.length - 1) {
        console.error(`[net] ${base} 解析/连接失败（${e.code || e.message}），换用 ${order[i + 1]}`);
      }
    }
  }
  throw lastErr || new Error('网络请求失败');
}

/**
 * 把连接级故障翻译成用户能照着排查的话。
 *
 * 教训：原样抛出 `getaddrinfo ENOTFOUND modelscope.cn` 对用户毫无信息量 ——
 * 既看不出是 DNS 还是网络断了，也看不出该往哪查。而且这类错误特别容易被
 * 误当成「Key 失效」或「额度用完」，把排查方向整个带偏。
 *
 * 2026-09-26 补充：域名解析失败现在要分三种情况说，因为**处置完全不同**：
 *   ① 没走兜底（用户自己关了 / 兜底不可用）→ 建议本机排查 DNS；
 *   ② 兜底也失败 → **别再让人去重启代理了**，那是真没网或被拦死；
 *   ③ 普通解析失败 → 按原来的建议。
 * 一句话包打天下会把用户送去修一个没坏的东西。
 */
function netErrText(e) {
  const msg = String((e && e.message) || '');
  const code = (e && e.code) || (e && e.cause && e.cause.code) || '';
  const blob = `${code} ${msg}`;
  const host = (e && e.host) || (msg.match(/ENOTFOUND\s+([\w.-]+)/i) || [])[1] || '';
  const label = host ? `（${host}）` : '';

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(blob)) {
    // 文案里不要出现 markdown 记号（**）—— 这个字符串是直接塞进 toast 的，
    // 星号会原样显示给用户。也别把服务器列表塞进来：目标是 toast 能一眼读完，
    // 具体用了哪些 DNS 写在服务端日志里。
    if (e && e.dnsFallbackOff) {
      return (
        `域名解析失败${label}，与 API Key 无关。本机解析器解析不出来，` +
        '而公共 DNS 兜底已被关闭 —— 去掉 MSQ_DNS_FALLBACK 后重试即可自动兜底。'
      );
    }
    if (e && e.dnsFallbackTried) {
      return (
        `域名解析失败${label}，与 API Key 无关。本机解析器与公共 DNS 都解析不出来，` +
        '说明不是本机 DNS 的毛病，更像已断网或被防火墙整段拦截，请先确认网络连通再重试。'
      );
    }
    return (
      `域名解析失败${label}，与 API Key 无关。` +
      '多为本机 DNS 或代理软件所致，重启代理 / 切换节点或稍后重试；' +
      '生图走的是另一个域名，一般不受影响。'
    );
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(blob)) {
    return '连接被拒绝或中断，通常是代理软件 / 防火墙拦截，重启代理或稍后重试。';
  }
  if (/ETIMEDOUT|timeout|超时/i.test(blob)) {
    return '请求超时，一般是网络不稳定，稍后重试即可。';
  }
  return `网络错误：${msg}`;
}

/**
 * 错误 → 给用户看的话。
 * 网络类失败走翻译层（netErrText），其余原样透出 —— 业务错误（例如
 * 「优化失败：HTTP 400 ...」）本来就是人话，套一层翻译反而会丢掉细节。
 */
function errText(e, fallback = '服务器内部错误') {
  if (isRetryableNetErr(e)) return netErrText(e);
  return (e && e.message) || fallback;
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
    const { status, json } = await msWebApi('/openapi/v1/magicubes/balance', {
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
    return sendJson(res, 500, { ok: false, error: netErrText(e) });
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
    const r = await msWebApi('/openapi/v1/magicubes/balance', { apiKey: key, timeout: 30000 });
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
    return sendJson(res, 200, { ok: false, error: netErrText(e) });
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
 * body: { apiKey?, mode: 't2i'|'i2i'|'edit'|'inpaint', prompt, negativePrompt,
 *         width, height, steps, guidance, seed, transparent,
 *         images: [dataURL...] }
 *
 * transparent 是**语义开关，不是接口参数**：接口没有输出格式参数，模型恒定
 * 输出 RGBA 容器，画面透不透明完全由提示词决定，因此这里按官方句式改写提示词。
 * （曾经发过的 outputFormat / watermark 两个字段接口都不认，已移除。）
 *
 * images 的语义随 mode 变化：
 *   t2i     — 忽略
 *   i2i     — 最多 4 张参考图（接口硬上限，超出会 400）
 *   edit    — 第 1 张为待编辑原图，其余为参考图
 *   inpaint — 单张「原图+涂抹标记」合成图，或 [原图, 黑白掩码] 两图
 */
/**
 * 校验并规整 LoRA 参数。
 *
 * 为什么是「拒绝」而不是「钳制」：张数超限可以截断（前 4 张参考图仍有意义），
 * 但 LoRA 的权重之和必须为 1.0 —— 截掉一个就会破坏这个硬约束，
 * 权重和不为 1 时去替他归一化等于篡改他的意图。两者都会静默改变画面，
 * 所以这里一律报错并把实际值告诉他。
 *
 * @returns {{ok:true, value:Object}|{ok:false, error:string}}
 */
function normalizeLoras(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };

  // 允许三种写法：{"org/name": 0.6, ...} 映射、["org/name", ...] 纯 id 数组、单个字符串
  let pairs = [];
  if (typeof raw === 'string') {
    pairs = [[raw, null]];
  } else if (Array.isArray(raw)) {
    for (const it of raw) {
      if (typeof it === 'string') pairs.push([it, null]);
      else if (it && typeof it === 'object') {
        const id = it.repo_id || it.id || it.name;
        if (id) pairs.push([String(id), it.weight === undefined ? null : Number(it.weight)]);
      }
    }
  } else if (typeof raw === 'object') {
    pairs = Object.keys(raw).map((k) => [k, Number(raw[k])]);
  } else {
    return { ok: false, error: 'loras 格式不正确：应为 {"仓库 id": 权重} 的映射' };
  }

  if (!pairs.length) return { ok: true, value: null };
  if (pairs.length > API_MAX_LORAS) {
    return {
      ok: false,
      error: `LoRA 最多 ${API_MAX_LORAS} 个，当前 ${pairs.length} 个（权重之和必须为 1.0，无法自动截断）`,
    };
  }

  const value = {};
  let sum = 0;
  let autoWeight = false;
  for (const [id, w] of pairs) {
    const repo = String(id || '').trim();
    if (!LORA_ID_RE.test(repo)) {
      return {
        ok: false,
        error: `LoRA 标识「${repo}」不是合法的 ModelScope 仓库 id（形如 org/name）`,
      };
    }
    if (Object.prototype.hasOwnProperty.call(value, repo)) {
      return { ok: false, error: `LoRA「${repo}」重复填写` };
    }
    if (w === null || !Number.isFinite(w)) {
      autoWeight = true;
      continue;
    }
    if (w < 0 || w > 1) {
      return { ok: false, error: `LoRA「${repo}」的权重 ${w} 超出 [0, 1]` };
    }
    value[repo] = w;
    sum += w;
  }

  if (autoWeight) {
    // 只写了 id 没写权重：官方文档的单条写法即"不带权重"，此时按 1.0 处理。
    if (pairs.length > 1) {
      return { ok: false, error: '多个 LoRA 必须逐个指定权重，且权重之和为 1.0' };
    }
    return { ok: true, value: { [String(pairs[0][0]).trim()]: 1 } };
  }

  if (Math.abs(sum - 1) > LORA_WEIGHT_SUM_TOL) {
    return {
      ok: false,
      error: `LoRA 权重之和为 ${Number(sum.toFixed(3))}，官方要求必须等于 1.0`,
    };
  }
  return { ok: true, value };
}

/**
 * 组装一次 ModelScope 生图请求体。
 *
 * 为什么抽成独立函数：一次生成多张时接口**没有 batch 参数**（真值表里被识别的字段都在
 * 上面列着，其余一律静默忽略），所以只能**扇出成 N 个独立任务** —— 它们共享同一份参数、
 * 只有 seed 不同。组装逻辑若留在 handleGenerate 里，扇出时只能复制一遍，两处必然漂移。
 *
 * 字段名必须逐字对照上面的「参数真值表」：写错不会报错，只会静默失效。
 *
 * @returns {{ok:true, payload:Object, notes:string[], mode:string}|{ok:false, error:string}}
 */
function buildGeneratePayload(p) {
  const mode = ['t2i', 'i2i', 'edit', 'inpaint'].includes(p.mode) ? p.mode : 't2i';

  // 透明背景：接口没有这个开关，只能靠提示词。按官方模型卡的推荐句式补齐，
  // 已经写过透明意图的就不再重复拼（避免同一句话出现两遍）。
  const notes = [];
  let promptText = String(p.prompt);

  // 用户可能直接把"官方契约形态"的 JSON（就是模型输出的那个格式）粘进创作台。
  // 那层壳是模型与程序之间的传输格式，不是提示词内容 —— 必须先剥掉，
  // 否则 JSON 标点会作为提示词进画面，壳里的比例字段还会顶撞 edit 规范。
  const envelope = unwrapPromptEnvelope(promptText);
  if (envelope) {
    promptText = envelope.prompt;
    notes.push(
      '已自动去除 JSON 外壳（那是官方规范规定的「模型输出格式」，不是提示词本身）' +
        (envelope.whRatio ? `；壳内 wh_ratio=${envelope.whRatio}，如需按此比例请自行设置尺寸` : '')
    );
  }

  if (p.transparent === true) {
    if (TRANSPARENT_HINT_RE.test(promptText)) {
      notes.push('提示词已含透明相关表述，未重复追加官方句式');
    } else {
      // 模型卡给的示例里，中间那句是**完整句子**（以句号收尾）：
      // "This is an RGBA image with transparency. A cute cartoon dragon sticker.
      //  The image has alpha channel and the background is transparent."
      // 用户手写的中文提示词常常没有句号，直接拼会让两句连成一句，所以补齐标点。
      let mid = promptText.trim();
      if (!/[.!?。！？]$/.test(mid)) mid += '.';
      promptText = `${TRANSPARENT_PREFIX} ${mid} ${TRANSPARENT_SUFFIX}`;
      notes.push('已按官方模型卡句式补齐透明背景描述');
    }
  }

  // 组装 ModelScope 请求体。字段名必须逐字对照上面的「参数真值表」，
  // 写错不会报错，只会静默失效。
  const payload = {
    model: MODEL_ID,
    prompt: promptText,
  };
  if (p.negativePrompt && String(p.negativePrompt).trim()) {
    payload.negative_prompt = String(p.negativePrompt);
  }
  // 尺寸：Qwen-Image-2.1 只认 `size` 字符串（"WxH"）。
  // 实测：传 width/height 会被接口静默忽略，模型退回默认纵向比例（760x1280）。
  // 约束：宽高各自必须在 [64, 2048] 内（单边上限，非总像素上限），且为 16 的倍数。
  // （不需要 32 对齐 —— 1360x2048 实测原样接受。）
  if (p.width && p.height) {
    const clamp = (v) => {
      const n = Math.round(Number(v) / API_SIZE_STEP) * API_SIZE_STEP;
      return Math.max(API_SIZE_MIN, Math.min(API_SIZE_MAX, n));
    };
    const w = clamp(p.width);
    const h = clamp(p.height);
    payload.size = `${w}x${h}`;
  } else if (p.size) {
    payload.size = String(p.size);
  }
  // 采样步数：字段名是 `steps`（不是 num_inference_steps），上限 50。
  // 以前发 num_inference_steps，接口静默忽略 —— 界面滑块一直是摆设。
  if (p.steps !== undefined && p.steps !== null && p.steps !== '') {
    const n = Math.round(Number(p.steps));
    if (Number.isFinite(n)) {
      const c = Math.max(API_STEPS_MIN, Math.min(API_STEPS_MAX, n));
      if (c !== n) notes.push(`步数 ${n} 超出接口范围，已调整到 ${c}`);
      payload.steps = c;
    }
  }
  // 引导系数：字段名是 `guidance`（不是 guidance_scale），范围 [1.0, 20.0]。
  // 同理，以前发 guidance_scale 也是静默失效。注意 guidance ≤ 1 时 negative_prompt 无效。
  if (p.guidance !== undefined && p.guidance !== null && p.guidance !== '') {
    const n = Number(p.guidance);
    if (Number.isFinite(n)) {
      const c = Math.max(API_GUIDANCE_MIN, Math.min(API_GUIDANCE_MAX, n));
      if (c !== n) notes.push(`引导系数 ${n} 超出接口范围，已调整到 ${c}`);
      payload.guidance = c;
    }
  }
  // 随机种子：接口范围 [-1, 2147483647]，-1 即随机。
  if (p.seed !== undefined && p.seed !== null && p.seed !== '') {
    const n = Math.trunc(Number(p.seed));
    if (Number.isFinite(n)) {
      if (n < API_SEED_MIN || n > API_SEED_MAX) {
        notes.push(`种子 ${n} 超出接口范围 [${API_SEED_MIN}, ${API_SEED_MAX}]，已忽略`);
      } else {
        payload.seed = n;
      }
    }
  }
  // LoRA：字段名 `loras`，真实生效（实测见 API_MAX_LORAS 处的注释）。
  // 校验不过就当场拒绝 —— 一个写错的 id 会让整个请求在服务端下载模型时失败，
  // 拿到的是「apiInferModelDownload call failed / 模型不存在」，用户很难自己归因。
  const lora = normalizeLoras(p.loras);
  if (!lora.ok) return { ok: false, error: lora.error };
  if (lora.value) payload.loras = lora.value;

  // 注意：接口**没有** watermark 参数，也**没有** outputFormat 参数。
  // 以前照搬界面字段发了 watermark，接口静默忽略 —— 那个开关是假的，已从前端移除。

  // 图生图 / 编辑 / 局部重绘：把参考图以 dataURL 形式提交。
  //
  // ⚠️ 字段名必须是 `image_url`（单数）。这是本接口最隐蔽的坑之一：
  //    - `image`    → 被静默忽略（不报错、不告警，参考图直接丢弃）
  //    - `image_urls` → 同样被忽略
  //    - `image_url` → 生效；接受 data URI，也接受数组（原图+掩码）
  // 字段名写错时接口返回 200、任务 SUCCEED，但出图完全由提示词决定，
  // 表现为「图生图/编辑看起来能用，其实参考图从未参与」。
  // 2026-09 实测：同图同提示词下 `image_url` 能保住原图构图只改目标属性，
  // 而 `image`/`image_urls` 会输出一张与输入无关的新图。
  //
  // 张数上限实测为 **4**（第 5 张起接口直接 400：
  // "image_url count 5 exceeds maximum limit of 4"）。官方模型卡写「最多 10 张参考图」，
  // 那是模型本身的能力；经 ModelScope 推理 API 只放行 4 张。超出不会降级重试，
  // 是**提交阶段就失败**，所以这里主动截断并如实上报，避免用户上传 5 张后莫名报错。
  const imgs = Array.isArray(p.images) ? p.images.filter((x) => typeof x === 'string' && x.startsWith('data:')) : [];
  if (imgs.length) {
    if (imgs.length > API_MAX_REF_IMAGES) {
      notes.push(`参考图 ${imgs.length} 张超出接口上限 ${API_MAX_REF_IMAGES} 张，已取前 ${API_MAX_REF_IMAGES} 张`);
    }
    const use = imgs.slice(0, API_MAX_REF_IMAGES);
    payload.image_url = use.length === 1 ? use[0] : use;
  }

  return { ok: true, payload, notes, mode };
}

/* ---------------- 生成作业：一次提交多张 + 服务端后台轮询 ----------------

   这两件事本质是同一件：**把任务推进权从浏览器搬到服务端**。

   ① 一次生成多张 —— 接口**没有批量参数**（真值表里被识别的字段都在上面，其余一律静默
      忽略；`loras` 的真伪就是这么判出来的）。所以 N 张只能**扇出成 N 个独立任务**。
      每张各自计费，这是接口的计费方式决定的，不是这里的实现选择。
   ② 后台轮询 —— 以前是浏览器每 4 秒问一次、再逐张调 `/api/save` 落盘；关掉页面或刷新
      任务就丢了（图还在 ModelScope 上，但没人取回）。现在服务端自己持有作业、自己轮询、
      自己落盘，网页只是**观察者**：刷新后重连即可看到进度，关掉页面回来结果已在历史里。

   作业落盘到 `data/jobs.json`（只留最近 JOB_KEEP 条），所以**服务重启也能续跑**：
   重启时未完成的作业照常被轮询器接管。作业里**不存参考图**（dataURL 动辄几 MB），
   只存文件名 —— 图片只在提交那一刻需要，之后用不到。 */

const JOB_MAX_COUNT = 4; // 一次最多几张；每张都消耗额度，上限不宜大
/**
 * 允许同时在跑的作业数上限。
 *
 * 早先这里是"只许一个作业在跑"，第二个提交直接 409 —— 出发点是不让误触变成双倍消耗，
 * 但代价是用户想连着出几批时必须**干等**，忘了看页面就彻底卡住。这个代价比多花钱更常发生，
 * 所以改成允许并行排队，只留一个上限兜住失控（连点最多也就这么多批同时在跑）。
 */
const JOB_MAX_RUNNING = Math.max(1, Number(process.env.MSQ_MAX_RUNNING) || 5);
const JOB_POLL_MS = 4000; // 后台轮询间隔（与原来前端的 4s 一致）
const JOB_ITEM_TIMEOUT_MS = 10 * 60 * 1000; // 单张等待上限（与前端原超时一致）
const JOB_KEEP = 30; // jobs.json 只保留最近这么多条

let jobs = [];
let jobsLoaded = false;
let jobTicker = null;

async function loadJobs() {
  if (jobsLoaded) return;
  jobsLoaded = true;
  const list = await readJson(JOBS_FILE, []);
  jobs = Array.isArray(list) ? list.filter((j) => j && j.id && Array.isArray(j.items)) : [];
}

async function persistJobs() {
  try {
    // ⚠️ 必须把内存态的 `key` 摘掉再落盘：作业对象上带着提交时用的 Key（见
    // handleGenerate 的 `job.key = key`），那是**进程内**用来轮询的，不该进磁盘。
    // 落盘的是 `{ key, ...rest }` 里的 rest，不是 job 本身。
    const stripped = jobs.slice(0, JOB_KEEP).map(({ key, ...rest }) => rest);
    await writeJson(JOBS_FILE, stripped);
  } catch (e) {
    /* 落盘失败不影响内存里的推进 */
  }
}

function activeJob() {
  return jobs.find((j) => j.status === 'running') || null;
}

function countDone(job) {
  return job.items.filter((i) => i.status === 'succeeded').length;
}

/** 单张的 seed。接口 -1 = 随机；固定 seed 时逐张 +i，否则 N 张会出一模一样的图。 */
function seedForItem(baseSeed, i) {
  if (baseSeed === undefined || baseSeed === null || !Number.isFinite(Number(baseSeed))) return -1;
  const n = Math.trunc(Number(baseSeed));
  if (n < 0) return -1;
  const v = n + i;
  return v > API_SEED_MAX ? n : v;
}

/** 单个任务的请求体：与作业共享参数，只有 seed 不同 */
function payloadForItem(built, item) {
  const out = { ...built.payload };
  if (item.seed === -1) delete out.seed; // 不传即随机，与接口默认一致
  else out.seed = item.seed;
  return out;
}

/** 写历史用的 meta —— seed 必须是**这一张自己的**，不是作业级的 */
function itemMeta(job, item) {
  const q = job.params || {};
  return {
    mode: q.mode,
    prompt: q.prompt,
    negativePrompt: q.negativePrompt,
    width: q.width,
    height: q.height,
    steps: q.steps,
    guidance: q.guidance,
    seed: item.seed,
    transparent: q.transparent,
    sourceImages: q.sourceImages,
    durationMs: item.submittedAt ? Date.now() - item.submittedAt : null,
  };
}

/** 收尾判定。所有 item 都不再是 pending 时才定终态。 */
function finalizeJob(job) {
  if (job.status !== 'running') return false;
  if (job.items.some((i) => i.status === 'pending')) return false;
  const okN = countDone(job);
  const failN = job.items.filter((i) => i.status === 'failed').length;
  job.status = failN === 0 ? 'done' : okN > 0 ? 'partial' : 'failed';
  job.finishedAt = Date.now();
  return true;
}

/** 取任务的输出图 URL（接口有两种返回形态） */
function taskImageUrls(json) {
  const urls = json.output_images || json.result?.urls || json.result?.url || [];
  return (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
}

/**
 * 推进一个作业里所有待完成的任务。返回「是否有状态变化」。
 * 一次只问一个任务，串行推进 —— 任务数上限才 4，没必要并发，也不给接口添压。
 */
async function advanceJob(job, key) {
  let changed = false;

  for (const item of job.items) {
    if (item.status !== 'pending' || !item.taskId) continue;

    if (Date.now() - (item.submittedAt || job.createdAt) > JOB_ITEM_TIMEOUT_MS) {
      item.status = 'failed';
      item.error = '等待超时（10 分钟）—— 任务可能仍在排队，可稍后在历史里确认';
      changed = true;
      continue;
    }

    let r;
    try {
      r = await msApi(`${MS_BASE}/v1/tasks/${encodeURIComponent(item.taskId)}`, {
        apiKey: key,
        taskType: 'image_generation',
        timeout: 60000,
      });
    } catch (e) {
      // 网络抖动不判失败 —— 下一轮再问。把偶发失败写成终态是最贵的错误。
      continue;
    }

    const st = String(r.json.task_status || r.json.status || '').toUpperCase();
    item.remoteStatus = st || null;

    if (st === 'SUCCEED' || st === 'SUCCESS') {
      const url = taskImageUrls(r.json)[0] || '';
      item.finishedAt = Date.now();
      if (!url) {
        item.status = 'failed';
        item.error = '任务成功但没有返回图片';
      } else if (!job.save) {
        // 未勾选自动保存：只留远程地址做临时预览（该地址会过期）
        item.url = url;
        item.status = 'succeeded';
      } else {
        const saved = await saveRemoteImage(url, itemMeta(job, item));
        if (saved.ok) {
          item.url = url;
          item.file = saved.item.file;
          item.width = saved.item.width;
          item.height = saved.item.height;
          item.bytes = saved.item.size;
          item.dimensionMismatch = saved.item.dimensionMismatch;
          item.status = 'succeeded';
        } else {
          item.status = 'failed';
          item.error = `已生成但保存失败：${saved.error}`;
        }
      }
      changed = true;
    } else if (['FAILED', 'FAIL', 'CANCELED', 'CANCELLED', 'TIMEOUT'].includes(st)) {
      item.status = 'failed';
      item.error = String(r.json.error || r.json.message || '任务执行失败').slice(0, 300);
      changed = true;
    } else if (r.status >= 400) {
      item.status = 'failed';
      item.error = String(r.json.message || r.json.error || `查询失败 HTTP ${r.status}`).slice(0, 300);
      changed = true;
    }
    // 其余（PENDING / RUNNING / QUEUED / 空）：继续等
  }

  if (finalizeJob(job)) changed = true;
  if (changed) job.updatedAt = Date.now();
  return changed;
}

/** 后台轮询一轮。没有进行中的作业时几乎零开销。 */
async function tickJobs() {
  await loadJobs();
  const running = jobs.filter((j) => j.status === 'running');
  if (!running.length) return;

  // 每个作业优先用它**提交时那把 Key**（可能来自请求体），否则退回配置里的 Key。
  // 只认配置的话，用请求体传 Key 的调用方提交完就再也问不动了 —— 那是个真实缺陷：
  // 提交成功、后台却报"Key 已丢失"。进程重启后内存里的 key 没了，就只剩配置这条路。
  for (const job of running) {
    const key = job.key || pickKey(null);
    if (!key) {
      // 真的没有 Key 可用，如实收尾，不要让它永远挂着
      job.status = 'failed';
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      job.error = '找不到可用的 API Key，无法继续轮询（请到「个人信息」页配置后重试）';
      for (const it of job.items) {
        if (it.status === 'pending') {
          it.status = 'failed';
          it.error = 'API Key 已丢失';
        }
      }
      continue;
    }
    await advanceJob(job, key);
  }
  await persistJobs();
}

function ensureJobTicker() {
  if (jobTicker) return;
  jobTicker = setInterval(() => {
    tickJobs().catch(() => {});
  }, JOB_POLL_MS);
  if (jobTicker.unref) jobTicker.unref();
}

/** 给前端的作业视图：补齐计数、按序号排好 items */
function jobView(job) {
  return {
    id: job.id,
    status: job.status,
    save: job.save,
    count: job.count,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    params: job.params,
    items: [...job.items].sort((a, b) => a.index - b.index).map((it) => {
      // 已落盘的图后来可能被删掉（历史那边同样的情况有 missing 标记）。
      // 这里不标的话前端会照旧去取 /outputs/xxx —— 每个被删的文件都会赚一个 404
      // 和一条控制台报错，界面还会留一块空白。
      if (!it.file) return it;
      return fs.existsSync(path.join(OUTPUTS_DIR, it.file)) ? it : { ...it, missing: true };
    }),
    done: countDone(job),
    failed: job.items.filter((i) => i.status === 'failed').length,
    pending: job.items.filter((i) => i.status === 'pending').length,
  };
}

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

  const built = buildGeneratePayload(p);
  if (!built.ok) return sendJson(res, 400, { ok: false, error: built.error });
  const { payload, notes } = built;

  await loadJobs();
  const runningNow = jobs.filter((j) => j.status === 'running');
  if (runningNow.length >= JOB_MAX_RUNNING) {
    // 只有真的堆到上限才拒绝 —— 且要说清"上限"这件事，而不是含糊地让用户等
    return sendJson(res, 409, {
      ok: false,
      error:
        `后台已有 ${runningNow.length} 个任务在排队（上限 ${JOB_MAX_RUNNING}）——` +
        '先等其中一批结束，或在右栏对不需要的批次点「停止跟踪」',
    });
  }

  const count = Math.max(1, Math.min(JOB_MAX_COUNT, Math.trunc(Number(p.count) || 1)));

  /**
   * 批量种子策略 —— 一次 N 张能不能出 N 张不同的图，全看这里。
   *
   *   · 用户填了 seed        → 拿它当基准，逐张 +i（固定种子也要保证 N 张不同）
   *   · 留空 + 一次多张      → 服务端抽一个基准 seed，逐张 +i，**每张都显式发出去**
   *   · 留空 + 单张          → 不传 seed，交给接口随机（历史里记 -1 = 随机）
   *
   * 中间那条是 2026-09-29 补的：以前留空时 N 个请求体**一字不差**，
   * 能不能出不同的图完全取决于接口对"缺省种子"的处理 —— 实测会随机，
   * 但那是运气，不该依赖；而且历史里每张都记成 -1，看起来就像"四张共用一个种子"。
   * 现在每张都有自己的种子，既保证不同，也能逐张复现。
   */
  const baseSeed =
    payload.seed !== undefined
      ? payload.seed
      : count > 1
        ? crypto.randomInt(0, Math.max(1, API_SEED_MAX - count + 1))
        : null;

  const seedPlan = Array.from({ length: count }, (_, i) => seedForItem(baseSeed, i));

  const job = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    save: p.autoSave !== false, // 前端传 autoSave；缺省按"保存"处理（与旧行为一致）
    count,
    params: {
      mode: built.mode,
      prompt: String(p.prompt),
      negativePrompt: p.negativePrompt ? String(p.negativePrompt) : '',
      width: p.width ? Number(p.width) : null,
      height: p.height ? Number(p.height) : null,
      size: payload.size || null,
      steps: payload.steps ?? null,
      guidance: payload.guidance ?? null,
      seed: baseSeed,
      transparent: p.transparent === true,
      loras: payload.loras || null,
      sourceImages: Array.isArray(p.sourceImages) ? p.sourceImages.slice(0, 10).map(String) : [],
    },
    items: [],
  };

  // 提交时用的 Key 只留在**内存**里给后台轮询器用（persistJobs 落盘时会摘掉它）。
  // 只认配置里的 Key 是不够的：调用方可能在请求体里传 Key，那就会出现
  // "提交成功、后台却报 Key 已丢失" —— 提交与轮询必须用同一把 Key。
  job.key = key;

  if (count > 1) {
    notes.push(`一次生成 ${count} 张：接口没有批量参数，已拆成 ${count} 个独立任务（每张各自计费）`);
    notes.push(`每张用各自的种子（${seedPlan.join(' / ')}），所以不会出成同一张图`);
  }
  if (runningNow.length) {
    // 并行是被允许的，但"我现在同时压着几批"是用户有权知道的事实（每批都在花额度）
    notes.push(`后台还有 ${runningNow.length} 个任务在跑，本批会与它们并行推进`);
  }

  // 逐张提交：串行 + 间隔，避免同一 Key 瞬间并发触发限流（429）。
  const submitErrors = [];
  for (let i = 0; i < count; i++) {
    const item = { index: i, seed: seedPlan[i], status: 'pending', submittedAt: Date.now() };
    job.items.push(item);
    try {
      const { status, json } = await msApi(`${MS_BASE}/v1/images/generations`, {
        method: 'POST',
        apiKey: key,
        taskType: 'image_generation',
        body: payloadForItem(built, item),
        timeout: 90000,
      });
      // ModelScope 兼容两种异步返回：header 里带 task_id，或 body.task_id
      const taskId = json.task_id || json.data?.task_id;
      if (status >= 400 || !taskId) {
        // 消息位置不统一：普通错误在 message / error.message；模型下载类错误
        // （例如 LoRA 仓库不存在）在 **errors.message**。漏掉最后这一支，
        // 用户只会看到「提交失败 HTTP 500」，完全无从下手。
        const msg =
          json.message ||
          json.error?.message ||
          json.errors?.message ||
          json.error ||
          json._raw ||
          `提交失败 HTTP ${status}`;
        item.status = 'failed';
        item.error = String(msg).slice(0, 500);
        submitErrors.push(item.error);
      } else {
        item.taskId = taskId;
      }
    } catch (e) {
      item.status = 'failed';
      // 走翻译层：作业卡片上要给的是"能照着排查的话"，不是 getaddrinfo 原文
      item.error = netErrText(e);
      item.errorCode = (e && e.code) || null;
      submitErrors.push(item.error);
    }
    if (i < count - 1) await sleep(400);
  }

  // 一张都没提交成功：作业不落库，直接把原因回给用户（与单张时期行为一致）
  if (!job.items.some((it) => it.taskId)) {
    return sendJson(res, 400, { ok: false, error: submitErrors[0] || '任务提交失败' });
  }

  finalizeJob(job); // 部分在提交阶段就失败时，可能直接收尾
  jobs.unshift(job);
  await persistJobs();
  ensureJobTicker();

  sendJson(res, 200, {
    ok: true,
    jobId: job.id,
    count,
    // 兼容旧调用方：给第一个成功提交的任务 id
    taskId: (job.items.find((it) => it.taskId) || {}).taskId || null,
    items: job.items.map((it) => ({
      index: it.index,
      seed: it.seed,
      taskId: it.taskId || null,
      status: it.status,
      error: it.error || null,
    })),
    // 回传「实际发出去的参数」与调整说明：
    // 接口对越界参数是硬报错、对未知参数是静默忽略，两种情况用户都看不见，
    // 所以把真实生效值回传，前端才有机会说人话。
    sent: {
      size: payload.size || null,
      steps: payload.steps ?? null,
      guidance: payload.guidance ?? null,
      // 批量时这里给的是**本批基准种子**，各张的真实种子见 items[].seed / note
      seed: baseSeed ?? null,
      seeds: count > 1 ? seedPlan : undefined,
      refImages: Array.isArray(payload.image_url) ? payload.image_url.length : payload.image_url ? 1 : 0,
      loras: payload.loras || null,
    },
    note: notes.join('；'),
  });
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
    sendJson(res, 500, { ok: false, error: netErrText(e) });
  }
}

/**
 * GET /api/job?id= — 查单个作业。前端轮询这个，不再直连 /api/task ——
 * /api/task 只问 ModelScope 要状态，而作业还要包含"已落盘到哪个文件"这些本地事实。
 */
async function handleJob(res, url) {
  await loadJobs();
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少作业 id' });
  const job = jobs.find((j) => j.id === id);
  if (!job) return sendJson(res, 404, { ok: false, error: '作业不存在（可能已被清理）' });
  sendJson(res, 200, { ok: true, job: jobView(job) });
}

/** GET /api/jobs — 最近作业列表。页面加载时用它发现"上次那个还在跑"，从而重连。 */
async function handleJobs(res) {
  await loadJobs();
  sendJson(res, 200, {
    ok: true,
    jobs: jobs.slice(0, 10).map(jobView),
    activeId: (activeJob() || {}).id || null,
  });
}

/**
 * POST /api/job/cancel — 停止跟踪一个作业。body: { id }
 *
 * ⚠️ 文案必须诚实：这里只能停止**轮询**，无法取消 ModelScope 上已经排队或正在执行的任务。
 * 也就是说取消**不会**把额度省回来 —— 如果写成"已取消"，用户会以为省了钱。
 */
async function handleJobCancel(req, res) {
  const raw = await readBody(req);
  let p;
  try {
    p = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求格式错误' });
  }
  await loadJobs();
  const job = jobs.find((j) => j.id === String(p.id || '').trim());
  if (!job) return sendJson(res, 404, { ok: false, error: '作业不存在' });
  if (job.status !== 'running') {
    return sendJson(res, 400, { ok: false, error: `作业已结束（${job.status}），无需取消` });
  }
  job.status = 'cancelled';
  job.finishedAt = Date.now();
  job.updatedAt = job.finishedAt;
  job.error = '已停止跟踪；ModelScope 上已提交的任务可能仍在执行，额度不会退回';
  for (const it of job.items) {
    if (it.status === 'pending') {
      it.status = 'cancelled';
      it.error = it.error || '已停止跟踪';
    }
  }
  await persistJobs();
  sendJson(res, 200, { ok: true, job: jobView(job) });
}

/**
 * 下载远程图片 → 落盘到 outputs/yyyymmdd####.png → 写入历史，返回历史条目。
 *
 * 抽出来的原因：后台作业轮询器拿不到浏览器，必须自己完成"保存"这一步。
 * 接口（/api/save）与轮询器共用这一份实现，避免两处落盘规则漂移。
 *
 * @returns {{ok:true, item:Object}|{ok:false, error:string, http:number}}
 */
async function saveRemoteImage(url, meta = {}) {
  if (!url || !/^https?:\/\//.test(url)) {
    return { ok: false, error: '缺少合法的图片 URL', http: 400 };
  }

  let imgBuf;
  try {
    const r = await requestUrl(url, { timeout: 180000 });
    if (r.status !== 200 || !r.body || r.body.length < 100) {
      return { ok: false, error: `图片下载失败 HTTP ${r.status}`, http: 400 };
    }
    imgBuf = r.body;
  } catch (e) {
    return { ok: false, error: `下载失败：${e.message}`, http: 500 };
  }

  // 需求要求统一 .png 命名；非 PNG 内容时用 sharp 不可用则直接原样落盘为 .png
  const { filename, seq, dateStr } = await nextOutputName('png');
  const filePath = path.join(OUTPUTS_DIR, filename);
  await fsp.writeFile(filePath, imgBuf);

  // 读回真实像素尺寸：接口可能忽略尺寸参数并退回默认比例，需如实记录
  const actual = readPngSize(imgBuf);
  const requested = meta.width && meta.height ? { w: meta.width, h: meta.height } : null;
  const mismatch = !!(requested && actual && (actual.w !== requested.w || actual.h !== requested.h));

  const item = {
    id: crypto.randomUUID(),
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
    // 记录的是「本次是否按透明图句式改写提示词」，而不是某个接口开关 ——
    // 接口没有输出格式参数，模型永远输出 RGBA 容器。
    transparent: !!meta.transparent,
    sourceImages: Array.isArray(meta.sourceImages) ? meta.sourceImages : [],
    durationMs: meta.durationMs ?? null,
  };

  const list = await readJson(HISTORY_FILE, []);
  list.unshift(item);
  await writeHistory(list);

  return { ok: true, item };
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

  const saved = await saveRemoteImage(p.url, p.meta && typeof p.meta === 'object' ? p.meta : {});
  if (!saved.ok) return sendJson(res, saved.http || 500, { ok: false, error: saved.error });

  sendJson(res, 200, { ok: true, item: saved.item, path: `outputs/${saved.item.file}` });
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

/** 读取规范文件（按 mtime+size 缓存）
 *  规范文件是提示词质量的唯一来源，用户可能随时替换它（换机器、官方更新），
 *  所以缓存按 mtime+size 失效，替换文件后无需重启服务即可生效。 */
const _ruleCache = {};
function readTextCached(file) {
  try {
    const st = fs.statSync(file);
    const hit = _ruleCache[file];
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = fs.readFileSync(file, 'utf8');
    _ruleCache[file] = { mtimeMs: st.mtimeMs, size: st.size, text };
    return text;
  } catch (e) {
    return null;
  }
}

function readRule(kind) {
  return readTextCached(RULE_FILES[kind] || RULE_FILES.t2i);
}

/** 附加规则原文；文件缺失时返回 null（调用方必须如实报错，不能静默降级） */
function readExtraRule() {
  return readTextCached(EXTRA_RULE_FILE);
}

/** 从规范原文提取章节大纲（## 标题行），供界面展示"这份规范实际要求什么" */
function extractOutline(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) out.push(m[1]);
    if (out.length >= 24) break;
  }
  return out;
}

/** 规范文件元信息：文件名 / 大小 / sha256 / 行数 / 大纲
 *  界面上直接把指纹亮出来，用来回答"应用当前到底在用哪份规范"这个疑问。 */
function fileMeta(file, kind) {
  const base = {
    kind,
    file: path.basename(file),
    path: `data/rules/${path.basename(file)}`,
    exists: false,
    bytes: 0,
    sha256: '',
    lines: 0,
    outline: [],
  };
  try {
    const text = readTextCached(file);
    if (!text) return base;
    const st = fs.statSync(file);
    return {
      ...base,
      exists: true,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
      lines: text.split(/\r?\n/).length,
      outline: extractOutline(text),
      mtime: st.mtimeMs,
    };
  } catch (e) {
    return base;
  }
}

function ruleMeta(kind) {
  return fileMeta(RULE_FILES[kind], kind);
}

function extraRuleMeta() {
  return fileMeta(EXTRA_RULE_FILE, 'extra');
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
      let rfOk = /^<image\d+>$/.test(rf) ? rf : '';

      // 文生图规范（Image Prompt Rewriting Expert）只定义了 rewritten_prompt 与
      // wh_ratio 两个字段，没有"跟随某张输入图"的概念。模型若多吐了 ratio_follow
      // 一律丢弃，否则会污染下游创作台的尺寸设置。
      if (kind === 't2i') rfOk = '';

      // 编辑规范的互斥兜底：两个都有值时保留 ratio_follow（编辑场景更常见）
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
 * 官方规范规定：模型的回复必须是 JSON ——
 *   t2i  : {"rewritten_prompt": "...", "wh_ratio": "..."}
 *   edit : {"rewritten_prompt": "...", "wh_ratio": "", "ratio_follow": "<image1>"}
 * （t2i 规范："Return one strictly valid JSON object on a single line, nothing before or after"；
 *   edit 规范："Output a valid JSON object with exactly three fields" / "Do not include any text
 *   outside the JSON object"）
 *
 * 但这个 JSON 是**模型与程序之间的传输格式**，不是给扩散模型看的提示词：
 * 直接把它当 prompt 送去生图，JSON 标点会进画面；而且壳里带着比例字段，
 * 恰好违反 edit 规范「正文不得出现比例」那一条。
 *
 * 用户经常直接从别处复制这种带壳文本粘进创作台，所以这里剥一次壳。
 * 只有"确实长得像官方契约"的输入才剥，其余一律原样返回（返回 null）。
 */
function unwrapPromptEnvelope(text) {
  let t = String(text || '').trim();
  // 从聊天窗口复制时常常带着 markdown 代码块围栏
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!t.startsWith('{')) return null; // 快速排除：提示词正文几乎不会以 { 开头
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj = null;
  try {
    obj = JSON.parse(m[0]);
  } catch (e) {
    // 再试一次：字符串值里可能有未转义的真实换行 / 制表符
    try {
      obj = JSON.parse(
        m[0].replace(/"((?:[^"\\]|\\.)*)"/g, (full) =>
          full.replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t')
        )
      );
    } catch (e2) {
      return null; // 不是合法 JSON，可能只是普通正文里带了花括号
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.rewritten_prompt !== 'string' || !obj.rewritten_prompt.trim()) return null;
  return {
    prompt: obj.rewritten_prompt.replace(/\r\n|\r|\n/g, ' ').replace(/\s{2,}/g, ' ').trim(),
    whRatio: typeof obj.wh_ratio === 'string' ? obj.wh_ratio.trim() : '',
    ratioFollow: typeof obj.ratio_follow === 'string' ? obj.ratio_follow.trim() : '',
  };
}

/**
 * 收集本次要送入模型的图片 —— 唯一来源是该对话锁定在 inputs/ 里的图片文件。
 *
 * 早先还支持请求体直接传 imageData（前端把 base64 一起发来），现已移除：
 * 那条路与"服务端持有唯一真相"重复，一旦前端内存里的图与实际落盘的文件不一致，
 * 就会出现"界面显示有图、模型收到的是另一张（或什么都没有）"这类极难排查的分裂。
 * 现在前端只提交 convId，服务端读盘组装 dataURL。
 *
 * @returns {Promise<{list:string[], dropped:number, invalid:number, missing:number, note:string}>}
 */
async function collectVisionImages(p) {
  const urls = [];
  let missing = 0;
  let invalid = 0;

  if (p && p.convId) {
    try {
      const store = await readConvStore();
      const item = store.items.find((i) => i.id === String(p.convId));
      for (const im of (item && item.images) || []) {
        if (!isSafeInputFile(im.file)) {
          invalid += 1;
          continue;
        }
        try {
          const buf = await fsp.readFile(path.join(INPUTS_DIR, im.file));
          urls.push(`data:${mimeFromExt(im.file)};base64,${buf.toString('base64')}`);
        } catch (e) {
          // 文件在盘上丢了。必须如实上报：否则用户会以为模型"看过图"了，
          // 实际拿到的是盲写的提示词。
          missing += 1;
        }
      }
    } catch (e) {
      /* 读不到对话就按无图处理，不能因为附图失败而让优化整体失败 */
    }
  }

  const list = [];
  let total = 0;
  let dropped = 0;
  for (const u of urls) {
    if (list.length >= VISION_MAX_IMAGES) {
      dropped += 1;
      continue;
    }
    if (!isImageDataUrl(u)) {
      invalid += 1;
      continue;
    }
    if (u.length > VISION_IMG_MAX_CHARS || total + u.length > VISION_TOTAL_MAX_CHARS) {
      dropped += 1;
      continue;
    }
    list.push(u);
    total += u.length;
  }

  const notes = [];
  if (dropped) notes.push(`有 ${dropped} 张图片因超出张数或体积上限未送入模型`);
  if (invalid) notes.push(`有 ${invalid} 张图片格式不受支持，已跳过`);
  if (missing) notes.push(`有 ${missing} 张图片文件在 inputs/ 中缺失`);
  return { list, dropped, invalid, missing, note: notes.join('；') };
}

/**
 * POST /api/optimize — 按 Qwen-Image-2.1 官方规范优化提示词
 * body: { apiKey?, baseUrl?, model?, kind?:'t2i'|'edit', text,
 *         convId?, history?:[{role,content}] }
 * 参考图不随请求传 —— 服务端按 convId 从 inputs/ 读该对话锁定的图片。
 *
 * imageData 为真正的图片数据（视觉输入）；images 只是文件名，用于在没带图时
 * 至少让模型知道"有几张输入图"。
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

  // 附加规则（可选）：只有用户勾选时才追加，并且是**独立的第二条 system 消息**，
  // 不是拼进官方规范里 —— 官方规范原文因此逐字节保持不变。
  // 「改规范」和「加补充」是两件事，这里严格分开。
  let extraMeta = null;
  if (p.extra === true) {
    const extraText = readExtraRule();
    if (!extraText) {
      return sendJson(res, 500, {
        ok: false,
        error: '已勾选附加规则，但读取不到 data/rules/extra_transparent_subject.md',
      });
    }
    messages.push({ role: 'system', content: extraText });
    extraMeta = extraRuleMeta();
  }

  // 带上历史轮次，实现多轮迭代优化
  if (Array.isArray(p.history)) {
    for (const h of p.history.slice(-8)) {
      if (!h || !h.role || !h.content) continue;
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: String(h.content) });
      }
    }
  }

  // —— 视觉输入：把参考图真正递给模型 ——
  const vision = await collectVisionImages(p);

  // 图片数量以实际送入模型的张数为准；没有图片数据时退回文件名计数
  const nameCount = Array.isArray(p.images) ? p.images.filter(Boolean).length : 0;
  const imgCount = vision.list.length || nameCount;
  let userContent = text;
  if (kind === 'edit') {
    userContent = vision.list.length
      ? `【本次输入图片数量：${vision.list.length} 张，已随本条消息附在下方，按先后顺序对应 <image1>${
          vision.list.length > 1 ? `~<image${vision.list.length}>` : ''
        }】\n\n用户指令：${text}`
      : `【本次输入图片数量：${imgCount} 张${
          imgCount >= 2 ? `，请使用 <image1>~<image${imgCount}> 标签引用` : ''
        }】\n\n用户指令：${text}`;
  } else if (vision.list.length) {
    // 文生图规范没有 <imageN> 的概念：附图只作风格与内容参照，明确禁止引用标签
    userContent =
      `【附图 ${vision.list.length} 张，仅作为风格与内容的参照】\n` +
      `注意：本任务是文生图（从零生成），提示词正文里不要出现 <image1> 这类引用标签。\n\n` +
      `用户需求：${text}`;
  }

  if (vision.list.length) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userContent },
        ...vision.list.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    });
  } else {
    messages.push({ role: 'user', content: userContent });
  }

  let baseUrl = (p.baseUrl || opt.baseUrl || 'https://api-inference.modelscope.cn/v1').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    return sendJson(res, 400, { ok: false, error: 'Base URL 格式不正确' });
  }
  const model = (p.model || opt.model || 'Qwen/Qwen3-8B').trim();

  const callModel = async (msgs, maxTokens) => {
    const { status, json } = await msApi(`${baseUrl}/chat/completions`, {
      method: 'POST',
      apiKey,
      body: { model, messages: msgs, temperature: 0.7, max_tokens: maxTokens, stream: false },
      timeout: 180000,
    });
    if (status >= 400) {
      const msg = json?.error?.message || json?.message || json?._raw || `HTTP ${status}`;
      throw new Error(`优化失败：${String(msg).slice(0, 300)}`);
    }
    const content = String(
      json?.choices?.[0]?.message?.content || json?.output?.text || json?.data?.[0]?.content || ''
    );
    // 推理模型（如 DeepSeek-V4.1）会把预算花在思维链上；预算被吃满时 content 为空。
    // 这种情况单独标记，交由上层加大预算重试，而不是直接报"结果为空"。
    if (!content.trim()) {
      const reasoning = String(json?.choices?.[0]?.message?.reasoning_content || '');
      return {
        ok: false,
        empty: true,
        error: reasoning
          ? '模型只输出了推理过程、没有产出提示词（输出预算被推理占满）'
          : '优化结果为空，请重试',
      };
    }
    return parseOptimizerOutput(content, kind);
  };

  try {
    const budget = vision.list.length ? OPT_MAX_TOKENS_VISION : OPT_MAX_TOKENS;
    let parsed = await callModel(messages, budget);

    // 首轮没有任何正文产出（输出预算被思维链占满）→ 加大预算重试一次
    if (!parsed.ok && parsed.empty) {
      const retry = await callModel(messages, OPT_MAX_TOKENS_RETRY);
      parsed = retry.ok
        ? retry
        : {
            ok: false,
            error: `${retry.error || parsed.error}。可在「个人信息」页把优化模型换成非推理模型后重试`,
          };
    }

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
        const retry = await callModel(compressMsgs, budget);
        if (retry.ok && retry.prompt.length < parsed.prompt.length) {
          parsed = retry;
          parsed.compressed = true;
        }
      } catch (e) {
        // 压缩重试失败时保留首轮结果，由前端提示用户手工精简
      }
    }

    if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

    const meta = ruleMeta(kind);
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
      // 本次实际喂给模型的规范文件指纹，界面上直接展示，便于核对"用的是哪份规范"
      ruleFile: meta.file,
      ruleSha: meta.sha256.slice(0, 12),
      // 附加规则（透明图句式 / 主体提取）本次是否生效，以及它的指纹
      extra: extraMeta
        ? { file: extraMeta.file, sha: extraMeta.sha256.slice(0, 12), bytes: extraMeta.bytes }
        : null,
      // 本次是否真的把图递给了模型（区别于只报了个图片数量）
      visionUsed: vision.list.length > 0,
      visionImageCount: vision.list.length,
      visionNote: vision.note || '',
      ruleBytes: meta.bytes,
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: errText(e, '优化失败') });
  }
}

// GET /api/rules — 返回规范文件是否存在及元信息（文件名 / 大小 / sha256 / 大纲）
async function handlePluginConfig(res) {
  const t2i = ruleMeta('t2i');
  const edit = ruleMeta('edit');
  const extra = extraRuleMeta();
  sendJson(res, 200, {
    ok: true,
    rules: { t2i, edit },
    // 附加规则（透明图句式 / 主体提取）。不属于官方规范，勾选时才随请求发送。
    extraRule: extra,
    // 兼容旧字段：是否存在
    available: { t2i: t2i.exists, edit: edit.exists },
    dir: 'data/rules',
    model: MODEL_ID,
    source: 'https://modelscope.cn/models/Qwen/Qwen-Image-2.1',
  });
}

/** GET /api/rules/:kind/source — 返回规范原文，供界面「查看原文」
 *  kind 取 t2i / edit / extra（extra = 本项目的附加规则文件） */
function handleRuleSource(res, kind) {
  if (kind === 'extra') {
    const text = readExtraRule();
    if (!text) {
      return sendJson(res, 404, {
        ok: false,
        error: `附加规则文件不存在：${extraRuleMeta().path}`,
      });
    }
    return sendJson(res, 200, { ok: true, kind, meta: extraRuleMeta(), text });
  }
  if (!RULE_FILES[kind]) {
    return sendJson(res, 400, { ok: false, error: '未知的规范类型（应为 t2i、edit 或 extra）' });
  }
  const text = readRule(kind);
  if (!text) {
    return sendJson(res, 404, { ok: false, error: `规范文件不存在：${ruleMeta(kind).path}` });
  }
  sendJson(res, 200, { ok: true, kind, meta: ruleMeta(kind), text });
}

/* ---------------- 提示词对话记录（持久化会话） ----------------
   设计要点：
   1) 类型 kind 由用户在每个对话里显式选择，绝不从创作台模式推断 ——
      否则"在图生图模式下聊文生图提示词"就会用错规范文件。
   2) 消息自身也记录 kind。前端只把 kind 相同的消息作为多轮上下文发给模型，
      因此中途切换类型不会让两种规范的产物互相污染。
   3) 会话可新建 / 重命名 / 删除；元数据不可再生（用户手写的需求 + 模型产出的
      提示词），所以每次写入前留一份滚动备份，与历史记录同一策略。 */

const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
const CONV_BAK_FILE = path.join(DATA_DIR, 'conversations.bak.json');
const CONV_KINDS = ['t2i', 'edit'];
const CONV_MAX_ITEMS = 80; // 最多保留的对话数（超出丢最旧的空对话）
const CONV_MAX_MESSAGES = 200; // 单个对话最多保留的消息数
// 对话锁定的参考图：前端已按视觉模型需要压缩过，这里再兜一层格式与体积校验
const CONV_MAX_IMAGES = 6;
// 前端提交的单张 dataURL 字符上限。落盘解决的是存储问题、不改变体积问题：
// 这些图最终仍要以 base64 送进视觉模型，所以这里必须与 VISION_IMG_MAX_CHARS 对齐，
// 否则会出现「存得下、发不出」——图在对话里显示正常，模型却永远收不到。
const CONV_IMG_DATAURL_MAX = 900_000;

async function writeConversations(store) {
  try {
    await fsp.copyFile(CONV_FILE, CONV_BAK_FILE);
  } catch (e) {
    /* 首次写入时源文件不存在，无需备份 */
  }
  await writeJson(CONV_FILE, store);
}

/* ---------- 锁定图：磁盘引用 ----------

   锁定图不再以 base64 存在 conversations.json 里，而是落盘到 inputs/，
   对话里只留文件名。理由：
     · 6 张图原本能让 conversations.json 膨胀到 8MB，列表接口也得跟着变大；
     · 图片文件可直接查看、替换、复用，排查问题不再需要从 JSON 里挖 base64。

   注意：**落盘解决的是存储问题，不是体积问题**。这些图最终仍要以 base64
   送进视觉模型（ModelScope 的 image_url 只认 dataURL），所以单张体积上限
   依旧与 VISION_IMG_MAX_CHARS 对齐。 */

const INPUTS_URL_PREFIX = '/inputs/';

/** 由 dataURL 的 mime 推导文件扩展名 */
function extFromDataUrl(u) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,/.exec(u);
  if (!m) return '';
  const t = m[1];
  if (t === 'jpeg' || t === 'jpg') return '.jpg';
  return t === 'webp' ? '.webp' : '.png';
}

/** 由扩展名反推 mime，供读盘后重新组装 dataURL */
function mimeFromExt(file) {
  const e = path.extname(file).toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  return 'image/png';
}

/** 文件名是否可安全拼进 INPUTS_DIR —— 不含任何目录成分、非隐藏文件 */
function isSafeInputFile(f) {
  return (
    typeof f === 'string' &&
    f.length > 0 &&
    f.length <= 160 &&
    path.basename(f) === f &&
    !f.startsWith('.')
  );
}

/** 生成不冲突的落盘文件名，同时保留原图名的主体部分便于辨认 */
function makeInputFileName(origName, ext) {
  const base =
    String(origName || 'image')
      .replace(/\.[^.]*$/, '')
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
      .slice(0, 40) || 'image';
  return `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}_${base}${ext}`;
}

async function writeInputFile(file, dataUrl) {
  const comma = dataUrl.indexOf(',');
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  await fsp.writeFile(path.join(INPUTS_DIR, file), buf);
  return buf.length;
}

/** 规范化单张锁定图的**引用**形式（只含文件名，不含 base64） */
function normConvImage(im) {
  if (!im || typeof im !== 'object') return null;
  if (!isSafeInputFile(im.file)) return null;
  return {
    name: String(im.name || 'image').slice(0, 120),
    file: im.file,
    w: Math.max(0, Math.round(Number(im.w) || 0)),
    h: Math.max(0, Math.round(Number(im.h) || 0)),
    bytes: Math.max(0, Math.round(Number(im.bytes) || 0)),
  };
}

/** 规范化整组锁定图 */
function normConvImages(arr) {
  return (Array.isArray(arr) ? arr : []).map(normConvImage).filter(Boolean).slice(0, CONV_MAX_IMAGES);
}

/**
 * 接收前端提交的整组锁定图并落盘，返回引用列表。
 * 每项允许两种形态：
 *   · { name, dataUrl, w, h } —— 前端压缩好的新图，写入 inputs/
 *   · { file, name, w, h }    —— 服务端此前返回的引用，原样沿用（避免每次 PATCH 重写文件）
 */
async function ingestConvImages(arr) {
  const out = [];
  for (const im of Array.isArray(arr) ? arr : []) {
    if (out.length >= CONV_MAX_IMAGES) break;
    if (!im || typeof im !== 'object') continue;
    const name = String(im.name || 'image').slice(0, 120);
    const w = Math.max(0, Math.round(Number(im.w) || 0));
    const h = Math.max(0, Math.round(Number(im.h) || 0));

    if (isSafeInputFile(im.file)) {
      // 沿用既有引用：顺手 stat 一下，文件不在了就丢弃，避免留下死引用
      try {
        const st = await fsp.stat(path.join(INPUTS_DIR, im.file));
        if (!st.isFile()) continue;
        out.push({ name, file: im.file, w, h, bytes: st.size });
      } catch (e) {
        /* 文件不存在 → 跳过 */
      }
      continue;
    }

    const dataUrl = String(im.dataUrl || '');
    if (!isImageDataUrl(dataUrl) || dataUrl.length > CONV_IMG_DATAURL_MAX) continue;
    const ext = extFromDataUrl(dataUrl);
    if (!ext) continue;
    try {
      const file = makeInputFileName(name, ext);
      const bytes = await writeInputFile(file, dataUrl);
      out.push({ name, file, w, h, bytes });
    } catch (e) {
      /* 单张写盘失败就跳过，不牵连其余 */
    }
  }
  return out;
}

/** 删除某组图片文件（尽力而为，失败不影响主流程） */
async function removeInputFiles(files) {
  await Promise.all(
    (files || [])
      .filter(isSafeInputFile)
      .map((f) => fsp.unlink(path.join(INPUTS_DIR, f)).catch(() => {}))
  );
}

function normConvMsg(m) {
  if (!m || typeof m !== 'object') return null;
  const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
  if (!role) return null;
  const out = {
    role,
    kind: CONV_KINDS.includes(m.kind) ? m.kind : 't2i',
    ts: Number(m.ts) || Date.now(),
    text: String(m.text == null ? '' : m.text).slice(0, 8000),
  };
  if (role === 'assistant' && m.result && typeof m.result === 'object') {
    out.result = {
      prompt: String(m.result.prompt || '').slice(0, PROMPT_HARD_LIMIT + 500),
      whRatio: String(m.result.whRatio || '').slice(0, 16),
      ratioFollow: String(m.result.ratioFollow || '').slice(0, 24),
      note: String(m.result.note || '').slice(0, 500),
      ruleFile: String(m.result.ruleFile || '').slice(0, 80),
      ruleSha: String(m.result.ruleSha || '').slice(0, 16),
    };
  }
  return out;
}

function normConv(it) {
  if (!it || typeof it !== 'object') return null;
  const id = String(it.id || '').trim();
  if (!id) return null;
  const createdAt = Number(it.createdAt) || Date.now();
  return {
    id: id.slice(0, 64),
    title: String(it.title || '').slice(0, 80) || '未命名对话',
    kind: CONV_KINDS.includes(it.kind) ? it.kind : 't2i',
    // 是否启用附加规则（透明图句式 / 主体提取）。属于对话级设置，随对话保存。
    extra: it.extra === true,
    createdAt,
    updatedAt: Number(it.updatedAt) || createdAt,
    messages: (Array.isArray(it.messages) ? it.messages : [])
      .map(normConvMsg)
      .filter(Boolean)
      .slice(-CONV_MAX_MESSAGES),
    // 该对话锁定的参考图：送给视觉模型"检阅"的就是这几张
    images: normConvImages(it.images),
  };
}

function normStore(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = (Array.isArray(src.items) ? src.items : []).map(normConv).filter(Boolean);
  // 超出上限时优先丢弃最旧的"空对话"，没有任何消息的会话丢了也不心疼
  if (items.length > CONV_MAX_ITEMS) {
    items.sort((a, b) => {
      const ae = a.messages.length === 0 ? 0 : 1;
      const be = b.messages.length === 0 ? 0 : 1;
      if (ae !== be) return ae - be;
      return a.updatedAt - b.updatedAt;
    });
    items.splice(0, items.length - CONV_MAX_ITEMS);
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  let activeId = String(src.activeId || '');
  if (!items.some((i) => i.id === activeId)) activeId = items[0] ? items[0].id : '';
  return { version: 1, activeId, items };
}

function newConvId() {
  return `c_${crypto.randomBytes(6).toString('hex')}`;
}

// 同一个进程内的写入串行化，避免连续两个 PATCH 互相覆盖
let _convChain = Promise.resolve();
function withConvLock(fn) {
  const run = _convChain.then(fn, fn);
  _convChain = run.catch(() => {});
  return run;
}

async function readConvStore() {
  return normStore(await readJson(CONV_FILE, null));
}

/**
 * 启动时一次性迁移：早期版本把压缩图的 base64 直接存在对话里（images[].dataUrl）。
 * 改为落盘引用后，旧数据必须就地迁走，否则那些图会静默消失。
 * 放在启动阶段而非请求路径里，是为了避开并发读同时触发迁移的竞态。
 * @returns {Promise<number>} 迁移张数
 */
async function migrateConvImageStorage() {
  const raw = await readJson(CONV_FILE, null);
  const items = Array.isArray(raw && raw.items) ? raw.items : [];
  const legacy = items.filter(
    (it) => it && Array.isArray(it.images) && it.images.some((im) => im && im.dataUrl)
  );
  if (!legacy.length) return 0;

  const store = normStore(raw);
  let count = 0;
  for (const it of legacy) {
    const target = store.items.find((i) => i.id === String(it.id));
    if (!target) continue;
    target.images = await ingestConvImages(it.images);
    count += target.images.length;
  }
  await writeConversations(store);
  return count;
}

/**
 * 回收 inputs/ 里的孤儿文件：凡是没有被任何对话引用的，且已存在超过
 * 宽限期（避免误删正在写入的文件），一律清掉。
 * 只在启动时跑一次 —— 会话期间删掉的图会留到下次启动，换来的是零竞态。
 */
async function pruneInputs(graceMs = 10 * 60 * 1000) {
  let files;
  try {
    files = await fsp.readdir(INPUTS_DIR);
  } catch (e) {
    return 0;
  }
  const store = await readConvStore();
  const used = new Set();
  for (const it of store.items) {
    for (const im of it.images || []) if (im.file) used.add(im.file);
  }
  const now = Date.now();
  let removed = 0;
  for (const f of files) {
    if (used.has(f) || !isSafeInputFile(f)) continue;
    const full = path.join(INPUTS_DIR, f);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs < graceMs) continue;
      await fsp.unlink(full);
      removed += 1;
    } catch (e) {
      /* 单个文件失败不影响其余 */
    }
  }
  return removed;
}

async function handleConversations(res) {
  const store = await readConvStore();
  // 图片已是文件名引用，不再有 base64 需要剥离，列表与详情返回同一形状。
  sendJson(res, 200, { ok: true, activeId: store.activeId, items: store.items });
}

/** GET /api/conversations/:id — 单个对话完整内容（图片为 inputs/ 下的文件名引用） */
async function handleConvGet(res, id) {
  const store = await readConvStore();
  const item = store.items.find((i) => i.id === id);
  if (!item) return sendJson(res, 404, { ok: false, error: '对话不存在' });
  sendJson(res, 200, { ok: true, item });
}

async function handleConvCreate(req, res) {
  const raw = await readBody(req);
  let p = {};
  try {
    p = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求格式错误' });
  }
  const kind = CONV_KINDS.includes(p.kind) ? p.kind : 't2i';
  await withConvLock(async () => {
    const store = await readConvStore();
    const now = Date.now();
    const item = {
      id: newConvId(),
      title: String(p.title || '').slice(0, 80) || (kind === 'edit' ? '新的编辑提示词对话' : '新的文生图提示词对话'),
      kind,
      createdAt: now,
      updatedAt: now,
      messages: [],
      // 从创作台「去优化提示词」跳转时，参考图可随创建一起锁定进这个对话
      images: await ingestConvImages(p.images),
    };
    store.items.unshift(item);
    store.activeId = item.id;
    const next = normStore(store);
    await writeConversations(next);
    const saved = next.items.find((i) => i.id === item.id) || item;
    sendJson(res, 200, { ok: true, item: saved, activeId: next.activeId, items: next.items });
  });
}

async function handleConvUpdate(req, res, id) {
  const raw = await readBody(req);
  let p;
  try {
    p = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求格式错误' });
  }
  await withConvLock(async () => {
    const store = await readConvStore();
    const idx = store.items.findIndex((i) => i.id === id);
    if (idx < 0) return sendJson(res, 404, { ok: false, error: '对话不存在' });

    const cur = store.items[idx];
    const next = { ...cur };
    if (typeof p.title === 'string') next.title = p.title.slice(0, 80) || cur.title;
    if (CONV_KINDS.includes(p.kind)) next.kind = p.kind;
    if (typeof p.extra === 'boolean') next.extra = p.extra;
    // 整组替换语义：传 [] 即清空该对话锁定的图片
    if (Array.isArray(p.images)) {
      const prevFiles = (cur.images || []).map((im) => im.file);
      next.images = await ingestConvImages(p.images);
      const keep = new Set(next.images.map((im) => im.file));
      // 替换后不再被引用的旧图当场删掉，避免 inputs/ 只增不减
      await removeInputFiles(prevFiles.filter((f) => !keep.has(f)));
    }
    if (Array.isArray(p.messages)) {
      next.messages = p.messages.map(normConvMsg).filter(Boolean).slice(-CONV_MAX_MESSAGES);
      const firstUser = next.messages.find((m) => m.role === 'user' && m.text);
      // 标题仍是默认值时，用首条需求自动命名
      if (firstUser && /^新的(文生图|编辑)提示词对话$/.test(next.title)) {
        next.title = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 30);
      }
    }
    next.updatedAt = Date.now();
    store.items[idx] = normConv(next);
    const saved = normStore(store);
    await writeConversations(saved);
    const savedItem = saved.items.find((i) => i.id === id) || null;
    sendJson(res, 200, { ok: true, item: savedItem, activeId: saved.activeId });
  });
}

async function handleConvDelete(res, id) {
  await withConvLock(async () => {
    const store = await readConvStore();
    const doomed = store.items.find((i) => i.id === id);
    const before = store.items.length;
    store.items = store.items.filter((i) => i.id !== id);
    if (store.items.length === before) {
      return sendJson(res, 404, { ok: false, error: '对话不存在' });
    }
    if (store.activeId === id) store.activeId = store.items[0] ? store.items[0].id : '';
    const saved = normStore(store);
    await writeConversations(saved);
    // 对话连同它的锁定图一起消失，别在 inputs/ 里留下无主文件
    if (doomed) await removeInputFiles((doomed.images || []).map((im) => im.file));
    sendJson(res, 200, { ok: true, activeId: saved.activeId, items: saved.items });
  });
}

async function handleConvSetActive(req, res) {
  const raw = await readBody(req);
  let p;
  try {
    p = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求格式错误' });
  }
  await withConvLock(async () => {
    const store = await readConvStore();
    const id = String(p.id || '');
    if (id && !store.items.some((i) => i.id === id)) {
      return sendJson(res, 404, { ok: false, error: '对话不存在' });
    }
    store.activeId = id || (store.items[0] ? store.items[0].id : '');
    const saved = normStore(store);
    await writeConversations(saved);
    sendJson(res, 200, { ok: true, activeId: saved.activeId });
  });
}

/* 尺寸预设统一由前端 public/app.js 的 SIZES 维护（单边上限 2048，见该处注释）。
   此处曾有一份未使用的 PRESETS 常量，其中 2048x3072 已超单边上限，故移除，避免误导。 */

/* ---------------- 静态文件 ---------------- */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // outputs / inputs / public 都可访问。
  // 两个资源目录一律取 basename —— 丢掉任何目录成分，从根上堵住 ../ 穿越。
  let filePath;
  if (rel.startsWith('/outputs/')) {
    filePath = path.join(OUTPUTS_DIR, path.basename(rel));
  } else if (rel.startsWith('/inputs/')) {
    filePath = path.join(INPUTS_DIR, path.basename(rel));
  } else {
    filePath = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  }

  const resolved = path.resolve(filePath);
  const allowed = [path.resolve(PUBLIC_DIR), path.resolve(OUTPUTS_DIR), path.resolve(INPUTS_DIR)];
  if (!allowed.some((a) => resolved.startsWith(a))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const st = await fsp.stat(resolved);
    if (!st.isFile()) throw new Error('not file');
    const ext = path.extname(resolved).toLowerCase();

    /* 前端资源（html / js / css）一律要求**回源校验**，只发 ETag。
       教训：原来给 js/css 发了 `max-age=3600` 却没有 ETag / Last-Modified，
       浏览器于是能把 app.js 缓存满一整小时 —— 改完代码、重启服务、刷新页面，
       拿到的还是旧行为，看起来就像「改动没生效」，排查极费时间。
       outputs/ 与 inputs/ 里是落盘后就不再变动的文件，那里才适合长时间缓存。 */
    const immutable = /^\/(outputs|inputs)\//.test(rel);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (!immutable && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return void res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache',
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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
    if (pathname === '/api/job' && req.method === 'GET') return void (await handleJob(res, url));
    if (pathname === '/api/jobs' && req.method === 'GET') return void (await handleJobs(res));
    if (pathname === '/api/job/cancel' && req.method === 'POST') return void (await handleJobCancel(req, res));
    if (pathname === '/api/save' && req.method === 'POST') return void (await handleSave(req, res));
    if (pathname === '/api/optimize' && req.method === 'POST') return void (await handleOptimize(req, res));
    if (pathname === '/api/rules' && req.method === 'GET') return void handlePluginConfig(res);
    if (pathname.startsWith('/api/rules/') && pathname.endsWith('/source') && req.method === 'GET') {
      return void handleRuleSource(res, pathname.split('/')[3]);
    }

    // 提示词对话记录
    if (pathname === '/api/conversations' && req.method === 'GET') return void (await handleConversations(res));
    if (pathname === '/api/conversations' && req.method === 'POST') return void (await handleConvCreate(req, res));
    if (pathname === '/api/conversations/active' && req.method === 'POST') {
      return void (await handleConvSetActive(req, res));
    }
    // 单个对话（含锁定的图片本体）。必须排在 PATCH/DELETE 之前用 GET 区分，
    // 且 'active' 那条已在上方拦截，不会被这里当成 id。
    if (pathname.startsWith('/api/conversations/') && req.method === 'GET') {
      return void (await handleConvGet(res, decodeURIComponent(pathname.split('/').pop())));
    }
    if (pathname.startsWith('/api/conversations/') && req.method === 'PATCH') {
      return void (await handleConvUpdate(req, res, decodeURIComponent(pathname.split('/').pop())));
    }
    if (pathname.startsWith('/api/conversations/') && req.method === 'DELETE') {
      return void (await handleConvDelete(res, decodeURIComponent(pathname.split('/').pop())));
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '未知接口' });

    return void (await serveStatic(req, res, pathname));
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || '服务器内部错误' });
  }
});

ensureDirs();

// 启动维护：先迁移旧的 base64 存储，再回收孤儿文件。
// 都放在 listen 之前 —— 迁移没跑完就对外服务的话，前几个请求会读到"没有图片"的对话。
(async () => {
  try {
    const moved = await migrateConvImageStorage();
    if (moved) console.log(`  已迁移 ${moved} 张锁定图到 ${INPUTS_DIR}`);
  } catch (e) {
    console.error(`  锁定图迁移失败（不影响其余功能）: ${e.message}`);
  }
  try {
    const pruned = await pruneInputs();
    if (pruned) console.log(`  已清理 ${pruned} 个无主参考图文件`);
  } catch (e) {
    console.error(`  参考图清理失败（不影响其余功能）: ${e.message}`);
  }

  // 恢复生成作业：上次进程退出时未完成的作业继续跑 —— 这是"异步"的关键一半，
  // 否则重启一次就等于把在途任务全丢了（图还在 ModelScope 上，没人取）。
  try {
    await loadJobs();
    const unfinished = jobs.filter((j) => j.status === 'running');
    if (unfinished.length) {
      console.log(`  恢复 ${unfinished.length} 个未完成的生成作业，继续后台轮询`);
    }
    ensureJobTicker();
  } catch (e) {
    console.error(`  生成作业恢复失败（不影响其余功能）: ${e.message}`);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Qwen-Image-2.1 Studio 已启动`);
    console.log(`  → http://127.0.0.1:${PORT}\n`);
    console.log(`  输出目录: ${OUTPUTS_DIR}`);
    console.log(`  参考图目录: ${INPUTS_DIR}`);
    console.log(`  配置目录: ${DATA_DIR}\n`);
  });
})();
