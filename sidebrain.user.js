// ==UserScript==
// @name         Safari AI Sidebar（自用）
// @description  网页右侧 AI 侧边栏：自带 key 跑 DeepSeek / OpenRouter / Gemini / Anthropic，按任务自动挑最省钱且够用的模型
// @namespace    cola.local
// @version      1.0.0
// @edition      free
// @match        *://*/*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @inject-into  content
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* 用法
 * 1) 装免费的 Userscripts（App Store, quoid 出品），Safari 设置里启用并「允许所有网站」
 * 2) 把本文件放进 Userscripts 目录，打开一次扩展弹窗让它加载
 * 3) 网页里按 ⌘⇧K 开侧边栏，点齿轮填 key（至少填一个）
 * 4) 模型选「自动」即可：短问题走便宜模型，长文/硬推理自动升级
 */
(() => {
  'use strict';
  if (window.top !== window.self) return;
  if (document.getElementById('__cola_ai_host__')) return;

  // ---------- 配置 ----------
  const DEFAULTS = {
    hosted: true,                              // 默认走我们自己的服务器：用户不填 key、不选模型
    sbToken: '',                               // 注册后由服务端发的一次性令牌
    serverBase: 'http://127.0.0.1:8792',
    deepseekKey: '',
    openrouterKey: '',
    subChatGPT: false,
    subClaude: false,
    geminiKey: '',
    geminiKey2: '',
    geminiKey3: '',
    anthropicKey: '',
    geminiModel: 'gemini-3.5-flash',
    geminiLongModel: 'gemini-3.5-flash',
    anthropicModel: 'claude-sonnet-4-5',
    ollamaModel: 'gemma4:e4b-it-q4_K_M',
    ollamaUrl: 'http://localhost:11434',
    gatewayUrl: 'http://127.0.0.1:8791',
    panelWidth: 400,
    cacheEnabled: false,
    tinySpend: true,
    groqKey: '',
    groqKey2: '',
    groqModel: 'openai/gpt-oss-120b',
    cfToken: '',
    cfAccount: '',
    cfModel: '@cf/openai/gpt-oss-20b',
    orFreeModels: 'dots-studio/dots-3-note-preview:free,recursive/flint-v1.0:free,openrouter/free',
  };
  const PRESETS = {
    'auto': null,   // 免费优先路由
    'auto-q': null, // 质量优先路由
    'deepseek-flash': { p: 'deepseek', m: 'deepseek-flash' },
    'deepseek-v4-pro': { p: 'deepseek', m: 'deepseek-v4-pro' },
    'ollama': { p: 'ollama', m: '__ollamaModel' },
    'claude-sub': { p: 'claude-sub', m: 'claude-sub' },
    'chatgpt-sub': { p: 'chatgpt-sub', m: 'chatgpt-sub' },
    'openrouter-auto': { p: 'openrouter', m: 'openrouter/auto' },
    'gemini-flash': { p: 'gemini', m: '__geminiModel' },
    'gemini-pro': { p: 'gemini', m: '__geminiLongModel' },
    'claude': { p: 'anthropic', m: '__anthropicModel' },
  };
  const LABEL = {
    'deepseek-chat': 'DeepSeek Chat',
    'deepseek-reasoner': 'DeepSeek R1',
    'openrouter/auto': 'OpenRouter Auto',
    'gemini-flash': 'Gemini Flash',
    'gemini-pro': 'Gemini Pro',
    'claude': 'Claude Sonnet',
  };
  // 每条消息塞进上下文的页面文本上限（字符）
  const PAGE_LIMIT = 24000;
  const HISTORY_TURNS = 8;

  const EDITION = 'free';
  const IS_PRO = EDITION === 'pro';
  // 试用到期 / 未激活时，Pro 能力在客户端也一起关掉（服务端同样会拦）
  let PRO_ON = IS_PRO;
  let TRIAL = null;
  let CFG = { ...DEFAULTS };
  let MODEL_CHOICE = 'auto-b';
  let busy = false;
  const history = []; // {role, content}

  // ---------- 路由：任务 → 模型 ----------
  const HARD = /(代码|重构|报错|异常|堆栈|算法|证明|推导|架构|设计模式|调试|性能|复杂度|正则|SQL|debug|refactor|stack ?trace|algorithm|prove|architect)/i;

  // 判断这句要什么能力（同步启发式；网关可用时优先用 1.5B 分类器）
  function heuristicKind(userText, ctx) {
    const len = (ctx || '').length + userText.length;
    if (len > 16000 && CFG.geminiKey) return 'long';
    if (/(证明|推导|复杂度|架构|设计模式|取舍|trade.?off|多步推理)/i.test(userText)) return 'hard';
    if (/(代码|重构|报错|异常|堆栈|算法|调试|正则|SQL|debug|refactor|stack ?trace|algorithm)/i.test(userText)) return 'code';
    if (/(写一|润色|审阅|翻译成|报告|总结成文|文案|改写成)/.test(userText) && userText.length > 30) return 'writing';
    return 'simple';
  }

  // 每类能力的候选链。四档：free 零成本 / speed 最快 / qual 最强 / bal 小模型判档
  // 同一个 Gemini 模型可以轮流用几把 key：免费额度是按 key 算的
  function gemKey(t) {
    const i = (t && t.k) || 1;
    if (!PRO_ON && i > 1) return '';
    return [CFG.geminiKey, CFG.geminiKey2, CFG.geminiKey3][i - 1] || '';
  }

  function targets() {
    return {
      G: { p: 'gemini', m: CFG.geminiModel, why: 'Gemini 免费层' },
      GL: { p: 'gemini', m: CFG.geminiLongModel, why: '长上下文' },
      G2: { p: 'gemini', m: CFG.geminiModel, why: 'Gemini 免费层 #2', k: 2 },
      G3: { p: 'gemini', m: CFG.geminiModel, why: 'Gemini 免费层 #3', k: 3 },
      CGPT: { p: 'chatgpt-sub', m: 'chatgpt-sub', why: 'ChatGPT 订阅' },
      CL: { p: 'claude-sub', m: 'claude-sub', why: 'Claude 订阅' },
      DSF: { p: 'deepseek', m: 'deepseek-flash', why: 'DeepSeek Flash' },
      DSP: { p: 'deepseek', m: 'deepseek-v4-pro', why: 'DeepSeek V4 Pro' },
      OL: { p: 'ollama', m: CFG.ollamaModel, why: '本地兜底' },
      // 免费层 API（各家官方免费额度）：GR = Groq，CF = Cloudflare Workers AI，ORF = OpenRouter 免费模型池
      GR: { p: 'groq', m: CFG.groqModel, why: 'Groq 免费层' },
      GR2: { p: 'groq2', m: CFG.groqModel, why: 'Groq 备用 key' },
      CF: { p: 'cf', m: CFG.cfModel, why: 'Cloudflare 免费额度（经网关）' },
    };
  }

  // 三层优先级：① 真免费（免费层 API）② 订阅（已付过，边际成本 0）③ 按量计费 API
  // 层与层之间固定这个顺序；层内按这一类题的质量排。本地永远当兜底。
  function chainFor(kind, mode = 'free', level = 2) {
    const { G, GL, G2, G3, CGPT, CL, DSF, DSP, OL, GR, GR2, CF } = targets();

    // OpenRouter 免费模型按清单排：前一个被限流就换下一个（免费模型经常 429）
    const orFrees = String(CFG.orFreeModels || DEFAULTS.orFreeModels)
      .split(',').map(x => x.trim()).filter(Boolean)
      .map((m, i) => ({ p: 'openrouter', m, why: 'OpenRouter 免费模型' + (i ? ' #' + (i + 1) : '') }));

    const freePool = {
      long: [GL, G, G2, G3, GR, GR2, ...orFrees, CF],
      simple: [G, G2, G3, GR, GR2, ...orFrees, CF],
      code: [G, G2, G3, GR, GR2, ...orFrees, CF],
      writing: [G, G2, G3, GR, GR2, ...orFrees, CF],
      hard: [G, G2, G3, GR, GR2, ...orFrees, CF],
    };
    // 订阅层内：ChatGPT 额度比 Claude 多得多，所以先吃 ChatGPT，Claude 当第二
    const subPool = {
      long: [CGPT, CL], simple: [CGPT, CL], code: [CGPT, CL], writing: [CGPT, CL], hard: [CGPT, CL],
    };
    const apiPool = {
      long: [DSP, DSF], simple: [DSF, DSP], code: [DSP, DSF], writing: [DSP, DSF], hard: [DSP, DSF],
    };
    const F = freePool[kind] || freePool.simple;
    const S = subPool[kind] || subPool.simple;
    const A = apiPool[kind] || apiPool.simple;
    // 允许花几分钱时，DeepSeek Flash 顶到本地小模型前面（本地 4B 答得太差）
    const tiny = CFG.tinySpend ? [DSF] : [];

    // 速度档是唯一例外：订阅 CLI 首字 6 秒，API 首字 0.5 秒，
    // 这里把"快"放在"省钱"前面，否则速度档名不副实。
    if (mode === 'speed') return dedupeChain([...(kind === 'long' ? [GL] : [DSF, G]), ...A, ...S, OL]);

    // 平衡档：难度决定"从哪一层起跳"。
    //   难度 1（简单）→ 免费层先上，它答得动，没必要占订阅额度
    //   难度 2（中等）→ 免费层那些 Flash 级模型常常答不完整，直接从订阅起跳
    //   难度 3（真难题）→ 订阅先上，扛不住再花 API 钱
    // 订阅和免费层都是零额外成本，所以这个切换不增加你的开销，只是别把题喂错地方。
    if (mode === 'bal') {
      if (level <= 1) return dedupeChain([...F, ...S, ...tiny, OL]);
      if (level === 2) return dedupeChain([...S, ...F, ...tiny, OL]);
      return dedupeChain([...S, ...A, ...F, OL]);
    }
    // 质量档：三层全开，层内按质量
    if (mode === 'qual') return dedupeChain([...F, ...S, ...A, ...tiny, OL]);
    // 免费档：只用免费层和订阅，API 不主动上（本地除外）
    return dedupeChain([...F, ...S, ...tiny, OL]);
  }

  // 额度冷却：某条通道刚报过限流/额度用完，就先别在它身上反复撞墙。
  // 时长尽量按对方随口告诉我们的重试时间来（Gemini 会说 "Please retry in 27.5s"），
  // 没说的话按 60 秒猜 —— 免费层多数是每分钟限流，不是当天用完。
  const COOLDOWN = {};
  const chanKey = t => t.p + '|' + t.m + (t.k ? '#' + t.k : '');
  function cooldownFromMessage(msg) {
    const m = String(msg || '');
    let sec = 0;
    const a = m.match(/retry(?:Delay)?[^0-9]{0,20}(\d+(?:\.\d+)?)\s*s/i);
    if (a) sec = parseFloat(a[1]);
    if (!sec) {
      const b = m.match(/(\d+(?:\.\d+)?)\s*(?:秒|s)\s*(?:后|再)?/i);
      if (b && /retry|限流|quota|limit/i.test(m)) sec = parseFloat(b[1]);
    }
    const ms = sec > 0 ? Math.min(Math.max(sec * 1000 + 2000, 5000), 20 * 60 * 1000) : 60000;
    return ms;
  }
  function markDead(t, msg) {
    if (!t) return;
    const ms = cooldownFromMessage(msg);
    COOLDOWN[chanKey(t)] = Date.now() + ms;
    const label = ms >= 60000 ? Math.round(ms / 60000) + ' 分钟' : Math.round(ms / 1000) + ' 秒';
    bubble('a', '「' + t.p + '」当前限流/额度用完，' + label + '内自动跳过它。');
  }
  function alive(t) {
    const until = COOLDOWN[chanKey(t)];
    return !until || until < Date.now();
  }

  const NEED_KEY = {
    gemini: () => !!CFG.geminiKey,
    deepseek: () => !!CFG.deepseekKey,
    openrouter: () => !!CFG.openrouterKey,
    anthropic: () => !!CFG.anthropicKey,
    groq: () => !!CFG.groqKey,
    groq2: () => PRO_ON && !!CFG.groqKey2,
    // Cloudflare 走本地网关转发，key 存在网关那边，侧边栏不持有
  };

  function modeOf(choice) {
    const c = choice === undefined ? MODEL_CHOICE : choice;
    if (c === 'auto-s') return 'speed';
    if (c === 'auto-q') return 'qual';
    if (c === 'auto-b') return 'bal';
    return 'free';
  }

  function dedupeChain(list) {
    const out = [];
    const seen = new Set();
    for (const t of list) {
      if (!t) continue;
      if (t.p === 'chatgpt-sub' && !CFG.subChatGPT) continue;
      if (t.p === 'claude-sub' && !CFG.subClaude) continue;
      // 免费版没有本地网关，走网关的通道（订阅 / Cloudflare）一律不参与
      if (!PRO_ON && (t.p === 'cf' || t.p === 'chatgpt-sub' || t.p === 'claude-sub')) continue;
      // 没填 key 的通道直接不参与路由，别让它在链上白报一次错
      const K = NEED_KEY[t.p];
      if (K && !K()) continue;
      if (t.p === 'gemini' && t.k && !gemKey(t)) continue;   // 没填的第 2/3 把 key 不参与
      const k = chanKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    const live = out.filter(alive);
    // 全挂了也要留一条，否则链空了没法报错给人看
    return live.length ? live : out;
  }

  function pick(userText) {
    const p = !['auto', 'auto-s', 'auto-q', 'auto-b', 'gateway'].includes(MODEL_CHOICE) ? PRESETS[MODEL_CHOICE] : null;
    if (p) {
      const m = p.m.startsWith('__') ? CFG[p.m.slice(2)] : p.m;
      return { p: p.p, m, why: '手动' };
    }
    return chainFor(heuristicKind(userText, lastContext), modeOf())[0];
  }

  // 用本地 1.5B 分类器判类别（约 50ms）；失败退回启发式
  // 返回 { kind, level, src, ms }：判官最慢约 1.2s，超时就走启发式（不拦路）
  let lastRoute = null;
  async function decideKind(text) {
    if (!PRO_ON) {
      const h = heuristicKind(text, lastContext);
      lastRoute = { kind: h, src: 'heuristic', ms: 0 };
      return lastRoute;
    }
    if ((lastContext || '').length + text.length > 16000 && CFG.geminiKey) {
      lastRoute = { kind: 'long', src: 'long-context', ms: 0 };
      return lastRoute;
    }
    try {
      const r = await Promise.race([
        gm({
          method: 'POST',
          url: `${CFG.gatewayUrl}/route`,
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ text, mode: MODEL_CHOICE }),
          timeout: 3000,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('路由超时')), 3200)),
      ]);
      if (r.status >= 400) throw new Error('route HTTP ' + r.status);
      const j = JSON.parse(r.responseText);
      if (j.kind) {
        lastRoute = { kind: j.kind, level: j.level, src: j.src, ms: j.ms };
        return lastRoute;
      }
    } catch (_) { /* 网关没起来就走启发式 */ }
    const h = heuristicKind(text, lastContext);
    lastRoute = { kind: h, src: 'heuristic', ms: 0 };
    return lastRoute;
  }

  // ---------- 托管模式：请求只发给我们的服务器 ----------
  const hostedOn = () => !!(CFG.hosted && CFG.sbToken);
  const SERVER = () => (CFG.serverBase || DEFAULTS.serverBase).replace(/\/+$/, '');

  function serverCall(pathname, { method = 'GET', body = null, timeout = 90000 } = {}) {
    return gm({
      method,
      url: SERVER() + pathname,
      headers: { 'Content-Type': 'application/json', 'bypass-tunnel-reminder': '1', ...(CFG.sbToken ? { Authorization: 'Bearer ' + CFG.sbToken } : {}) },
      data: body ? JSON.stringify(body) : undefined,
      timeout,
    }).then(r => {
      let j = {};
      try { j = JSON.parse(r.responseText); } catch (_) {}
      if (r.status >= 200 && r.status < 300) return j;
      const e = new Error(j.error || ('HTTP ' + r.status));
      e.status = r.status;
      e.body = j;
      throw e;
    }, () => { throw new Error('连不上服务器（' + SERVER() + '）'); });
  }

  // 服务器地址：优先用说明文件里的（我们换地址时不用让用户重装）
  async function resolveEndpoint() {
    try {
      const r = await gm({ url: 'https://buzzmartglobal-art.github.io/sidebrain/endpoint.json?t=' + Date.now(), method: 'GET', timeout: 6000 });
      const j = JSON.parse(r.responseText);
      if (j && j.serverBase) { CFG.serverBase = String(j.serverBase).replace(/\/+$/, ''); return true; }
    } catch (_) {}
    return false;
  }

  async function ensureAccount() {
    if (CFG.sbToken) {
      try { return await serverCall('/account'); }
      catch (e) {
        if (e.status === 401) return { plan: 'invalid', email: '' };   // 令牌失效：留着 token，让用户用邮箱重连
        throw e;
      }
    }
    return null;
  }

  // 设置页里的账号区：只有「连接 / 已连接 · 还剩几天 / 试用结束」
  let ACCT = null;
  function paintAcct() {
    const st = $('acct-state'); if (!st) return;
    const mail = $('acct-mail-row'), go = $('acct-go'), sub = $('acct-sub-row'), out = $('acct-out');
    if (ACCT && ACCT.plan === 'invalid') {
      st.innerHTML = LANG === 'zh'
        ? '这台设备的登录失效了。<br><span style="opacity:.65">填回原来的邮箱就能接上，试用天数不变。</span>'
        : 'Sign-in on this device expired.<br><span style="opacity:.65">Re-enter the same email to reconnect — trial days are kept.</span>';
      if (mail) mail.style.display = 'flex';
      if (go) { go.style.display = 'block'; go.textContent = LANG === 'zh' ? '用邮箱重新连接' : 'Reconnect with email'; }
      if (sub) sub.style.display = 'none';
      if (out) out.style.display = 'block';
      return;
    }
    if (ACCT && ACCT.plan !== 'none') {
      const zh = LANG === 'zh';
      const text = ACCT.plan === 'active'
        ? (zh ? `已订阅 ✓ · ${ACCT.email}` : `Subscribed ✓ · ${ACCT.email}`)
        : ACCT.plan === 'trial'
          ? (zh ? `免费试用中 · 还剩 ${ACCT.daysLeft} 天 · ${ACCT.email}` : `Free trial · ${ACCT.daysLeft} days left · ${ACCT.email}`)
          : (zh ? `试用已结束 · ${ACCT.email}` : `Trial ended · ${ACCT.email}`);
      st.innerHTML = text + (zh ? `<br><span style="opacity:.65">今天用了 ${ACCT.usedToday || 0} 次</span>` : `<br><span style="opacity:.65">${ACCT.usedToday || 0} today</span>`);
      if (mail) mail.style.display = 'none';
      if (go) go.style.display = 'none';
      if (sub) sub.style.display = ACCT.plan === 'active' ? 'none' : 'flex';
      if (out) out.style.display = 'block';
    } else {
      st.textContent = LANG === 'zh' ? '填个邮箱就能开始，7 天免费，不用信用卡、不用挑模型。' : 'Enter your email to start. 7 days free, no card, no model picking.';
      if (mail) mail.style.display = 'flex';
      if (go) { go.style.display = 'block'; go.textContent = LANG === 'zh' ? '开始 7 天免费试用' : 'Start the 7-day free trial'; }
      if (sub) sub.style.display = 'none';
      if (out) out.style.display = 'none';
    }
  }

  async function refreshAcct() {
    try {
      ACCT = await ensureAccount();
      if (ACCT) ACCT.plan = ACCT.plan || 'trial';
    } catch (_) { ACCT = null; }
    paintAcct();
    // 顶栏：连上服务器之后就不让用户挑模型
    const sel = $('model'), hm = $('hmode');
    const adv = $('adv');
    if (adv) adv.style.display = hostedOn() && ACCT ? 'none' : '';
    if (hostedOn() && ACCT) {
      sel.style.display = 'none';
      hm.style.display = 'inline-block';
      hm.textContent = ACCT.plan === 'active' ? '自动 · 已订阅' : ACCT.plan === 'trial' ? `自动 · 试用 ${ACCT.daysLeft} 天` : '自动 · 已过期';
    } else {
      sel.style.display = '';
      hm.style.display = 'none';
    }
  }

  async function decideChain(text) {
    const route = await decideKind(text);
    const kind = route.kind;
    const list = chainFor(kind, modeOf(), route.level || 2);
    return { kind, route, list: list.map((t, i) => (i === 0 ? { ...t, why: `${t.why}·${kind}` } : t)) };
  }

  // ---------- 页面取文 ----------
  let lastContext = '';
  // 本轮注入的搜索结果（每发一条消息重算）
  let searchBlock = '';
  let SEARCH_ON = true;
  // 浏览即记：默认开，只写本机
  let MEMORY_ON = true;
  // 哪些问句值得先搜一下（只管“需要新鲜事实”的类型，不做全量搜）
  const NEEDS_FRESH = /(最新|最近|近期|这两天|今天|昨天|本周|本月|今年|新闻|发布|上线|版本|更新|价格|多少钱|汇率|股价|天气|比分|哪家|排行|评测|对比|教程|release|latest|today|price|news)/i;
  // 哪些问句值得回忆一下长期记忆（CortexDB）；默认不查，省延迟
  const NEEDS_RECALL = /(之前|上次|上回|以前|历史|一直|记得|说过|定过|决定的|方案|结论|我们|之前定|曾经)/;
  function readPage() {
    const sel = window.getSelection && String(window.getSelection()).trim();
    if (sel && sel.length > 40) return sel.slice(0, PAGE_LIMIT);
    const root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,nav,footer,header,aside,iframe,svg,form,[aria-hidden="true"]').forEach(n => n.remove());
    const txt = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    return txt.slice(0, PAGE_LIMIT);
  }

  // ---------- 各家 API ----------
  function gm(details) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        timeout: 120000,
        ...details,
        onload: r => resolve(r),
        onerror: () => reject(new Error('网络请求失败（检查 key / 代理 / 余额）')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  function openAIish(body, headers, url) {
    return gm({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      data: JSON.stringify(body),
    }).then(r => {
      let j;
      try { j = JSON.parse(r.responseText); } catch { throw new Error(`HTTP ${r.status}: ${(r.responseText || '').slice(0, 300)}`); }
      if (r.status >= 400) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      const msg = j.choices?.[0]?.message || {};
      let out = msg.content || '';
      // 思考型模型可能把额度全花在 reasoning 上，别让它变成空白
      if (!out && msg.reasoning) out = '（模型只输出了思考过程）\n' + msg.reasoning;
      return out || '(空回复)';
    });
  }

  const SYSTEM_ZH = '你是网页侧边栏助手。回答用中文，简洁、可执行；引用页面内容时不要复述整段，直接给结论。';
  const SYSTEM_EN = "You are a sidebar assistant inside the user's browser. Answer in the language the user writes in. Be concise and actionable; when citing the page, do not restate whole paragraphs — give the conclusion and point to where it is.";
  const getSystem = () => ((typeof LANG !== 'undefined' && LANG === 'en') ? SYSTEM_EN : SYSTEM_ZH);
  const ROLE_A = () => ((typeof LANG !== 'undefined' && LANG === 'en') ? 'Assistant: ' : '助手: ');
  const ROLE_U = () => ((typeof LANG !== 'undefined' && LANG === 'en') ? 'Me: ' : '我: ');

  // ---------- 流式调用 + 自动降级 ----------
  function buildMessages(userText) {
    const ctx = lastContext;
    const prior = history.slice(-HISTORY_TURNS * 2, -1).map(h => ({ role: h.role, content: h.content }));
    const ctxBlock = ctx ? `以下是当前网页（${location.hostname}）的正文，供参考：\n"""\n${ctx}\n"""\n\n` : '';
    return [...prior, { role: 'user', content: ctxBlock + searchBlock + userText }];
  }

  class HTTPError extends Error {
    constructor(msg, status) { super(msg); this.status = status; }
  }
  // 只有限流/服务器错误/网络阻断才值得换下一家；key 错、参数错就当场告诉人
  const canFallback = e => !(e instanceof HTTPError) || e.status === 429 || e.status >= 500 || e.status === 0;

  async function readSSE(resp, onData) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try { onData(JSON.parse(payload)); } catch (_) { /* 忽略半行 */ }
      }
    }
  }

  async function streamCall(target, userText, onChunk, onReason) {
    const { p, m, think } = target;
    const messages = buildMessages(userText);
    let url, headers, body;

    if (p === 'deepseek' || p === 'openrouter') {
      const key = p === 'deepseek' ? CFG.deepseekKey : CFG.openrouterKey;
      if (!key) throw new HTTPError('没填 ' + p + ' 的 key', 401);
      url = p === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
      if (p === 'openrouter') Object.assign(headers, { 'HTTP-Referer': location.origin, 'X-Title': 'Safari AI Sidebar' });
      body = { model: m, stream: true, messages: [{ role: 'system', content: getSystem() }, ...messages] };
      if (p === 'deepseek' && !/pro/.test(m)) body.temperature = 0.3;
    } else if (p === 'gemini') {
      const gk = gemKey(target);
      if (!gk || gk.length < 20) throw new HTTPError('没填 Gemini key（AIza 或 AQ. 开头都行）', 401);
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`;
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': gk };
      const gen = { temperature: 0.3 };
      // Gemini 3.x 默认会烧几百个思考 token；日常任务直接关掉，又省又快
      if (!think) gen.thinkingConfig = { thinkingBudget: 0 };
      body = {
        systemInstruction: { parts: [{ text: getSystem() }] },
        contents: messages.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })),
        generationConfig: gen,
      };
    } else if (p === 'groq' || p === 'groq2') {
      const gk = p === 'groq' ? CFG.groqKey : CFG.groqKey2;
      if (!gk) throw new HTTPError('没填 Groq key', 401);
      url = 'https://api.groq.com/openai/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${gk}` };
      body = { model: m, stream: true, temperature: 0.3, reasoning_effort: 'low', messages: [{ role: 'system', content: getSystem() }, ...messages] };
    } else if (p === 'cf') {
      // Cloudflare 的 CORS 预检直接 405，浏览器直连必然失败 → 交给本地网关转发
      throw new HTTPError('这个模型走非流式', 400);
    } else if (p === 'anthropic') {
      if (!CFG.anthropicKey) throw new HTTPError('没填 Anthropic key', 401);
      url = 'https://api.anthropic.com/v1/messages';
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': CFG.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      body = { model: m, max_tokens: 4096, stream: true, system: getSystem(), messages };
    } else {
      throw new HTTPError('这个模型走非流式', 400);
    }

    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) }).catch(e => {
      throw new HTTPError('请求被页面 CSP 或网络挡了：' + e.message, 0);
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      let msg = `HTTP ${resp.status}`;
      try { msg = JSON.parse(t)?.error?.message || msg; } catch (_) {}
      throw new HTTPError(msg, resp.status);
    }

    if (p === 'deepseek' || p === 'openrouter') {
      let rn = 0;
      await readSSE(resp, d => {
        const dl = d.choices?.[0]?.delta || {};
        if (dl.content) onChunk(dl.content);
        else if (dl.reasoning_content && onReason) onReason((rn += dl.reasoning_content.length));
      });
    } else if (p === 'gemini') {
      await readSSE(resp, d => {
        const t = (d.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
        if (t) onChunk(t);
      });
    } else if (p === 'groq' || p === 'groq2' || p === 'cf') {
      let rn = 0;
      await readSSE(resp, d => {
        const dl = d.choices?.[0]?.delta || {};
        if (dl.content) onChunk(dl.content);
        else if (dl.reasoning && onReason) onReason((rn += dl.reasoning.length));
      });
    } else {
      await readSSE(resp, d => {
        if (d.type === 'content_block_delta' && d.delta?.text) onChunk(d.delta.text);
      });
    }
  }

  // 降级链：主选挂了就按便宜优先的顺序换
  // 非流式兜底（fetch 被 CSP 挡掉时走 GM 请求）
  async function callModelPlain(target, userText) {
    const { p, m, think } = target;

    // ChatGPT 订阅通道：调本地网关的 codex exec，走订阅额度，不花 API 钱
    if (p === 'chatgpt-sub') {
      const prompt = [getSystem(), ...buildMessages(userText).map(x => (x.role === 'assistant' ? ROLE_A() : ROLE_U()) + x.content)].join('\n\n');
      const r = await gm({
        method: 'POST',
        url: `${CFG.gatewayUrl}/chatgpt`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ prompt }),
        timeout: 180000,
      }).catch(e => { throw new HTTPError('本地网关没起来（bash ~/ai-gateway/start.sh）：' + e.message, 0); });
      let j = {};
      try { j = JSON.parse(r.responseText); } catch (_) {}
      if (r.status >= 400) throw new HTTPError(j.error || 'chatgpt 通道出错', r.status);
      return j.text || '(空回复)';
    }

    // Claude 订阅通道：调本地网关，它用 Claude Code 的登录态跑，不花 API 额度
    if (p === 'claude-sub') {
      const prompt = [getSystem(), ...buildMessages(userText).map(x => (x.role === 'assistant' ? ROLE_A() : ROLE_U()) + x.content)].join('\n\n');
      const r = await gm({
        method: 'POST',
        url: `${CFG.gatewayUrl}/claude`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ prompt }),
        timeout: 180000,
      }).catch(e => { throw new Error('本地网关没起来（bash ~/ai-gateway/start.sh）：' + e.message); });
      let j = {};
      try { j = JSON.parse(r.responseText); } catch (_) {}
      if (r.status >= 400) throw new HTTPError(j.error || 'claude 通道出错', r.status);
      return j.text || '(空回复)';
    }
    const ctx = lastContext;
    // 历史里最后一条就是这条新消息本身，先排除，避免重复
    const messages = [
      ...history.slice(-HISTORY_TURNS * 2, -1).map(h => ({ role: h.role, content: h.content })),
    ];
    const ctxBlock = ctx
      ? `以下是当前网页（${location.hostname}）的正文，供参考：\n"""\n${ctx}\n"""\n\n`
      : '';
    messages.push({ role: 'user', content: ctxBlock + userText });

    if (p === 'deepseek') {
      const base = { model: m, messages: [{ role: 'system', content: getSystem() }, ...messages] };
      if (!/pro/.test(m)) base.temperature = 0.3; // pro/thinking 模型不收 temperature
      return openAIish(
        base,
        { Authorization: `Bearer ${CFG.deepseekKey}` },
        'https://api.deepseek.com/chat/completions'
      );
    }
    if (p === 'groq' || p === 'groq2') {
      return openAIish(
        { model: m, temperature: 0.3, reasoning_effort: 'low', messages: [{ role: 'system', content: getSystem() }, ...messages] },
        { Authorization: `Bearer ${p === 'groq' ? CFG.groqKey : CFG.groqKey2}` },
        'https://api.groq.com/openai/v1/chat/completions'
      );
    }
    if (p === 'cf') {
      const prompt = [getSystem(), ...messages.map(x => (x.role === 'assistant' ? ROLE_A() : ROLE_U()) + x.content)].join('\n\n');
      const r = await gm({
        method: 'POST',
        url: `${CFG.gatewayUrl}/cf`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ prompt, model: m }),
        timeout: 60000,
      }).catch(e => { throw new HTTPError('本地网关没起来（bash ~/ai-gateway/start.sh）：' + e.message, 0); });
      let j = {};
      try { j = JSON.parse(r.responseText); } catch (_) {}
      if (r.status >= 400) throw new HTTPError(j.error || 'Cloudflare 通道出错', r.status);
      return j.text || '(空回复)';
    }
    if (p === 'openrouter') {
      return openAIish(
        { model: m, messages: [{ role: 'system', content: getSystem() }, ...messages] },
        { Authorization: `Bearer ${CFG.openrouterKey}`, 'HTTP-Referer': location.origin, 'X-Title': 'Safari AI Sidebar' },
        'https://openrouter.ai/api/v1/chat/completions'
      );
    }
    if (p === 'gemini') {
      const gk = gemKey(target);
      if (!gk || gk.length < 20) {
        throw new Error('没填 Gemini key。去 aistudio.google.com/apikey 拿一把（AIza 或 AQ. 开头都行）。');
      }
      const body = {
        systemInstruction: { parts: [{ text: getSystem() }] },
        contents: messages.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })),
        generationConfig: think ? { temperature: 0.3 } : { temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
      };
      const r = await gm({
        method: 'POST',
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gk },
        data: JSON.stringify(body),
      });
      let j;
      try { j = JSON.parse(r.responseText); } catch { throw new Error(`HTTP ${r.status}: ${(r.responseText || '').slice(0, 300)}`); }
      if (r.status >= 400) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      return j.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '(空回复)';
    }
    if (p === 'anthropic') {
      const r = await gm({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CFG.anthropicKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        data: JSON.stringify({ model: m, max_tokens: 4096, system: getSystem(), messages }),
      });
      let j;
      try { j = JSON.parse(r.responseText); } catch { throw new Error(`HTTP ${r.status}: ${(r.responseText || '').slice(0, 300)}`); }
      if (r.status >= 400) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      return j.content?.map(x => x.text || '').join('') || '(空回复)';
    }
    if (p === 'ollama') {
      return openAIish(
        { model: m, messages: [{ role: 'system', content: getSystem() }, ...messages], stream: false, max_tokens: 1800 },
        {},
        `${(CFG.ollamaUrl || DEFAULTS.ollamaUrl).replace(/\/$/, '')}/v1/chat/completions`
      ).catch(e => { throw new Error(`本地 Ollama 没响应（检查 Ollama 是否在跑、模型名对不对）：${e.message}`); });
    }
    throw new Error('没有可用的模型：先去齿轮里填一个 key');
  }

  // ---------- UI ----------
  const host = document.createElement('div');
  host.id = '__cola_ai_host__';
  host.style.cssText = 'all:initial;position:fixed;inset:0 auto 0 auto;right:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  (document.documentElement || document.body).appendChild(host);

  root.innerHTML = `
<style>
  :host, * { box-sizing: border-box; }
  .wrap { position: fixed; top: 0; right: 0; bottom: 0; display: flex; font: 13px/1.6 -apple-system, "SF Pro Text", "PingFang SC", sans-serif; pointer-events: none; }
  .panel { position: relative; display: flex; flex-direction: column; height: 100%; width: var(--w, 400px); background: #14161a; color: #e6e8ec; border-left: 1px solid #2a2e36; box-shadow: -12px 0 32px rgba(0,0,0,.28); pointer-events: auto; transform: translateX(0); transition: transform .18s ease; }
  .panel.hidden { transform: translateX(105%); }
  .grip { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2a2e36; }
  .bar .t { font-weight: 600; font-size: 13px; flex: none; }
  select, button, textarea, input { font: inherit; color: inherit; }
  select { background: #1c2027; border: 1px solid #2f3540; border-radius: 6px; padding: 3px 6px; max-width: 150px; }
  .ico { background: none; border: none; cursor: pointer; padding: 4px 6px; border-radius: 6px; color: #9aa3b2; }
  .ico.off { opacity: .38; }
  .ico:hover { background: #232931; color: #e6e8ec; }
  .msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .m { padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .m.u { align-self: flex-end; background: #2b3a55; max-width: 88%; }
  .m.a { background: #1b1f26; border: 1px solid #262b34; }
  .m.err { background: #3a1d1d; border: 1px solid #6b2b2b; color: #ffb4b4; }
  .m pre { background: #0f1115; border: 1px solid #262b34; border-radius: 8px; padding: 8px; overflow-x: auto; white-space: pre; margin: 6px 0; }
  .m code { background: #0f1115; padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .tag { font-size: 11px; color: #7c869a; margin-top: 4px; }
  .foot { display: flex; gap: 2px; align-items: center; margin-top: 6px; font-size: 11px; color: #7c869a; flex-wrap: wrap; }
  .foot button { background: transparent; border: none; color: #8b95a7; cursor: pointer; font-size: 12px; padding: 2px 5px; border-radius: 6px; line-height: 1.4; }
  .foot button:hover { background: #262b34; color: #cfd6e4; }
  .foot .sp { flex: 1; min-width: 8px; }
  .foot .time { opacity: .75; }
  .foot .on { color: #6fa8ff; }
  .det { display: none; margin-top: 6px; font-size: 11px; color: #8b95a7; background: #0f1115; border: 1px solid #262b34; border-radius: 8px; padding: 6px 8px; white-space: pre-wrap; }
  .det.on { display: block; }
  .src { margin-top: 6px; font-size: 11px; color: #8b95a7; }
  .src div { margin: 2px 0 0 2px; }
  .src a { color: #6fa8ff; text-decoration: none; }
  .src .fold { cursor: pointer; color: #8b95a7; text-decoration: underline dotted; }
  .composer { border-top: 1px solid #2a2e36; padding: 10px; display: flex; gap: 8px; align-items: flex-end; }
  .cwrap { display: flex; align-items: flex-end; gap: 6px; width: 100%; }
  .cbtn { flex: 0 0 auto; height: 34px; width: 34px; }
  .att { display: none; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .att.on { display: flex; }
  .att .chip { position: relative; display: flex; align-items: center; gap: 6px; background: #232830; border: 1px solid #333a45; border-radius: 8px; padding: 4px 6px; font-size: 11px; color: #b9c2d0; max-width: 100%; }
  .att .chip img { width: 34px; height: 34px; object-fit: cover; border-radius: 5px; display: block; }
  .att .chip .x { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; line-height: 14px; text-align: center; border-radius: 50%; background: #4a2222; border: 1px solid #7a3030; font-size: 10px; cursor: pointer; }
  .att .chip .nm { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .msg .attimg { max-width: 180px; max-height: 140px; border-radius: 8px; display: block; margin-bottom: 4px; }
  textarea { flex: 1; resize: none; background: #1c2027; border: 1px solid #2f3540; border-radius: 8px; padding: 8px; max-height: 140px; min-height: 40px; outline: none; }
  textarea:focus { border-color: #4a6fa5; }
  .send { background: #3b6fd4; border: none; color: #fff; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
  .send:disabled { opacity: .45; cursor: default; }
  .fab { position: fixed; right: 14px; bottom: 90px; width: 38px; height: 38px; border-radius: 50%; border: 1px solid #3a4150; background: #1c2027ee; color: #cfd6e4; cursor: pointer; pointer-events: auto; font-size: 15px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .fab:hover { background: #262d38; }
  .settings { padding: 12px; border-bottom: 1px solid #2a2e36; display: none; flex-direction: column; gap: 8px; max-height: 62%; overflow-y: auto; }
  .settings.on { display: flex; }
  .row { display: flex; flex-direction: column; gap: 3px; }
  .row label { font-size: 11px; color: #8b95a7; }
  .row input { background: #1c2027; border: 1px solid #2f3540; border-radius: 6px; padding: 6px; outline: none; }
  .hint { font-size: 11px; color: #6b7484; line-height: 1.5; }
  /* 记忆面板 */
  .memp { position: absolute; inset: 0; background: #14171c; display: none; flex-direction: column; z-index: 5; }
  .memp.on { display: flex; }
  .memp-top { padding: 10px 12px; border-bottom: 1px solid #2a2e36; display: flex; align-items: center; gap: 8px; font-size: 12px; color: #93a0b5; }
  .memp-top b { color: #d7dde8; font-weight: 600; }
  .memp-tabs { display: flex; gap: 6px; padding: 8px 12px 0; align-items: center; }
  .mtab { background: #1c2027; border: 1px solid #2f3540; color: #93a0b5; border-radius: 999px; padding: 3px 10px; font-size: 11.5px; cursor: pointer; }
  .mtab.on { background: #2a3546; border-color: #3d5673; color: #e3ecfa; }
  .memp-chatall { background: none; border: none; color: #6b7484; cursor: pointer; display: none; }
  .memp-q { padding: 8px 12px; border-bottom: 1px solid #2a2e36; }
  .memp-q input { width: 100%; background: #1c2027; border: 1px solid #2f3540; border-radius: 6px; padding: 6px 8px; outline: none; color: #d7dde8; font-size: 12px; }
  .memp-list { flex: 1; overflow-y: auto; }
  .memp-item { padding: 9px 12px; border-bottom: 1px solid #23272f; display: flex; gap: 8px; align-items: flex-start; }
  .memp-item:hover { background: #191d23; }
  .memp-main { flex: 1; min-width: 0; }
  .memp-title { font-size: 12px; color: #dde3ee; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .memp-meta { font-size: 10.5px; color: #6b7484; margin-top: 2px; }
  .memp-kind { font-size: 10px; padding: 1px 5px; border-radius: 4px; margin-right: 5px; }
  .memp-kind.page { background: #1f2a36; color: #7fa8d6; }
  .memp-kind.chat { background: #2a2436; color: #b194d6; }
  .memp-ex { font-size: 11px; color: #8b95a7; margin-top: 3px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .memp-item.open { background: #191d23; }
  .memp-caret { color: #5b6675; font-size: 11px; }
  .memp-detail { padding: 10px 0 2px; border-top: 1px dashed #2a3038; margin-top: 8px; }
  .memp-d-q { font-size: 12.5px; color: #cfd7e3; line-height: 1.5; margin-bottom: 6px; }
  .memp-d-a { font-size: 12px; color: #9aa5b6; line-height: 1.65; white-space: pre-wrap; max-height: 260px; overflow-y: auto; }
  .memp-d-meta { font-size: 10.5px; color: #6b7484; margin-top: 8px; }
  .memp-d-open { color: #6f9fd8; cursor: pointer; }
  .memp-del { background: none; border: 1px solid #3a2a2a; color: #c98b8b; border-radius: 6px; font-size: 11px; padding: 3px 7px; cursor: pointer; flex: 0 0 auto; }
  .memp-del:hover { background: #2a1d1d; }
  .notep { position: absolute; inset: 34px 0 0 0; background: #16191f; display: none; flex-direction: column; z-index: 5; }
  .notep.on { display: flex; }
  .note-view { display: none; flex: 1; overflow-y: auto; padding: 12px; font-size: 13px; line-height: 1.75; color: #d6dbe4; }
  .note-view.on { display: block; }
  .note-view h1 { font-size: 16px; margin: 2px 0 10px; }
  .note-view h2 { font-size: 14px; margin: 14px 0 6px; }
  .note-view h3 { font-size: 13px; margin: 10px 0 4px; }
  .note-view p { margin: 6px 0; }
  .note-view ul, .note-view ol { padding-left: 18px; margin: 6px 0; }
  .note-view code { background: #232830; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
  .note-view pre { background: #1b1f26; border: 1px solid #2a2f38; border-radius: 6px; padding: 8px; overflow-x: auto; font-size: 12px; }
  .note-view blockquote { border-left: 2px solid #3a4250; margin: 8px 0; padding-left: 10px; color: #9aa6b8; }
  .note-view .nl { color: #7fb0ff; cursor: pointer; border-bottom: 1px dashed #43608c; }
  .note-view .nbar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .note-view .nbar button { background: #232830; border: 1px solid #333a45; color: #b9c2d0; border-radius: 6px; padding: 4px 8px; font-size: 11px; cursor: pointer; }
  .note-view .nmeta { font-size: 11px; color: #6b7484; margin-bottom: 8px; }
  .note-view .nback { margin-top: 14px; border-top: 1px solid #262b33; padding-top: 8px; font-size: 12px; color: #93a0b5; }
  .note-view textarea { width: 100%; min-height: 320px; background: #1c2027; border: 1px solid #2f3540; border-radius: 6px; padding: 8px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; color: #d6dbe4; }
  .memp-foot { padding: 8px 12px; border-top: 1px solid #2a2e36; display: flex; gap: 8px; align-items: center; }
  .memp-empty { padding: 24px 12px; text-align: center; color: #6b7484; font-size: 12px; line-height: 1.7; }
  .hint b { color: #93a0b5; }
</style>
<div class="wrap">
  <div class="panel hidden" id="panel">
    <div class="grip" id="grip"></div>
    <div class="bar">
      <span class="t">AI</span>
      <span id="hmode" style="display:none;font-size:12px;color:#93a0b5;padding:2px 8px;border:1px solid #333a45;border-radius:999px">自动</span>
      <select id="model">
        <option value="auto">自动 · 免费优先（0 元）</option>
        <option value="auto-b">自动 · 平衡（默认）</option>
        <option value="auto-s">自动 · 速度优先</option>
        <option value="auto-q">自动 · 质量优先</option>
        <optgroup label="订阅（0 边际，有每日上限）">
          <option value="chatgpt-sub">ChatGPT 订阅（Codex CLI）</option>
          <option value="claude-sub">Claude 订阅（CLI，非网页）</option>
        </optgroup>
        <optgroup label="免费层">
          <option value="gemini-flash">Gemini Flash（免费额度）</option>
          <option value="gemini-pro">Gemini Pro（长文）</option>
        </optgroup>
        <optgroup label="付费 API">
          <option value="deepseek-flash">DeepSeek Flash（最便宜）</option>
          <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
          <option value="openrouter-auto">OpenRouter Auto</option>
          <option value="claude">Claude API</option>
        </optgroup>
        <optgroup label="本地">
          <option value="ollama">本地 Ollama</option>
        </optgroup>
      </select>
      <span style="flex:1"></span>
      <button class="ico" id="mic" title="语音输入">🎤</button>
      <button class="ico" id="searchbtn" title="联网搜索（免费，走本地网关）">🔍</button>
      <button class="ico" id="memobtn" title="自动记住看过的网页（只存本机）">🧠</button>
      <button class="ico" id="memlist" title="记忆：看过哪些页（可删单条 / 一键清空）">🗂</button>
      <button class="ico" id="notebtn" title="笔记（Obsidian 库，可直接读写）">🗒</button>
      <button class="ico" id="gear" title="设置">⚙︎</button>
      <button class="ico" id="clear" title="清空本页对话">⟲</button>
      <button class="ico" id="close" title="收起 (⌘⇧K)">✕</button>
    </div>
    <div class="memp" id="memp">
      <div class="memp-top">
        <span>记忆 · 网页 <b id="mem-count">0</b> · 对话 <b id="mem-chatcount">0</b> · <span id="mem-size">0 KB</span></span>
        <span style="flex:1"></span>
        <button class="ico" id="mem-close" title="关闭">✕</button>
      </div>
      <div class="memp-tabs">
        <button class="mtab on" data-t="all">全部</button>
        <button class="mtab" data-t="page">网页</button>
        <button class="mtab" data-t="chat">对话</button>
        <span style="flex:1"></span>
        <button class="memp-chatall" id="mem-chatall" title="只看对话">💬</button>
      </div>
      <div class="memp-q"><input id="mem-q" type="text" placeholder="搜一条记忆：随便打几个词，比如「降噪耳机测评」"></div>
      <div class="memp-list" id="mem-list"></div>
      <div class="memp-foot">
        <button class="send" id="mem-more" style="padding:5px 10px;font-size:12px;background:#3a4048">加载更多</button>
        <button class="send" id="mem-restore" style="padding:5px 10px;font-size:12px;background:#3a4048">恢复上次快照</button>
        <span style="flex:1"></span>
        <button class="send" id="mem-clear" style="padding:5px 10px;font-size:12px;background:#4a2222">一键清空</button>
      </div>
    </div>
    <div class="notep" id="notep">
      <div class="memp-top">
        <span>笔记 · <b id="note-count">0</b> 篇 <span id="note-root"></span></span>
        <span style="flex:1"></span>
        <button class="ico" id="note-retitle" title="刷新">↻</button>
        <button class="ico" id="note-close" title="关闭">✕</button>
      </div>
      <div class="memp-q"><input id="note-q" type="text" placeholder="搜笔记：打几个词就行，中文也可以"></div>
      <div class="memp-list" id="note-list"></div>
      <div class="note-view" id="note-view"></div>
      <div class="memp-foot" id="note-foot">
        <button class="send" id="note-new" style="padding:5px 10px;font-size:12px">新建</button>
        <button class="send" id="note-daily" style="padding:5px 10px;font-size:12px;background:#3a4048">今天的日记</button>
        <button class="send" id="note-memo" style="padding:5px 10px;font-size:12px;background:#2f4a6f">今日备忘录</button>
        <span style="flex:1"></span>
        <span style="font-size:11px;color:#6b7484" id="note-hint">点标题读，读的时候能改</span>
      </div>
    </div>
    <div class="settings" id="settings">
      <div class="row" id="lang-row">
        <label>界面语言 / Language</label>
        <select id="set-lang" style="width:auto;min-width:140px"></select>
      </div>
      <div id="acct">
        <div class="hint" id="acct-state">还没连上服务器。</div>
        <div class="row" id="acct-mail-row"><label>邮箱（用来登录、找回和续费）</label><input id="acct-mail" type="email" placeholder="you@example.com"></div>
        <button class="send" id="acct-go">开始 7 天免费试用</button>
        <div class="row" id="acct-sub-row" style="display:none"><button class="send" id="acct-sub" style="background:#2f6fed">订阅 $8/月</button></div>
        <button class="send" id="acct-out" style="display:none;background:#3a4048">断开这台设备</button>
      </div>
      <details id="adv" style="margin-top:10px">
        <summary style="cursor:pointer;font-size:12px;color:#93a0b5">高级：自己带 key（不经过我们的服务器）</summary>
      <div class="hint"><b>至少填一个 key。</b>key 只存在本机（GM 存储），请求直连各家，不经过任何第三方。</div>
      <div class="row"><label>DeepSeek API key（默认主力，最便宜）</label><input id="k-deepseek" type="password" placeholder="sk-..."></div>
      <div class="row"><label>OpenRouter API key（Auto 自动挑模型 / 兜底）</label><input id="k-openrouter" type="password" placeholder="sk-or-..."></div>
      <div class="row"><label>Gemini API key（长文/超长上下文）</label><input id="k-gemini" type="password" placeholder="AIza..."></div>
      <div class="row"><label>Anthropic API key（想要 Claude 质量时）</label><input id="k-anthropic" type="password" placeholder="sk-ant-..."></div>
      <div class="row pro-only"><label>Gemini 备用 key #2（免费额度按 key 算）</label><input id="k-gemini2" type="password" placeholder="AQ. / AIza"></div>
      <div class="row pro-only"><label>Gemini 备用 key #3</label><input id="k-gemini3" type="password" placeholder="AQ. / AIza"></div>
      <div class="row"><label>Gemini 便宜模型</label><input id="m-gemini" type="text"></div>
      <div class="row"><label>Gemini 长文模型</label><input id="m-geminilong" type="text"></div>
      <div class="row"><label>Claude 模型</label><input id="m-claude" type="text"></div>
      <div class="row"><label>本地 Ollama 模型（免费离线，需 Ollama 在跑）</label><input id="m-ollama" type="text" placeholder="gemma4:26b"></div>
      <div class="row"><label>Ollama 地址</label><input id="u-ollama" type="text" placeholder="http://localhost:11434"></div>
      <div class="row"><label>Groq API key（免费层，首字最快；console.groq.com）</label><input id="k-groq" type="password" placeholder="gsk_..."></div>
      <div class="row pro-only"><label>Groq 备用 key（第一把限流时自动顶上）</label><input id="k-groq2" type="password" placeholder="gsk_..."></div>
      <div class="row"><label>Groq 模型（免费层只剩几个）</label><input id="m-groq" type="text" placeholder="openai/gpt-oss-120b"></div>
      <div class="row pro-only"><label>Cloudflare 账号 ID（免费额度，dash.cloudflare.com）</label><input id="k-cfid" type="text" placeholder="32 位十六进制"></div>
      <div class="row pro-only"><label>Cloudflare API token（Workers AI 权限）</label><input id="k-cftoken" type="password" placeholder="..."></div>
      <div class="row pro-only"><label>Cloudflare 模型</label><input id="m-cf" type="text" placeholder="@cf/openai/gpt-oss-20b"></div>
      <div class="row pro-only"><label>OpenRouter 免费模型清单（逗号分隔，前一个限流自动换下一个）</label><input id="m-orfree" type="text"></div>
      <div class="row pro-only" style="flex-direction:row;align-items:center;gap:8px">
        <input id="c-chatgpt" type="checkbox" style="width:auto">
        <label style="margin:0">使用我的 ChatGPT 订阅额度（走本机已登录的 Codex CLI）</label>
      </div>
      <div class="row pro-only" style="flex-direction:row;align-items:center;gap:8px">
        <input id="c-claude" type="checkbox" style="width:auto">
        <label style="margin:0">使用我的 Claude 订阅额度（走本机已登录的 Claude Code）</label>
      </div>
      <div class="row" style="flex-direction:row;align-items:center;gap:8px">
        <input id="c-tiny" type="checkbox" style="width:auto">
        <label style="margin:0">免费额度用完时，允许花几分钱走 DeepSeek Flash（约 ¥0.001/次）</label>
      </div>
      <div class="hint" style="opacity:.7">
        这两项由你自己决定开或不开，默认关闭。开启后，侧边栏只是调用你已经装好、已经登录的官方命令行工具，<b>不保存任何账号或凭证</b>。<br>
        你的订阅怎么用、用多少、符不符合你和模型商的协议，由你自己判断并自行承担；本工具开发者不参与、不代付、不转售。官方随时可能变更规则，本工具不保证这两条通道长期可用。
      </div>
      <div id="ack" class="hint" style="display:none;border:1px solid #4a3a1a;background:#241d10;padding:8px;border-radius:8px"></div>
      <button class="send" id="save">保存</button>
      </details>
      <details style="margin-top:4px" id="sc" class="pro-only">
        <summary style="cursor:pointer;font-size:12px;color:#8b95a7">通道自检（哪条通、哪条额度没了）</summary>
        <div class="hint" id="sc-out" style="margin-top:8px;line-height:1.9;font-family:ui-monospace,Menlo,monospace;opacity:.95">点下面按钮，逐条探一遍。</div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="send" id="sc-run" style="padding:5px 10px;font-size:12px">检查全部通道</button>
          <button class="send" id="sc-sub" style="padding:5px 10px;font-size:12px;background:#3a4048">实测订阅（各耗 1 次额度）</button>
        </div>
        <div class="hint" style="opacity:.55;margin-top:6px">DeepSeek 查余额、Gemini 查模型列表、Ollama 查本地模型，这三个不花钱。订阅通道必须真发一句话才知道通不通。</div>
      </details>
      <details style="margin-top:4px">
        <summary style="cursor:pointer;font-size:12px;color:#8b95a7">反馈统计（👍/👎 怎么改了我的路由）</summary>
        <div class="hint" id="fstats" style="opacity:.8;margin-top:6px;line-height:1.8;font-family:ui-monospace,Menlo,monospace"></div>
        <div class="hint" style="opacity:.6;margin-top:4px">得分 = (👍+2)/(👍+👎+4)。同一成本档内，得分高的排前面；差距小于 0.12 不动，避免一票就抖。</div>
      </details>
      <div class="row" id="lic-row" style="margin-top:10px">
        <label>许可证（购买后邮件里那串）</label>
        <div style="display:flex;gap:6px">
          <input id="lic-input" type="text" placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX" style="flex:1">
          <button class="send" id="lic-btn" style="padding:5px 10px;font-size:12px;background:#3a4048">激活</button>
        </div>
        <div class="hint" id="lic-hint" style="margin-top:6px">试用状态：读取中…</div>
      </div>
      <details style="margin-top:4px">
        <summary style="cursor:pointer;font-size:12px;color:#8b95a7">关于 / 免责说明（v<span id="aver">—</span>）</summary>
        <div class="hint" style="opacity:.75;margin-top:6px;line-height:1.6">
          本工具只是一个浏览器侧栏壳：<b>不保存账号凭证</b>，请求由你的浏览器直连各家模型。<br>
          <b>订阅通道</b>——「使用我的 ChatGPT / Claude 订阅额度」由你自行开启，默认关闭。开启后本工具仅调用你本机已安装、已登录的官方命令行工具，不保存、不中转、不代付你的账号或凭证。你的订阅额度如何被第三方工具使用、是否符合你与模型商的协议，由你自行判断并独立承担；开发者不参与、不代为支付、不转售额度。模型商规则可能随时变更，本工具不保证该通道长期可用，不可用时自动改用你的 API key 或本地模型。<br>
          <b>数据</b>——记忆与索引存在本机；提问内容按你原有账号的条款直连模型商，不经过任何中间服务器。<br>
          <b>无担保</b>——本工具按现状提供，不对输出内容的准确性作任何承诺，重要决策请自行核对。
        </div>
      </details>
    </div>
    <div class="msgs" id="msgs"></div>
    <div class="composer">
      <div class="att" id="att"></div>
      <div class="cwrap">
        <button class="ico cbtn" id="filebtn" title="加图片或文件（也可以直接粘贴、拖进来）">📎</button>
        <input type="file" id="filepick" accept="image/*,.txt,.md,.json,.csv,.log,.js,.ts,.py,.html,.css,.pdf" multiple style="display:none">
        <textarea id="input" rows="1" placeholder="问点什么…（Enter 发送 / Shift+Enter 换行）"></textarea>
        <button class="ico cbtn" id="mic2" title="语音输入">🎤</button>
        <button class="send" id="send">发送</button>
      </div>
    </div>
  </div>
  <button class="fab" id="fab" title="AI 侧边栏 (⌘⇧K)">✦</button>
</div>`;


  // ---------- 双语：跟着浏览器语言走（zh 中文，其它英文） ----------
  // 界面语言：默认跟浏览器，用户可以在设置里改
  const LANGS = [
    ['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['es', 'Español'],
    ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['ru', 'Русский'], ['it', 'Italiano'],
  ];
  const SPEECH_LANG = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', ru: 'ru-RU', it: 'it-IT' };
  function guessLang() {
    const n = (navigator.language || 'en').toLowerCase();
    const two = n.slice(0, 2);
    return LANGS.some(([c]) => c === two) ? two : 'en';
  }
  let LANG = guessLang();

  // 多语言词典：以中文原文为键；没翻到的自动回落到英文，再回落到中文
  const LK = ['设置', '发送', '关闭', '清空本页对话', '复制', '朗读', '有用', '没用', '更多',
    '联网搜索', '自动记住看过的网页', '记忆', '问点什么…（Enter 发送 / Shift+Enter 换行）',
    '开始 7 天免费试用', '用邮箱重新连接', '断开这台设备', '订阅 $8/月', '语音输入', '停止录音', '听不见声音'];
  const LT = {
    ja: ['設定', '送信', '閉じる', 'このタブの会話を消す', 'コピー', '読み上げ', '役に立った', '役に立たない', 'その他',
      'ウェブ検索', '見たページを記憶', 'メモリー', '何でも聞いてください…（Enter で送信 / Shift+Enter で改行）',
      '7 日間の無料トライアルを開始', 'メールで再接続', 'このデバイスを切断', '月額 $8 で購読', '音声入力', '録音を停止', '音が聞こえません'],
    ko: ['설정', '보내기', '닫기', '이 탭의 대화 지우기', '복사', '읽기', '도움됨', '도움 안 됨', '더보기',
      '웹 검색', '본 페이지 기억하기', '메모리', '무엇이든 물어보세요… (Enter 전송 / Shift+Enter 줄바꿈)',
      '7일 무료 체험 시작', '이메일로 다시 연결', '이 기기 연결 해제', '월 $8 구독', '음성 입력', '녹음 중지', '소리가 들리지 않습니다'],
    es: ['Ajustes', 'Enviar', 'Cerrar', 'Borrar esta pestaña', 'Copiar', 'Leer en voz alta', 'Útil', 'No útil', 'Más',
      'Buscar en la web', 'Recordar páginas que leo', 'Memoria', 'Pregunta lo que quieras… (Enter envía, Shift+Enter salto de línea)',
      'Empezar 7 días gratis', 'Reconectar con el correo', 'Desconectar este dispositivo', 'Suscribirme por $8/mes', 'Entrada de voz', 'Detener grabación', 'No se oye nada'],
    fr: ['Réglages', 'Envoyer', 'Fermer', 'Effacer cet onglet', 'Copier', 'Lire à voix haute', 'Utile', 'Pas utile', 'Plus',
      'Recherche web', 'Mémoriser les pages lues', 'Mémoire', "Posez votre question… (Entrée envoie, Maj+Entrée pour un saut de ligne)",
      "Démarrer les 7 jours gratuits", "Reconnecter avec l'e-mail", 'Déconnecter cet appareil', "S'abonner à 8 $/mois", 'Saisie vocale', "Arrêter l'enregistrement", 'Je ne vous entends pas'],
    de: ['Einstellungen', 'Senden', 'Schließen', 'Diesen Tab leeren', 'Kopieren', 'Vorlesen', 'Hilfreich', 'Nicht hilfreich', 'Mehr',
      'Websuche', 'Gelesene Seiten merken', 'Gedächtnis', 'Frag einfach… (Enter sendet, Shift+Enter neue Zeile)',
      '7 Tage kostenlos starten', 'Mit E-Mail neu verbinden', 'Dieses Gerät trennen', 'Für 8 $/Monat abonnieren', 'Spracheingabe', 'Aufnahme stoppen', 'Ich höre nichts'],
    pt: ['Ajustes', 'Enviar', 'Fechar', 'Limpar esta aba', 'Copiar', 'Ler em voz alta', 'Útil', 'Não útil', 'Mais',
      'Buscar na web', 'Lembrar páginas lidas', 'Memória', 'Pergunte o que quiser… (Enter envia, Shift+Enter nova linha)',
      'Começar 7 dias grátis', 'Reconectar com o e-mail', 'Desconectar este dispositivo', 'Assinar por $8/mês', 'Entrada de voz', 'Parar gravação', 'Não estou ouvindo'],
    ru: ['Настройки', 'Отправить', 'Закрыть', 'Очистить эту вкладку', 'Копировать', 'Прочитать', 'Полезно', 'Бесполезно', 'Ещё',
      'Поиск в сети', 'Запоминать прочитанные страницы', 'Память', 'Спросите что угодно… (Enter — отправить, Shift+Enter — новая строка)',
      'Начать 7 бесплатных дней', 'Подключиться по e-mail', 'Отключить это устройство', 'Подписка $8/мес', 'Голосовой ввод', 'Остановить запись', 'Вас не слышно'],
    it: ['Impostazioni', 'Invia', 'Chiudi', 'Svuota questa scheda', 'Copia', 'Leggi ad alta voce', 'Utile', 'Non utile', 'Altro',
      'Ricerca web', 'Ricorda le pagine lette', 'Memoria', 'Chiedi quello che vuoi… (Invio invia, Shift+Invio nuova riga)',
      'Inizia i 7 giorni gratis', 'Riconnetti con la email', 'Scollega questo dispositivo', 'Abbonati a 8 $/mese', 'Input vocale', 'Ferma registrazione', 'Non ti sento'],
  };
  const LDICT = {};
  for (const code of Object.keys(LT)) LDICT[code] = Object.fromEntries(LK.map((k, i) => [k, LT[code][i]]));
  const EN = {
    // 顶栏 / 基础
    '设置': 'Settings', '发送': 'Send', '关闭': 'Close', '收起 (⌘⇧K)': 'Hide (⌘⇧K)',
    '清空本页对话': 'Clear this tab', '联网搜索（免费，走本地网关）': 'Web search (free, via local service)',
    '自动记住看过的网页（只存本机）': 'Remember pages you read (stored locally)',
    '记忆：看过哪些页（可删单条 / 一键清空）': 'Memory: pages you read (delete one, or wipe all)',
    'AI 侧边栏 (⌘⇧K)': 'AI sidebar (⌘⇧K)',
    '问点什么…（Enter 发送 / Shift+Enter 换行）': 'Ask anything… (Enter to send, Shift+Enter for a new line)',
    // 模型下拉
    '自动 · 免费优先（0 元）': 'Auto · Free first ($0)',
    '自动 · 平衡（默认）': 'Auto · Balanced (default)',
    '自动 · 速度优先': 'Auto · Speed first',
    '自动 · 质量优先': 'Auto · Quality first',
    'ChatGPT 订阅（Codex CLI）': 'ChatGPT subscription (Codex CLI)',
    'Claude 订阅（CLI，非网页）': 'Claude subscription (CLI, not the web app)',
    'Gemini Flash（免费额度）': 'Gemini Flash (free tier)',
    'Gemini Pro（长文）': 'Gemini Pro (long context)',
    'DeepSeek Flash（最便宜）': 'DeepSeek Flash (cheapest)',
    '本地 Ollama': 'Local Ollama',
    // 设置项
    '至少填一个 key。': 'Fill in at least one key.',
    'key 只存在本机（GM 存储），请求直连各家，不经过任何第三方。': 'Keys stay on this Mac (userscript storage). Requests go straight to the provider — no middleman.',
    'DeepSeek API key（默认主力，最便宜）': 'DeepSeek API key (cheapest, the default workhorse)',
    'OpenRouter API key（Auto 自动挑模型 / 兜底）': 'OpenRouter API key (auto-picks a model / last resort)',
    'Gemini API key（长文/超长上下文）': 'Gemini API key (long context)',
    'Anthropic API key（想要 Claude 质量时）': 'Anthropic API key (when you want Claude quality)',
    'Gemini 备用 key #2（免费额度按 key 算）': 'Gemini spare key #2 (free quota is per key)',
    'Gemini 备用 key #3': 'Gemini spare key #3',
    'Gemini 便宜模型': 'Gemini cheap model',
    'Gemini 长文模型': 'Gemini long-context model',
    'Claude 模型': 'Claude model',
    '本地 Ollama 模型（免费离线，需 Ollama 在跑）': 'Local Ollama model (free, offline, needs Ollama running)',
    'Ollama 地址': 'Ollama address',
    'Groq API key（免费层，首字最快；console.groq.com）': 'Groq API key (free tier, fastest first token)',
    'Groq 备用 key（第一把限流时自动顶上）': 'Groq spare key (takes over when the first is rate-limited)',
    'Groq 模型（免费层只剩几个）': 'Groq model (only a few left on the free tier)',
    'Cloudflare 账号 ID（免费额度，dash.cloudflare.com）': 'Cloudflare account ID (free tier)',
    'Cloudflare API token（Workers AI 权限）': 'Cloudflare API token (Workers AI permission)',
    'Cloudflare 模型': 'Cloudflare model',
    'OpenRouter 免费模型清单（逗号分隔，前一个限流自动换下一个）': 'OpenRouter free models (comma separated, rotates on rate limit)',
    '使用我的 ChatGPT 订阅额度（走本机已登录的 Codex CLI）': 'Use my ChatGPT subscription (via the Codex CLI already logged in here)',
    '使用我的 Claude 订阅额度（走本机已登录的 Claude Code）': 'Use my Claude subscription (via the Claude Code CLI already logged in here)',
    '免费额度用完时，允许花几分钱走 DeepSeek Flash（约 ¥0.001/次）': 'When free quota runs out, allow a fraction of a cent on DeepSeek Flash',
    '这两项由你自己决定开或不开，默认关闭。开启后，侧边栏只是调用你已经装好、已经登录的官方命令行工具，': 'Both are your call and ship switched off. When on, the sidebar only invokes the official CLI you installed and logged into yourself. ',
    '不保存任何账号或凭证': 'No credentials are stored or proxied.',
    '保存': 'Save',
    '通道自检（哪条通、哪条额度没了）': 'Channel check (what is alive, what is out of quota)',
    '点下面按钮，逐条探一遍。': 'Press a button to probe every channel.',
    '检查全部通道': 'Check all channels',
    '实测订阅（各耗 1 次额度）': 'Test subscriptions (uses 1 request each)',
    'DeepSeek 查余额、Gemini 查模型列表、Ollama 查本地模型，这三个不花钱。订阅通道必须真发一句话才知道通不通。': 'DeepSeek balance, Gemini model list and local Ollama are free to check. Subscriptions need a real message to prove they work.',
    '反馈统计（👍/👎 怎么改了我的路由）': 'Feedback stats (how 👍/👎 changed my routing)',
    '得分 = (👍+2)/(👍+👎+4)。同一成本档内，得分高的排前面；差距小于 0.12 不动，避免一票就抖。': 'Score = (👍+2)/(👍+👎+4). Within a cost tier, higher scores go first; gaps under 0.12 are ignored so one vote does not flip it.',
    '许可证（购买后邮件里那串）': 'License key (the one in your email)',
    '激活': 'Activate', '试用状态：读取中…': 'Trial status: reading…',
    '关于 / 免责说明（v': 'About / terms (v',
    '本工具只是一个浏览器侧栏壳：': 'This is a sidebar shell: ',
    '不保存账号凭证': 'no credentials are stored',
    '，请求由你的浏览器直连各家模型。': ' and requests go from your browser straight to the provider.',
    '订阅通道': 'Subscription channels', '数据': 'Data', '无担保': 'No warranty',
    '——记忆与索引存在本机；提问内容按你原有账号的条款直连模型商，不经过任何中间服务器。': ' — memory and its index live on this Mac; questions go straight to the provider under your own account terms, through no intermediate server.',
    '——本工具按现状提供，不对输出内容的准确性作任何承诺，重要决策请自行核对。': ' — provided as is, with no promise about accuracy. Check anything that matters.',
    // 记忆面板
    '记忆 · 网页': 'Memory · pages', '· 对话': '· chats', '全部': 'All', '网页': 'Pages', '对话': 'Chats',
    '加载更多': 'Load more', '恢复上次快照': 'Restore snapshot', '一键清空': 'Wipe all',
    '只看对话': 'Chats only',
    '搜一条记忆：随便打几个词，比如「降噪耳机测评」': 'Search memory in plain words, e.g. "noise cancelling headphones"',
    // 消息区
    '（无标题）': '(untitled)', '(空回复)': '(empty reply)', '复制全文': 'Copy answer',
    '删除': 'Delete', '删除这条': 'Delete this', '已激活': 'Activated',
    '读取中…': 'Loading…',
  };
  // 英文环境下把静态界面翻一遍（动态文本在调用处过 tr()）
  function tr(t) {
    if (LANG === 'zh' || !t) return t;
    const s = String(t).trim();
    const dict = LANG === 'en' ? EN : (LDICT[LANG] || {});
    if (dict[s]) return dict[s];
    if (LANG !== 'en') {
      // 其它语言只翻了核心几条：整句命中不了就退回英文，不留中文
      if (EN[s]) return EN[s];
      let out2 = String(t);
      for (const k of Object.keys(dict)) {
        if (k.length >= 3 && out2.includes(k)) out2 = out2.split(k).join(dict[k]);
      }
      if (out2 !== t) return out2;
    }
    let out = t;
    for (const k of Object.keys(EN)) {
      if (k.length >= 3 && out.includes(k)) out = out.split(k).join(EN[k]);
    }
    return out;
  }
  function translateTree(node) {
    if (LANG === 'zh') return;
    const walk = el => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) {
          const v = n.nodeValue;
          if (v && /[\u4e00-\u9fff]/.test(v)) {
            const t = tr(v);
            if (t !== v) n.nodeValue = t;
          }
        } else if (n.nodeType === 1) {
          for (const a of ['placeholder', 'title']) {
            const v = n.getAttribute && n.getAttribute(a);
            if (v && /[\u4e00-\u9fff]/.test(v)) n.setAttribute(a, tr(v));
          }
          walk(n);
        }
      }
    };
    walk(node);
  }

  translateTree(root);
  {
    const _in = root.getElementById('input'), _sb = root.getElementById('send');
    if (_in) _in.setAttribute('placeholder', tr('问点什么…（Enter 发送 / Shift+Enter 换行）'));
    if (_sb && LANG !== 'zh') _sb.textContent = tr('发送');
  }
  const $ = id => root.getElementById(id);
  const panel = $('panel'), msgs = $('msgs'), input = $('input'), sendBtn = $('send'), fab = $('fab');

  function esc(s) {
    return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function md(s) {
    let h = esc(s);
    h = h.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${code.replace(/^\w*\n/, '')}</pre>`);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    return h;
  }
  function bubble(role, text, tag) {
    const d = document.createElement('div');
    d.className = `m ${role}`;
    d.innerHTML = role === 'a' ? md(text) : esc(text);
    if (tag) {
      const t = document.createElement('div');
      t.className = 'tag';
      t.textContent = tr(tag);
      d.appendChild(t);
    }
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  // ---------- 每条回答的页脚：复制 / 朗读 / 评价 / 更多 / 时间 / 耗时详情 ----------
  function copyText(t, btn) {
    const done = () => { const o = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = o; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(() => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (_) {}
      ta.remove();
    }
  }

  function speak(t, btn) {
    if (!window.speechSynthesis) return;
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      btn.classList.remove('on');
      return;
    }
    const u = new SpeechSynthesisUtterance(t.replace(/```[\s\S]*?```/g, '（代码块）').slice(0, 4000));
    u.lang = 'zh-CN'; u.rate = 1.05;
    u.onend = () => btn.classList.remove('on');
    btn.classList.add('on');
    window.speechSynthesis.speak(u);
  }

  function estCost(ch, inChars, outChars) {
    const id = String(ch.id || ch.m || '');
    const tin = inChars / 1.6, tout = outChars / 1.6;
    if (/deepseek|ds/i.test(id) && !/free|sub/i.test(id)) {
      const inPrice = /pro/i.test(id) ? 0.55 : 0.15, outPrice = /pro/i.test(id) ? 2.2 : 0.6;
      return (tin / 1e6) * inPrice + (tout / 1e6) * outPrice;
    }
    if (/free/i.test(id)) return 0;
    if (/openrouter/i.test(id)) return (tin / 1e6) * 1 + (tout / 1e6) * 3;
    return 0;
  }
  const money = v => {
    if (typeof v === 'string') return v;            // 托管模式：服务器不暴露单价
    if (!Number.isFinite(v) || v <= 0) return '¥0';
    return v < 0.01 ? '¥' + v.toFixed(4) : '¥' + v.toFixed(2);
  };

  // ---------- 反馈闭环：👍/👎 直接改下一次的通道排序 ----------
  // 存本地：votes["kind|channel"] = {up, down, reasons:[]}
  let VOTES = {};
  function voteKey(kind, ch) { return `${kind || 'simple'}|${ch}`; }
  function voteScore(kind, ch) {
    const r = VOTES[voteKey(kind, ch)];
    if (!r) return 0.5;                       // 没数据 → 中性先验
    return (r.up + 2) / (r.up + r.down + 4);  // 拉普拉斯平滑，避免 1 票就翻天
  }
  // 只在同一成本档内重排：免费档不能被挪成付费，反之亦然
  const isPaid = ch => /deepseek|openrouter|anthropic/ .test(ch);
  function applyFeedback(list, kind, level) {
    if (!list || list.length < 2) return list;
    let out = list.slice();
    // ① 硬降级：这类问题上被踩到分数 <0.35（净差 2 票以上）→ 挪到整条链最后
    const bad = out.filter(t => voteScore(kind, t.p) < 0.35);
    if (bad.length && bad.length < out.length) {
      out = out.filter(t => voteScore(kind, t.p) >= 0.35).concat(bad);
    }
    // ② 同成本档内按分数排（免费档不会被排到付费档后面，反之亦然）
    const runs = [];
    out.forEach(t => {
      const paid = isPaid(t.p);
      const last = runs[runs.length - 1];
      if (last && last.paid === paid) last.items.push(t);
      else runs.push({ paid, items: [t] });
    });
    runs.forEach(r => {
      if (r.items.length > 1) r.items.sort((x, y) => voteScore(kind, y.p) - voteScore(kind, x.p));
    });
    return runs.flatMap(r => r.items);
  }

  const REASONS = [
    ['答偏了', 'wrong'],
    ['太浅', 'shallow'],
    ['有错误', 'error'],
    ['太啰嗦', 'verbose'],
    ['模型不该用它', 'badmodel'],
  ];

  function toast(el, text) {
    const f = el.querySelector('.foot');
    if (!f) return;
    let t = f.querySelector('.toast');
    if (!t) {
      t = document.createElement('span');
      t.className = 'toast';
      t.style.cssText = 'font-size:11px;color:#6fa8ff;margin-left:6px';
      f.insertBefore(t, f.querySelector('.sp'));
    }
    t.textContent = text;
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.textContent = ''; }, 4000);
  }

  function vote(el, meta, v, btn) {
    const wrap = el.querySelector('.foot');
    wrap.querySelectorAll('[data-act="up"],[data-act="down"]').forEach(x => x.classList.remove('on'));
    btn.classList.add('on');
    const k = voteKey(meta.kind, meta.channel);
    VOTES[k] = VOTES[k] || { up: 0, down: 0, reasons: [] };
    if (v > 0) VOTES[k].up++; else VOTES[k].down++;
    GM.setValue('votes', VOTES);
    toast(el, '已记录 ✓');
    // 点踩 → 追问原因，同时给出"下次会怎么变"
    const old = el.querySelector('.why-row');
    if (old) old.remove();
    if (v < 0) {
      const row = document.createElement('div');
      row.className = 'why-row';
      row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;font-size:11px';
      const tip = document.createElement('span');
      tip.textContent = '哪里不行？';
      tip.style.cssText = 'color:#8b95a7';
      row.appendChild(tip);
      REASONS.forEach(([label, code]) => {
        const b2 = document.createElement('button');
        b2.textContent = label;
        b2.style.cssText = 'background:#1b1f26;border:1px solid #2f3540;color:#cfd6e4;border-radius:999px;padding:2px 8px;font-size:11px;cursor:pointer';
        b2.onclick = () => {
          VOTES[k].reasons.push(code);
          GM.setValue('votes', VOTES);
          row.querySelectorAll('button').forEach(x => (x.disabled = true));
          b2.style.borderColor = '#3b6fd4';
          const stronger = meta.kind === 'code' || meta.kind === 'hard' ? '更强的模型' : '同档里更靠前的模型';
          toast(el, `记下了。这类问题下一个更倾向${stronger}`);
          if (meta.kind === 'code' || meta.kind === 'hard' || code === 'shallow' || code === 'wrong') {
            // 明确记为"这个通道在这类问题上不够用"，让它排到同档最后
            VOTES[k].down += 1;
            GM.setValue('votes', VOTES);
          }
          sendFeedback({ ...meta, vote: -1, reason: code });
        };
        row.appendChild(b2);
      });
      el.appendChild(row);
    } else {
      sendFeedback({ ...meta, vote: 1 });
    }
  }

  async function seedVotes() {
    try {
      const r = await gm({ method: 'GET', url: `${CFG.gatewayUrl}/feedback/stats`, timeout: 4000 });
      const j = JSON.parse(r.responseText);
      (j.groups || []).forEach(g => {
        const k = voteKey(g.kind, g.channel);
        const local = VOTES[k];
        if (!local || (local.up + local.down) < g.n) {
          VOTES[k] = { up: g.up, down: g.down, reasons: Object.keys(g.reasons || {}) };
        }
      });
      GM.setValue('votes', VOTES);
      renderStats();
    } catch (_) {}
  }

  function renderStats() {
    const box = $('fstats');
    if (!box) return;
    const rows = Object.entries(VOTES)
      .map(([k, v]) => {
        const [kind, ch] = k.split('|');
        const n = v.up + v.down;
        return { kind, ch, n, up: v.up, score: (v.up + 2) / (n + 4) };
      })
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 12);
    if (!rows.length) {
      box.innerHTML = '<span style="opacity:.6">还没有反馈。点回答下面的 👍/👎，这里会显示每条通道在你手里得分。</span>';
      return;
    }
    box.innerHTML = rows.map(r =>
      `${r.kind} · ${r.ch}　👍${r.up} 👎${r.n - r.up}　得分 ${r.score.toFixed(2)}`
    ).join('<br>');
  }

  function sendFeedback(meta) {
    try {
      gm({
        method: 'POST',
        url: `${CFG.gatewayUrl}/feedback`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          q: meta.q, vote: meta.vote, reason: meta.reason || '',
          channel: meta.channel, model: meta.model,
          kind: meta.kind, level: meta.level, routeSrc: meta.routeSrc, ms: meta.ms,
        }),
        timeout: 4000,
      });
    } catch (_) {}
  }

  function menuFor(el, meta) {
    const old = el.querySelector('.more-menu');
    if (old) { old.remove(); return; }
    const d = document.createElement('div');
    d.className = 'more-menu';
    d.style.cssText = 'margin-top:6px;border:1px solid #262b34;border-radius:8px;background:#0f1115;overflow:hidden';
    const item = (label, fn) => {
      const x = document.createElement('button');
      x.textContent = label;
      x.style.cssText = 'display:block;width:100%;text-align:left;background:transparent;border:none;color:#cfd6e4;font-size:12px;padding:7px 10px;cursor:pointer';
      x.onmouseenter = () => (x.style.background = '#1b1f26');
      x.onmouseleave = () => (x.style.background = 'transparent');
      x.onclick = () => { d.remove(); fn(); };
      d.appendChild(x);
    };
    item('复制全文', () => copyText(meta.text, document.createElement('button')));
    item('重新生成', () => { input.value = meta.q; input.focus(); });
    item('删除这条', () => el.remove());
    el.appendChild(d);
  }

  function addFooter(el, meta) {
    const f = document.createElement('div');
    f.className = 'foot';
    const mk = (label, act, title) => {
      const b2 = document.createElement('button');
      b2.textContent = label; b2.dataset.act = act; b2.title = title || label;
      f.appendChild(b2);
      return b2;
    };
    const copyB = mk('⧉', 'copy', tr('复制'));
    copyB.onclick = () => copyText(meta.text, copyB);
    const ttsB = mk('🔊', 'tts', tr('朗读'));
    ttsB.onclick = () => speak(meta.text, ttsB);
    const upB = mk('👍', 'up', tr('有用'));
    upB.onclick = () => vote(el, meta, 1, upB);
    const downB = mk('👎', 'down', tr('没用'));
    downB.onclick = () => vote(el, meta, -1, downB);
    const moreB = mk('⋯', 'more', tr('更多'));
    moreB.onclick = () => menuFor(el, meta);

    const sp = document.createElement('span'); sp.className = 'sp'; f.appendChild(sp);
    const tm = document.createElement('span'); tm.className = 'time';
    tm.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    f.appendChild(tm);

    const detBtn = document.createElement('button');
    detBtn.dataset.act = 'det';
    detBtn.textContent = LANG === 'en' ? `${(meta.ms / 1000).toFixed(1)}s ›` : `耗时 ${(meta.ms / 1000).toFixed(1)}s ›`;
    f.appendChild(detBtn);
    el.appendChild(f);

    const det = document.createElement('div');
    det.className = 'det';
    const chars = meta.text.length;
    const approxTok = Math.round(chars / 1.6);
    const L2 = LANG === 'en' ? {
      ch: 'Channel', kind: 'Routed', total: 'Total', out: 'Output', ctx: 'Context',
      cost: 'Est. cost', chain: 'Fallback chain', why: 'Why this one', page: 'page', inj: 'injected',
      approx: 'est. official rates, see your bill', chars: 'chars', toks: 'tokens',
    } : { ch: '通道', kind: '判定', total: '总耗时', out: '输出', ctx: '上下文', cost: '估算花费',
      chain: '降级链', why: '选中理由', page: '页面', inj: '注入', approx: '（按官方单价估，实际以账单为准）', chars: '字', toks: 'tokens' };
    const lines = [
      `${L2.ch}　${meta.channel}${meta.model ? ' · ' + meta.model : ''}`,
      `${L2.kind}　${meta.kind}${meta.level ? ' · L' + meta.level : ''}${meta.routeSrc ? ' · ' + meta.routeSrc : ''}${meta.routeMs != null ? ' · ' + meta.routeMs + 'ms' : ''}`,
      `${L2.total}　${(meta.ms / 1000).toFixed(1)}s`,
      `${L2.out}　${chars} ${L2.chars} (~${approxTok} tokens)`,
      `${L2.ctx}　${L2.page} ${Math.round((lastContext || '').length / 100) / 10}k ${L2.chars}` +
        (meta.sources && meta.sources.length ? ` · ${L2.inj} ${meta.sources.length}` : '') +
        (meta.searchNote ? ` · ${meta.searchNote}` : ''),
      `${L2.cost}　${money(meta.cost)}${typeof meta.cost === 'number' && meta.cost > 0 ? ' ' + L2.approx : ''}`,
    ];
    if (meta.chain && meta.chain.length > 1) lines.push(`${L2.chain}　${meta.chain.join(' → ')}`);
    if (meta.why) lines.push(`${L2.why}　${meta.why}`);
    det.textContent = lines.join('\n');
    el.appendChild(det);
    detBtn.onclick = () => det.classList.toggle('on');

    if (meta.sources && meta.sources.length) {
      const box = document.createElement('div');
      box.className = 'src';
      const head = document.createElement('span');
      head.className = 'fold';
      head.textContent = LANG === 'en' ? `Sources (${meta.sources.length}) ›` : `来源 ${meta.sources.length} 项 ›`;
      box.appendChild(head);
      const list = document.createElement('div');
      list.style.display = 'none';
      meta.sources.forEach(s => {
        const line = document.createElement('div');
        if (s.url) {
          const a = document.createElement('a');
          a.href = s.url; a.target = '_blank'; a.rel = 'noreferrer';
          a.textContent = s.title || s.url;
          line.appendChild(a);
        } else {
          line.textContent = s.title || s.path || '本地笔记';
          line.title = s.path || '';
        }
        list.appendChild(line);
      });
      box.appendChild(list);
      head.onclick = () => {
        const open = list.style.display === 'none';
        list.style.display = open ? 'block' : 'none';
        head.textContent = `来源 ${meta.sources.length} 项 ${open ? '⌄' : '›'}`;
      };
      el.appendChild(box);
    }
  }

  function openPanel() { busy = false; sendBtn.disabled = false; panel.classList.remove('hidden'); fab.style.display = 'none'; input.focus(); }
  function closePanel() { panel.classList.add('hidden'); fab.style.display = 'flex'; }
  fab.onclick = openPanel;
  $('close').onclick = closePanel;
  $('clear').onclick = () => { history.length = 0; msgs.innerHTML = ''; };

  $('gear').onclick = () => {
    $('settings').classList.toggle('on');
    if ($('settings').classList.contains('on')) renderStats();
  };
  $('searchbtn').onclick = () => {
    SEARCH_ON = !SEARCH_ON;
    $('searchbtn').classList.toggle('off', !SEARCH_ON);
    GM.setValue('searchOn', SEARCH_ON);
  };
  $('memobtn').onclick = () => {
    MEMORY_ON = !MEMORY_ON;
    $('memobtn').classList.toggle('off', !MEMORY_ON);
    GM.setValue('memoryOn', MEMORY_ON);
    bubble('a', MEMORY_ON ? '开始记住你看过的网页（只存本机，可随时关掉）。' : '已停止自动记忆。');
  };

  // ---------- 浏览即记：页面停留 4 秒后自动入库 ----------
  let capturedThisPage = false;
  function autoCapture() {
    if (!PRO_ON) return;   // 免费版 / 试用结束：没有本地记忆
    if (!MEMORY_ON || capturedThisPage) return;
    if (!/^https?:/i.test(location.href)) return;
    const txt = readPage();
    if (!txt || txt.length < 400) return;
    capturedThisPage = true;
    gm({
      method: 'POST',
      url: `${CFG.gatewayUrl}/capture`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ url: location.href, title: document.title || '', text: txt.slice(0, 2500) }),
      timeout: 12000,
    });
  }
  // 第一次用（一个 key 都没填）就把设置打开，并告诉他要做什么
  const hasAnyKey = () => !!(CFG.deepseekKey || CFG.geminiKey || CFG.groqKey || CFG.openrouterKey || CFG.anthropicKey);
  // 第一次用：托管模式只让他填一个邮箱；自己带 key 的老用户不打扰
  if (CFG.hosted && !CFG.sbToken) {
    setTimeout(() => {
      $('settings').classList.add('on');
      bubble('a', LANG === 'zh'
        ? '第一次用，只有一步：**填个邮箱**，7 天免费就开了。\n\n不用信用卡，不用挑模型，不用申请任何 key —— 用哪家模型由服务器决定，坏了自己往下切。'
        : 'One step to start: **enter your email** and the 7-day trial opens.\n\nNo card, no model picking, no API keys. The server chooses the model and falls back on its own if one breaks.');
    }, 900);
  }
  setTimeout(refreshTrial, 600);
  bindAttach();
  bindNotes();
  resolveEndpoint().finally(() => setTimeout(refreshAcct, 300));
  setTimeout(autoCapture, 4000);
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; capturedThisPage = false; setTimeout(autoCapture, 4000); }
  }, 2000);
  $('send').onclick = send;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      panel.classList.contains('hidden') ? openPanel() : closePanel();
    }
  }, true);

  // 拖动改宽
  (() => {
    let dragging = false, startX = 0, startW = 0;
    $('grip').addEventListener('mousedown', e => {
      dragging = true; startX = e.clientX; startW = panel.offsetWidth;
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const w = Math.min(Math.max(startW + (startX - e.clientX), 300), Math.min(760, window.innerWidth - 200));
      panel.style.setProperty('--w', w + 'px');
      CFG.panelWidth = w;
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; GM.setValue('cfg', CFG); }
    });
  })();

  // 模型选择持久化
  $('model').onchange = e => { MODEL_CHOICE = e.target.value; GM.setValue('model', MODEL_CHOICE); };

  // ---------- 设置读写 ----------
  function fillSettings() {
    setTimeout(renderStats, 0);
    $('k-deepseek').value = CFG.deepseekKey;
    $('k-openrouter').value = CFG.openrouterKey;
    $('k-gemini').value = CFG.geminiKey;
    $('k-gemini2').value = CFG.geminiKey2 || '';
    $('k-gemini3').value = CFG.geminiKey3 || '';
    $('k-anthropic').value = CFG.anthropicKey;
    $('m-gemini').value = CFG.geminiModel;
    $('m-geminilong').value = CFG.geminiLongModel;
    $('m-claude').value = CFG.anthropicModel;
    $('m-ollama').value = CFG.ollamaModel;
    $('c-chatgpt').checked = !!CFG.subChatGPT;
    $('c-claude').checked = !!CFG.subClaude;
    $('c-tiny').checked = CFG.tinySpend !== false;
    $('k-groq').value = CFG.groqKey || '';
    $('k-groq2').value = CFG.groqKey2 || '';
    $('m-groq').value = CFG.groqModel || '';
    $('k-cfid').value = CFG.cfAccount || '';
    $('k-cftoken').value = CFG.cfToken || '';
    $('m-cf').value = CFG.cfModel || '';
    $('m-orfree').value = CFG.orFreeModels || DEFAULTS.orFreeModels;
    $('u-ollama').value = CFG.ollamaUrl;
  }
  // 首次勾选订阅通道时确认一次
  function needsAck(which) {
    const acked = CFG.subAck || {};
    return !acked[which];
  }
  function showAck(which, box) {
    const el = $('ack');
    el.style.display = 'block';
    el.innerHTML = `你正在开启「${which === 'chatgpt' ? 'ChatGPT' : 'Claude'} 订阅额度」通道。<br>` +
      `本工具只调用你本机已登录的官方命令行工具，不保存任何凭证；额度怎么用、是否符合你与模型商的协议，由你自己判断并承担。<br>` +
      `<span style="opacity:.7">模型商可能随时关闭这类用法，届时会自动改用你的 API key 或本地模型。</span><br><br>` +
      `<button class="send" id="ack-yes" style="padding:5px 10px;font-size:12px">我了解，自己承担</button> ` +
      `<button class="send" id="ack-no" style="padding:5px 10px;font-size:12px;background:#3a4048">先算了</button>`;
    $('ack-yes').onclick = () => {
      CFG.subAck = Object.assign({}, CFG.subAck, { [which]: true });
      GM.setValue('cfg', CFG);
      el.style.display = 'none';
    };
    $('ack-no').onclick = () => { box.checked = false; el.style.display = 'none'; };
  }
  ['chatgpt', 'claude'].forEach(w => {
    const box = $('c-' + w);
    box.addEventListener('change', () => {
      if (box.checked && needsAck(w)) showAck(w, box);
      else $('ack').style.display = 'none';
    });
  });
  $('aver').textContent = '0.23.1';

  // ---------- 试用 / 许可证 ----------
  function paintLic(st) {
    const hint = $('lic-hint');
    if (!hint) return;
    if (!IS_PRO) { $('lic-row').style.display = 'none'; return; }
    const st2 = st || TRIAL;
    if (!st2) { hint.textContent = '试用状态读不到（本地服务没起来？）'; return; }
    if (st2.state === 'licensed') {
      hint.innerHTML = `已激活 ✓ ${memEsc(st2.key || '')}` + (st2.licensedAt ? ` · ${memDate(st2.licensedAt)}` : '');
      hint.style.color = '#7fb08a';
    } else if (st2.state === 'trial') {
      hint.innerHTML = `试用中 · 还剩 <b>${st2.daysLeft}</b> 天（共 ${st2.trialDays} 天）· 到期后记忆和自动路由会暂停`;
      hint.style.color = '#93a0b5';
    } else {
      hint.innerHTML = '试用已结束 · 自动路由和记忆已暂停，手选模型照常能用';
      hint.style.color = '#c98b8b';
    }
  }

  async function refreshTrial() {
    if (!IS_PRO) return;
    try {
      const r = await gm({ method: 'GET', url: `${CFG.gatewayUrl}/license`, timeout: 6000 });
      const j = JSON.parse(r.responseText);
      TRIAL = j;
      PRO_ON = j.state !== 'expired';
      paintLic(j);
    } catch (e) {
      paintLic(null);
    }
  }

  $('lic-btn').onclick = async () => {
    const key = ($('lic-input').value || '').trim();
    if (!key) { bubble('a', '先把许可证粘进去。'); return; }
    $('lic-btn').textContent = '验证中…';
    try {
      const r = await gm({
        method: 'POST', url: `${CFG.gatewayUrl}/license`,
        headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ key }), timeout: 20000,
      });
      const j = JSON.parse(r.responseText);
      if (!j.ok) throw new Error(j.error || '激活失败');
      TRIAL = j.trial; PRO_ON = true;
      paintLic(j.trial);
      bubble('a', '激活成功，谢谢。' + (j.email ? '（' + j.email + '）' : ''));
      $('lic-btn').textContent = '已激活';
    } catch (e) {
      $('lic-btn').textContent = '激活';
      bubble('a', '激活失败：' + e.message);
    }
  };
  // 免费版：隐藏所有依赖本地网关、以及多 key 的入口
  if (!IS_PRO) {
    ['memlist', 'memobtn', 'searchbtn'].forEach(id => { const el = $(id); if (el) el.style.display = 'none'; });
    root.querySelectorAll('.pro-only').forEach(el => { el.style.display = 'none'; });
  }

  // ---------- 记忆面板：看过哪些页 / 删单条 / 一键清空 ----------
  let MEM_OFFSET = 0;
  let MEM_TYPE = 'all';
  GM.getValue('memTab', 'all').then(v => {
    if (!v || !['all', 'page', 'chat'].includes(v)) return;
    MEM_TYPE = v;
    const t = root.querySelector(`.mtab[data-t="${v}"]`);
    if (t) { root.querySelectorAll('.mtab').forEach(x => x.classList.toggle('on', x === t)); }
  });
  const MEM_PAGE = 20;
  const memEmptyText = () => {
    if (($('mem-q').value || '').trim()) return '没搜到。换个词试试。';
    if (MEM_TYPE === 'chat') return '还没记下对话。<br>开着 🧠 问几句，回来就有了。';
    if (MEM_TYPE === 'page') return '还没记下任何页面。<br>开着 🧠 逛几个网页，回来就有了。';
    return '还没记下什么。<br>开着 🧠 逛几个网页、问几句话，回来就有了。';
  };
  const memDate = ts => {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const memEsc = t => String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function memFetch(path, body) {
    const r = await gm({
      method: body ? 'POST' : 'GET',
      url: CFG.gatewayUrl + path,
      headers: { 'Content-Type': 'application/json' },
      data: body ? JSON.stringify(body) : undefined,
      timeout: 15000,
    }).catch(e => { throw new Error('记忆服务没起来（bash ~/ai-gateway/start.sh）'); });
    let j = {};
    try { j = JSON.parse(r.responseText); } catch (_) {}
    if (r.status >= 400) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  function memRow(it) {
    const el = document.createElement('div');
    el.className = 'memp-item';
    const isChat = it.type === 'chat';
    const kind = `<span class="memp-kind ${isChat ? 'chat' : 'page'}">${isChat ? '对话' : '网页'}</span>`;
    const meta = isChat
      ? `${kind}${memEsc(it.channel || '本机')} · ${memDate(it.ts)} · ${it.chars} 字`
      : `${kind}${memEsc(it.domain)} · ${memDate(it.ts)} · ${it.chars} 字`;
    el.innerHTML =
      `<div class="memp-main">` +
        `<div class="memp-title" title="${memEsc(it.title || it.url)}">${memEsc(it.title || '(无标题)')}${isChat ? ' <span class="memp-caret">⌄</span>' : ''}</div>` +
        `<div class="memp-meta">${meta}</div>` +
        (it.excerpt ? `<div class="memp-ex">${memEsc(it.excerpt)}</div>` : '') +
      `</div>`;
    const del = document.createElement('button');
    del.className = 'memp-del';
    del.textContent = '删除';
    del.onclick = async () => {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = '确认删？';
        del.style.background = '#2a1d1d';
        return;
      }
      del.disabled = true;
      try {
        const r = await memFetch('/memory/forget', it.type === 'chat' ? { id: it.id, type: 'chat' } : { url: it.url, type: 'page' });
        el.remove();
        memBump(-1);
        bubble('a', '删掉了这条。' + (r.backup ? '（删之前存了快照，可点「恢复上次快照」找回）' : ''));
      } catch (e) {
        del.disabled = false;
        bubble('a', '删除失败：' + e.message);
      }
    };
    el.appendChild(del);

    if (isChat) {
      // 点开看这段对话本身，不跳原网页
      const detail = document.createElement('div');
      detail.className = 'memp-detail';
      const lvl = it.level ? ` · 难度 ${it.level}` : '';
      const kindName = { simple: '简单', code: '代码', writing: '写作', hard: '硬' }[it.kind] || it.kind || '';
      detail.innerHTML =
        `<div class="memp-d-q">${memEsc(it.q || it.title)}</div>` +
        `<div class="memp-d-a">${memEsc(it.a || it.excerpt || '')}</div>` +
        `<div class="memp-d-meta">${memEsc(it.channel || '')} · ${memEsc(kindName + lvl)} · ${it.ms ? '耗时 ' + (it.ms / 1000).toFixed(1) + 's · ' : ''}${it.chars} 字` +
        (it.url ? ` · <span class="memp-d-open">打开当时的页面</span>` : '') + `</div>`;
      detail.style.display = 'none';
      el.appendChild(detail);
      const openLink = detail.querySelector('.memp-d-open');
      if (openLink) openLink.onclick = e => { e.stopPropagation(); window.open(it.url, '_blank'); };
      el.querySelector('.memp-main').onclick = () => {
        const on = detail.style.display !== 'none';
        detail.style.display = on ? 'none' : 'block';
        el.classList.toggle('open', !on);
      };
    } else if (it.url) {
      el.querySelector('.memp-main').onclick = () => window.open(it.url, '_blank');
    }
    return el;
  }

  function memBump(delta) {
    const el = $('mem-count');
    if (!el) return;
    el.textContent = String(Math.max(0, Number(el.textContent || 0) + delta));
  }

  async function memLoad(reset) {
    const list = $('mem-list');
    if (reset) { MEM_OFFSET = 0; list.innerHTML = ''; }
    const q = ($('mem-q').value || '').trim();
    list.insertAdjacentHTML('beforeend', '<div class="memp-empty" id="mem-loading">读取中…</div>');
    try {
      const j = await memFetch(`/memory/list?limit=${MEM_PAGE}&offset=${MEM_OFFSET}&type=${MEM_TYPE}&q=${encodeURIComponent(q)}`);
      const loading = $('mem-loading');
      if (loading) loading.remove();
      $('mem-count').textContent = j.total;
      if (reset && !j.rows.length) {
        list.innerHTML = `<div class="memp-empty">${memEmptyText()}</div>`;
      }
      j.rows.forEach(it => list.appendChild(memRow(it)));
      MEM_OFFSET += j.rows.length;
      $('mem-more').style.display = MEM_OFFSET >= j.total ? 'none' : '';
    } catch (e) {
      const loading = $('mem-loading');
      if (loading) loading.remove();
      list.insertAdjacentHTML('beforeend', `<div class="memp-empty">${memEsc(e.message)}</div>`);
    }
  }

  async function memOpen() {
    $('memp').classList.add('on');
    try {
      const st = await memFetch('/memory/stats');
      $('mem-count').textContent = st.pages;
      $('mem-chatcount').textContent = st.chats ?? 0;
      $('mem-size').textContent = (st.bytes / 1024).toFixed(0) + ' KB';
    } catch (_) {}
    memLoad(true);
  }

  root.querySelectorAll('.mtab').forEach(t => {
    t.onclick = () => {
      root.querySelectorAll('.mtab').forEach(x => x.classList.toggle('on', x === t));
      MEM_TYPE = t.dataset.t;
      GM.setValue('memTab', MEM_TYPE);
      $('mem-clear').textContent = MEM_TYPE === 'all' ? '一键清空' : '清空这一类';
      memLoad(true);
    };
  });
  $('mem-chatall').onclick = () => {
    const t = root.querySelector('.mtab[data-t="chat"]');
    if (t) t.click();
  };

  $('memlist').onclick = () => memOpen();
  $('mem-close').onclick = () => $('memp').classList.remove('on');
  $('mem-more').onclick = () => memLoad(false);
  let memQTimer = null;
  $('mem-q').oninput = () => {
    clearTimeout(memQTimer);
    memQTimer = setTimeout(() => memLoad(true), 300);
  };
  $('mem-clear').onclick = async () => {
    const btn = $('mem-clear');
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = MEM_TYPE === 'all' ? '真的全清？再点一次' : `真的清空${MEM_TYPE === 'chat' ? '对话' : '网页'}？再点一次`;
      return;
    }
    btn.disabled = true;
    try {
      const r = await memFetch('/memory/clear', MEM_TYPE === 'all' ? { all: true } : { type: MEM_TYPE });
      btn.dataset.armed = '';
      btn.textContent = '一键清空';
      btn.disabled = false;
      bubble('a', `清空了 ${r.cleared} 条。${r.backup ? '（清之前存了快照，可点「恢复上次快照」找回）' : ''}`);
      memLoad(true);
    } catch (e) {
      btn.disabled = false;
      bubble('a', '清空失败：' + e.message);
    }
  };
  $('mem-restore').onclick = async () => {
    try {
      const r = await memFetch('/memory/restore', { type: MEM_TYPE === 'all' ? 'page' : MEM_TYPE });
      bubble('a', `已从快照恢复 ${r.rows} 条。`);
      memLoad(true);
    } catch (e) {
      bubble('a', '恢复失败：' + e.message);
    }
  };

  // ---------- 通道自检 ----------
  const SC_NAME = { gemini: 'Gemini 免费层', groq: 'Groq 免费层', cf: 'Cloudflare 免费额度', deepseek: 'DeepSeek API', ollama: '本地 Ollama', chatgpt: 'ChatGPT 订阅', claude: 'Claude 订阅' };
  const SC_MARK = { ok: '✅', quota: '🈵', auth: '⛔', nokey: '➖', off: '⏸', down: '⚠️', error: '⚠️' };
  const SC_TEXT = { ok: '可用', quota: '额度用完', auth: 'key 无效', nokey: '没填 key', off: '开关关着', down: '连不上', error: '出错' };

  async function probeOne(id, withSub) {
    const t0 = Date.now();
    const done = (state, note) => ({ id, state, note, ms: Date.now() - t0 });
    try {
      if (id === 'gemini') {
        const keys = [CFG.geminiKey, CFG.geminiKey2, CFG.geminiKey3].filter(Boolean);
        if (!keys.length) return done('nokey', '填了 key 才能用免费层');
        // 必须真发一次生成：列模型列表永远 200，看不出额度用没用完
        const r = await gm({
          method: 'POST',
          url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(CFG.geminiModel || 'gemini-3.5-flash')}:generateContent`,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': CFG.geminiKey },
          data: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1, thinkingConfig: { thinkingBudget: 0 } } }),
        });
        if (r.status === 429) return done('quota', `${keys.length} 把 key 都在限流（免费层按分钟限额）`);
        if (r.status === 404) return done('error', '模型名不对：' + (CFG.geminiModel || ''));
        if (r.status === 401 || r.status === 403) return done('auth', 'key 不被接受');
        if (r.status >= 400) return done('error', 'HTTP ' + r.status);
        return done('ok', keys.length + ' 把 key 可用');
      }
      if (id === 'deepseek') {
        if (!CFG.deepseekKey) return done('nokey', '填了 key 才能用');
        const r = await gm({ method: 'GET', url: 'https://api.deepseek.com/user/balance', headers: { Authorization: 'Bearer ' + CFG.deepseekKey } });
        if (r.status === 401) return done('auth', 'key 无效');
        if (r.status === 402) return done('quota', '余额不足');
        if (r.status >= 400) return done('error', 'HTTP ' + r.status);
        let bal = '';
        try { const j = JSON.parse(r.responseText); const b = (j.balance_infos || [])[0]; if (b) bal = `余额 ¥${b.total_balance}`; } catch (_) {}
        return done('ok', bal || '可用');
      }
      if (id === 'ollama') {
        const r = await gm({ method: 'GET', url: CFG.ollamaUrl.replace(/\/$/, '') + '/api/tags' });
        if (r.status >= 400) return done('down', 'HTTP ' + r.status + '（Ollama 可能没启动）');
        let n = 0;
        try { n = (JSON.parse(r.responseText).models || []).length; } catch (_) {}
        return done('ok', `${n} 个本地模型，完全免费但质量弱`);
      }
      if (id === 'groq') {
        const gk = CFG.groqKey || CFG.groqKey2;
        if (!gk) return done('nokey', '填了 key 才能用免费层');
        const r = await gm({ method: 'GET', url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: 'Bearer ' + gk } });
        if (r.status === 429) return done('quota', '限流中，稍后自动恢复');
        if (r.status === 401) return done('auth', 'key 无效');
        if (r.status >= 400) return done('error', 'HTTP ' + r.status);
        let n = 0;
        try { n = (JSON.parse(r.responseText).data || []).length; } catch (_) {}
        return done('ok', n + ' 个模型可用' + (CFG.groqKey && CFG.groqKey2 ? '（另有备用 key）' : ''));
      }
      if (id === 'cf') {
        const r = await gm({ method: 'GET', url: CFG.gatewayUrl + '/cf' }).catch(e => { throw new Error('网关没起来'); });
        let j = {};
        try { j = JSON.parse(r.responseText); } catch (_) {}
        if (!j.configured) return done('nokey', '网关里还没配 Cloudflare 账号/token');
        return done('ok', '经网关可用 · ' + (j.model || ''));
      }
      if (id === 'chatgpt' || id === 'claude') {
        const on = id === 'chatgpt' ? !!CFG.subChatGPT : !!CFG.subClaude;
        if (!on) return done('off', '齿轮里勾上才会进路由');
        if (!withSub) return done('ok', '开关已开（没实测）');
        const r = await gm({
          method: 'POST',
          url: CFG.gatewayUrl + (id === 'chatgpt' ? '/chatgpt' : '/claude'),
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ prompt: '只回两个字：在线' }),
        });
        if (r.status >= 400) {
          const quota = /limit|quota|额度|429|exceed/i.test(r.responseText || '');
          return done(quota ? 'quota' : 'error', quota ? '额度用完或限流' : 'HTTP ' + r.status);
        }
        return done('ok', '实测通了');
      }
    } catch (e) {
      return done('down', e.message || '连不上');
    }
    return done('error', '这条通道还没有探测逻辑');
  }

  async function probeAll(withSub) {
    const out = $('sc-out');
    const ids = ['gemini', 'groq', 'cf', 'deepseek', 'ollama', 'chatgpt', 'claude'];
    out.textContent = '探测中…';
    const res = await Promise.all(ids.map(id => probeOne(id, withSub)));
    const lines = res.map(r => {
      const name = (SC_NAME[r.id] || r.id).padEnd(14, ' ');
      return `${SC_MARK[r.state] || '·'} ${name} ${SC_TEXT[r.state] || r.state}${r.note ? '  · ' + r.note : ''}  ${r.ms}ms`;
    });
    const usable = res.filter(r => r.state === 'ok').map(r => SC_NAME[r.id]);
    out.innerHTML = '<pre style="margin:0;white-space:pre-wrap;font-family:inherit">' + lines.join('\n') + '</pre>' +
      `<div style="margin-top:8px;opacity:.85">现在能用：${usable.length ? usable.join('、') : '一条都没有 —— 至少填一个 key'}</div>` +
      `<div style="margin-top:6px;opacity:.7">质量优先/平衡档的首选是订阅通道；订阅开关关着时，能用的最强通道通常就是 DeepSeek。这就是"总是 DeepSeek"的原因。</div>`;
  }
  $('sc-run').onclick = () => probeAll(false);
  $('sc-sub').onclick = () => probeAll(true);

  // ---------- 界面语言 ----------
  const langSel = $('set-lang');
  if (langSel) {
    langSel.innerHTML = LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
    langSel.value = LANG;
    langSel.addEventListener('change', async () => {
      LANG = langSel.value;
      CFG.lang = LANG;
      await GM.setValue('cfg', CFG);
      // 静态文案整体重翻一遍，再修掉动态的几处
      try { translateTree(root); } catch (_) {}
      input.setAttribute('placeholder', tr('问点什么…（Enter 发送 / Shift+Enter 换行）'));
      paintAcct();
      await refreshAcct();
    });
  }

  // ---------- 语音输入（浏览器自带识别，不上传第三方） ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtns = ['mic2', 'mic'].map(id => $(id)).filter(Boolean);
  let recog = null, listening = false;
  micBtns.forEach(micBtn => {
  if (SR) {
    micBtn.addEventListener('click', () => {
      if (listening) { try { recog && recog.stop(); } catch (_) {} return; }
      recog = new SR();
      recog.lang = SPEECH_LANG[LANG] || 'en-US';
      recog.interimResults = true;
      recog.continuous = false;
      const before = input.value.trim();
      let finalText = '';
      recog.onstart = () => { listening = true; micBtn.textContent = '⏺'; micBtn.style.color = '#ff6b6b'; };
      recog.onresult = ev => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        input.value = (before ? before + ' ' : '') + finalText + interim;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      };
      recog.onerror = e => {
        listening = false; micBtn.textContent = '🎤'; micBtn.style.color = '';
        if (e.error === 'not-allowed') bubble('a', LANG === 'zh' ? '麦克风没权限：Safari 设置 → 网站 → 麦克风，允许这个站点。' : 'Microphone blocked. Safari Settings → Websites → Microphone → allow this site.');
        else if (e.error === 'no-speech') bubble('a', tr('听不见声音') + ' — ' + (LANG === 'zh' ? '再点一次 🎤 重新说。' : 'click 🎤 and try again.'));
      };
      recog.onend = () => {
        listening = false; micBtn.textContent = '🎤'; micBtn.style.color = '';
        if (input.value.trim()) input.focus();
      };
      try { recog.start(); } catch (_) { listening = false; }
    });
  } else {
    micBtn.style.opacity = '.35';
    micBtn.title = LANG === 'zh' ? '这个浏览器不支持语音识别' : 'This browser has no speech recognition';
  }
  });

  // ---------- 笔记（Obsidian 库直连：列表 / 读 / 改 / 建 / 双链 / 反向链接） ----------
  let NOTE_CUR = null;   // 当前打开的那一篇
  const noteCall = (pathname, body) => {
    const base = hostedOn() ? SERVER() : CFG.gatewayUrl;
    return gm({
      method: 'POST',
      url: base + pathname,
      headers: { 'Content-Type': 'application/json', 'bypass-tunnel-reminder': '1', ...(CFG.sbToken ? { Authorization: 'Bearer ' + CFG.sbToken } : {}) },
      data: JSON.stringify(body || {}),
      timeout: 20000,
    }).then(r => {
      let j = {};
      try { j = JSON.parse(r.responseText); } catch (_) {}
      if (r.status >= 200 && r.status < 300) return j;
      const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e;
    });
  };

  function noteListRow(item, depth = 0) {
    const row = document.createElement('div');
    row.className = 'memp-row';
    row.style.paddingLeft = (12 + depth * 12) + 'px';
    const t = document.createElement('div');
    t.className = 'memp-t';
    t.textContent = (item.type === 'dir' ? '📁 ' : '📄 ') + item.name;
    row.appendChild(t);
    if (item.type === 'dir') {
      row.onclick = () => openNoteDir(item.path);
    } else {
      const sub = document.createElement('div');
      sub.className = 'memp-sub';
      sub.textContent = item.path;
      row.appendChild(sub);
      row.onclick = () => openNote(item.path);
    }
    return row;
  }

  function paintNoteList(items, root) {
    const box = $('note-list');
    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = '<div class="memp-empty">这里还没有笔记。点底部「新建」，或者在对话里点 💾 把回答存成一篇。</div>';
      return;
    }
    const flat = [];
    const walk = (arr, depth) => arr.forEach(x => {
      if (x.type === 'dir') { flat.push({ ...x, depth }); walk(x.children || [], depth + 1); }
      else flat.push({ ...x, depth });
    });
    walk(items, 0);
    flat.slice(0, 300).forEach(x => box.appendChild(noteListRow(x, x.depth)));
    $('note-count').textContent = flat.filter(x => x.type === 'note').length;
    if (root) $('note-root').textContent = '· ' + (root === 'local' ? '本机库' : '我的库');
  }

  async function loadNotes() {
    try {
      const j = await noteCall('/vault/list', {});
      paintNoteList(j.notes || [], j.root);
    } catch (e) {
      $('note-list').innerHTML = '<div class="memp-empty">读不到笔记库：' + esc(e.message || String(e)) + '<br><br>' + (hostedOn() ? '检查服务器是否在线。' : '检查网关是否在跑（' + CFG.gatewayUrl + '）。') + '</div>';
    }
  }

  function openNoteDir(p) {
    noteCall('/vault/list', { dir: p }).then(j => paintNoteList(j.notes || [])).catch(() => {});
  }

  // 笔记正文：Markdown 里的结构都还原（标题/列表/引用/分隔线/任务框），再挂双链
  function renderNoteBody(body) {
    let src = String(body || '').replace(/^---\n[\s\S]*?\n---\n/, '');
    src = esc(src);
    src = src.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/^\w*\n/, '')}</pre>`);
    src = src.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    src = src.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<div class="nimg">🖼 $1 $2</div>');
    const lines = src.split('\n');
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const raw of lines) {
      const l = raw.trimEnd();
      const h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) { closeList(); out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`); continue; }
      if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(l)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + l.replace(/^\s*[-*]\s+\[([ xX])\]\s+/, (_, c) => (c === ' ' ? '☐ ' : '☑ ')) + '</li>');
        continue;
      }
      if (/^\s*[-*]\s+/.test(l)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + l.replace(/^\s*[-*]\s+/, '') + '</li>');
        continue;
      }
      if (/^\s*\d+\.\s+/.test(l)) {
        if (!inList) { out.push('<ol>'); inList = true; }
        out.push('<li>' + l.replace(/^\s*\d+\.\s+/, '') + '</li>');
        continue;
      }
      closeList();
      if (/^>\s?/.test(l)) { out.push('<blockquote>' + l.replace(/^>\s?/, '') + '</blockquote>'); continue; }
      if (/^---+$/.test(l.trim())) { out.push('<hr>'); continue; }
      if (!l.trim()) { out.push(''); continue; }
      out.push(`<p>${l}</p>`);
    }
    closeList();
    const html = out.join('\n');
    return html.replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_, name) => {
      const safe = name.replace(/"/g, '&quot;');
      return `<span class="nl" data-note="${safe}">${esc(name)}</span>`;
    });
  }

  async function openNote(path) {
    try {
      const n = await noteCall('/vault/read', { path });
      NOTE_CUR = n;
      const v = $('note-view');
      const back = (n.backlinks || []).length
        ? `<div class="nback">↩ 被 ${n.backlinks.length} 篇引用：` +
          n.backlinks.map(b => `<span class="nl" data-note="${esc(b.path.replace(/\.md$/, ''))}">${esc(b.title)}</span>`).join(' · ') + '</div>'
        : '<div class="nback">还没有别的笔记引用它。</div>';
      v.innerHTML = `<div class="nbar">
          <button data-act="back">← 列表</button>
          <button data-act="edit">✎ 编辑</button>
          <button data-act="append">＋ 追加</button>
          <button data-act="open-app">在 Obsidian 里打开</button>
          <button data-act="del" style="border-color:#7a3030;color:#e0a0a0">删除</button>
        </div>
        <div class="nmeta">${esc(n.path)} · ${n.size} 字</div>
        <div class="nbody">${renderNoteBody(n.body)}</div>${back}`;
      v.classList.add('on');
      $('note-list').style.display = 'none';
      $('note-foot').style.display = 'none';
      v.querySelectorAll('.nl').forEach(el => {
        el.onclick = () => {
          const t = el.getAttribute('data-note');
          if (!t) return;
          openNote(t.endsWith('.md') ? t : t + '.md');
        };
      });
      v.querySelector('[data-act="back"]').onclick = () => closeNoteView();
      v.querySelector('[data-act="edit"]').onclick = () => editNote(n, false);
      v.querySelector('[data-act="append"]').onclick = () => editNote(n, true);
      v.querySelector('[data-act="open-app"]').onclick = () => {
        bubble('a', LANG === 'zh'
          ? `这篇在磁盘上的位置：\n\n\`${n.path}\`\n\n在 Obsidian 里搜文件名就能打开；改完回来点 ↻ 刷新。`
          : `On disk:\n\n\`${n.path}\`\n\nOpen it in Obsidian by filename; hit ↻ here after you edit.`);
      };
      v.querySelector('[data-act="del"]').onclick = async () => {
        if (!confirm(LANG === 'zh' ? `删掉「${n.title}」？会先备份一份。` : `Delete "${n.title}"? A backup is kept.`)) return;
        try { await noteCall('/vault/delete', { path: n.path }); closeNoteView(); loadNotes(); }
        catch (e) { alert(e.message); }
      };
    } catch (e) {
      alert(LANG === 'zh' ? '打不开这一篇：' + e.message : 'Cannot open: ' + e.message);
    }
  }

  function closeNoteView() {
    $('note-view').classList.remove('on');
    $('note-view').innerHTML = '';
    $('note-list').style.display = '';
    $('note-foot').style.display = '';
    NOTE_CUR = null;
  }

  function editNote(n, appendMode) {
    const v = $('note-view');
    v.innerHTML = `<div class="nbar">
        <button data-act="save" style="border-color:#2f6fed;color:#a9c7ff">保存</button>
        <button data-act="cancel">取消</button>
      </div>
      <div class="nmeta">${esc(n.path)}${appendMode ? ' · 追加到末尾' : ''}</div>
      <textarea id="note-editor"></textarea>`;
    const ta = v.querySelector('#note-editor');
    ta.value = appendMode ? '' : (n.body || '');
    if (appendMode) ta.placeholder = LANG === 'zh' ? '写在末尾的内容…（自动空一行）' : 'Text to add at the end…';
    v.querySelector('[data-act="cancel"]').onclick = () => openNote(n.path);
    v.querySelector('[data-act="save"]').onclick = async () => {
      try {
        await noteCall('/vault/write', { path: n.path, body: ta.value, mode: appendMode ? 'append' : 'overwrite' });
        await openNote(n.path);
        loadNotes();
      } catch (e) { alert(e.message); }
    };
    ta.focus();
  }

  async function newNote(title, body) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const name = (title || (LANG === 'zh' ? '新笔记' : 'Untitled')).replace(/[\\/:*?"<>|]/g, '').slice(0, 60).trim() || 'note';
    const path = `${name}-${stamp}.md`;
    const content = body || `# ${title || name}\n\n`;
    await noteCall('/vault/write', { path, body: content });
    openNote(path);
    loadNotes();
  }

  function bindNotes() {
    $('notebtn').onclick = () => {
      const p = $('notep');
      const on = p.classList.toggle('on');
      $('memp').classList.remove('on');
      $('settings').classList.remove('on');
      if (on) loadNotes();
    };
    $('note-close').onclick = () => { $('notep').classList.remove('on'); closeNoteView(); };
    $('note-retitle').onclick = () => { closeNoteView(); loadNotes(); };
    $('note-new').onclick = async () => {
      const t = prompt(LANG === 'zh' ? '笔记标题' : 'Note title', '');
      if (t === null) return;
      try { await newNote(t.trim()); } catch (e) { alert(e.message); }
    };
    $('note-daily').onclick = async () => {
      try { const r = await noteCall('/vault/daily', {}); openNote(r.path); }
      catch (e) { alert(e.message); }
    };
    $('note-memo').onclick = async () => {
      const btn = $('note-memo');
      btn.disabled = true; btn.textContent = '生成中…';
      try {
        const r = await noteCall('/vault/memo', {});
        await openNote(r.path);
        $('note-q').value = '';
      } catch (e) { alert(e.message); }
      finally { btn.disabled = false; btn.textContent = '今日备忘录'; }
    };
    let timer = null;
    $('note-q').oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = $('note-q').value.trim();
        if (!q) return loadNotes();
        try {
          const j = await noteCall('/vault/search', { q, k: 20 });
          const box = $('note-list');
          box.innerHTML = '';
          if (!(j.hits || []).length) { box.innerHTML = '<div class="memp-empty">没搜到。换个词试试，或者去「今天」记一条。</div>'; return; }
          j.hits.forEach(h => {
            const row = document.createElement('div');
            row.className = 'memp-row';
            row.innerHTML = `<div class="memp-t">📄 ${esc(h.title)}</div><div class="memp-sub">${esc(h.path)}</div><div class="memp-ex">${esc(h.excerpt || '')}</div>`;
            row.onclick = () => openNote(h.path);
            box.appendChild(row);
          });
        } catch (e) { /* 搜索失败不炸面板 */ }
      }, 300);
    };
  }

  // 把一条回答存成笔记
  async function saveAnswerAsNote(meta) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const title = (meta.q || '对话').replace(/[\\/:*?"<>|]/g, '').slice(0, 50).trim();
    const path = `${title}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.md`;
    const body = [
      '---',
      `created: ${d.toISOString().slice(0, 19).replace('T', ' ')}`,
      `source: ${location.href}`,
      `channel: ${meta.channel || ''}`,
      'tags: [sidebrain]',
      '---',
      '',
      `# ${meta.q || '对话记录'}`,
      '',
      meta.text || '',
      '',
      `> 来源：${document.title || location.href}`,
      '',
    ].join('\n');
    await noteCall('/vault/write', { path, body });
    bubble('a', LANG === 'zh' ? `存好了：\`${path}\`\n\n点 🗒 就能看到，也能改。` : `Saved as \`${path}\`. Open 🗒 to edit it.`);
  }

  // ---------- 附件：图片 / 文本文件（粘贴、拖拽、选文件三条路都通） ----------
  const ATT = { image: null, files: [] };   // image: {dataUrl, mime}; files: [{name, text}]
  const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|css|html|xml|yml|yaml|sh|toml|ini)$/i;
  const MAX_TEXT = 60000;

  function paintAtt() {
    const box = $('att');
    if (!box) return;
    box.innerHTML = '';
    if (ATT.image) {
      const c = document.createElement('div');
      c.className = 'chip';
      const im = document.createElement('img');
      im.src = ATT.image.dataUrl;
      c.appendChild(im);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = '图片';
      c.appendChild(nm);
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
      x.onclick = () => { ATT.image = null; paintAtt(); };
      c.appendChild(x);
      box.appendChild(c);
    }
    ATT.files.forEach((f, i) => {
      const c = document.createElement('div');
      c.className = 'chip';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = f.name;
      c.appendChild(nm);
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
      x.onclick = () => { ATT.files.splice(i, 1); paintAtt(); };
      c.appendChild(x);
      box.appendChild(c);
    });
    box.classList.toggle('on', !!(ATT.image || ATT.files.length));
  }

  // 大图先缩一下：手机上截的图动辄 4MB，直接送会又慢又贵
  function shrinkImage(dataUrl, mime, cb) {
    const img = new Image();
    img.onload = () => {
      const MAX = 1400;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      if (scale >= 1 && dataUrl.length < 900000) return cb(dataUrl);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      try { cb(cv.toDataURL(mime === 'image/png' ? 'image/png' : 'image/jpeg', 0.85)); } catch (_) { cb(dataUrl); }
    };
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
  }

  function takeFile(file) {
    if (!file) return;
    if (/^image\//.test(file.type)) {
      const fr = new FileReader();
      fr.onload = () => {
        shrinkImage(String(fr.result), file.type, out => {
          const m = /^data:([^;]+);/.exec(out) || [];
          ATT.image = { dataUrl: out, mime: m[1] || file.type || 'image/png' };
          paintAtt();
        });
      };
      fr.readAsDataURL(file);
      return;
    }
    if (TEXT_EXT.test(file.name) || /^text\//.test(file.type) || /json/.test(file.type)) {
      const fr = new FileReader();
      fr.onload = () => {
        let txt = String(fr.result);
        const cut = txt.length > MAX_TEXT;
        if (cut) txt = txt.slice(0, MAX_TEXT);
        ATT.files.push({ name: file.name + (cut ? '（截到 6 万字符）' : ''), text: txt });
        paintAtt();
      };
      fr.readAsText(file);
      return;
    }
    bubble('a', LANG === 'zh'
      ? '这个文件类型我读不了（PDF 里是排版不是文字）。图片、文本、代码、CSV、JSON 都可以；PDF 的话截个图给我更快。'
      : "I can't read that format (PDFs are layout, not text). Images, text, code, CSV and JSON work — screenshot the PDF instead.");
  }

  function bindAttach() {
    const pick = $('filepick'), btn = $('filebtn');
    if (btn && pick) {
      btn.onclick = () => pick.click();
      pick.onchange = () => { [...pick.files].forEach(takeFile); pick.value = ''; };
    }
    input.addEventListener('paste', e => {
      const items = [...((e.clipboardData && e.clipboardData.items) || [])];
      const img = items.find(i => i.kind === 'file' && /^image\//.test(i.type));
      const txt = items.find(i => i.kind === 'file' && (TEXT_EXT.test(i.type) || /text/.test(i.type)));
      if (img) { e.preventDefault(); takeFile(img.getAsFile()); }
      else if (txt) { e.preventDefault(); takeFile(txt.getAsFile()); }
    });
    const panel = $('panel');
    panel.addEventListener('dragover', e => { e.preventDefault(); });
    panel.addEventListener('drop', e => {
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      if (!files.length) return;
      e.preventDefault();
      files.forEach(takeFile);
    });
  }

  // ---------- 账号：注册 / 订阅 / 断开 ----------
  const acctGo = $('acct-go');
  if (acctGo) acctGo.addEventListener('click', async () => {
    const mail = ($('acct-mail').value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { $('acct-state').textContent = LANG === 'zh' ? '邮箱看起来不对，再检查一下。' : 'That email looks off — check it again.'; return; }
    acctGo.disabled = true;
    $('acct-state').textContent = LANG === 'zh' ? '正在开通…' : 'Setting up…';
    try {
      const r = await serverCall('/account/signup', { method: 'POST', body: { email: mail } });
      CFG.sbToken = r.token; CFG.hosted = true;
      await GM.setValue('sbToken', r.token);
      await GM.setValue('hosted', true);
      await GM.setValue('acctEmail', mail);
      ACCT = r;
      await refreshAcct();
      $('settings').classList.remove('on');
      bubble('a', LANG === 'zh'
        ? `好了，7 天免费试用已经开通（到 ${String(r.trialEndsAt).slice(0, 10)}）。\n\n直接问就行 —— 用哪个模型不用你管，服务器会挑当下最省、够用的那条。`
        : `You're in — 7-day trial active until ${String(r.trialEndsAt).slice(0, 10)}.\n\nJust ask. You don't pick a model; the server picks the cheapest one that's good enough.`);
    } catch (e) {
      $('acct-state').textContent = (LANG === 'zh' ? '没开通成功：' : 'Failed: ') + (e.message || e);
    } finally { acctGo.disabled = false; }
  });

  const acctSub = $('acct-sub');
  if (acctSub) acctSub.addEventListener('click', () => {
    bubble('a', LANG === 'zh'
      ? '订阅页还在搭（Stripe 还没接）。这段时间试用可以续，直接回我一句「续试用」就行。'
      : "The subscribe page isn't up yet (Stripe pending). For now trials can be extended — just ask.");
  });

  const acctOut = $('acct-out');
  if (acctOut) acctOut.addEventListener('click', async () => {
    CFG.sbToken = '';
    await GM.setValue('sbToken', '');
    ACCT = null;
    await refreshAcct();
    bubble('a', LANG === 'zh' ? '这台设备断开了。要再连回来，填回原来的邮箱就行。' : 'Disconnected. Re-enter the same email to reconnect.');
  });

  $('save').onclick = async () => {
    CFG.deepseekKey = $('k-deepseek').value.trim();
    CFG.openrouterKey = $('k-openrouter').value.trim();
    CFG.geminiKey = $('k-gemini').value.trim();
    CFG.geminiKey2 = $('k-gemini2').value.trim();
    CFG.geminiKey3 = $('k-gemini3').value.trim();
    CFG.anthropicKey = $('k-anthropic').value.trim();
    CFG.geminiModel = $('m-gemini').value.trim() || DEFAULTS.geminiModel;
    CFG.geminiLongModel = $('m-geminilong').value.trim() || DEFAULTS.geminiLongModel;
    CFG.anthropicModel = $('m-claude').value.trim() || DEFAULTS.anthropicModel;
    CFG.ollamaModel = $('m-ollama').value.trim() || DEFAULTS.ollamaModel;
    CFG.ollamaUrl = $('u-ollama').value.trim() || DEFAULTS.ollamaUrl;
    CFG.subChatGPT = $('c-chatgpt').checked;
    CFG.subClaude = $('c-claude').checked;
    CFG.tinySpend = $('c-tiny').checked;
    CFG.groqKey = $('k-groq').value.trim();
    CFG.groqKey2 = $('k-groq2').value.trim();
    CFG.groqModel = $('m-groq').value.trim() || DEFAULTS.groqModel;
    CFG.cfAccount = $('k-cfid').value.trim();
    CFG.cfToken = $('k-cftoken').value.trim();
    CFG.cfModel = $('m-cf').value.trim() || DEFAULTS.cfModel;
    CFG.orFreeModels = $('m-orfree').value.trim() || DEFAULTS.orFreeModels;
    await GM.setValue('cfg', CFG);
    $('settings').classList.remove('on');
    bubble('a', '已保存。key 只在本机。');
  };

  // ---------- 发送 ----------
  async function send() {
    if (busy) return;
    let text = input.value.trim();
    const hasAtt = !!(ATT.image || ATT.files.length);
    if (!text && !hasAtt) return;
    if (!text && hasAtt) text = ATT.image ? '看看这张图，说说看到什么、有什么要注意的。' : '看看这个文件，说说写了什么、有什么问题。';
    const forceSearch = /^\/(s|search)\s+/i.test(text);
    if (forceSearch) text = text.replace(/^\/(s|search)\s+/i, '').trim();
    if (!text) return;

    // 说“换个模型”时不要花钱去问模型自己，直接给切模型的入口
    const SWITCH = /^(换个?一?个?模型|切换模型|换模型|模型换一下|换个?别的模型)/;
    if (SWITCH.test(text)) {
      bubble('u', text);
      const sel = $('model');
      const opts = [...sel.options].map(o => `· ${o.textContent}  →  ${o.value}`).join('\n');
      bubble('a', `模型在顶栏那个下拉里选，当前是：${sel.options[sel.selectedIndex].textContent}\n\n可用：\n${opts}`);
      return;
    }

    // 先把消息上屏，用户立刻看得见反应，后面慢也不会像“按钮坏了”
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';
    $('settings').classList.remove('on');
    const ub = bubble('u', text);
    if (ATT.image) {
      const im = document.createElement('img');
      im.className = 'attimg';
      im.src = ATT.image.dataUrl;
      ub.insertBefore(im, ub.firstChild);
    }
    ATT.files.forEach(f => {
      const t = document.createElement('div');
      t.className = 'tag';
      t.textContent = '📄 ' + f.name;
      ub.appendChild(t);
    });
    const sentImage = ATT.image ? { dataUrl: ATT.image.dataUrl, mime: ATT.image.mime } : null;
    const sentFiles = ATT.files.slice();
    ATT.image = null; ATT.files = []; paintAtt();
    if (sentFiles.length) {
      text += '\n\n' + sentFiles.map(f => `<附件 文件名="${f.name}">\n${f.text}\n</附件>`).join('\n');
    }
    history.push({ role: 'user', content: text });

    const b = bubble('a', '…');
    let answer = '';
    const paint = () => { b.innerHTML = md(answer || '…'); msgs.scrollTop = msgs.scrollHeight; };

    let used = null, lastErr = null;
    let searchNote = '';
    const t0 = Date.now();
    const sources = [];
    let route = null;
    try {
      lastContext = readPage();

      // 需要新鲜事实就先搜（免费、本地网关），搜不到不拦路
      searchBlock = '';
      const notes = [];

      // ① 本地 Obsidian 笔记库（只读，约 120ms）——每轮都查
      if (SEARCH_ON && !hostedOn()) {
        try {
          const nr = await gm({
            method: 'POST',
            url: `${CFG.gatewayUrl}/notes`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ q: text.slice(0, 120), k: 3 }),
            timeout: 5000,
          });
          const nj = JSON.parse(nr.responseText);
          if (nj.hits && nj.hits.length) {
            searchBlock += `以下是本地笔记库（Obsidian）里与问题相关的段落，可当背景用（引用时给出路径）：\n` +
              nj.hits.map((h, i) => `[笔记${i + 1}] ${h.title}\n路径：${h.path}\n${h.excerpt}`).join('\n\n') + '\n\n';
            notes.push(`笔记${nj.hits.length}条`);
            nj.hits.slice(0, 5).forEach(h => sources.push({ title: h.title, path: h.path }));
          }
        } catch (_) { /* 笔记检索失败不管 */ }
      }

      // ①b 长期记忆（CortexDB，只读；没命中就不占上下文）
      if (SEARCH_ON && (forceSearch || NEEDS_RECALL.test(text))) {
        try {
          const mr = await gm({
            method: 'POST',
            url: `${CFG.gatewayUrl}/recall`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ q: text.slice(0, 200), maxTokens: 700 }),
            timeout: 6000,
          });
          const mj = JSON.parse(mr.responseText);
          if (mj.count && mj.context_block) {
            searchBlock += `以下是本地长期记忆（CortexDB，${mj.scope}）里的相关事件，带时间戳，可作为背景：\n${mj.context_block}\n\n`;
            notes.push(`记忆${mj.count}条`);
          }
        } catch (_) { /* 记忆检索失败不管 */ }
      }

      // ①c 自己看过的网页（浏览即记，本机向量检索）
      if (MEMORY_ON && (forceSearch || NEEDS_RECALL.test(text) || /(看过|读过|浏览|上次|之前|找过|记得)/.test(text))) {
        try {
          const pr = await gm({
            method: 'POST',
            url: `${CFG.gatewayUrl}/memory/search`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ q: text.slice(0, 200), k: 3 }),
            timeout: 8000,
          });
          const pj = JSON.parse(pr.responseText);
          const hits = (pj.hits || []).filter(h => h.score > 0.45);
          if (hits.length) {
            searchBlock += `以下是用户自己在这台电脑上看过的网页（浏览即记，按相似度排序，可当事实来源，引用时给出日期和域名）：\n` +
              hits.map((h, i) => `[看过${i + 1}] ${h.title}\n${h.url}\n记于 ${String(h.at).slice(0, 10)}｜相似度 ${h.score}\n${h.excerpt}`).join('\n\n') + '\n\n';
            notes.push(`看过的${hits.length}条`);
            hits.forEach(h => sources.push({ title: h.title, url: h.url }));
          }
        } catch (_) { /* 记忆检索失败不拦路 */ }
      }

      // ② 需要新鲜事实才走免费网页搜索
      if (SEARCH_ON && (forceSearch || NEEDS_FRESH.test(text))) {
        b.innerHTML = '<span style="opacity:.5">搜索中…</span>';
        try {
          const sr = await gm({
            method: 'POST',
            url: `${CFG.gatewayUrl}/search`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ q: text.slice(0, 200), fetchPages: 2 }),
            timeout: 20000,
          });
          const sj = JSON.parse(sr.responseText);
          if (sj.results && sj.results.length) {
            searchBlock += `以下是刚搜到的网页结果（本地免费搜索，${new Date().toLocaleString('zh-CN')}，引用时说清来源域名）：\n` +
              sj.results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${x.snippet}${x.text ? '\n正文节选：' + x.text : ''}`).join('\n\n') + '\n\n';
            notes.push(`搜索${sj.results.length}条`);
            sj.results.slice(0, 6).forEach(x => sources.push({ title: x.title, url: x.url }));
          }
        } catch (e) {
          // 搜索是增强项，失败就不出声，别把技术噪音塞给用户
        }
        b.innerHTML = md('…');
      }
      searchNote = notes.join(' · ');

      let chainList = [];
      const autoMode = ['auto', 'auto-s', 'auto-q', 'auto-b', 'gateway'].includes(MODEL_CHOICE);

      // === 托管模式：全部交给服务器，客户端不碰任何 key ===
      if (hostedOn()) {
        b.innerHTML = '<span style="opacity:.5">思考中…</span>';
        const ctxMsgs = history.slice(-HISTORY_TURNS * 2).filter(m => m.content);
        const page = { title: document.title || '', text: (lastContext || '').slice(0, 6000) };
        let r;
        try {
          r = await serverCall('/v1/chat', {
            method: 'POST',
            body: {
              messages: ctxMsgs.map(m => ({ role: m.role, content: m.content })),
              image: sentImage,
              files: sentFiles.map(f => ({ name: f.name, text: f.text })),
              url: location.href,
              page,
              system: getSystem() + (searchBlock ? '\n\n' + searchBlock : ''),
            },
          });
        } catch (e) {
          b.className = 'm err';
          if (e.status === 402) {
            b.innerHTML = md('免费试用结束了。\n\n继续用需要订阅（$8/月，也可以先申请延长试用）：\n[点这里订阅](https://buzzmartglobal-art.github.io/sidebrain/join)');
            const t = document.createElement('div');
            t.className = 'tag';
            t.textContent = '试用已结束';
            b.appendChild(t);
          } else if (e.status === 429) {
            b.innerHTML = md('今天的免费额度用完了，明天零点恢复。\n\n急用的话可以等一会儿再试，或者自己填一个 key（设置 → 高级）。');
          } else if (e.status === 401) {
            b.innerHTML = md('这个设备的登录失效了。\n\n点 ⚙︎ → 「用邮箱重新连接」。');
          } else {
            b.textContent = '出错：' + (e.message || e);
          }
          return;
        }
        answer = r.text || '';
        used = { p: r.channel || 'server', m: r.model || '', why: '服务器自动选（' + (r.tier === 'free' ? '免费额度' : r.tier === 'paid' ? '付费兜底' : '本机') + '）' };
        route = { kind: r.kind || 'simple', level: r.level || 2, src: 'server', ms: 0 };
        chainList = (r.tried || []).map(t => ({ m: t.label }));
        b.innerHTML = md(answer || '(空回复)');
        const tag0 = document.createElement('div');
        tag0.className = 'tag';
        tag0.textContent = `${r.channel || '服务器'} · ${r.model || ''}${searchNote ? ' · ' + searchNote : ''}${r.saved ? ' · 已入库' : ''}`;
        b.appendChild(tag0);
        addFooter(b, {
          q: text, text: answer, channel: r.channel || 'server', model: r.model || '',
          why: used.why, kind: route.kind, level: route.level, routeSrc: 'server', routeMs: null,
          ms: Date.now() - t0, sources, searchNote, cost: '—',
          chain: [r.channel || 'server', ...(r.tried || []).map(x => x.label)],
        });
        history.push({ role: 'assistant', content: answer });
        if (PRO_ON && MEMORY_ON) {
          gm({
            method: 'POST',
            url: `${CFG.gatewayUrl}/memory/chat`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ q: text, a: answer, url: location.href, title: document.title || '', channel: `${r.channel} · ${r.model}`, kind: route.kind, level: route.level, ms: Date.now() - t0 }),
            timeout: 12000,
          }).catch(() => {});
        }
        return;
      }

      if (autoMode) {
        const decided = await decideChain(text);
        route = decided.route;
        chainList = dedupeChain(decided.list);
      } else {
        const manual = pick(text);
        route = { kind: heuristicKind(text, lastContext), src: 'manual', ms: 0 };
        chainList = dedupeChain([manual, ...chainFor(route.kind, 'free')]);
      }
      chainList = applyFeedback(chainList, route ? route.kind : 'simple', route ? route.level : 2);
      if (!chainList.length) {
        b.className = 'm err';
        b.textContent = '还没有可用通道：点右上齿轮填一个 key；' +
          (MODEL_CHOICE === 'chatgpt-sub' || MODEL_CHOICE === 'claude-sub'
            ? '这个订阅通道现在是关闭的，在齿轮里勾上「使用我的…订阅额度」。'
            : '订阅通道要走的话，也在齿轮里自己勾上。');
        return;
      }

      for (const c of chainList) {
        answer = '';
        try {
          await streamCall(c, text, chunk => { answer += chunk; paint(); }, n => {
            b.innerHTML = `<span style="opacity:.5">思考中… ${n} 字</span>`;
            msgs.scrollTop = msgs.scrollHeight;
          });
          used = c;
          break;
        } catch (e) {
          lastErr = e;
          // 流式被挡（CSP）→ 同一家用非流式再试一次
          if (e instanceof HTTPError && e.status === 0) {
            try {
              answer = await callModelPlain(c, text);
              used = c;
              break;
            } catch (e2) { lastErr = e2; }
          } else if (e instanceof HTTPError && e.status === 400 && /非流式/.test(e.message)) {
            try {
              answer = await callModelPlain(c, text);
              used = c;
              break;
            } catch (e2) { lastErr = e2; }
          }
          // 额度用完 / 限流 → 这条通道进入冷却，这一轮和接下来 20 分钟都不再先撞它
          if (lastErr instanceof HTTPError && lastErr.status === 429) markDead(c, lastErr.message);
          if (!canFallback(lastErr)) break;
        }
      }

      if (used) {
        b.innerHTML = md(answer || '(空回复)');
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.textContent = `${used.p} · ${used.m} · ${used.why}${searchNote ? ' · ' + searchNote : ''}`;
        b.appendChild(tag);
        const inChars = (lastContext || '').length + text.length + (searchBlock || '').length;
        addFooter(b, {
          q: text,
          text: answer,
          channel: used.p,
          model: used.m,
          why: used.why,
          kind: route ? route.kind : '—',
          level: route ? route.level : null,
          routeSrc: route ? route.src : null,
          routeMs: route ? route.ms : null,
          ms: Date.now() - t0,
          sources,
          searchNote,
          cost: estCost(used, inChars, answer.length),
          chain: chainList.map(c => c.m),
        });
        history.push({ role: 'assistant', content: answer });
        // 对话即记：这一轮问了什么、谁答的、答了什么，都进本机记忆
        if (PRO_ON && MEMORY_ON) {
          gm({
            method: 'POST',
            url: `${CFG.gatewayUrl}/memory/chat`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
              q: text, a: answer,
              url: location.href, title: document.title || '',
              channel: `${used.p} · ${used.m}`, kind: route ? route.kind : '', level: route ? route.level : 0,
              ms: Date.now() - t0,
            }),
            timeout: 12000,
          }).catch(() => {});
        }
      } else {
        b.className = 'm err';
        b.textContent = `出错：${lastErr ? lastErr.message : '未知错误'}`;
      }
    } catch (e) {
      b.className = 'm err';
      b.textContent = `出错：${e && e.message ? e.message : e}`;
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  }

  // ---------- 启动 ----------
  (async () => {
    try {
      const saved = await GM.getValue('cfg', null);
      if (saved) {
        CFG = { ...DEFAULTS, ...saved };
        // 空值不该盖掉预置默认值（否则之前点过保存就会把预置 key 抹掉）
        for (const k of Object.keys(DEFAULTS)) {
          if ((CFG[k] === '' || CFG[k] == null) && DEFAULTS[k] !== '') CFG[k] = DEFAULTS[k];
        }
      }
      if (saved && saved.lang && saved.lang !== LANG && LANGS.some(([c]) => c === saved.lang)) LANG = saved.lang;
      // 托管模式的登录令牌单独存（不随 cfg 一起被覆盖）
      const tk = await GM.getValue('sbToken', '');
      if (tk) CFG.sbToken = tk;
      const m = await GM.getValue('model', 'auto');
      MODEL_CHOICE = m || 'auto-b';
      if (MODEL_CHOICE === 'gateway' || MODEL_CHOICE === 'auto') MODEL_CHOICE = 'auto-b'; // 旧默认并入平衡档
      if (![...$('model').options].some(o => o.value === MODEL_CHOICE)) MODEL_CHOICE = 'auto';
      $('model').value = MODEL_CHOICE;
      VOTES = (await GM.getValue('votes', {})) || {};
      seedVotes();
      MEMORY_ON = (await GM.getValue('memoryOn', true)) !== false;
      $('memobtn').classList.toggle('off', !MEMORY_ON);
      SEARCH_ON = (await GM.getValue('searchOn', true)) !== false;
      $('searchbtn').classList.toggle('off', !SEARCH_ON);
      // 老版本存过的已下线模型名 → 强制纠正
      const DEAD = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-pro-latest'];
      if (DEAD.includes(CFG.geminiModel)) CFG.geminiModel = DEFAULTS.geminiModel;
      if (DEAD.includes(CFG.geminiLongModel)) CFG.geminiLongModel = DEFAULTS.geminiLongModel;
      await GM.setValue('cfg', CFG);
      panel.style.setProperty('--w', (CFG.panelWidth || 400) + 'px');
    } catch (_) { /* 忽略 */ }
    fillSettings();
  })();
})();
