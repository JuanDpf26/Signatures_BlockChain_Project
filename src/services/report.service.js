/**
 * Informes en PDF con el mismo estilo del certificado de firma:
 *  - Registro de auditoría (tabla paginada, A4 horizontal)
 *  - Comprobante de verificación de un documento (A4 vertical, con QR)
 */
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { safe } = require('./certificate.service');

const NAVY = rgb(0.03, 0.21, 0.56);
const BLUE = rgb(0.043, 0.271, 0.71);
const TEXT = rgb(0.11, 0.13, 0.17);
const HINT = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.86, 0.88, 0.92);
const SOFT = rgb(0.957, 0.965, 0.98);
const GREEN = rgb(0.18, 0.49, 0.2);
const RED = rgb(0.83, 0.18, 0.18);
const AMBER = rgb(0.85, 0.6, 0);

const fmt = (d) =>
  d ? new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' }) : '-';

/** Corta un texto para que quepa en `width` (con …) */
const fit = (text, font, size, width) => {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t}...`;
};

const wrap = (text, font, size, width) => {
  const out = [];
  let line = '';
  for (const w of safe(text).split(/\s+/)) {
    const test = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > width && line) {
      out.push(line);
      line = w;
    } else line = test;
  }
  if (line) out.push(line);
  return out;
};

const header = (page, { title, subtitle, right, bold, font }) => {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: height - 70, width, height: 70, color: NAVY });
  page.drawText('DocBlockSign', { x: 36, y: height - 34, size: 16, font: bold, color: rgb(1, 1, 1) });
  page.drawText(safe(title), { x: 36, y: height - 54, size: 10.5, font, color: rgb(0.85, 0.9, 1) });
  if (right) {
    const w = font.widthOfTextAtSize(safe(right), 9);
    page.drawText(safe(right), { x: width - 36 - w, y: height - 34, size: 9, font, color: rgb(0.85, 0.9, 1) });
  }
  if (subtitle) {
    const w = font.widthOfTextAtSize(safe(subtitle), 9);
    page.drawText(safe(subtitle), { x: width - 36 - w, y: height - 50, size: 9, font, color: rgb(0.85, 0.9, 1) });
  }
};

const footer = (page, { text, n, total, font }) => {
  const { width } = page.getSize();
  page.drawLine({ start: { x: 36, y: 34 }, end: { x: width - 36, y: 34 }, thickness: 0.5, color: LINE });
  page.drawText(fit(text, font, 7.5, width - 140), { x: 36, y: 22, size: 7.5, font, color: HINT });
  const p = `Página ${n} de ${total}`;
  page.drawText(safe(p), { x: width - 36 - font.widthOfTextAtSize(safe(p), 7.5), y: 22, size: 7.5, font, color: HINT });
};

// ─────────────────────────────────────────
// REGISTRO DE AUDITORÍA
// ─────────────────────────────────────────
const RESULT_COLOR = { permitido: GREEN, denegado: RED, error: AMBER };

/**
 * @param {object} p { user:{name,email}, rows:[audit rows], periodLabel, filtersLabel, digest, title? }
 */
const buildAuditPdf = async ({ user, rows, periodLabel, filtersLabel, digest, title = 'Registro de auditoría' }) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const W = 841.89;
  const H = 595.28; // A4 horizontal
  const cols = [
    { k: 'when', label: 'FECHA Y HORA', w: 112 },
    { k: 'event', label: 'EVENTO', w: 290 },
    { k: 'who', label: 'USUARIO', w: 120 },
    { k: 'resource', label: 'RECURSO', w: 86 },
    { k: 'ip', label: 'IP', w: 80 },
    { k: 'result', label: 'RESULTADO', w: 0 },
  ];
  const tableW = W - 72;
  cols[cols.length - 1].w = tableW - cols.slice(0, -1).reduce((a, c) => a + c.w, 0);
  const pages = [];
  const newPage = (first) => {
    const pg = pdf.addPage([W, H]);
    pages.push(pg);
    header(pg, { title, right: `Generado: ${fmt(new Date())}`, subtitle: periodLabel, bold, font });
    let y = H - 92;
    if (first) {
      // Datos y totales
      const facts = [
        ['Usuario', user?.name || '-'],
        ['Correo', user?.email || '-'],
        ['Periodo', periodLabel || '-'],
        ['Filtros', filtersLabel || 'Todos'],
      ];
      let x = 36;
      for (const [k, v] of facts) {
        pg.drawText(safe(k), { x, y, size: 8, font, color: HINT });
        pg.drawText(fit(v, bold, 10, 180), { x, y: y - 13, size: 10, font: bold, color: TEXT });
        x += 192;
      }
      y -= 36;
      const count = (r) => rows.filter((e) => e.result === r).length;
      const kpis = [['Eventos', rows.length, TEXT], ['Permitidos', count('permitido'), GREEN], ['Denegados', count('denegado'), RED], ['Errores', count('error'), AMBER]];
      x = 36;
      const kw = (tableW - 30) / 4;
      for (const [k, v, c] of kpis) {
        pg.drawRectangle({ x, y: y - 38, width: kw, height: 40, borderColor: LINE, borderWidth: 0.8, color: rgb(1, 1, 1) });
        pg.drawText(safe(k), { x: x + 10, y: y - 12, size: 8, font, color: HINT });
        pg.drawText(String(v), { x: x + 10, y: y - 31, size: 15, font: bold, color: c });
        x += kw + 10;
      }
      y -= 56;
    }
    // Encabezado de tabla
    pg.drawRectangle({ x: 36, y: y - 6, width: tableW, height: 20, color: SOFT });
    let x = 42;
    for (const c of cols) {
      pg.drawText(c.label, { x, y: y, size: 7.5, font: bold, color: HINT });
      x += c.w;
    }
    return { pg, y: y - 22 };
  };

  let { pg, y } = newPage(true);
  if (!rows.length) {
    pg.drawText(safe('No hay eventos en este periodo.'), { x: 42, y: y - 8, size: 10, font, color: HINT });
  }
  for (const e of rows) {
    if (y < 60) ({ pg, y } = newPage(false));
    const cells = {
      when: fmt(e.created_at),
      event: e.description || e.action,
      sub: `${e.action}${e.method ? ` · ${e.method} ${e.path || ''}` : ''}`,
      who: e.actor_email || e.user_name || user?.email || '-',
      resource: e.resource ? String(e.resource).slice(0, 14) : '-',
      ip: e.ip || '-',
      result: e.result || '-',
    };
    let x = 42;
    for (const c of cols) {
      if (c.k === 'event') {
        pg.drawText(fit(cells.event, bold, 8.5, c.w - 8), { x, y, size: 8.5, font: bold, color: TEXT });
        pg.drawText(fit(cells.sub, mono, 6.8, c.w - 8), { x, y: y - 10, size: 6.8, font: mono, color: HINT });
      } else if (c.k === 'result') {
        pg.drawText(safe(cells.result), { x, y, size: 8.5, font: bold, color: RESULT_COLOR[e.result] || HINT });
      } else {
        const f = c.k === 'ip' || c.k === 'resource' ? mono : font;
        pg.drawText(fit(cells[c.k], f, 8, c.w - 8), { x, y, size: 8, font: f, color: c.k === 'when' ? TEXT : HINT });
      }
      x += c.w;
    }
    pg.drawLine({ start: { x: 36, y: y - 16 }, end: { x: 36 + tableW, y: y - 16 }, thickness: 0.4, color: LINE });
    y -= 26;
  }

  const foot = `Huella SHA-256 del registro (CSV): ${digest}. Nunca se guardan contraseñas, tokens ni el contenido de los documentos.`;
  pages.forEach((p, i) => footer(p, { text: foot, n: i + 1, total: pages.length, font }));
  pdf.setTitle(safe(`${title} - DocBlockSign`));
  pdf.setProducer('DocBlockSign');
  return Buffer.from(await pdf.save());
};

// ─────────────────────────────────────────
// COMPROBANTE DE VERIFICACIÓN
// ─────────────────────────────────────────
const VERDICT = {
  authentic: ['Documento auténtico', GREEN, rgb(0.91, 0.96, 0.92)],
  revoked: ['Firma revocada', RED, rgb(0.99, 0.92, 0.92)],
  invalid_signature: ['Firma no válida', RED, rgb(0.99, 0.92, 0.92)],
  pending: ['Registro en proceso', AMBER, rgb(1, 0.97, 0.88)],
  not_registered: ['Sin registro en blockchain', HINT, SOFT],
  unavailable: ['Blockchain no disponible', AMBER, rgb(1, 0.97, 0.88)],
  invalid: ['Huella no válida', RED, rgb(0.99, 0.92, 0.92)],
};

/**
 * @param {object} p { v: resultado de buildVerification, checkedBy:{name,email}, verifyUrl, fileName? }
 */
const buildReceiptPdf = async ({ v, checkedBy, verifyUrl, fileName }) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const W = 595.28;
  const H = 841.89;
  const M = 48;
  const page = pdf.addPage([W, H]);
  header(page, { title: 'Comprobante de verificación', right: `Consultado: ${fmt(v.checkedAt)}`, bold, font });
  let y = H - 104;

  const [label, color, bg] = VERDICT[v.verdict] || VERDICT.not_registered;
  page.drawRectangle({ x: M, y: y - 44, width: W - M * 2, height: 52, color: bg, borderColor: color, borderWidth: 0.8 });
  page.drawText(safe(label), { x: M + 14, y: y - 14, size: 15, font: bold, color });
  const msg = (v.message && v.message[v.verdict]) || (v.verdict === 'unavailable' ? 'No se pudo consultar la red Sepolia en este momento; el resultado de la base de datos se muestra abajo.' : '');
  page.drawText(fit(msg, font, 9, W - M * 2 - 28), { x: M + 14, y: y - 32, size: 9, font, color: TEXT });
  y -= 72;

  const h1 = (t) => {
    y -= 8;
    page.drawText(safe(t), { x: M, y, size: 12, font: bold, color: TEXT });
    y -= 7;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINE });
    y -= 16;
  };
  const row = (k, val, monoV = false) => {
    page.drawText(safe(k), { x: M, y, size: 8.5, font: bold, color: HINT });
    for (const l of wrap(val ?? '-', monoV ? mono : font, monoV ? 8 : 9.5, W - M * 2 - 140)) {
      page.drawText(l, { x: M + 140, y, size: monoV ? 8 : 9.5, font: monoV ? mono : font, color: TEXT });
      y -= 13;
    }
    y -= 3;
  };

  h1('Documento');
  if (fileName) row('Archivo comprobado', fileName);
  row('Nombre registrado', v.document?.title || 'No está en DocBlockSign');
  row('Huella SHA-256', v.hash, true);
  if (v.document?.signerName) row('Firmado por', v.document.signerName);

  if (v.blockchain) {
    h1('Registro en blockchain');
    row('Red', 'Ethereum Sepolia (red de pruebas)');
    row('Transacción', v.transaction?.hash || v.transaction?.txHash || '-', true);
    if (v.transaction?.blockNumber != null) row('Bloque', `#${v.transaction.blockNumber}`);
    row('Fecha de registro', fmt(v.blockchain.signedAt));
    row('Correo(s) registrado(s)', v.blockchain.signerEmail);
    row('Contrato', v.blockchain.contractAddress, true);
  }

  h1('Comprobaciones');
  for (const s of v.steps || []) {
    if (y < 200) break;
    const c = s.ok ? GREEN : s.ok === false ? RED : HINT;
    page.drawCircle({ x: M + 5, y: y + 3, size: 4, color: c });
    page.drawText(fit(s.label, bold, 9.5, W - M * 2 - 20), { x: M + 16, y, size: 9.5, font: bold, color: TEXT });
    y -= 12;
    page.drawText(fit(s.detail || '', font, 8.5, W - M * 2 - 20), { x: M + 16, y, size: 8.5, font, color: HINT });
    y -= 17;
  }

  // QR + quién consultó
  const qr = await pdf.embedPng(await QRCode.toBuffer(verifyUrl, { type: 'png', margin: 1, width: 300 }));
  page.drawImage(qr, { x: M, y: 64, width: 100, height: 100 });
  const tx = M + 118;
  page.drawText(safe('Volver a comprobar'), { x: tx, y: 148, size: 11, font: bold, color: BLUE });
  for (const [i, l] of wrap('Escanea el código, inicia sesión en DocBlockSign y sube el archivo original: el resultado debe coincidir con este comprobante.', font, 8.5, W - tx - M).entries()) {
    page.drawText(l, { x: tx, y: 132 - i * 11, size: 8.5, font, color: TEXT });
  }
  page.drawText(safe(`Consultado por ${checkedBy?.name || ''} (${checkedBy?.email || ''})`), { x: tx, y: 82, size: 8, font, color: HINT });
  page.drawText(safe('Este comprobante refleja el estado al momento de la consulta. La firma es electrónica, respaldada por blockchain.'), { x: M, y: 40, size: 7, font, color: HINT });
  pdf.setTitle(safe(`Comprobante de verificación - ${v.document?.title || v.hash.slice(0, 12)}`));
  pdf.setProducer('DocBlockSign');
  return Buffer.from(await pdf.save());
};

module.exports = { buildAuditPdf, buildReceiptPdf };
