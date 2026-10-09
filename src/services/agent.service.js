// ────────────────────────────────────────────────
// ASISTENTE IA DE BLOCKSIGN ("Sign IA")
//
// Un agente con herramientas (tool calling de Groq). El modelo decide qué
// herramienta usar, el servidor la ejecuta SIEMPRE con el usuario de la
// sesión (nunca ve documentos de otros) y le devuelve el resultado.
// El agente no firma ni borra nada por su cuenta: solo propone acciones que
// el usuario confirma en la app.
// ────────────────────────────────────────────────
const Groq = require('groq-sdk');
const pool = require('../config/db');
const {
  parsePdf,
  GROQ_MODELS,
  explainGroqError,
  isModelError,
  groqJson,
  isJsonError,
} = require('../controllers/documentController');
const { buildVerification } = require('../controllers/signing.controller');
const { getNetworkInfo } = require('./blockchain.service');

const groq = new Groq({ apiKey: (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '') }); // tolera espacios o comillas pegados en el panel de Render
const mammoth = require('mammoth');

const MAX_TOOL_ROUNDS = 5;
const STATUS_ES = { pending: 'pendiente', signed: 'firmado', verified: 'verificado', rejected: 'rechazado' };

// ── Definición de herramientas (lo que el modelo puede pedir) ──────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_my_stats',
      description: 'Resumen de la cuenta del usuario: total de documentos, pendientes, firmados, verificados y espacio usado.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_documents',
      description:
        'Busca documentos del usuario por texto (título, categoría o etiquetas) y/o estado. Úsala para listar, encontrar o contar documentos.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto a buscar. Vacío para todos.' },
          status: { type: 'string', enum: ['pending', 'signed', 'verified', 'any'], description: 'Filtrar por estado' },
          limit: { type: 'integer', description: 'Máximo de resultados (1-10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_document_details',
      description: 'Ficha completa de un documento: análisis de IA, metadatos, estado de la firma y datos de blockchain.',
      parameters: {
        type: 'object',
        properties: { document_id: { type: 'string', description: 'ID del documento (UUID)' } },
        required: ['document_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review_document',
      description:
        'Lee el contenido completo de un documento y hace una revisión antes de firmar: nivel de riesgo, partes, fechas, montos, cláusulas a revisar y campos vacíos.',
      parameters: {
        type: 'object',
        properties: { document_id: { type: 'string', description: 'ID del documento (UUID)' } },
        required: ['document_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_document',
      description: 'Responde una pregunta concreta sobre el contenido de un documento (fechas, partes, valores, obligaciones…).',
      parameters: {
        type: 'object',
        properties: {
          document_id: { type: 'string', description: 'ID del documento (UUID)' },
          question: { type: 'string', description: 'La pregunta del usuario' },
        },
        required: ['document_id', 'question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_hash',
      description: 'Verifica en blockchain una huella SHA-256 de 64 caracteres hexadecimales.',
      parameters: {
        type: 'object',
        properties: { hash: { type: 'string', description: 'Huella SHA-256 (64 caracteres)' } },
        required: ['hash'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_network_status',
      description: 'Estado de la red Ethereum Sepolia y del contrato de DocBlockSign (bloque actual, documentos registrados, saldo).',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const STEP_LABEL = {
  get_my_stats: 'Revisó el resumen de tu cuenta',
  search_documents: 'Buscó en tus documentos',
  get_document_details: 'Consultó la ficha del documento',
  review_document: 'Leyó y revisó el documento',
  ask_document: 'Buscó la respuesta en el documento',
  verify_hash: 'Verificó la huella en blockchain',
  get_network_status: 'Consultó la red Sepolia',
};

// ── Utilidades ─────────────────────────────────────────────────────────
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''));

const findDocument = async (userId, documentId) => {
  if (!isUuid(documentId)) return null;
  const r = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [documentId, userId]);
  return r.rows[0] || null;
};

const docBrief = (d) => {
  const m = d.metadata || {};
  return {
    id: d.id,
    title: d.title,
    status: STATUS_ES[d.status] || d.status,
    in_blockchain_process: ['sending', 'confirming'].includes(m.blockchain_status),
    category: (m.category_source === 'manual' ? m.category : (m.ai_category || m.category)) || null,
    description: m.user_description || undefined,
    uploaded: d.created_at,
    pages: m.pages || null,
  };
};

// Texto completo del archivo (se descarga de Supabase y se extrae)
const textCache = new Map();
const getDocumentText = async (doc) => {
  if (textCache.has(doc.id)) return textCache.get(doc.id);
  const m = doc.metadata || {};
  let text = '';
  try {
    const resp = await fetch(doc.file_url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    if ((m.extension || '').toLowerCase() === 'pdf' || m.mime_type === 'application/pdf') {
      text = (await parsePdf(buffer)).text || '';
    } else {
      text = (await mammoth.extractRawText({ buffer })).value || '';
    }
  } catch (err) {
    console.error(`[agente] No se pudo leer ${doc.id}:`, err.message);
    text = m.text_preview || '';
  }
  text = text.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (textCache.size > 50) textCache.clear();
  textCache.set(doc.id, text);
  return text;
};

// Llama a Groq probando los modelos en orden
const chat = async (payload) => {
  let lastErr;
  for (const model of GROQ_MODELS) {
    try {
      const extra = /gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {};
      const completion = await groq.chat.completions.create({ model, ...extra, ...payload });
      return { completion, model };
    } catch (err) {
      lastErr = err;
      const code = err?.error?.error?.code || err?.error?.code || '';
      // Modelo retirado o tool call mal formada: probamos el siguiente
      if (isModelError(err) || code === 'tool_use_failed') continue;
      throw err;
    }
  }
  throw lastErr;
};

// ── Revisión antes de firmar ───────────────────────────────────────────
const reviewDocument = async (doc) => {
  const m = doc.metadata || {};
  if (m.ai_review && m.ai_review_hash === doc.file_hash) return m.ai_review; // ya revisado

  const text = await getDocumentText(doc);
  if (!text) return { error: 'El documento no tiene texto legible (puede ser un escaneo).' };

  const reviewMessages = [
      {
        role: 'system',
        content:
          'Eres un asistente que revisa documentos antes de que una persona los firme. No eres abogado: das una revisión orientativa, clara y en español. Responde SOLO con JSON.',
      },
      {
        role: 'user',
        content: `Revisa este documento titulado "${doc.title}" y devuelve un JSON con esta forma exacta:
{
  "risk": "bajo" | "medio" | "alto",
  "summary": "2 frases sobre qué es y qué implica firmarlo",
  "parties": ["partes o personas que intervienen"],
  "dates": ["fechas o plazos importantes con su significado"],
  "amounts": ["valores o montos con su concepto"],
  "alerts": [{"level": "alto"|"medio"|"bajo", "text": "cláusula o punto que conviene revisar y por qué"}],
  "missing": ["campos vacíos, firmas faltantes o datos incompletos"],
  "recommendation": "una frase: si se puede firmar o qué revisar antes"
}
Máximo 5 alertas. Listas vacías si no aplica.

TEXTO:
"""${text.slice(0, 14000)}"""`,
      },
    ];
  let review;
  let lastErr;
  for (const model of GROQ_MODELS) {
    try {
      review = await groqJson(model, reviewMessages, 2000, 0.2);
      break;
    } catch (err) {
      lastErr = err;
      if (isModelError(err) || isJsonError(err)) continue;
      throw err;
    }
  }
  if (!review) throw lastErr;
  review.reviewed_at = new Date().toISOString();
  await pool.query(
    `UPDATE documents SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ ai_review: review, ai_review_hash: doc.file_hash }), doc.id]
  );
  return review;
};

// ── Ejecutar una herramienta (siempre con el usuario de la sesión) ─────
const runTool = async (name, args, user, ui) => {
  switch (name) {
    case 'get_my_stats': {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'signed')::int AS signed,
                COUNT(*) FILTER (WHERE status = 'verified')::int AS verified,
                COALESCE(SUM((metadata->>'size_bytes')::bigint), 0)::bigint AS bytes
           FROM documents WHERE user_id = $1`,
        [user.id]
      );
      const s = r.rows[0];
      return { ...s, size_mb: (Number(s.bytes) / 1048576).toFixed(2), bytes: undefined };
    }

    case 'search_documents': {
      const params = [user.id];
      let where = 'user_id = $1';
      if (args.query) {
        params.push(`%${String(args.query).slice(0, 80)}%`);
        where += ` AND (title ILIKE $${params.length} OR metadata->>'ai_category' ILIKE $${params.length}
                   OR metadata->>'ai_description' ILIKE $${params.length} OR metadata::text ILIKE $${params.length})`;
      }
      if (args.status && args.status !== 'any') {
        params.push(args.status);
        where += ` AND status = $${params.length}`;
      }
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 10);
      const r = await pool.query(
        `SELECT id, title, status, metadata, created_at FROM documents WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`,
        params
      );
      const docs = r.rows.map(docBrief);
      docs.slice(0, 3).forEach((d) => ui.actions.push({ type: 'open_document', documentId: d.id, label: `Ver "${d.title}"` }));
      return { count: docs.length, documents: docs };
    }

    case 'get_document_details': {
      const d = await findDocument(user.id, args.document_id);
      if (!d) return { error: 'Documento no encontrado en tu cuenta' };
      const m = d.metadata || {};
      ui.actions.push({ type: 'open_document', documentId: d.id, label: `Ver "${d.title}"` });
      if (d.status === 'pending' && !['sending', 'confirming'].includes(m.blockchain_status)) {
        ui.actions.push({ type: 'sign_document', documentId: d.id, title: d.title, label: 'Firmar este documento' });
      }
      return {
        ...docBrief(d),
        description: m.ai_description || null,
        summary: m.ai_summary || null,
        tags: m.ai_tags || [],
        confidentiality: m.confidentiality || m.ai_confidentiality || null,
        author: m.author || null,
        words: m.word_count || null,
        sha256: d.file_hash,
        signed_at: m.signed_at || null,
        signer: m.signer_email || null,
        blockchain_tx: m.blockchain_tx || d.blockchain_tx || null,
        blockchain_block: m.blockchain_block || null,
      };
    }

    case 'review_document': {
      const d = await findDocument(user.id, args.document_id);
      if (!d) return { error: 'Documento no encontrado en tu cuenta' };
      const review = await reviewDocument(d);
      if (!review.error) {
        ui.cards.push({ type: 'review', documentId: d.id, title: d.title, ...review });
        if (d.status === 'pending') {
          ui.actions.push({ type: 'sign_document', documentId: d.id, title: d.title, label: 'Firmar este documento' });
        }
      }
      return review;
    }

    case 'ask_document': {
      const d = await findDocument(user.id, args.document_id);
      if (!d) return { error: 'Documento no encontrado en tu cuenta' };
      const text = await getDocumentText(d);
      if (!text) return { error: 'El documento no tiene texto legible' };
      ui.actions.push({ type: 'open_document', documentId: d.id, label: `Ver "${d.title}"` });
      // Se le pasa al modelo el texto relevante (hasta ~14k caracteres)
      return { title: d.title, question: args.question, content: text.slice(0, 14000), truncated: text.length > 14000 };
    }

    case 'verify_hash': {
      const h = String(args.hash || '').trim().toLowerCase().replace(/^0x/, '');
      const r = await buildVerification(h);
      ui.actions.push({ type: 'go_verify', label: 'Abrir Verificar' });
      return {
        verdict: r.verdict,
        message: r.message,
        document_title: r.blockchain?.documentTitle || r.document?.title || null,
        signer: r.blockchain?.signerEmail || null,
        signed_at: r.blockchain?.signedAt || null,
        block: r.transaction?.blockNumber || null,
      };
    }

    case 'get_network_status':
      return getNetworkInfo();

    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
};

// ── Bucle del agente ───────────────────────────────────────────────────
const systemPrompt = (user, context) => `Eres "Sign IA", el asistente inteligente de DocBlockSign, una plataforma de firma digital de documentos con huella SHA-256 y registro en la blockchain Ethereum Sepolia.
Hablas con ${user.name || 'el usuario'}. Responde SIEMPRE en español, de forma breve, cálida y clara (máximo ~120 palabras salvo que pidan detalle). Usa **negritas** para lo importante y listas cortas con "- " cuando ayuden.

Reglas:
- Para cualquier dato de sus documentos usa las herramientas; nunca inventes documentos, fechas, montos ni hashes.
- Si el usuario menciona un documento por nombre, primero búscalo con search_documents para obtener su id.
- Si pide revisar, analizar riesgos o "¿lo puedo firmar?", usa review_document. La app mostrará una tarjeta con el detalle: tú resume el riesgo y la recomendación en 2-3 frases.
- Tú no puedes firmar, borrar ni modificar nada. Si quiere firmar, dile que puede hacerlo con el botón que aparece debajo de tu mensaje.
- Aclara que tu revisión es orientativa y no reemplaza asesoría legal cuando hables de riesgos de un contrato.
- Si te preguntan cómo funciona DocBlockSign: la huella SHA-256 identifica el archivo exacto; al firmar se registra en un contrato inteligente en Sepolia; verificar compara la huella del archivo con ese registro.
${context?.documentId ? `- El usuario está viendo el documento con id ${context.documentId}${context.documentTitle ? ` ("${context.documentTitle}")` : ''}; si dice "este documento", se refiere a ese.` : ''}
Fecha actual: ${new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full' })}.`;

const runAgent = async ({ user, messages, context }) => {
  if (!process.env.GROQ_API_KEY) throw new Error('Falta GROQ_API_KEY en el .env');

  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!history.length || history[history.length - 1].role !== 'user') throw new Error('Falta el mensaje del usuario');

  const convo = [{ role: 'system', content: systemPrompt(user, context) }, ...history];
  const ui = { steps: [], actions: [], cards: [] };
  let usedModel = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { completion, model } = await chat({
      messages: convo,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 900,
    });
    usedModel = model;
    const msg = completion.choices[0].message;
    const calls = msg.tool_calls || [];

    if (!calls.length) {
      return finish(msg.content, ui, usedModel);
    }

    convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (_) { /* argumentos vacíos */ }
      let result;
      try {
        result = await runTool(call.function.name, args, user, ui);
      } catch (err) {
        console.error(`[agente] ${call.function.name} falló:`, err.message);
        result = { error: explainGroqError(err) };
      }
      ui.steps.push({ tool: call.function.name, label: STEP_LABEL[call.function.name] || call.function.name, ok: !result?.error });
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 16000) });
    }
  }

  // Demasiadas vueltas: pedimos una respuesta final sin herramientas
  const { completion } = await chat({ messages: convo, temperature: 0.3, max_tokens: 700 });
  return finish(completion.choices[0].message.content, ui, usedModel);
};

const finish = (content, ui, model) => {
  // Acciones únicas (sin repetir el mismo botón)
  const seen = new Set();
  const actions = ui.actions.filter((a) => {
    const k = `${a.type}:${a.documentId || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    reply: (content || '').trim() || 'Listo.',
    steps: ui.steps,
    actions: actions.slice(0, 4),
    cards: ui.cards,
    model,
  };
};

module.exports = { runAgent, explainGroqError };
