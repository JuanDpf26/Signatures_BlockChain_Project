const pool = require('../config/db');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ────────────────────────────────────────────────
// DETECTAR CATEGORÍA POR NOMBRE
// ────────────────────────────────────────────────
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
    { keywords: ['poder', 'autorización', 'autorizacion', 'permiso'], category: 'Autorización' },
    { keywords: ['manual', 'guía', 'instructivo', 'procedimiento'], category: 'Manual' },
    { keywords: ['presupuesto', 'budget', 'estimado'], category: 'Presupuesto' },
  ];
  for (const rule of rules) {
    if (rule.keywords.some((kw) => name.includes(kw))) return rule.category;
  }
  return 'Documento';
};

// ────────────────────────────────────────────────
// GENERAR TAGS AUTOMÁTICOS
// ────────────────────────────────────────────────
const generateTags = (filename, category) => {
  const tags = new Set([category.toLowerCase()]);
  const name = filename.toLowerCase().replace(/[._-]/g, ' ');
  const keywords = ['urgente', 'confidencial', 'borrador', 'draft', 'final',
    'aprobado', 'pendiente', 'revision', 'original', '2024', '2025', '2026'];
  keywords.forEach((kw) => { if (name.includes(kw)) tags.add(kw); });
  const ext = filename.split('.').pop().toLowerCase();
  tags.add(ext === 'pdf' ? 'pdf' : 'word');
  return Array.from(tags).slice(0, 6);
};

// ────────────────────────────────────────────────
// FORMATEAR FECHA PDF
// ────────────────────────────────────────────────
const formatPdfDate = (pdfDate) => {
  try {
    if (typeof pdfDate === 'string' && pdfDate.startsWith('D:')) {
      const d = pdfDate.slice(2, 16);
      return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${d.slice(8,10)}:${d.slice(10,12)}`;
    }
    return pdfDate;
  } catch { return null; }
};

// ────────────────────────────────────────────────
// EXTRAER METADATOS REALES
// ────────────────────────────────────────────────
const extractMetadata = async (buffer, mimetype, originalname, size) => {
  const ext = originalname.split('.').pop().toLowerCase();
  const isPdf = mimetype === 'application/pdf';
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
    if (isPdf) {
      const data = await pdfParse(buffer);
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
        has_text: data.text && data.text.trim().length > 0,
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
      };
    }
  } catch (err) {
    console.error('Metadata extraction error:', err.message);
    return { ...base, extraction_error: err.message };
  }
};

// ────────────────────────────────────────────────
// SUBIR DOCUMENTO
// ────────────────────────────────────────────────
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

    const fileName = `${userId}/${Date.now()}_${originalname.replace(/\s/g, '_')}`;

    const { error: storageError } = await supabase.storage
      .from('documents')
      .upload(fileName, buffer, { contentType: mimetype, upsert: false });

    if (storageError) {
      console.error('STORAGE ERROR:', storageError);
      return res.status(500).json({ error: 'Error al subir el archivo' });
    }

    const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
    const fileUrl = urlData.publicUrl;
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const metadata = await extractMetadata(buffer, mimetype, originalname, size);

    const result = await pool.query(
      `INSERT INTO documents (user_id, title, file_url, file_hash, status, metadata)
       VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *`,
      [userId, originalname, fileUrl, fileHash, JSON.stringify(metadata)]
    );

    return res.status(201).json({
      message: 'Documento subido exitosamente',
      document: result.rows[0],
    });
  } catch (err) {
    console.error('ERROR UPLOAD:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// ────────────────────────────────────────────────
// LISTAR DOCUMENTOS CON FILTROS
// ────────────────────────────────────────────────
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
        OR metadata->>'category' ILIKE $${i} OR metadata->>'author' ILIKE $${i}
        OR metadata->>'doc_title' ILIKE $${i} OR metadata->>'subject' ILIKE $${i})`;
      params.push(`%${search}%`); i++;
    }
    if (category && category !== 'Todos') {
      query += ` AND metadata->>'category' = $${i}`;
      params.push(category); i++;
    }
    if (status && status !== 'Todos') {
      query += ` AND status = $${i}`;
      params.push(status); i++;
    }
    if (ext && ext !== 'Todos') {
      query += ` AND metadata->>'extension' = $${i}`;
      params.push(ext); i++;
    }
    if (date_from) {
      query += ` AND created_at >= $${i}`;
      params.push(date_from); i++;
    }
    if (date_to) {
      query += ` AND created_at <= $${i}`;
      params.push(date_to + ' 23:59:59'); i++;
    }

    const countResult = await pool.query(
      query.replace('SELECT id, title, file_url, file_hash, status, metadata, created_at, updated_at', 'SELECT COUNT(*)'),
      params
    );
    const total = parseInt(countResult.rows[0].count);

    query += ` ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
    params.push(limit, (page - 1) * limit);

    const result = await pool.query(query, params);
    return res.json({ documents: result.rows, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('ERROR GET DOCS:', err);
    return res.status(500).json({ error: 'Error al obtener documentos' });
  }
};

// ────────────────────────────────────────────────
// OBTENER DOCUMENTO (detalle)
// ────────────────────────────────────────────────
const getDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });
    return res.json({ document: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener documento' });
  }
};

// ────────────────────────────────────────────────
// ACTUALIZAR CATEGORÍA Y TAGS MANUALMENTE
// ────────────────────────────────────────────────
const updateDocumentMeta = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { category, tags, title } = req.body;

    const check = await pool.query('SELECT id FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });

    if (title) await pool.query('UPDATE documents SET title = $1 WHERE id = $2', [title, id]);

    const updates = { manually_edited: true, last_edited_at: new Date().toISOString() };
    if (category) updates.category = category;
    if (tags) updates.tags = Array.isArray(tags) ? tags : tags.split(',').map((t) => t.trim());

    await pool.query(`UPDATE documents SET metadata = metadata || $1::jsonb WHERE id = $2`, [JSON.stringify(updates), id]);

    const updated = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    return res.json({ message: 'Documento actualizado', document: updated.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Error al actualizar' });
  }
};

// ────────────────────────────────────────────────
// ELIMINAR DOCUMENTO
// ────────────────────────────────────────────────
const deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });

    const doc = result.rows[0];
    const urlParts = doc.file_url.split('/storage/v1/object/public/documents/');
    if (urlParts[1]) await supabase.storage.from('documents').remove([urlParts[1]]);

    await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    return res.json({ message: 'Documento eliminado' });
  } catch (err) {
    return res.status(500).json({ error: 'Error al eliminar documento' });
  }
};

// ────────────────────────────────────────────────
// ESTADÍSTICAS
// ────────────────────────────────────────────────
const getStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'signed') as signed,
        COUNT(*) FILTER (WHERE status = 'verified') as verified,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE metadata->>'extension' = 'pdf') as pdfs,
        COUNT(*) FILTER (WHERE metadata->>'extension' IN ('doc','docx')) as words,
        COALESCE(SUM((metadata->>'size_bytes')::bigint), 0) as total_size
       FROM documents WHERE user_id = $1`,
      [userId]
    );
    const s = result.rows[0];
    return res.json({
      total: parseInt(s.total), signed: parseInt(s.signed),
      verified: parseInt(s.verified), pending: parseInt(s.pending),
      pdfs: parseInt(s.pdfs), words: parseInt(s.words),
      total_size_mb: (parseInt(s.total_size) / (1024 * 1024)).toFixed(2),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
};

module.exports = { uploadDocument, getDocuments, getDocument, updateDocumentMeta, deleteDocument, getStats };