/**
 * PDF FIRMADO CON SELLO Y QR
 *
 * - Si el original es PDF: se copia tal cual y a cada página se le agrega un
 *   pie con la huella y un QR pequeño que lleva a Verificar. Al final se añade
 *   una página "Certificado de firma".
 * - Si es Word: se genera solo el certificado (el archivo original no se toca;
 *   su huella sigue siendo la registrada en blockchain).
 *
 * Importante: el PDF sellado es una COPIA para leer e imprimir. Su huella es
 * distinta a la del original; lo que se verifica es la huella del original,
 * que el QR lleva en el enlace.
 */
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const BLUE = rgb(0.043, 0.271, 0.71); // #0B45B5
const NAVY = rgb(0.03, 0.21, 0.56);
const TEXT = rgb(0.11, 0.13, 0.17);
const HINT = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.86, 0.88, 0.92);
const GREEN = rgb(0.18, 0.49, 0.2);

/** Helvetica solo dibuja Latin-1: se cambian comillas tipográficas y se quita lo demás */
const safe = (s) =>
  String(s ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');

const fmtDate = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' });
};

const short = (h, a = 12, b = 10) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}...${h.slice(-b)}` : h || '-');

const qrPng = (text) => QRCode.toBuffer(text, { type: 'png', margin: 1, width: 360, errorCorrectionLevel: 'M' });

const embedImage = async (pdf, bytes) => {
  if (!bytes || bytes.length < 8) return null;
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await pdf.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await pdf.embedJpg(bytes);
  } catch (_) {}
  return null;
};

/** Parte un texto en líneas que caben en `width` */
const wrap = (text, font, size, width) => {
  const words = safe(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
};

/**
 * @param {object} p
 * @param {Buffer|null} p.original   bytes del PDF original (null si es Word o no se pudo leer)
 * @param {object} p.doc             { title, file_hash, extension }
 * @param {object} p.chain           { txHash, blockNumber, signedAt, explorerUrl, network }
 * @param {Array}  p.signers         [{ name, email, signedAt, signatureHash, keyFingerprint, image: Buffer|null }]
 * @param {string} p.verifyUrl       enlace de Verificar con la huella
 */
const buildSignedPdf = async ({ original, doc, chain, signers, verifyUrl }) => {
  let pdf = null;
  let stamped = false;
  if (original) {
    try {
      pdf = await PDFDocument.load(original, { ignoreEncryption: false, updateMetadata: false });
      stamped = true;
    } catch (_) {
      pdf = null; // PDF protegido o dañado: se entrega solo el certificado
    }
  }
  if (!pdf) pdf = await PDFDocument.create();

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const qr = await pdf.embedPng(await qrPng(verifyUrl));

  // ── Sello en cada página del original ──
  if (stamped) {
    const label = safe(`Firmado digitalmente con DocBlockSign · Registro en blockchain (Sepolia) · Huella SHA-256: ${short(doc.file_hash, 16, 12)}`);
    for (const page of pdf.getPages()) {
      const { width } = page.getSize();
      const qrSize = 38;
      const h = 46;
      page.drawRectangle({ x: 0, y: 0, width, height: h, color: rgb(1, 1, 1), opacity: 0.92 });
      page.drawLine({ start: { x: 0, y: h }, end: { x: width, y: h }, thickness: 0.6, color: LINE });
      page.drawImage(qr, { x: width - qrSize - 10, y: 4, width: qrSize, height: qrSize });
      let size = 7.5;
      while (font.widthOfTextAtSize(label, size) > width - qrSize - 34 && size > 5) size -= 0.25;
      page.drawText(label, { x: 12, y: 26, size, font, color: TEXT });
      page.drawText(safe('Escanea el código o entra a Verificar para comprobar que este documento no fue modificado.'), {
        x: 12, y: 13, size: Math.min(size, 7), font, color: HINT,
      });
    }
  }

  // ── Página de certificado ──
  const page = pdf.addPage([595.28, 841.89]); // A4
  const W = 595.28;
  const M = 48;
  let y = 841.89 - M;

  page.drawRectangle({ x: 0, y: 841.89 - 92, width: W, height: 92, color: NAVY });
  page.drawText('DocBlockSign', { x: M, y: 841.89 - 46, size: 20, font: bold, color: rgb(1, 1, 1) });
  page.drawText(safe('Certificado de firma digital'), { x: M, y: 841.89 - 68, size: 11, font, color: rgb(0.85, 0.9, 1) });
  y = 841.89 - 92 - 34;

  const h1 = (t) => { y -= 10; page.drawText(safe(t), { x: M, y, size: 13, font: bold, color: TEXT }); y -= 8; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINE }); y -= 18; };
  const row = (k, v, { monoV = false } = {}) => {
    page.drawText(safe(k), { x: M, y, size: 9, font: bold, color: HINT });
    const lines = wrap(v, monoV ? mono : font, monoV ? 8.5 : 10, W - M * 2 - 150);
    for (const l of lines) { page.drawText(l, { x: M + 150, y, size: monoV ? 8.5 : 10, font: monoV ? mono : font, color: TEXT }); y -= 14; }
    y -= 4;
  };

  // Estado
  page.drawRectangle({ x: M, y: y - 30, width: W - M * 2, height: 40, color: rgb(0.91, 0.96, 0.92), borderColor: rgb(0.7, 0.86, 0.72), borderWidth: 0.8 });
  page.drawText(safe('Documento firmado y registrado en blockchain'), { x: M + 14, y: y - 8, size: 12, font: bold, color: GREEN });
  page.drawText(safe(`Registrado el ${fmtDate(chain.signedAt)}`), { x: M + 14, y: y - 23, size: 9, font, color: GREEN });
  y -= 60;

  h1('Documento');
  row('Nombre', doc.title);
  row('Tipo', (doc.extension || 'pdf').toUpperCase());
  row('Huella SHA-256', doc.file_hash, { monoV: true });

  h1('Registro en blockchain');
  row('Red', chain.network || 'Ethereum Sepolia (red de pruebas)');
  row('Transacción', chain.txHash || '-', { monoV: true });
  row('Bloque', chain.blockNumber != null ? `#${chain.blockNumber}` : '-');
  if (chain.combinedHash) row('Huella de las firmas', chain.combinedHash, { monoV: true });

  h1(signers.length > 1 ? `Firmantes (${signers.length})` : 'Firmante');
  for (const [i, s] of signers.entries()) {
    if (y < 230) {
      page.drawText(safe(`... y ${signers.length - i} firmante(s) más. La lista completa está en DocBlockSign.`), { x: M, y, size: 9, font, color: HINT });
      break; // espacio reservado para el QR
    }
    const img = await embedImage(pdf, s.image);
    const top = y;
    if (img) {
      const scale = Math.min(110 / img.width, 40 / img.height);
      page.drawImage(img, { x: W - M - img.width * scale, y: top - 40, width: img.width * scale, height: img.height * scale });
    }
    page.drawText(safe(`${signers.length > 1 ? `${i + 1}. ` : ''}${s.name || s.email}`), { x: M, y, size: 11, font: bold, color: TEXT });
    y -= 13;
    page.drawText(safe(`${s.email} · ${fmtDate(s.signedAt)}`), { x: M, y, size: 9, font, color: HINT });
    y -= 12;
    page.drawText(safe(`Firma ECDSA P-256: ${short(s.signatureHash, 18, 12)}`), { x: M, y, size: 8, font: mono, color: HINT });
    y -= 11;
    page.drawText(safe(`Huella de la llave: ${short(s.keyFingerprint, 16, 8)}`), { x: M, y, size: 8, font: mono, color: HINT });
    y -= 22;
  }

  // QR grande
  const qs = 120;
  page.drawImage(qr, { x: M, y: 70, width: qs, height: qs });
  page.drawText(safe('Verifica este documento'), { x: M + qs + 18, y: 70 + qs - 18, size: 12, font: bold, color: BLUE });
  for (const [i, l] of wrap('Escanea el código o abre el enlace, inicia sesión y sube el archivo original. DocBlockSign calcula su huella y la compara con la registrada en blockchain: si coinciden, el documento no fue modificado desde que se firmó.', font, 9, W - M * 2 - qs - 18).entries()) {
    page.drawText(l, { x: M + qs + 18, y: 70 + qs - 36 - i * 12, size: 9, font, color: TEXT });
  }
  page.drawText(safe(short(verifyUrl, 46, 20)), { x: M + qs + 18, y: 78, size: 7.5, font: mono, color: HINT });
  page.drawText(safe('Este certificado acompaña al documento. La copia con sello sirve para leer e imprimir; la prueba legal es la huella del archivo original registrada en blockchain.'), {
    x: M, y: 40, size: 7, font, color: HINT,
  });

  pdf.setTitle(safe(`${doc.title} (firmado)`));
  pdf.setProducer('DocBlockSign');
  pdf.setCreator('DocBlockSign');
  return { bytes: Buffer.from(await pdf.save()), stamped };
};

module.exports = { buildSignedPdf, safe };
