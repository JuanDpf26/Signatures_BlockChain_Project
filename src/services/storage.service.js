/**
 * Acceso privado a los archivos guardados en Supabase Storage.
 *
 * En la base de datos se guarda la dirección "pública" del archivo solo como
 * referencia de su ubicación. Hacia afuera nunca se entrega esa dirección: se
 * entrega un enlace firmado que vence (por defecto en 1 hora). Con el bucket
 * en privado, quien tenga una dirección vieja ya no puede abrir el archivo.
 */
const supabase = require('../config/supabase');

const HOUR = 60 * 60;
const EMAIL_TTL = 7 * 24 * HOUR; // enlaces que van en correos

/** Ruta interna del archivo dentro del bucket, a partir de cualquier URL de Storage */
const pathFromUrl = (url, bucket = 'documents') => {
  const m = String(url || '').match(new RegExp(`/storage/v1/object/(?:public|sign|authenticated)/${bucket}/([^?#]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};

/** Enlace firmado para un archivo; si algo falla devuelve null (nunca la dirección pública) */
const signedUrl = async (url, { bucket = 'documents', ttl = HOUR } = {}) => {
  const path = pathFromUrl(url, bucket);
  if (!path) return url || null; // no es de Storage (p. ej. datos de prueba locales)
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttl);
  if (error || !data?.signedUrl) {
    console.warn(`[storage] No se pudo firmar ${bucket}/${path}:`, error?.message);
    return null;
  }
  return data.signedUrl;
};

/** Firma de una sola vez el campo `key` de varias filas */
const signRows = async (rows, { key = 'file_url', bucket = 'documents', ttl = HOUR } = {}) => {
  const paths = rows.map((r) => pathFromUrl(r[key], bucket));
  const wanted = [...new Set(paths.filter(Boolean))];
  const byPath = new Map();
  if (wanted.length) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(wanted, ttl);
    if (error) console.warn('[storage] No se pudieron firmar los enlaces:', error.message);
    for (const it of data || []) if (it?.signedUrl && !it.error) byPath.set(it.path, it.signedUrl);
  }
  return rows.map((r, i) => (paths[i] ? { ...r, [key]: byPath.get(paths[i]) || null } : r));
};

/** Descarga el archivo desde el servidor (para adjuntos, análisis y el asistente) */
const download = async (url, { bucket = 'documents' } = {}) => {
  const path = pathFromUrl(url, bucket);
  if (!path) {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) throw new Error(error.message || 'No se pudo descargar el archivo');
  return Buffer.from(await data.arrayBuffer());
};

/**
 * Documentos listos para enviar a la app: firma el archivo actual y el de
 * cada versión anterior (historial) en una sola llamada a Storage.
 */
const signDocs = async (docs, { ttl = HOUR } = {}) => {
  const all = [];
  for (const d of docs) {
    all.push(d.file_url);
    for (const v of Array.isArray(d.metadata?.versions) ? d.metadata.versions : []) all.push(v?.file_url);
  }
  const wanted = [...new Set(all.map((u) => pathFromUrl(u)).filter(Boolean))];
  const byPath = new Map();
  if (wanted.length) {
    const { data, error } = await supabase.storage.from('documents').createSignedUrls(wanted, ttl);
    if (error) console.warn('[storage] No se pudieron firmar los enlaces:', error.message);
    for (const it of data || []) if (it?.signedUrl && !it.error) byPath.set(it.path, it.signedUrl);
  }
  const sign = (u) => { const p = pathFromUrl(u); return p ? byPath.get(p) || null : u; };
  return docs.map((d) => {
    const versions = Array.isArray(d.metadata?.versions) ? d.metadata.versions.map((v) => ({ ...v, file_url: sign(v?.file_url) })) : undefined;
    return { ...d, file_url: sign(d.file_url), ...(versions ? { metadata: { ...d.metadata, versions } } : {}) };
  });
};

module.exports = { pathFromUrl, signedUrl, signRows, signDocs, download, HOUR, EMAIL_TTL };
