const pool = require('../config/db');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const pdfParseLib = require('pdf-parse');
const mammoth = require('mammoth');
const Groq = require('groq-sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sanitizeFileName = (originalname) => {
  const ext = originalname.split('.').pop().toLowerCase();
  const nameWithoutExt = originalname.slice(0, originalname.lastIndexOf('.'));
  const safe = nameWithoutExt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
  return `${safe || 'documento'}.${ext}`;
};

const detectCategory = (filename) => {
  const name = filename.toLowerCase();
  const rules = [
    { keywords: ['contrato', 'contract', 'acuerdo', 'convenio'], category: 'Contrato' },
    { keywords: ['factura', 'invoice', 'recibo', 'cobro'], category: 'Factura' },
    { keywords: ['informe', 'report', 'reporte', 'analisis'], category: 'Informe' },
    { keywords: ['propuesta', 'proposal', 'cotizacion', 'oferta'], category: 'Propuesta' },
    { keywords: ['acta', 'minuta', 'reunion', 'meeting'], category: 'Acta' },
    { keywords: ['carta', 'letter', 'comunicado', 'memo', 'oficio'], category: 'Comunicado' },
    { keywords: ['certificado', 'certificate', 'diploma', 'constancia'], category: 'Certificado' },
    { keywords: ['poder', 'autorizacion', 'permiso'], category: 'Autorización' },
    { keywords: ['manual', 'guia', 'instructivo', 'procedimiento'], category: 'Manual' },
    { keywords: ['presupuesto', 'budget', 'estimado'], category: 'Presupuesto' },
  ];
  for (const rule of rules) {
    if (rule.keywords.some((kw) => name.includes(kw))) return rule.category;
  }
  return 'Documento';
};

const generateTags = (filename, category) => {
  const tags = new Set([category.toLowerCase()]);
  const name = filename.toLowerCase().replace(/[._-]/g, ' ');
  ['urgente', 'confidencial', 'borrador', 'draft', 'final', 'aprobado',
   'pendiente', 'revision', 'original', '2024', '2025', '2026']
    .forEach((kw) => { if (name.includes(kw)) tags.add(kw); });
  tags.add(filename.split('.').pop().toLowerCase() === 'pdf' ? 'pdf' : 'word');
  return Array.from(tags).slice(0, 6);
};

const formatPdfDate = (d) => {
  try {
    if (typeof d === 'string' && d.startsWith('D:')) {
      const s = d.slice(2, 16);
      return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}`;
    }
    return d;
  } catch { return null; }
};

// pdf-parse v2 (la que instala package.json) exporta la clase PDFParse;
// la v1 exportaba una función. Se soportan ambas.
const parsePdf = async (buffer) => {
  if (typeof pdfParseLib.PDFParse === 'function') {
    const parser = new pdfParseLib.PDFParse({ data: buffer });
    try {
      const textResult = await parser.getText();
      let info = {};
      let version = null;
      try {
        const infoResult = await parser.getInfo();
        info = infoResult.info || {};
        version = info.PDFFormatVersion || null;
      } catch (_) { /* sin metadatos internos */ }
      const text = (textResult.text || '').replace(/-- \d+ of \d+ --/g, '').trim();
      return { text, numpages: textResult.total || 0, info, version };
    } finally {
      if (typeof parser.destroy === 'function') await parser.destroy().catch(() => {});
    }
  }
  const fn = typeof pdfParseLib === 'function' ? pdfParseLib : pdfParseLib.default;
  return fn(buffer);
};

const extractMetadata = async (buffer, mimetype, originalname, size) => {
  const ext = originalname.split('.').pop().toLowerCase();
  const category = detectCategory(originalname);
  const base = {
    original_name: originalname,
    mime_type: mimetype,
    size_bytes: size,
    size_mb: (size / (1024 * 1024)).toFixed(2),
    size_kb: (size / 1024).toFixed(1),
    extension: ext,
    uploaded_at: new Date().toISOString(),
    category,
    tags: generateTags(originalname, category),
  };

  try {
    if (mimetype === 'application/pdf') {
      const data = await parsePdf(buffer);
      const info = data.info || {};
      return {
        ...base,
        pages: data.numpages || 0,
        author: info.Author || null,
        doc_title: info.Title || null,
        subject: info.Subject || null,
        creator: info.Creator || null,
        producer: info.Producer || null,
        creation_date: info.CreationDate ? formatPdfDate(info.CreationDate) : null,
        modification_date: info.ModDate ? formatPdfDate(info.ModDate) : null,
        pdf_version: data.version || null,
        word_count: data.text ? data.text.split(/\s+/).filter(Boolean).length : 0,
        char_count: data.text ? data.text.length : 0,
        has_text: !!(data.text?.trim().length),
        text_preview: data.text ? data.text.trim().slice(0, 500) : null,
      };
    } else {
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value || '';
      return {
        ...base,
        word_count: text.split(/\s+/).filter(Boolean).length,
        char_count: text.length,
        has_text: text.trim().length > 0,
        pages: Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 250)),
        text_preview: text.trim().slice(0, 500),
      };
    }
  } catch (err) {
    console.error('Error extrayendo metadatos:', err.message);
    return { ...base, extraction_error: err.message };
  }
};

// Modelos a probar en orden. Se puede fijar uno con GROQ_MODEL en el .env.
// (El antiguo "compound-beta-mini" fue retirado/renombrado por Groq.)
const GROQ_MODELS = [
  process.env.GROQ_MODEL,
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
].filter(Boolean);

// Extrae el primer objeto JSON de la respuesta aunque venga con texto o ```json
const parseJsonLoose = (text) => {
  const clean = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) { /* sigue */ }
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
  throw new Error('La IA no devolvió JSON válido');
};

const groqErrorCode = (err) => err?.error?.error?.code || err?.error?.code || err?.code || '';

const explainGroqError = (err) => {
  const code = groqErrorCode(err);
  if (err?.status === 401 || code === 'invalid_api_key')
    return 'GROQ_API_KEY inválida o revocada. Crea una nueva en https://console.groq.com/keys y ponla en el .env (las claves publicadas en GitHub se revocan solas).';
  if (err?.status === 429) return 'Límite de uso de Groq alcanzado; intenta de nuevo en unos minutos.';
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(err?.cause?.code || err?.code))
    return 'No hay conexión con api.groq.com (red o firewall).';
  return err?.message || String(err);
};

const isModelError = (err) => {
  const code = groqErrorCode(err);
  return ['model_decommissioned', 'model_not_found', 'model_not_active'].includes(code)
    || (err?.status === 404)
    || /model/i.test(err?.message || '') && [400, 404].includes(err?.status);
};

const generateDescriptionWithGroq = async (docId, metadata) => {
  if (!process.env.GROQ_API_KEY) {
    console.log('⚠️ [IA] GROQ_API_KEY no configurada en el .env: no se analizan documentos');
    return;
  }

  const {
    original_name, extension, size_mb, pages,
    author, doc_title, subject, category,
    word_count, text_preview,
  } = metadata;

  const prompt = `Eres un experto en gestión documental para BlockSign, sistema de firma digital con blockchain.
Analiza los metadatos de este documento y responde ÚNICAMENTE con JSON válido, sin markdown, sin texto adicional.

Metadatos:
- Nombre: ${original_name}
- Tipo: ${extension?.toUpperCase() || 'PDF'}
- Tamaño: ${size_mb} MB
- Páginas: ${pages || 'desconocido'}
- Autor: ${author || 'no especificado'}
- Título interno: ${doc_title || 'no especificado'}
- Asunto: ${subject || 'no especificado'}
- Categoría detectada: ${category}
- Palabras: ${word_count || 0}
${text_preview ? `- Vista previa: "${text_preview.slice(0, 300)}"` : ''}

Responde con este JSON exacto:
{"description":"descripción profesional de máximo 2 oraciones","tags":["tag1","tag2","tag3","tag4"],"category":"categoría","confidentiality":"Público o Interno o Confidencial o Secreto","summary":"resumen de 3 a 5 oraciones"}`;

  let lastErr;
  for (const model of GROQ_MODELS) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model,
        max_tokens: 700,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const aiData = parseJsonLoose(completion.choices[0]?.message?.content);

      await pool.query(
        `UPDATE documents SET metadata = (metadata - 'ai_error') || $1::jsonb WHERE id = $2`,
        [JSON.stringify({
          ai_description: aiData.description || null,
          ai_tags: Array.isArray(aiData.tags) ? aiData.tags.slice(0, 6) : [],
          ai_category: aiData.category || category,
          ai_confidentiality: aiData.confidentiality || null,
          ai_summary: aiData.summary || null,
          ai_model: model,
          ai_analyzed_at: new Date().toISOString(),
        }), docId]
      );

      console.log(`✅ [IA] Documento ${docId} analizado con ${model}`);
      return;
    } catch (err) {
      lastErr = err;
      if (isModelError(err)) {
        console.warn(`⚠️ [IA] Modelo ${model} no disponible (${groqErrorCode(err) || err.status}); probando el siguiente…`);
        continue;
      }
      break; // clave inválida, red, límite, JSON…: no sirve cambiar de modelo
    }
  }

  const reason = explainGroqError(lastErr);
  console.error(`❌ [IA] No se pudo analizar el documento ${docId}: ${reason}`);
  // Se guarda el motivo para poder verlo en los metadatos del documento
  await pool.query(
    `UPDATE documents SET metadata = metadata || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ ai_error: reason, ai_error_at: new Date().toISOString() }), docId]
  ).catch(() => {});
};

const uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const { originalname, mimetype, size, buffer } = req.file;
    const userId = req.user.id;

    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!allowed.includes(mimetype))
      return res.status(400).json({ error: 'Solo se permiten archivos PDF o Word' });
    if (size > 10 * 1024 * 1024)
      return res.status(400).json({ error: 'El archivo no puede superar 10MB' });

    const safeName = sanitizeFileName(originalname);
    const fileName = `${userId}/${Date.now()}_${safeName}`;

    const { error: storageError } = await supabase.storage
      .from('documents')
      .upload(fileName, buffer, { contentType: mimetype, upsert: false });

    if (storageError) {
      console.error('STORAGE ERROR:', storageError);
      return res.status(500).json({ error: 'Error al subir el archivo' });
    }

    const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const metadata = await extractMetadata(buffer, mimetype, originalname, size);

    const result = await pool.query(
      `INSERT INTO documents (user_id, title, file_url, file_hash, status, metadata)
       VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *`,
      [userId, originalname, urlData.publicUrl, fileHash, JSON.stringify(metadata)]
    );

    const doc = result.rows[0];
    generateDescriptionWithGroq(doc.id, metadata).catch(console.error);

    return res.status(201).json({
      message: 'Documento subido exitosamente. Analizando con IA...',
      document: doc,
    });
  } catch (err) {
    console.error('ERROR UPLOAD:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getDocuments = async (req, res) => {
  try {
    const userId = req.user.id;
    const { search, category, status, ext, date_from, date_to, page = 1, limit = 20 } = req.query;

    let query = `SELECT id, title, file_url, file_hash, status, metadata, created_at, updated_at
      FROM documents WHERE user_id = $1`;
    const params = [userId];
    let i = 2;

    if (search) {
      query += ` AND (title ILIKE $${i} OR metadata->>'original_name' ILIKE $${i}
        OR metadata->>'category' ILIKE $${i} OR metadata->>'ai_category' ILIKE $${i}
        OR metadata->>'author' ILIKE $${i} OR metadata->>'ai_description' ILIKE $${i}
        OR metadata->>'ai_summary' ILIKE $${i} OR metadata->>'doc_title' ILIKE $${i}
        OR metadata->>'subject' ILIKE $${i})`;
      params.push(`%${search}%`); i++;
    }
    if (category && category !== 'Todos') {
      query += ` AND (metadata->>'category' = $${i} OR metadata->>'ai_category' = $${i})`;
      params.push(category); i++;
    }
    if (status && status !== 'Todos') { query += ` AND status = $${i}`; params.push(status); i++; }
    if (ext && ext !== 'Todos') { query += ` AND metadata->>'extension' = $${i}`; params.push(ext); i++; }
    if (date_from) { query += ` AND created_at >= $${i}`; params.push(date_from); i++; }
    if (date_to) { query += ` AND created_at <= $${i}`; params.push(date_to + ' 23:59:59'); i++; }

    const countResult = await pool.query(
      query.replace('SELECT id, title, file_url, file_hash, status, metadata, created_at, updated_at', 'SELECT COUNT(*)'),
      params
    );
    const total = parseInt(countResult.rows[0].count);
    query += ` ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    const result = await pool.query(query, params);
    return res.json({ documents: result.rows, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) {
    console.error('ERROR GET DOCS:', err);
    return res.status(500).json({ error: 'Error al obtener documentos' });
  }
};

const getDocument = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
    return res.json({ document: result.rows[0] });
  } catch (err) { return res.status(500).json({ error: 'Error al obtener documento' }); }
};

const reanalyzeDocument = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
    generateDescriptionWithGroq(result.rows[0].id, result.rows[0].metadata || {}).catch(console.error);
    return res.json({ message: 'Análisis IA iniciado. Listo en unos segundos.' });
  } catch (err) { return res.status(500).json({ error: 'Error al re-analizar' }); }
};

const updateDocumentMeta = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, tags, title } = req.body;
    const check = await pool.query('SELECT id FROM documents WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
    if (title) await pool.query('UPDATE documents SET title = $1 WHERE id = $2', [title, id]);
    const updates = { manually_edited: true, last_edited_at: new Date().toISOString() };
    if (category) updates.category = category;
    if (tags) updates.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
    await pool.query(`UPDATE documents SET metadata = metadata || $1::jsonb WHERE id = $2`, [JSON.stringify(updates), id]);
    const updated = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    return res.json({ message: 'Documento actualizado', document: updated.rows[0] });
  } catch (err) { return res.status(500).json({ error: 'Error al actualizar' }); }
};

const deleteDocument = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
    const doc = result.rows[0];
    const urlParts = doc.file_url.split('/storage/v1/object/public/documents/');
    if (urlParts[1]) await supabase.storage.from('documents').remove([decodeURIComponent(urlParts[1])]);
    await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    return res.json({ message: 'Documento eliminado' });
  } catch (err) { return res.status(500).json({ error: 'Error al eliminar documento' }); }
};

const getStats = async (req, res) => {
  try {
    const s = (await pool.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='signed') as signed,
       COUNT(*) FILTER (WHERE status='verified') as verified, COUNT(*) FILTER (WHERE status='pending') as pending,
       COUNT(*) FILTER (WHERE metadata->>'extension'='pdf') as pdfs,
       COUNT(*) FILTER (WHERE metadata->>'extension' IN ('doc','docx')) as words,
       COALESCE(SUM((metadata->>'size_bytes')::bigint),0) as total_size
       FROM documents WHERE user_id = $1`, [req.user.id]
    )).rows[0];
    return res.json({ total: parseInt(s.total), signed: parseInt(s.signed), verified: parseInt(s.verified), pending: parseInt(s.pending), pdfs: parseInt(s.pdfs), words: parseInt(s.words), total_size_mb: (parseInt(s.total_size)/(1024*1024)).toFixed(2) });
  } catch (err) { return res.status(500).json({ error: 'Error al obtener estadísticas' }); }
};

module.exports = { uploadDocument, getDocuments, getDocument, reanalyzeDocument, updateDocumentMeta, deleteDocument, getStats };