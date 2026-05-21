const pool = require('../config/db');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Groq = require('groq-sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const detectCategory = (filename) => {
  const name = filename.toLowerCase();
  const rules = [
    { keywords: ['contrato', 'contract', 'acuerdo', 'convenio'], category: 'Contrato' },
    { keywords: ['factura', 'invoice', 'recibo', 'cobro'], category: 'Factura' },
    { keywords: ['informe', 'report', 'reporte', 'análisis'], category: 'Informe' },
    { keywords: ['propuesta', 'proposal', 'cotización', 'oferta'], category: 'Propuesta' },
    { keywords: ['acta', 'minuta', 'reunión', 'meeting'], category: 'Acta' },
    { keywords: ['carta', 'letter', 'comunicado', 'memo', 'oficio'], category: 'Comunicado' },
    { keywords: ['certificado', 'certificate', 'diploma', 'constancia'], category: 'Certificado' },
    { keywords: ['poder', 'autorización', 'permiso'], category: 'Autorización' },
    { keywords: ['manual', 'guía', 'instructivo', 'procedimiento'], category: 'Manual' },
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
  ['urgente','confidencial','borrador','draft','final','aprobado','pendiente','revision','original','2024','2025','2026']
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

const extractMetadata = async (buffer, mimetype, originalname, size) => {
  const ext = originalname.split('.').pop().toLowerCase();
  const category = detectCategory(originalname);
  const base = {
    original_name: originalname, mime_type: mimetype,
    size_bytes: size, size_mb: (size / (1024 * 1024)).toFixed(2),
    size_kb: (size / 1024).toFixed(1), extension: ext,
    uploaded_at: new Date().toISOString(), category,
    tags: generateTags(originalname, category),
  };
  try {
    if (mimetype === 'application/pdf') {
      const data = await pdfParse(buffer);
      const info = data.info || {};
      return {
        ...base,
        pages: data.numpages || 0,
        author: info.Author || null, doc_title: info.Title || null,
        subject: info.Subject || null, creator: info.Creator || null,
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
        char_count: text.length, has_text: text.trim().length > 0,
        pages: Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 250)),
        text_preview: text.trim().slice(0, 500),
      };
    }
  } catch (err) {
    return { ...base, extraction_error: err.message };
  }
};

const generateDescriptionWithGroq = async (docId, metadata) => {
  try {
    if (!process.env.GROQ_API_KEY) return;
    const { original_name, extension, size_mb, pages, author, doc_title, subject, category, word_count, text_preview } = metadata;
    const prompt = `Eres un experto en gestión documental para BlockSign (firma digital blockchain).
Analiza estos metadatos y responde ÚNICAMENTE con JSON sin markdown:
Nombre: ${original_name}
Tipo: ${extension?.toUpperCase()}
Tamaño: ${size_mb} MB | Páginas: ${pages || '?'} | Palabras: ${word_count || 0}
Autor: ${author || 'desconocido'} | Título: ${doc_title || 'N/A'} | Asunto: ${subject || 'N/A'}
Categoría detectada: ${category}
${text_preview ? `Contenido inicial: "${text_preview.slice(0, 300)}"` : ''}

JSON exacto requerido:
{"description":"máximo 2 oraciones profesionales","tags":["tag1","tag2","tag3","tag4"],"category":"categoría","confidentiality":"Público|Interno|Confidencial|Secreto","summary":"resumen de 3-5 oraciones del propósito del documento"}`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      max_tokens: 600,
      temperature: 0.3,
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) return;
    const clean = text.replace(/```json|```/g, '').trim();
    const aiData = JSON.parse(clean);

    await pool.query(
      `UPDATE documents SET metadata = metadata || $1::jsonb WHERE id = $2`,
      [JSON.stringify({
        ai_description: aiData.description, ai_tags: aiData.tags,
        ai_category: aiData.category, ai_confidentiality: aiData.confidentiality,
        ai_summary: aiData.summary, ai_analyzed_at: new Date().toISOString(),
      }), docId]
    );
    console.log(`✅ Documento ${docId} analizado por Groq`);
  } catch (err) {
    console.error('ERROR GROQ:', err.message);
  }
};

const uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const { originalname, mimetype, size, buffer } = req.file;
    const userId = req.user.id;
    const allowed = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowed.includes(mimetype)) return res.status(400).json({ error: 'Solo PDF o Word' });
    if (size > 10 * 1024 * 1024) return res.status(400).json({ error: 'Máximo 10MB' });

    const fileName = `${userId}/${Date.now()}_${originalname.replace(/\s/g, '_')}`;
    const { error: storageError } = await supabase.storage.from('documents').upload(fileName, buffer, { contentType: mimetype, upsert: false });
    if (storageError) { console.error('STORAGE ERROR:', storageError); return res.status(500).json({ error: 'Error al subir el archivo' }); }

    const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const metadata = await extractMetadata(buffer, mimetype, originalname, size);

    const result = await pool.query(
      `INSERT INTO documents (user_id, title, file_url, file_hash, status, metadata) VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
      [userId, originalname, urlData.publicUrl, fileHash, JSON.stringify(metadata)]
    );

    generateDescriptionWithGroq(result.rows[0].id, metadata).catch(console.error);
    return res.status(201).json({ message: 'Documento subido exitosamente', document: result.rows[0] });
  } catch (err) {
    console.error('ERROR UPLOAD:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getDocuments = async (req, res) => {
  try {
    const userId = req.user.id;
    const { search, category, status, ext, date_from, date_to, page = 1, limit = 20 } = req.query;
    let query = `SELECT id, title, file_url, file_hash, status, metadata, created_at, updated_at FROM documents WHERE user_id = $1`;
    const params = [userId]; let i = 2;

    if (search) {
      query += ` AND (title ILIKE $${i} OR metadata->>'original_name' ILIKE $${i} OR metadata->>'category' ILIKE $${i} OR metadata->>'author' ILIKE $${i} OR metadata->>'ai_description' ILIKE $${i} OR metadata->>'ai_summary' ILIKE $${i})`;
      params.push(`%${search}%`); i++;
    }
    if (category && category !== 'Todos') { query += ` AND (metadata->>'category' = $${i} OR metadata->>'ai_category' = $${i})`; params.push(category); i++; }
    if (status && status !== 'Todos') { query += ` AND status = $${i}`; params.push(status); i++; }
    if (ext && ext !== 'Todos') { query += ` AND metadata->>'extension' = $${i}`; params.push(ext); i++; }
    if (date_from) { query += ` AND created_at >= $${i}`; params.push(date_from); i++; }
    if (date_to) { query += ` AND created_at <= $${i}`; params.push(date_to + ' 23:59:59'); i++; }

    const countResult = await pool.query(query.replace('SELECT id, title, file_url, file_hash, status, metadata, created_at, updated_at', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count);
    query += ` ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
    params.push(limit, (page - 1) * limit);
    const result = await pool.query(query, params);
    return res.json({ documents: result.rows, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) } });
  } catch (err) { return res.status(500).json({ error: 'Error al obtener documentos' }); }
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
    return res.json({ message: 'Análisis iniciado. Listo en unos segundos.' });
  } catch (err) { return res.status(500).json({ error: 'Error al re-analizar' }); }
};

const updateDocumentMeta = async (req, res) => {
  try {
    const { id } = req.params; const { category, tags, title } = req.body;
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
    const parts = result.rows[0].file_url.split('/storage/v1/object/public/documents/');
    if (parts[1]) await supabase.storage.from('documents').remove([parts[1]]);
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