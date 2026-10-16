// Pruebas del acceso privado a archivos (sin conectarse a Supabase)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Supabase falso: firma devolviendo una URL con token y descarga un buffer fijo
const firmados = [];
const fake = {
  storage: {
    from: (bucket) => ({
      createSignedUrl: async (p, ttl) => { firmados.push({ bucket, p, ttl }); return { data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/${bucket}/${p}?token=abc` } }; },
      createSignedUrls: async (paths, ttl) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://x.supabase.co/storage/v1/object/sign/${bucket}/${p}?token=abc&ttl=${ttl}` })) }),
      download: async (p) => ({ data: new Blob([`contenido de ${p}`]) }),
    }),
  },
};
require.cache[path.resolve(__dirname, '../src/config/supabase.js')] = { exports: fake, loaded: true };
const storage = require('../src/services/storage.service');

const pub = (p) => `https://x.supabase.co/storage/v1/object/public/documents/${p}`;

test('extrae la ruta interna de una URL pública, incluso con caracteres especiales', () => {
  assert.strictEqual(storage.pathFromUrl(pub('u1/Acta%20octubre%C3%B1.pdf')), 'u1/Acta octubreñ.pdf');
  assert.strictEqual(storage.pathFromUrl('https://otro.sitio/archivo.pdf'), null);
});

test('nunca entrega la dirección pública: la cambia por un enlace firmado', async () => {
  const url = await storage.signedUrl(pub('u1/a.pdf'));
  assert.match(url, /\/object\/sign\/documents\/u1\/a\.pdf\?token=/);
  assert.ok(!url.includes('/object/public/'));
});

test('los enlaces de correo duran 7 días; los de la app, 1 hora', async () => {
  firmados.length = 0;
  await storage.signedUrl(pub('u1/a.pdf'));
  await storage.signedUrl(pub('u1/a.pdf'), { ttl: storage.EMAIL_TTL });
  assert.deepStrictEqual(firmados.map((f) => f.ttl), [3600, 604800]);
});

test('firma el archivo actual y las versiones anteriores de cada documento', async () => {
  const [d] = await storage.signDocs([{
    id: 1,
    file_url: pub('u1/v2.pdf'),
    metadata: { versions: [{ version: 1, file_url: pub('u1/v1.pdf') }] },
  }]);
  assert.match(d.file_url, /sign\/documents\/u1\/v2\.pdf/);
  assert.match(d.metadata.versions[0].file_url, /sign\/documents\/u1\/v1\.pdf/);
});

test('las direcciones que no son de Storage se dejan igual', async () => {
  const [d] = await storage.signDocs([{ file_url: 'http://localhost:8080/demo.pdf', metadata: {} }]);
  assert.strictEqual(d.file_url, 'http://localhost:8080/demo.pdf');
});

test('descarga el archivo desde el servidor sin usar la dirección pública', async () => {
  const buf = await storage.download(pub('u1/a.pdf'));
  assert.strictEqual(buf.toString(), 'contenido de u1/a.pdf');
});

// Varios firmantes: la huella combinada depende de quién firmó y en qué orden
test('huella combinada de varios firmantes: estable y sensible al orden', () => {
  const { combinedHash } = require('../src/controllers/cosign.controller');
  const a = { position: 1, email: 'a@x.co', signature_hash: 'aaa' };
  const b = { position: 2, email: 'b@x.co', signature_hash: 'bbb' };
  assert.strictEqual(combinedHash([a, b]), combinedHash([a, b]));
  assert.notStrictEqual(combinedHash([a, b]), combinedHash([{ ...b, position: 1 }, { ...a, position: 2 }]));
  assert.match(combinedHash([a, b]), /^[0-9a-f]{64}$/);
});
