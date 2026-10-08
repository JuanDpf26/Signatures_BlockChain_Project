#!/usr/bin/env node
/**
 * Verificación independiente en Sepolia (sin pasar por la app).
 *
 * Calcula la huella SHA-256 de un archivo y le pregunta directamente al
 * contrato si está registrada. Sirve para comprobar, en una prueba real o en
 * la sustentación, que la verificación no depende del backend ni de Supabase.
 *
 * Uso (desde la carpeta del backend, con el .env configurado):
 *   node scripts/verificar-en-cadena.js --estado                 Estado de la red, contrato y billetera
 *   node scripts/verificar-en-cadena.js ruta/al/archivo.pdf      Verifica un archivo
 *   node scripts/verificar-en-cadena.js --hash <sha256 en hex>   Verifica una huella
 *
 * Solo hace lecturas: no envía transacciones ni gasta ETH.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const ABI = [
  'function verifyDocument(bytes32 _documentHash) external view returns (bool isValid, address signer, uint256 timestamp, bytes32 signatureHash, string memory signerEmail, string memory documentTitle)',
  'function isDocumentRegistered(bytes32 _documentHash) external view returns (bool)',
  'function getTotalDocuments() external view returns (uint256)',
  'function owner() external view returns (address)',
];
const EXPLORER = 'https://sepolia.etherscan.io';
const SEPOLIA = 11155111;
const RPCS = [
  process.env.BLOCKCHAIN_RPC_URL,
  ...(process.env.BLOCKCHAIN_RPC_FALLBACKS || '').split(','),
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
  'https://1rpc.io/sepolia',
].map((u) => (u || '').trim()).filter(Boolean);

const fail = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };

async function connect() {
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, SEPOLIA, { staticNetwork: true });
      const block = await Promise.race([
        p.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error('sin respuesta en 8 s')), 8000)),
      ]);
      return { provider: p, block, url: url.replace(/\/[^/]{20,}$/, '/***') };
    } catch (e) {
      console.warn(`  · Nodo ${url.replace(/\/[^/]{20,}$/, '/***')} no respondió (${e.shortMessage || e.message})`);
    }
  }
  fail('Ningún nodo de Sepolia respondió. Revisa la conexión a internet o BLOCKCHAIN_RPC_URL.');
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) fail('Indica un archivo, --hash <huella> o --estado. Ejemplo: node scripts/verificar-en-cadena.js contrato.pdf');
  const address = process.env.BLOCKCHAIN_CONTRACT_ADDRESS;
  if (!address) fail('Falta BLOCKCHAIN_CONTRACT_ADDRESS en el .env');

  const { provider, block, url } = await connect();
  const contract = new ethers.Contract(address, ABI, provider);
  console.log(`\nRed: Sepolia (bloque actual ${block}) vía ${url}`);
  console.log(`Contrato: ${address}\n         ${EXPLORER}/address/${address}`);

  if (args[0] === '--estado') {
    const code = await provider.getCode(address);
    if (code === '0x') fail('En esa dirección no hay ningún contrato desplegado en Sepolia.');
    const total = await contract.getTotalDocuments().catch(() => null);
    const owner = await contract.owner().catch(() => null);
    console.log(`Documentos registrados en el contrato: ${total ?? 'no disponible'}`);
    if (owner) console.log(`Dueño del contrato: ${owner}`);
    if (process.env.BLOCKCHAIN_PRIVATE_KEY) {
      const wallet = new ethers.Wallet(process.env.BLOCKCHAIN_PRIVATE_KEY.trim());
      const bal = await provider.getBalance(wallet.address);
      console.log(`Billetera del servidor: ${wallet.address}`);
      console.log(`Saldo: ${ethers.formatEther(bal)} SepoliaETH${bal < ethers.parseEther('0.01') ? '  ⚠ poco saldo: pide más en un faucet' : ''}`);
    }
    console.log('');
    return;
  }

  let hash;
  if (args[0] === '--hash') {
    hash = (args[1] || '').replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) fail('La huella debe tener 64 caracteres hexadecimales.');
  } else {
    const file = path.resolve(args[0]);
    if (!fs.existsSync(file)) fail(`No existe el archivo ${file}`);
    hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    console.log(`\nArchivo: ${path.basename(file)} (${fs.statSync(file).size} bytes)`);
  }
  console.log(`Huella SHA-256: ${hash}`);

  const key = '0x' + hash;
  const registered = await contract.isDocumentRegistered(key);
  if (!registered) {
    console.log('\n✖ NO REGISTRADO: esta huella no está en el contrato.');
    console.log('  El archivo no se ha firmado o fue modificado (un solo byte distinto cambia la huella).\n');
    process.exit(2);
  }
  const r = await contract.verifyDocument(key);
  const fecha = new Date(Number(r.timestamp) * 1000);
  console.log(r.isValid ? '\n✔ VÁLIDO: la huella está registrada y la firma está vigente.' : '\n✖ REVOCADO: la huella está registrada pero la firma fue revocada.');
  console.log(`  Título:          ${r.documentTitle}`);
  console.log(`  Firmante:        ${r.signerEmail}`);
  console.log(`  Registrado por:  ${r.signer}`);
  console.log(`  Fecha (bloque):  ${fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
  console.log(`  signatureHash:   ${r.signatureHash}`);
  console.log(`  Ver eventos:     ${EXPLORER}/address/${address}#events\n`);
  process.exit(r.isValid ? 0 : 3);
}

main().catch((e) => fail(e.shortMessage || e.message));
