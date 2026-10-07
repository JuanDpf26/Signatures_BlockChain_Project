const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { logAudit, clientIp } = require('../services/audit.service');

// GET /api/audit?limit=50&action=document&result=denegado
// Devuelve los eventos del usuario de la sesión (por id o por su correo, para
// incluir intentos de inicio de sesión fallidos con su cuenta).
const getMyAudit = async (req, res) => {
  try {
    const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const email = u.rows[0]?.email?.toLowerCase() || '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const params = [String(req.user.id), email];
    let where = '(user_id = $1 OR (user_id IS NULL AND actor_email = $2))';
    if (req.query.action) {
      params.push(`${String(req.query.action).replace(/[^a-z_.]/gi, '')}%`);
      where += ` AND action LIKE $${params.length}`;
    }
    if (['permitido', 'denegado', 'error'].includes(req.query.result)) {
      params.push(req.query.result);
      where += ` AND result = $${params.length}`;
    }

    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT id, created_at, action, description, resource, result, status_code, ip, user_agent, request_id, method, path, detail
           FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE result = 'denegado')::int AS denied,
                COUNT(*) FILTER (WHERE result = 'error')::int AS errors,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7,
                MAX(created_at) FILTER (WHERE action IN ('auth.login','auth.google') AND result = 'permitido') AS last_login,
                COUNT(DISTINCT ip)::int AS ips
           FROM audit_logs WHERE (user_id = $1 OR (user_id IS NULL AND actor_email = $2))`,
        [String(req.user.id), email]
      ),
    ]);

    return res.json({ events: rows.rows, summary: summary.rows[0] });
  } catch (err) {
    console.error('ERROR AUDIT:', err.message);
    return res.status(500).json({ error: 'No se pudo consultar la auditoría' });
  }
};

// ─────────────────────────────────────────
// EXPORTAR EL REGISTRO DE AUDITORÍA
// 1) POST /api/audit/export-link  (con sesión) → enlace temporal (2 min)
// 2) GET  /api/audit/export?token=…  → descarga CSV o informe imprimible
// Así funciona igual en web y en celular (se abre en el navegador).
// ─────────────────────────────────────────
const ACTION_LABELS = {
  auth: 'Sesión y cuenta', document: 'Documentos', signing: 'Firma y verificación', profile: 'Perfil',
  agent: 'Sign IA', inbox: 'Bandeja', team: 'Equipos', keys: 'Llaves', audit: 'Auditoría',
};
const PERIODS = { '7d': 7, '30d': 30, '90d': 90, all: null };

const buildWhere = (uid, email, f) => {
  const params = [String(uid), email];
  let where = '(user_id = $1 OR (user_id IS NULL AND actor_email = $2))';
  if (f.action) {
    params.push(`${String(f.action).replace(/[^a-z_.]/gi, '')}%`);
    where += ` AND action LIKE $${params.length}`;
  }
  if (['permitido', 'denegado', 'error'].includes(f.result)) {
    params.push(f.result);
    where += ` AND result = $${params.length}`;
  }
  const days = PERIODS[f.period] ?? null;
  if (days) {
    params.push(days);
    where += ` AND created_at > NOW() - ($${params.length}::int * INTERVAL '1 day')`;
  }
  return { where, params };
};

const createExportLink = async (req, res) => {
  try {
    const b = req.body || {};
    const format = b.format === 'html' ? 'html' : 'csv';
    const filters = {
      action: b.action ? String(b.action).slice(0, 30) : '',
      result: ['permitido', 'denegado', 'error'].includes(b.result) ? b.result : '',
      period: Object.keys(PERIODS).includes(b.period) ? b.period : '30d',
    };
    const token = jwt.sign({ purpose: 'audit_export', uid: String(req.user.id), format, filters }, process.env.JWT_SECRET, { expiresIn: '2m' });
    const base = `${req.protocol}://${req.get('host')}`;
    return res.json({ url: `${base}/api/audit/export?token=${encodeURIComponent(token)}`, expires_in: 120 });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo preparar la descarga' });
  }
};

const fmtDate = (d) =>
  new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// CSV para Excel en español: separador ';', BOM UTF-8 y saltos CRLF
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const exportAudit = async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET);
    if (payload.purpose !== 'audit_export') throw new Error('propósito inválido');
  } catch {
    return res.status(401).send('El enlace de descarga venció o no es válido. Vuelve a descargar el registro desde BlockSign.');
  }
  try {
    const u = await pool.query('SELECT name, email FROM users WHERE id::text = $1', [payload.uid]);
    const user = u.rows[0] || {};
    const email = String(user.email || '').toLowerCase();
    const { where, params } = buildWhere(payload.uid, email, payload.filters || {});
    const r = await pool.query(
      `SELECT created_at, action, description, resource, result, status_code, ip, user_agent, request_id, method, path, detail
         FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT 5000`,
      params
    );
    const rows = r.rows;
    const header = ['Fecha y hora (Bogotá)', 'Acción', 'Descripción', 'Resultado', 'Código HTTP', 'Recurso', 'IP', 'Navegador', 'Método', 'Ruta', 'ID de petición', 'Detalle'];
    const lines = rows.map((e) => [
      fmtDate(e.created_at), e.action, e.description, e.result, e.status_code, e.resource, e.ip, e.user_agent, e.method, e.path, e.request_id,
      e.detail ? JSON.stringify(e.detail) : '',
    ]);
    const csv = [header, ...lines].map((l) => l.map(csvCell).join(';')).join('\r\n');
    // Huella del contenido exportado: permite comprobar después que el archivo no se alteró
    const digest = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
    const stamp = new Date().toISOString().slice(0, 10);

    logAudit({
      userId: payload.uid, actorEmail: email || null, action: 'audit.export',
      description: `Descargó el registro de auditoría (${payload.format === 'html' ? 'informe' : 'CSV'})`,
      result: 'permitido', statusCode: 200, ip: clientIp(req), userAgent: req.headers['user-agent'], requestId: req.id,
      method: 'GET', path: '/api/audit/export', detail: { rows: rows.length, sha256: digest, filters: payload.filters },
    });

    res.setHeader('X-Content-SHA256', digest);
    res.setHeader('Cache-Control', 'no-store');
    if (payload.format !== 'html') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="BlockSign_auditoria_${stamp}.csv"`);
      return res.send('﻿' + csv);
    }

    // Informe imprimible (se guarda como PDF desde el navegador)
    const f = payload.filters || {};
    const count = (k) => rows.filter((e) => e.result === k).length;
    const periodLabel = { '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', '90d': 'Últimos 90 días', all: 'Todo el historial' }[f.period] || 'Últimos 30 días';
    const color = { permitido: '#2E7D32', denegado: '#D32F2F', error: '#D99A00' };
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registro de auditoría · BlockSign</title>
<style>
  *{box-sizing:border-box} body{font-family:'Segoe UI',Roboto,Arial,sans-serif;color:#1B1F27;margin:0;background:#F4F6FA}
  .page{max-width:1100px;margin:24px auto;background:#fff;border:1px solid #E3E7EE;border-radius:14px;overflow:hidden}
  header{background:linear-gradient(135deg,#0B45B5,#08368F);color:#fff;padding:24px 28px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
  header h1{margin:0;font-size:22px} header p{margin:4px 0 0;opacity:.8;font-size:13px}
  .meta{padding:18px 28px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;border-bottom:1px solid #E3E7EE}
  .meta div{font-size:12px;color:#5F6670} .meta b{display:block;color:#1B1F27;font-size:14px;margin-top:2px}
  .kpis{display:flex;gap:12px;padding:16px 28px;flex-wrap:wrap}
  .kpi{flex:1;min-width:140px;border:1px solid #E3E7EE;border-radius:12px;padding:12px 14px}
  .kpi span{font-size:12px;color:#5F6670} .kpi b{display:block;font-size:24px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#F4F6FA;text-align:left;padding:9px 10px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#5F6670}
  td{padding:8px 10px;border-top:1px solid #E3E7EE;vertical-align:top}
  .mono{font-family:Consolas,monospace;font-size:11px;color:#5F6670}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;border:1.4px solid;font-weight:700;font-size:11px}
  .wrap{padding:0 28px 8px} footer{padding:16px 28px;font-size:11.5px;color:#5F6670;border-top:1px solid #E3E7EE;word-break:break-all}
  .print{position:fixed;right:20px;bottom:20px;background:#0B45B5;color:#fff;border:0;border-radius:999px;padding:12px 20px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(11,69,181,.3)}
  @media print{body{background:#fff}.page{margin:0;border:0}.print{display:none} tr{page-break-inside:avoid}}
</style></head><body>
<div class="page">
  <header><div><h1>Registro de auditoría</h1><p>BlockSign · firma digital con blockchain</p></div>
  <div style="text-align:right;font-size:13px">Generado el<br><b>${esc(fmtDate(new Date()))}</b></div></header>
  <div class="meta">
    <div>Usuario<b>${esc(user.name || '—')}</b></div><div>Correo<b>${esc(user.email || '—')}</b></div>
    <div>Periodo<b>${esc(periodLabel)}</b></div>
    <div>Filtros<b>${esc([f.action ? ACTION_LABELS[f.action] || f.action : 'Todas las acciones', f.result || 'todos los resultados'].join(' · '))}</b></div>
  </div>
  <div class="kpis">
    <div class="kpi"><span>Eventos</span><b>${rows.length}</b></div>
    <div class="kpi"><span>Permitidos</span><b style="color:#2E7D32">${count('permitido')}</b></div>
    <div class="kpi"><span>Denegados</span><b style="color:#D32F2F">${count('denegado')}</b></div>
    <div class="kpi"><span>Errores</span><b style="color:#D99A00">${count('error')}</b></div>
  </div>
  <div class="wrap"><table>
    <thead><tr><th>Fecha y hora</th><th>Evento</th><th>Recurso</th><th>IP</th><th>ID de petición</th><th>Resultado</th></tr></thead>
    <tbody>${rows.map((e) => `<tr><td>${esc(fmtDate(e.created_at))}</td><td><b>${esc(e.description || e.action)}</b><br><span class="mono">${esc(e.action)}${e.method ? ` · ${esc(e.method)} ${esc(e.path || '')}` : ''}</span></td><td class="mono">${esc(e.resource ? String(e.resource).slice(0, 18) : '—')}</td><td class="mono">${esc(e.ip || '—')}</td><td class="mono">${esc(e.request_id ? String(e.request_id).slice(0, 8) : '—')}</td><td><span class="pill" style="color:${color[e.result] || '#5F6670'};border-color:${color[e.result] || '#5F6670'}">${esc(e.result)}</span></td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:24px;color:#5F6670">No hay eventos en este periodo.</td></tr>'}</tbody>
  </table></div>
  <footer>Huella SHA-256 del registro exportado (formato CSV): <b class="mono">${digest}</b><br>
  Nunca se guardan contraseñas, tokens ni el contenido de los documentos. Este informe se generó desde BlockSign y queda registrado en la auditoría.</footer>
</div>
<button class="print" onclick="window.print()">Imprimir o guardar como PDF</button>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:");
    return res.send(html);
  } catch (err) {
    console.error('ERROR AUDIT EXPORT:', err.message);
    return res.status(500).send('No se pudo generar el registro.');
  }
};

module.exports = { getMyAudit, createExportLink, exportAudit };
