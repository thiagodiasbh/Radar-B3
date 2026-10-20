#!/usr/bin/env node
// Radar B3 — robô diário (GitHub Actions). Node 20+, sem dependências.
// Fluxo: coleta brapi (1 chamada por ativo, sequencial) → acumula histórico → score (RadarCore)
//        → compara com ontem → alerta só o que mudou → IA resume notícias dos ativos que mudaram → Telegram.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require('./radar-core.js');

const ENV = process.env;
const DATA = ENV.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dados');
const DRY = ENV.DRY_RUN === '1';
const FORCE = ENV.FORCE === '1';
const BRAPI_RANGE = ENV.BRAPI_RANGE || '3mo';            // plano grátis: até 3 meses
const MODEL = ENV.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MAX_BARS = 300;
const BENCH = 'BOVA11';
const TZ = 'America/Sao_Paulo';
const log = (...a) => console.log('[radar]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const diaBR = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });          // YYYY-MM-DD
const ddmm = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const R$ = v => v == null ? '—' : 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pc = (v, d = 1) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d).replace('.', ',') + '%';

function readJSON(f, def) { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return def; } }
function writeJSON(f, v) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 1)); }

async function fetchT(url, opt = {}, ms = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// ---------------- configuração ----------------
function loadConfig() {
  let raw = ENV.RADAR_CONFIG;
  if (!raw && fs.existsSync(path.join(DATA, '..', 'radar-config.json'))) raw = fs.readFileSync(path.join(DATA, '..', 'radar-config.json'), 'utf8');
  if (!raw) throw new Error('RADAR_CONFIG não definido (cole o JSON exportado do painel no Secret RADAR_CONFIG).');
  const c = JSON.parse(raw);
  const watch = (c.watchlist || c.tickers || []).map(x => typeof x === 'string' ? { ticker: x } : x)
    .map(x => ({ ticker: String(x.ticker).toUpperCase(), alvo: x.alvo ?? x.target ?? null }));
  const pos = (c.posicoes || []).map(p => ({ ...p, ticker: String(p.ticker).toUpperCase() }));
  return {
    watch, pos,
    margem: c.margemAlvoPct ?? 15,
    tune: c.score ? { w: c.score.weights, fav: c.score.favorable, neu: c.score.neutral } : undefined,
    quedaDiaPct: c.quedaDiaPct ?? 4,
    enviarSemMudancas: !!c.enviarSemMudancas,
  };
}

// ---------------- coleta ----------------
async function brapi(sym) {
  const tok = ENV.BRAPI_TOKEN;
  if (!tok) throw new Error('BRAPI_TOKEN ausente');
  // o GitHub Actions mascara o valor do Secret em qualquer log, e a URL não é impressa
  const url = `https://brapi.dev/api/quote/${encodeURIComponent(sym)}?range=${BRAPI_RANGE}&interval=1d&fundamental=true&token=${encodeURIComponent(tok)}`;
  for (let tent = 1; tent <= 3; tent++) {
    try {
      const r = await fetchT(url);
      if (r.status === 429) { await sleep(3000 * tent); continue; }
      if (r.status === 401 || r.status === 403) throw new Error('token brapi recusado (HTTP ' + r.status + ')');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const js = await r.json();
      const q = js.results && (js.results.find(x => x.symbol === sym) || js.results[0]);
      if (!q || !q.historicalDataPrice || !q.historicalDataPrice.length) throw new Error('sem histórico');
      return q;
    } catch (e) {
      if (/token brapi/.test(e.message) || tent === 3) throw e;
      await sleep(1500 * tent);
    }
  }
  throw new Error('limite de requisições (429)');
}
function mergeBars(prev, q) {
  const by = {};
  for (const b of prev || []) by[b.d] = b;
  for (const x of q.historicalDataPrice) {
    const c = +x.close; if (!(c > 0) || !x.date) continue;
    const d = diaBR(new Date(x.date * 1000));
    by[d] = { d, o: +x.open || null, h: +x.high || null, l: +x.low || null, c, v: +x.volume || null };
  }
  return Object.values(by).sort((a, b) => a.d < b.d ? -1 : 1).slice(-MAX_BARS);
}

// ---------------- análise ----------------
function analyze(tk, bars, q, bench, cfg) {
  const closes = bars.map(b => b.c);
  const ind = Core.indicators(closes, { px: q.regularMarketPrice ?? closes.at(-1), hi52: q.fiftyTwoWeekHigh, lo52: q.fiftyTwoWeekLow });
  const sc = Core.buyScore(ind, cfg.tune);
  const lb = Core.scoreLabel(sc.total, cfg.tune);
  const a = Core.atr(bars.map(b => ({ h: b.h, l: b.l, c: b.c })), 14);
  const bc = bench ? bench.map(b => b.c) : null;
  return {
    tk, nome: q.longName || q.shortName || tk, d: bars.at(-1).d, px: ind.px, chg: q.regularMarketChangePercent ?? null,
    ind, score: sc.total, items: sc.items, label: lb.key, labelTxt: lb.txt,
    flags: Core.riskFlags(ind, bars.length), nBars: bars.length,
    atr: a, stopAtr: a ? ind.px - 2 * a : null,
    rs21: bc ? Core.relStrength(closes, bc, 21) : null, rs63: bc ? Core.relStrength(closes, bc, 63) : null,
  };
}
function snap(a, cfg, alvo, pos) {
  const mg = (cfg.margem ?? 15) / 100;
  const s = {
    score: a.score, label: a.label, px: a.px,
    mm200: a.ind.mm200 == null ? null : a.px >= a.ind.mm200 ? 'acima' : 'abaixo',
    cruz: a.ind.mm21 == null || a.ind.mm50 == null ? null : a.ind.mm21 > a.ind.mm50 ? 'alta' : 'baixa',
    rsiZ: a.ind.rsi == null ? null : a.ind.rsi <= 30 ? 'sobrevendido' : a.ind.rsi >= 70 ? 'sobrecomprado' : 'neutro',
  };
  if (alvo) s.alvo = a.px <= alvo ? 'hit' : a.px <= alvo * (1 + mg) ? 'near' : 'far';
  if (pos) {
    if (pos.meta) s.meta = a.px >= pos.meta ? 'hit' : 'far';
    if (pos.stop) s.stop = a.px <= pos.stop ? 'hit' : 'far';
  }
  return s;
}
const LBL = { fav: 'FAVORÁVEL', neu: 'NEUTRO', des: 'DESFAVORÁVEL' };
function events(a, now, before, ctx) {
  const ev = [];
  const b = before || {};
  const add = (prio, txt) => ev.push({ prio, txt });
  if (ctx.watch) {
    if (b.label && b.label !== now.label) add(now.label === 'fav' ? 3 : 2, `termômetro ${LBL[b.label]} → ${LBL[now.label]} (${b.score} → ${now.score})`);
    if (now.alvo && b.alvo !== now.alvo && now.alvo !== 'far') add(3, now.alvo === 'hit' ? `🎯 no seu alvo de compra (${R$(ctx.alvo)})` : `👀 a ${pc(100 * (a.px - ctx.alvo) / ctx.alvo)} do alvo de compra (${R$(ctx.alvo)})`);
  }
  if (ctx.pos) {
    if (now.meta === 'hit' && b.meta !== 'hit') add(3, `🏁 atingiu sua meta de venda (${R$(ctx.pos.meta)})`);
    if (now.stop === 'hit' && b.stop !== 'hit') add(3, `🛑 abaixo do seu stop (${R$(ctx.pos.stop)})`);
  }
  if (a.chg != null && a.chg <= -Math.abs(ctx.quedaDiaPct)) add(2, `queda de ${pc(a.chg)} no dia`);
  if (b.mm200 && now.mm200 && b.mm200 !== now.mm200) add(2, now.mm200 === 'acima' ? 'voltou para cima da MM200' : 'perdeu a MM200');
  if (b.cruz && now.cruz && b.cruz !== now.cruz) add(1, now.cruz === 'alta' ? 'MM21 cruzou para cima da MM50' : 'MM21 cruzou para baixo da MM50');
  if (b.rsiZ && now.rsiZ && b.rsiZ !== now.rsiZ && now.rsiZ !== 'neutro') add(1, `RSI entrou em zona de ${now.rsiZ} (${a.ind.rsi.toFixed(0)})`);
  return ev;
}

// ---------------- placar do score (o sinal FAVORÁVEL funciona?) ----------------
function outcomes(sinais, hist) {
  const H = [5, 10, 20]; const res = { 5: [], 10: [], 20: [] };
  for (const s of sinais) {
    const bars = hist[s.tk]; const bb = hist[BENCH];
    if (!bars) continue;
    const i = bars.findIndex(b => b.d === s.d); if (i < 0) continue;
    for (const h of H) {
      if (i + h >= bars.length) continue;
      const r = (bars[i + h].c / bars[i].c - 1) * 100;
      let rb = null;
      if (bb) { const j = bb.findIndex(b => b.d === s.d); if (j >= 0 && j + h < bb.length) rb = (bb[j + h].c / bb[j].c - 1) * 100; }
      res[h].push({ r, ex: rb == null ? null : r - rb });
    }
  }
  return H.map(h => {
    const v = res[h]; if (!v.length) return null;
    const avg = v.reduce((s, x) => s + x.r, 0) / v.length;
    const ex = v.filter(x => x.ex != null); const avgEx = ex.length ? ex.reduce((s, x) => s + x.ex, 0) / ex.length : null;
    return { h, n: v.length, acerto: 100 * v.filter(x => x.r > 0).length / v.length, avg, avgEx };
  }).filter(Boolean);
}

// ---------------- notícias + IA ----------------
function decodeXml(s) { return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(); }
async function headlines(tk, nome) {
  const nomeCurto = (nome || '').replace(/\s+(S\.?A\.?|SA|ON|PN|UNT|N\d|NM|EDJ|ED|EJ).*$/i, '').trim();
  const q = encodeURIComponent(`${tk}${nomeCurto && nomeCurto !== tk ? ` OR "${nomeCurto}"` : ''} when:3d`);
  try {
    const r = await fetchT(`https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`, {}, 10000);
    if (!r.ok) return [];
    const xml = await r.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(m => {
      const g = t => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decodeXml(x[1]) : ''; };
      return { titulo: g('title'), fonte: g('source'), data: g('pubDate') ? diaBR(new Date(g('pubDate'))) : '' };
    }).filter(x => x.titulo);
  } catch { return []; }
}
async function aiComment(items) {
  const key = ENV.ANTHROPIC_API_KEY;
  if (!key || !items.length) return null;
  const system = 'Você é um assistente de acompanhamento de ações da B3 para um investidor pessoa física. Escreva em português do Brasil, direto e curto. ' +
    'Use SOMENTE os dados e manchetes recebidos: não invente preços, fatos, datas, notícias ou probabilidades. ' +
    'Separe o que é dado (indicador, manchete) do que é interpretação. Nunca dê ordem de compra ou venda nem recomendação. ' +
    'Se as manchetes não explicam o movimento, diga que não há notícia que explique. Texto puro, sem markdown, sem asteriscos.';
  const user = 'Para cada ativo abaixo, escreva no máximo 3 linhas: (1) o que mudou, em linguagem simples; (2) se alguma manchete ajuda a explicar, citando a fonte; ' +
    '(3) o principal risco ou o que confirmaria/invalidaria a leitura. Comece cada bloco com o ticker seguido de dois-pontos.\n\nDADOS:\n' + JSON.stringify(items);
  try {
    const r = await fetchT('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] }),
    }, 90000);
    const js = await r.json();
    if (!r.ok) { log('IA indisponível:', r.status, js.error && js.error.message); return null; }
    return (js.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim() || null;
  } catch (e) { log('IA falhou:', e.message); return null; }
}

// ---------------- Telegram ----------------
function chunks(text, max = 3800) {
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out.map((c, i) => out.length > 1 ? `${c}\n\n(${i + 1}/${out.length})` : c);
}
async function telegram(text) {
  if (DRY) { console.log('\n======== MENSAGEM (dry run) ========\n' + text + '\n===================================='); return; }
  const tok = ENV.TELEGRAM_BOT_TOKEN, chat = ENV.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { log('Telegram não configurado — mensagem só no log'); console.log(text); return; }
  for (const part of chunks(text)) {
    const r = await fetchT(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: part, disable_web_page_preview: true }),
    });
    if (!r.ok) throw new Error('Telegram HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    await sleep(400);
  }
}

// ---------------- principal ----------------
async function main() {
  const cfg = loadConfig();
  const hoje = ENV.HOJE || diaBR(); // HOJE só para testes
  const dow = new Date(hoje + 'T12:00:00Z').getUTCDay();
  const hist = readJSON('historico.json', {});
  const estado = readJSON('estado.json', { porTicker: {} });
  const sinais = readJSON('sinais.json', []);
  const watchSet = new Map(cfg.watch.map(w => [w.ticker, w]));
  const posSet = new Map(cfg.pos.map(p => [p.ticker, p]));
  const all = [BENCH, ...new Set([...watchSet.keys(), ...posSet.keys()].filter(t => t !== BENCH))];
  log(`${all.length} ativos · range ${BRAPI_RANGE} · ${hoje}`);

  const quotes = {}; const falhas = [];
  for (const tk of all) {
    try { const q = await brapi(tk); quotes[tk] = q; hist[tk] = mergeBars(hist[tk], q); }
    catch (e) { falhas.push(`${tk}: ${e.message}`); log('falha', tk, e.message); if (/token brapi/.test(e.message)) break; }
    await sleep(700); // 1 requisição por vez, com folga
  }
  if (!quotes[BENCH] && !Object.keys(quotes).length) throw new Error('Nenhuma cotação obtida. ' + falhas.join(' | '));
  writeJSON('historico.json', hist); // o histórico é salvo mesmo se o resto falhar

  const pregao = quotes[BENCH] ? hist[BENCH].at(-1).d : hoje;
  if (pregao !== hoje && !FORCE) { log(`último pregão é ${pregao} — hoje (${hoje}) sem pregão (feriado?). Nada a alertar.`); return; }
  if (estado.ultimoPregao === pregao && !FORCE) { log('pregão de hoje já processado — evitando alerta duplicado'); return; }

  const bench = hist[BENCH];
  const res = []; const porTicker = {}; const primeira = !Object.keys(estado.porTicker || {}).length;
  for (const tk of all) {
    if (tk === BENCH && !watchSet.has(tk) && !posSet.has(tk)) continue;
    const q = quotes[tk]; if (!q || !hist[tk] || hist[tk].length < 22) continue;
    const w = watchSet.get(tk), p = posSet.get(tk);
    const a = analyze(tk, hist[tk], q, tk === BENCH ? null : bench, cfg);
    const now = snap(a, cfg, w && w.alvo, p);
    a.ev = primeira ? [] : events(a, now, estado.porTicker[tk], { watch: !!w, alvo: w && w.alvo, pos: p, quedaDiaPct: cfg.quedaDiaPct });
    a.isPos = !!p; a.isWatch = !!w; a.pos = p;
    porTicker[tk] = now; res.push(a);
    const antes = estado.porTicker[tk];
    if (w && now.label === 'fav' && (!antes || antes.label !== 'fav'))
      sinais.push({ tk, d: a.d, px: a.px, score: a.score, core: Core.CORE_VERSION });
  }

  // ---------- mensagem ----------
  const L = [];
  L.push(`📡 RADAR B3 · fechamento ${ddmm(pregao)}`);
  const mudou = res.filter(a => a.ev.length).sort((x, y) => Math.max(...y.ev.map(e => e.prio)) - Math.max(...x.ev.map(e => e.prio)));
  if (primeira) {
    L.push('', 'Primeira execução: este é o retrato inicial. A partir de amanhã você só recebe o que mudar.');
  }
  if (mudou.length) {
    L.push('', '🔔 O QUE MUDOU HOJE');
    for (const a of mudou) {
      L.push('', `${a.tk} · ${R$(a.px)} (${pc(a.chg)}) · score ${a.score}${a.isPos ? ' · 💼 carteira' : ''}`);
      for (const e of a.ev) L.push('  • ' + e.txt);
      if (a.rs63 != null) L.push(`  força vs Ibov 3m: ${pc(a.rs63)} p.p.${a.stopAtr ? ` · stop técnico (2×ATR): ${R$(a.stopAtr)}` : ''}`);
      if (a.flags.length) L.push('  ⚠ ' + a.flags.join('; '));
    }
    if (ENV.ANTHROPIC_API_KEY) {
      const itens = [];
      for (const a of mudou.slice(0, 8)) {
        itens.push({ ticker: a.tk, nome: a.nome, preco: a.px, variacaoDiaPct: a.chg, score: a.score, leitura: a.labelTxt,
          mudancas: a.ev.map(e => e.txt), rsi14: a.ind.rsi && +a.ind.rsi.toFixed(1), mm21: a.ind.mm21 && +a.ind.mm21.toFixed(2),
          mm50: a.ind.mm50 && +a.ind.mm50.toFixed(2), mm200: a.ind.mm200 && +a.ind.mm200.toFixed(2), volAnualPct: a.ind.vol && +a.ind.vol.toFixed(1),
          forcaVsIbov3mPP: a.rs63 && +a.rs63.toFixed(1), riscos: a.flags, manchetes: await headlines(a.tk, a.nome) });
      }
      const txt = await aiComment(itens);
      if (txt) L.push('', '🧠 LEITURA DA IA (resumo de dados e manchetes — não é recomendação)', '', txt);
    }
  } else if (!primeira) {
    L.push('', 'Sem mudanças relevantes hoje.');
  }
  // retrato compacto: na 1ª execução, às sextas, ou se configurado
  const sexta = dow === 5;
  if (primeira || sexta || cfg.enviarSemMudancas) {
    const wl = res.filter(a => a.isWatch).sort((x, y) => y.score - x.score);
    if (wl.length) {
      L.push('', '🎯 WATCHLIST (maior score primeiro)');
      for (const a of wl) L.push(`${a.tk} ${a.score} ${LBL[a.label]} · ${R$(a.px)} · RSI ${a.ind.rsi?.toFixed(0) ?? '—'} · vs Ibov 3m ${pc(a.rs63)}`);
    }
    const ps = res.filter(a => a.isPos);
    if (ps.length) {
      L.push('', '💼 CARTEIRA');
      for (const a of ps) {
        const lucro = a.pos.pm ? (a.px / a.pos.pm - 1) * 100 : null;
        const st = a.pos.meta && a.px >= a.pos.meta ? ' · 🏁 acima da meta' : a.pos.stop && a.px <= a.pos.stop ? ' · 🛑 abaixo do stop' : '';
        L.push(`${a.tk} ${R$(a.px)} · ${pc(lucro)} sobre o PM${a.pos.meta ? ` · meta ${R$(a.pos.meta)}` : ''}${a.pos.stop ? ` · stop ${R$(a.pos.stop)}` : ''}${st}`);
      }
    }
  }
  if (sexta || FORCE) {
    const pl = outcomes(sinais, hist);
    L.push('', '📈 PLACAR DO SCORE (sinais FAVORÁVEL desde o início)');
    if (!pl.length) L.push('Ainda sem sinais com prazo completo — o placar aparece depois do 5º pregão do primeiro sinal.');
    for (const p of pl) L.push(`${p.h} pregões: ${p.n} sinais · ${p.acerto.toFixed(0)}% positivos · média ${pc(p.avg)}${p.avgEx != null ? ` · vs Ibov ${pc(p.avgEx)}` : ''}`);
  }
  const hb = hist[BENCH]?.length || 0;
  if (hb < 200) L.push('', `ℹ histórico acumulado: ${hb} pregões. MM200 e topo de 52 semanas reais a partir de 200 (o robô acumula 1 pregão por dia).`);
  if (falhas.length) L.push('', '⚠ falhas na coleta: ' + falhas.join(' | '));
  L.push('', 'Sinal quantitativo, não é ordem. Dados da brapi com ~30 min de atraso.');

  const msg = L.join('\n');
  const deveEnviar = primeira || mudou.length || sexta || cfg.enviarSemMudancas || falhas.length || FORCE;
  if (deveEnviar) await telegram(msg); else log('sem mudanças — nenhuma mensagem enviada');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'ultimo-relatorio.txt'), msg);
  writeJSON('estado.json', { ultimoPregao: pregao, atualizadoEm: new Date().toISOString(), core: Core.CORE_VERSION, porTicker: { ...estado.porTicker, ...porTicker } });
  writeJSON('sinais.json', sinais.slice(-500));
  log(`ok · ${res.length} analisados · ${mudou.length} com mudança · enviado=${!!deveEnviar}`);
}

main().catch(e => { console.error('[radar] ERRO:', e.message); process.exit(1); });
