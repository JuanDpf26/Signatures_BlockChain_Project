const pool = require('../config/db');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const pdfParseLib = require('pdf-parse');
const mammoth = require('mammoth');
const Groq = require('groq-sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { logAudit } = require('../services/audit.service');
const { sendDocumentEmail } = require('../services/email.service');

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
  if (code === 'json_validate_failed' || /no devolvió JSON/i.test(err?.message || ''))
    return 'La IA no logró generar una respuesta válida para este documento. Intenta analizarlo de nuevo.';
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(err?.cause?.code || err?.code))
    return 'No hay conexión con api.groq.com (red o firewall).';
  return err?.message || String(err);
};

// Groq devuelve 400 "json_validate_failed" cuando el modelo no produce JSON
// (pasa sobre todo con modelos de razonamiento que gastan los tokens pensando).
const isJsonError = (err) => groqErrorCode(err) === 'json_validate_failed' || /JSON/i.test(err?.message || '');

/**
 * Pide una respuesta JSON a un modelo:
 * 1) con response_format json_object; 2) si falla la validación, sin él,
 * extrayendo el JSON del texto. Si tampoco sale, lanza el error.
 */
const groqJson = async (model, messages, maxTokens = 1500, temperature = 0.3) => {
  const base = { model, messages, max_tokens: maxTokens, temperature };
  // Los modelos gpt-oss razonan antes de responder: que piensen poco
  if (/gpt-oss/i.test(model)) base.reasoning_effort = 'low';
  try {
    const c = await groq.chat.completions.create({ ...base, response_format: { type: 'json_object' } });
    return parseJsonLoose(c.choices[0]?.message?.content);
  } catch (err) {
    if (!isJsonError(err)) throw err;
    console.warn(`⚠️ [IA] ${model} no devolvió JSON válido; reintentando sin modo JSON…`);
    const c = await groq.chat.completions.create({
      ...base,
      messages: [...messages, { role: 'user', content: 'Responde únicamente con el objeto JSON, sin texto adicional.' }],
    });
    return parseJsonLoose(c.choices[0]?.message?.content);
  }
};

const isModelError = (err) => {
  const code = groqErrorCode(err);
  return ['model_decommissioned', 'model_not_found', 'model_not_active'].includes(code)
    || (err?.status === 404)
    || /model/i.test(err?.message || '') && [400, 404].includes(err?.status);
};

// Guarda en qué etapa va el análisis para que la app muestre el proceso en vivo
const setAiStage = (docId, stage, extra = {}) =>
  pool
    .query(`UPDATE documents SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`, [
      JSON.stringify({ ai_stage: stage, ai_stage_at: new Date().toISOString(), ...extra }),
      docId,
    ])
    .catch(() => {});

const generateDescriptionWithGroq = async (docId, metadata) => {
  if (!process.env.GROQ_API_KEY) {
    console.log('⚠️ [IA] GROQ_API_KEY no configurada en el .env: no se analizan documentos');
    await setAiStage(docId, 'failed', {
      ai_error: 'GROQ_API_KEY no configurada en el servidor',
      ai_error_at: new Date().toISOString(),
    });
    return;
  }
  await setAiStage(docId, 'reading');

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
      await setAiStage(docId, 'thinking', { ai_trying_model: model });
      const aiData = await groqJson(model, [{ role: 'user', content: prompt }], 1500);

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
          ai_stage: 'done',
        }), docId]
      );

      console.log(`✅ [IA] Documento ${docId} analizado con ${model}`);
      pool.query('SELECT user_id FROM documents WHERE id = $1', [docId])
        .then(({ rows }) => logAudit({
          userId: rows[0]?.user_id, action: 'document.analyzed', description: `Análisis con IA completado (${model})`,
          resource: docId, result: 'permitido',
        }))
        .catch(() => {});
      return;
    } catch (err) {
      lastErr = err;
      if (isModelError(err)) {
        console.warn(`⚠️ [IA] Modelo ${model} no disponible (${groqErrorCode(err) || err.status}); probando el siguiente…`);
        continue;
      }
      if (isJsonError(err)) {
        console.warn(`⚠️ [IA] ${model} no generó un JSON válido; probando el siguiente modelo…`);
        continue;
      }
      break; // clave inválida, red, límite, JSON…: no sirve cambiar de modelo
    }
  }

  const reason = explainGroqError(lastErr);
  console.error(`❌ [IA] No se pudo analizar el documento ${docId}: ${reason}`);
  pool.query('SELECT user_id FROM documents WHERE id = $1', [docId])
    .then(({ rows }) => logAudit({
      userId: rows[0]?.user_id, action: 'document.analyze_failed', description: 'El análisis con IA falló',
      resource: docId, result: 'error', detail: { error: String(reason).slice(0, 200) },
    }))
    .catch(() => {});
  // Se guarda el motivo para poder verlo en los metadatos del documento
  await pool.query(
    `UPDATE documents SET metadata = metadata || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ ai_error: reason, ai_error_at: new Date().toISOString(), ai_stage: 'failed' }), docId]
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
        OR metadata->>'subject' ILIKE $${i} OR metadata->>'user_description' ILIKE $${i}
        OR metadata->>'tags' ILIKE $${i} OR metadata->>'ai_tags' ILIKE $${i})`;
      params.push(`%${search}%`); i++;
    }
    if (category && category !== 'Todos') {
      query += ` AND (CASE WHEN metadata->>'category_source' = 'manual' THEN metadata->>'category'
        ELSE COALESCE(metadata->>'ai_category', metadata->>'category') END) = $${i}`;
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

// ─────────────────────────────────────────
// EDICIÓN DE DOCUMENTOS
// ─────────────────────────────────────────
const CONFIDENTIALITY_LEVELS = ['Público', 'Interno', 'Confidencial', 'Secreto'];
const ALLOWED_MIMES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const IN_CHAIN = ['sending', 'confirming'];

// Lo que la app muestra: lo editado a mano tiene prioridad sobre lo que propuso la IA
const shownCategory = (m) => (m.category_source === 'manual' ? m.category : (m.ai_category || m.category)) || 'Documento';
const shownTags = (m) => (m.tags_source === 'manual' ? m.tags : (m.ai_tags || m.tags)) || [];

const cleanTags = (raw) => {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out = [];
  for (const t of list) {
    const v = String(t).trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, 30);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 15);
};

const pushHistory = (meta, entry) =>
  [entry, ...(Array.isArray(meta.edit_history) ? meta.edit_history : [])].slice(0, 20);

/**
 * PATCH /api/documents/:id
 * Edita nombre, descripción, categoría, etiquetas y confidencialidad.
 * No toca el archivo ni su huella: por eso también se permite en documentos firmados.
 */
const updateDocumentMeta = async (req, res) => {
  try {
    const { id } = req.params;
    const found = await pool.query('SELECT id, title, status, metadata FROM documents WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!found.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });

    const doc = found.rows[0];
    const meta = doc.metadata || {};
    const b = req.body || {};
    const changed = [];
    const updates = {};
    let newTitle = null;

    if (b.title !== undefined) {
      let t = String(b.title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
      if (!t) return res.status(400).json({ error: 'El nombre del documento no puede quedar vacío' });
      const ext = meta.extension ? `.${meta.extension}` : '';
      if (ext && !t.toLowerCase().endsWith(ext.toLowerCase())) t += ext;
      if (t !== doc.title) { newTitle = t; changed.push('nombre'); }
    }

    if (b.description !== undefined) {
      const d = String(b.description || '').trim().slice(0, 1000);
      if (d !== (meta.user_description || '')) { updates.user_description = d; changed.push('descripción'); }
    }

    if (b.category !== undefined) {
      const c = String(b.category || '').trim().slice(0, 40);
      if (!c) return res.status(400).json({ error: 'Elige una categoría' });
      if (c !== shownCategory(meta)) {
        updates.category = c;
        updates.category_source = 'manual';
        changed.push('categoría');
      }
    }

    if (b.tags !== undefined) {
      const tags = cleanTags(b.tags);
      if (JSON.stringify(tags) !== JSON.stringify(shownTags(meta))) {
        updates.tags = tags;
        updates.tags_source = 'manual';
        changed.push('etiquetas');
      }
    }

    if (b.confidentiality !== undefined) {
      const level = String(b.confidentiality || '').trim();
      if (!CONFIDENTIALITY_LEVELS.includes(level))
        return res.status(400).json({ error: `Confidencialidad no válida. Usa: ${CONFIDENTIALITY_LEVELS.join(', ')}` });
      if (level !== (meta.confidentiality || meta.ai_confidentiality)) {
        updates.confidentiality = level;
        changed.push('confidencialidad');
      }
    }

    if (!changed.length) {
      const current = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
      return res.json({ message: 'No había cambios para guardar', changed: [], document: current.rows[0] });
    }

    const now = new Date().toISOString();
    updates.manually_edited = true;
    updates.last_edited_at = now;
    updates.edit_history = pushHistory(meta, { at: now, fields: changed, by: req.user.id });

    const updated = await pool.query(
      `UPDATE documents SET title = COALESCE($1, title), metadata = metadata || $2::jsonb, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [newTitle, JSON.stringify(updates), id]
    );

    res.locals.auditDetail = { fields: changed };
    return res.json({ message: 'Documento actualizado', changed, document: updated.rows[0] });
  } catch (err) {
    console.error('ERROR UPDATE DOC:', err);
    return res.status(500).json({ error: 'Error al actualizar el documento' });
  }
};

/**
 * PUT /api/documents/:id/file
 * Sube una nueva versión del archivo. Solo mientras el documento NO esté firmado:
 * una vez firmado, su huella SHA-256 está anclada en blockchain y no puede cambiar.
 * Conserva lo editado a mano y guarda la versión anterior en metadata.versions.
 * ?analyze=0 → no lanza la IA aquí (la app la lanza para mostrar el proceso).
 */
const replaceDocumentFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const { id } = req.params;
    const found = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!found.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });

    const doc = found.rows[0];
    const meta = doc.metadata || {};
    if (doc.status !== 'pending')
      return res.status(409).json({ error: 'El documento ya está firmado: su huella está registrada en blockchain y el archivo no se puede reemplazar. Sube un documento nuevo.' });
    if (IN_CHAIN.includes(meta.blockchain_status))
      return res.status(409).json({ error: 'La firma de este documento se está registrando en blockchain. Espera a que termine.' });

    const { originalname, mimetype, size, buffer } = req.file;
    if (!ALLOWED_MIMES.includes(mimetype)) return res.status(400).json({ error: 'Solo se permiten archivos PDF o Word' });
    if (size > 10 * 1024 * 1024) return res.status(400).json({ error: 'El archivo no puede superar 10MB' });

    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (fileHash === doc.file_hash)
      return res.status(400).json({ error: 'Es exactamente el mismo archivo (la huella SHA-256 no cambió).' });

    const fileName = `${req.user.id}/${Date.now()}_${sanitizeFileName(originalname)}`;
    const { error: storageError } = await supabase.storage
      .from('documents')
      .upload(fileName, buffer, { contentType: mimetype, upsert: false });
    if (storageError) {
      console.error('STORAGE ERROR (reemplazo):', storageError);
      return res.status(500).json({ error: 'Error al subir el archivo' });
    }
    const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
    const extracted = await extractMetadata(buffer, mimetype, originalname, size);

    // Lo que el usuario editó a mano se conserva; lo de la IA se recalcula
    const keep = {};
    if (meta.category_source === 'manual') Object.assign(keep, { category: meta.category, category_source: 'manual' });
    if (meta.tags_source === 'manual') Object.assign(keep, { tags: meta.tags, tags_source: 'manual' });
    if (meta.user_description) keep.user_description = meta.user_description;
    if (meta.confidentiality) keep.confidentiality = meta.confidentiality;

    const now = new Date().toISOString();
    const version = (parseInt(meta.version, 10) || 1) + 1;
    const versions = [
      {
        version: version - 1,
        file_hash: doc.file_hash,
        file_url: doc.file_url,
        name: meta.original_name || doc.title,
        size_mb: meta.size_mb ?? null,
        uploaded_at: meta.uploaded_at || doc.created_at,
        replaced_at: now,
      },
      ...(Array.isArray(meta.versions) ? meta.versions : []),
    ].slice(0, 10);

    const newMeta = {
      ...extracted,
      ...keep,
      version,
      versions,
      manually_edited: true,
      last_edited_at: now,
      edit_history: pushHistory(meta, { at: now, fields: [`archivo (v${version})`], by: req.user.id }),
    };

    // Si el nombre nunca se cambió a mano, se usa el del archivo nuevo
    const renamedByUser = meta.original_name && doc.title !== meta.original_name;
    const title = renamedByUser ? doc.title : originalname;

    const updated = await pool.query(
      `UPDATE documents SET title = $1, file_url = $2, file_hash = $3, metadata = $4::jsonb, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [title, urlData.publicUrl, fileHash, JSON.stringify(newMeta), id]
    );

    if (String(req.query.analyze) !== '0') generateDescriptionWithGroq(id, newMeta).catch(console.error);

    res.locals.auditDetail = { version, previous_hash: doc.file_hash.slice(0, 16), new_hash: fileHash.slice(0, 16) };
    return res.json({ message: `Archivo reemplazado. Ahora es la versión ${version}.`, version, document: updated.rows[0] });
  } catch (err) {
    console.error('ERROR REPLACE FILE:', err);
    return res.status(500).json({ error: 'Error al reemplazar el archivo' });
  }
};

// ─────────────────────────────────────────
// ENVIAR DOCUMENTO POR CORREO
// ─────────────────────────────────────────
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
const MAX_ATTACH_BYTES = 15 * 1024 * 1024; // Gmail acepta hasta 25 MB; dejamos margen

/**
 * POST /api/documents/:id/send
 * body: { recipients: string[] (1–5), message?: string, subject?: string, attach?: boolean }
 */
const sendDocumentByEmail = async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const raw = Array.isArray(b.recipients) ? b.recipients : String(b.recipients || '').split(/[,;\s]+/);
    const emails = [...new Set(raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    const teamIds = [...new Set((Array.isArray(b.teams) ? b.teams : []).map(String).filter((t) => /^[0-9a-f-]{36}$/i.test(t)))];
    if (!emails.length && !teamIds.length) return res.status(400).json({ error: 'Escribe al menos un correo o elige un equipo' });
    if (emails.length > 5) return res.status(400).json({ error: 'Puedes escribir máximo 5 correos a la vez (para más personas, usa un equipo)' });
    const bad = emails.filter((e) => !EMAIL_RE.test(e) || e.length > 120);
    if (bad.length) return res.status(400).json({ error: `Correo no válido: ${bad.join(', ')}` });

    const kind = b.kind === 'review' ? 'review' : 'info';
    const message = String(b.message || '').trim().slice(0, 2000);
    const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
    const wantAttach = b.attach !== false;

    const [found, me] = await Promise.all([
      pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, req.user.id]),
      pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]),
    ]);
    if (!found.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
    const doc = found.rows[0];
    const meta = doc.metadata || {};
    const sender = me.rows[0] || { name: null, email: null };
    if (!sender.email) return res.status(400).json({ error: 'Tu cuenta no tiene un correo registrado' });
    const myEmail = sender.email.toLowerCase();

    // Destinatarios: correos escritos + miembros de los equipos elegidos (sin repetir y sin incluirte)
    const recipients = new Map(); // email -> { email, userId, name, teamId }
    if (emails.length) {
      const reg = await pool.query('SELECT id, name, email FROM users WHERE lower(email) = ANY($1)', [emails]);
      const byEmail = Object.fromEntries(reg.rows.map((u) => [u.email.toLowerCase(), u]));
      for (const e of emails) {
        if (e === myEmail) continue;
        recipients.set(e, { email: e, userId: byEmail[e] ? String(byEmail[e].id) : null, name: byEmail[e]?.name || null, teamId: null });
      }
    }
    const teamNames = [];
    for (const t of teamIds) {
      const mine = await pool.query('SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id WHERE t.id = $1 AND m.user_id = $2', [t, String(req.user.id)]);
      if (!mine.rows.length) return res.status(403).json({ error: 'Solo puedes enviar a equipos de los que eres parte' });
      teamNames.push(mine.rows[0].name);
      const mem = await pool.query(
        'SELECT u.id, u.name, u.email FROM team_members m JOIN users u ON u.id::text = m.user_id WHERE m.team_id = $1',
        [t]
      );
      for (const u of mem.rows) {
        const e = String(u.email || '').toLowerCase();
        if (!e || e === myEmail || recipients.has(e)) continue;
        recipients.set(e, { email: e, userId: String(u.id), name: u.name, teamId: t });
      }
    }
    const list = [...recipients.values()];
    if (!list.length) return res.status(400).json({ error: 'No hay a quién enviarlo (el equipo solo te tiene a ti)' });
    if (list.length > 50) return res.status(400).json({ error: 'Máximo 50 destinatarios por envío' });

    // Adjuntar el archivo (si no es muy grande); si no, se manda el enlace de descarga
    let attachment = null;
    let attachNote = null;
    if (wantAttach) {
      const sizeBytes = Number(meta.size_bytes) || 0;
      if (sizeBytes > MAX_ATTACH_BYTES) {
        attachNote = 'El archivo es muy grande para adjuntarlo; se envió el enlace de descarga.';
      } else {
        try {
          const r = await fetch(doc.file_url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const content = Buffer.from(await r.arrayBuffer());
          const ext = meta.extension ? `.${meta.extension}` : '';
          const filename = doc.title.toLowerCase().endsWith(ext.toLowerCase()) ? doc.title : `${doc.title}${ext}`;
          attachment = { filename, content, contentType: meta.mime_type || undefined };
        } catch (e) {
          console.warn('[envío] No se pudo descargar el archivo para adjuntarlo:', e.message);
          attachNote = 'No se pudo adjuntar el archivo; se envió el enlace de descarga.';
        }
      }
    }

    const signed = ['signed', 'verified'].includes(doc.status);
    const docInfo = {
      title: doc.title,
      hash: doc.file_hash,
      signed,
      txHash: meta.blockchain_tx || doc.blockchain_tx || null,
      blockNumber: meta.blockchain_block ?? null,
      explorerUrl: meta.blockchain_explorer || null,
      signedAt: meta.signed_at || null,
      fileUrl: doc.file_url,
    };

    // Correo: personas con cuenta (también lo verán en su bandeja) y personas sin cuenta.
    // Con varios destinatarios se usa copia oculta para no exponer los correos de todos.
    const inApp = list.filter((r) => r.userId).map((r) => r.email);
    const outside = list.filter((r) => !r.userId).map((r) => r.email);
    const groups = [[inApp, true], [outside, false]].filter(([g]) => g.length);
    for (const [g, isIn] of groups) {
      await sendDocumentEmail({
        to: g.length === 1 ? g[0] : sender.email,
        bcc: g.length === 1 ? undefined : g.join(', '),
        sender, subject, message, attachment, kind, inApp: isIn, doc: docInfo,
      });
    }

    // Bandeja de entrada: un registro por destinatario, agrupados por envío (batch)
    const batch = crypto.randomUUID();
    try {
      const values = [];
      const params = [];
      list.forEach((r, i) => {
        const o = i * 10;
        values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`);
        params.push(batch, String(doc.id), String(req.user.id), r.userId, r.email, r.teamId, subject || null, message || null, kind, !!attachment);
      });
      await pool.query(
        `INSERT INTO document_shares (batch_id, document_id, sender_id, recipient_id, recipient_email, team_id, subject, message, kind, attached)
         VALUES ${values.join(',')}`,
        params
      );
    } catch (e) {
      console.error('[bandeja] No se pudo guardar el envío en la bandeja:', e.message);
    }

    const now = new Date().toISOString();
    const shares = [
      { at: now, to: list.map((r) => r.email), teams: teamNames, kind, attached: !!attachment, signed },
      ...(Array.isArray(meta.shares) ? meta.shares : []),
    ].slice(0, 30);
    await pool.query(`UPDATE documents SET metadata = metadata || $1::jsonb WHERE id = $2`, [
      JSON.stringify({ shares, last_shared_at: now }),
      id,
    ]);

    res.locals.auditDetail = { recipients: list.length, in_app: inApp.length, teams: teamNames, kind, attached: !!attachment };
    return res.json({
      message: `Documento enviado a ${list.length} persona${list.length === 1 ? '' : 's'}`,
      sent_to: list.map((r) => r.email),
      in_app: inApp.length,
      teams: teamNames,
      kind,
      attached: !!attachment,
      note: attachNote,
      shares,
    });
  } catch (err) {
    console.error('ERROR SEND DOC:', err);
    const auth = /Invalid login|EAUTH|535/i.test(`${err.code} ${err.message}`);
    return res.status(502).json({
      error: auth
        ? 'El servidor de correo rechazó el inicio de sesión. Revisa EMAIL_USER y EMAIL_PASS (contraseña de aplicación de Gmail).'
        : `No se pudo enviar el correo: ${err.message || 'error desconocido'}`,
    });
  }
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
    const uid = req.user.id;
    // Fecha de firma segura (si el texto no es una fecha, queda NULL en vez de fallar)
    const SIGNED_AT = `CASE WHEN metadata->>'signed_at' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (metadata->>'signed_at')::timestamptz END`;
    const [base, extra, conf, activity] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='signed') as signed,
         COUNT(*) FILTER (WHERE status='verified') as verified, COUNT(*) FILTER (WHERE status='pending') as pending,
         COUNT(*) FILTER (WHERE metadata->>'extension'='pdf') as pdfs,
         COUNT(*) FILTER (WHERE metadata->>'extension' IN ('doc','docx')) as words,
         COALESCE(SUM((metadata->>'size_bytes')::bigint),0) as total_size
         FROM documents WHERE user_id = $1`, [uid]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('signed','verified') AND ${SIGNED_AT} >= date_trunc('month', NOW())) AS signed_month,
           AVG(EXTRACT(EPOCH FROM (${SIGNED_AT} - created_at)) / 3600) FILTER (WHERE status IN ('signed','verified')) AS avg_hours_to_sign,
           COUNT(*) FILTER (WHERE metadata ? 'ai_analyzed_at') AS analyzed,
           COUNT(*) FILTER (WHERE metadata ? 'ai_error' AND NOT metadata ? 'ai_analyzed_at') AS ai_errors,
           COUNT(*) FILTER (WHERE (metadata->>'revoked')::text = 'true') AS revoked,
           COUNT(*) FILTER (WHERE metadata->>'blockchain_status' IN ('sending','confirming')) AS in_chain,
           COALESCE(SUM(CASE WHEN metadata->>'blockchain_fee_eth' ~ '^[0-9.]+$' THEN (metadata->>'blockchain_fee_eth')::numeric END), 0) AS gas_eth,
           MAX(CASE WHEN metadata->>'blockchain_block' ~ '^[0-9]+$' THEN (metadata->>'blockchain_block')::bigint END) AS last_block,
           COALESCE(SUM(CASE WHEN metadata->>'pages' ~ '^[0-9]+$' THEN (metadata->>'pages')::int END), 0) AS pages
         FROM documents WHERE user_id = $1`, [uid]
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(metadata->>'confidentiality',''), NULLIF(metadata->>'ai_confidentiality',''), 'Sin analizar') AS level, COUNT(*)::int AS n
           FROM documents WHERE user_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [uid]
      ),
      pool.query(
        `WITH days AS (
           SELECT generate_series((NOW() AT TIME ZONE 'America/Bogota')::date - 6, (NOW() AT TIME ZONE 'America/Bogota')::date, '1 day')::date AS day
         )
         SELECT d.day,
           (SELECT COUNT(*) FROM documents x WHERE x.user_id = $1 AND (x.created_at AT TIME ZONE 'America/Bogota')::date = d.day)::int AS uploaded,
           (SELECT COUNT(*) FROM documents x WHERE x.user_id = $1 AND x.status IN ('signed','verified')
              AND (CASE WHEN x.metadata->>'signed_at' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN ((x.metadata->>'signed_at')::timestamptz AT TIME ZONE 'America/Bogota')::date END) = d.day)::int AS signed
         FROM days d ORDER BY d.day`, [uid]
      ),
    ]);
    const s = base.rows[0];
    const e = extra.rows[0];
    const total = parseInt(s.total);
    return res.json({
      total, signed: parseInt(s.signed), verified: parseInt(s.verified), pending: parseInt(s.pending),
      pdfs: parseInt(s.pdfs), words: parseInt(s.words),
      total_size_mb: (parseInt(s.total_size) / (1024 * 1024)).toFixed(2),
      signed_month: parseInt(e.signed_month) || 0,
      avg_hours_to_sign: e.avg_hours_to_sign != null ? Number(Number(e.avg_hours_to_sign).toFixed(1)) : null,
      analyzed: parseInt(e.analyzed) || 0,
      analyzed_pct: total ? Math.round((parseInt(e.analyzed) * 100) / total) : 0,
      ai_errors: parseInt(e.ai_errors) || 0,
      revoked: parseInt(e.revoked) || 0,
      in_chain: parseInt(e.in_chain) || 0,
      gas_eth: Number(e.gas_eth || 0).toFixed(6),
      last_block: e.last_block != null ? Number(e.last_block) : null,
      pages: parseInt(e.pages) || 0,
      confidentiality: conf.rows,
      activity: activity.rows.map((r) => ({ day: r.day, uploaded: r.uploaded, signed: r.signed })),
    });
  } catch (err) {
    console.error('ERROR STATS:', err.message);
    return res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
};

module.exports = {
  uploadDocument,
  getDocuments,
  getDocument,
  reanalyzeDocument,
  updateDocumentMeta,
  replaceDocumentFile,
  sendDocumentByEmail,
  deleteDocument,
  getStats,
  // usados por el asistente IA
  parsePdf,
  GROQ_MODELS,
  explainGroqError,
  isModelError,
  parseJsonLoose,
  groqJson,
  isJsonError,
};