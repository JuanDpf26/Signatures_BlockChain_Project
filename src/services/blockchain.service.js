const { ethers } = require('ethers');

// ABI del contrato BlockSign
const CONTRACT_ABI = [
  "function signDocument(bytes32 _documentHash, bytes32 _signatureHash, string calldata _signerEmail, string calldata _documentTitle) external",
  "function verifyDocument(bytes32 _documentHash) external view returns (bool isValid, address signer, uint256 timestamp, bytes32 signatureHash, string memory signerEmail, string memory documentTitle)",
  "function isDocumentRegistered(bytes32 _documentHash) external view returns (bool)",
  "function revokeSignature(bytes32 _documentHash) external",
  "function getDocumentsBySigner(address _signer) external view returns (bytes32[] memory)",
  "function getTotalDocuments() external view returns (uint256)",
  "function owner() external view returns (address)",
  "event DocumentSigned(bytes32 indexed documentHash, bytes32 indexed signatureHash, address indexed signer, uint256 timestamp, string documentTitle)",
  "event SignatureRevoked(bytes32 indexed documentHash, address indexed signer, uint256 timestamp)"
];

let provider;
let wallet;
let contract;
let initialized = false;

// ────────────────────────────────────────────────
// INICIALIZAR CONEXIÓN
// ────────────────────────────────────────────────
const initBlockchain = () => {
  try {
    if (!process.env.BLOCKCHAIN_RPC_URL || !process.env.BLOCKCHAIN_PRIVATE_KEY || !process.env.BLOCKCHAIN_CONTRACT_ADDRESS) {
      console.log('⚠️  Blockchain no configurada — módulo desactivado');
      return false;
    }

    provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL);
    wallet = new ethers.Wallet(process.env.BLOCKCHAIN_PRIVATE_KEY, provider);
    contract = new ethers.Contract(
      process.env.BLOCKCHAIN_CONTRACT_ADDRESS,
      CONTRACT_ABI,
      wallet
    );

    initialized = true;
    console.log('✅ Blockchain (Sepolia) conectada');
    console.log(`   Wallet: ${wallet.address}`);
    console.log(`   Contrato: ${process.env.BLOCKCHAIN_CONTRACT_ADDRESS}`);
    return true;
  } catch (err) {
    console.error('❌ Error conectando blockchain:', err.message);
    return false;
  }
};

// ────────────────────────────────────────────────
// HELPER: Convertir hex string a bytes32
// ────────────────────────────────────────────────
const hexToBytes32 = (hexString) => {
  // Eliminar 0x si existe
  const clean = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
  // Asegurar 64 caracteres (32 bytes)
  const padded = clean.padEnd(64, '0').slice(0, 64);
  return '0x' + padded;
};

// ────────────────────────────────────────────────
// REGISTRAR FIRMA EN BLOCKCHAIN
// ────────────────────────────────────────────────
const registerSignatureOnBlockchain = async ({
  documentHash,
  signatureHash,
  signerEmail,
  documentTitle,
}) => {
  if (!initialized) {
    return {
      success: false,
      error: 'Blockchain no configurada',
      txHash: null,
    };
  }

  try {
    const docHashBytes32 = hexToBytes32(documentHash);
    const sigHashBytes32 = hexToBytes32(signatureHash);

    console.log(`📝 Registrando firma en blockchain...`);
    console.log(`   Doc hash: ${docHashBytes32}`);
    console.log(`   Firmante: ${signerEmail}`);

    // Estimar gas
    const gasEstimate = await contract.signDocument.estimateGas(
      docHashBytes32,
      sigHashBytes32,
      signerEmail,
      documentTitle
    );

    // Enviar transacción con 20% más de gas por seguridad
    const tx = await contract.signDocument(
      docHashBytes32,
      sigHashBytes32,
      signerEmail,
      documentTitle,
      { gasLimit: (gasEstimate * 120n) / 100n }
    );

    console.log(`   Tx enviada: ${tx.hash}`);
    console.log(`   Esperando confirmación...`);

    // Esperar 1 confirmación
    const receipt = await tx.wait(1);

    console.log(`✅ Firma registrada en bloque ${receipt.blockNumber}`);

    return {
      success: true,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      explorerUrl: `https://sepolia.etherscan.io/tx/${tx.hash}`,
    };
  } catch (err) {
    console.error('❌ Error registrando en blockchain:', err.message);

    // Si el documento ya está registrado no es un error crítico
    if (err.message.includes('ya registrado')) {
      return {
        success: false,
        error: 'Documento ya registrado en blockchain',
        alreadyRegistered: true,
      };
    }

    return {
      success: false,
      error: err.message,
      txHash: null,
    };
  }
};

// ────────────────────────────────────────────────
// VERIFICAR FIRMA EN BLOCKCHAIN
// ────────────────────────────────────────────────
const verifySignatureOnBlockchain = async (documentHash) => {
  if (!initialized) {
    return {
      verified: false,
      error: 'Blockchain no configurada',
      onChain: false,
    };
  }

  try {
    const docHashBytes32 = hexToBytes32(documentHash);

    // Verificar si existe
    const exists = await contract.isDocumentRegistered(docHashBytes32);

    if (!exists) {
      return {
        verified: false,
        onChain: false,
        error: 'Documento no encontrado en blockchain',
      };
    }

    // Obtener detalles
    const result = await contract.verifyDocument(docHashBytes32);

    return {
      verified: true,
      onChain: true,
      isValid: result.isValid,
      signer: result.signer,
      timestamp: Number(result.timestamp),
      signedAt: new Date(Number(result.timestamp) * 1000).toISOString(),
      signatureHash: result.signatureHash,
      signerEmail: result.signerEmail,
      documentTitle: result.documentTitle,
      explorerUrl: `https://sepolia.etherscan.io/address/${process.env.BLOCKCHAIN_CONTRACT_ADDRESS}`,
    };
  } catch (err) {
    console.error('❌ Error verificando en blockchain:', err.message);
    return {
      verified: false,
      onChain: false,
      error: err.message,
    };
  }
};

// ────────────────────────────────────────────────
// REVOCAR FIRMA
// ────────────────────────────────────────────────
const revokeSignatureOnBlockchain = async (documentHash) => {
  if (!initialized) {
    return { success: false, error: 'Blockchain no configurada' };
  }

  try {
    const docHashBytes32 = hexToBytes32(documentHash);
    const tx = await contract.revokeSignature(docHashBytes32);
    const receipt = await tx.wait(1);

    return {
      success: true,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      explorerUrl: `https://sepolia.etherscan.io/tx/${tx.hash}`,
    };
  } catch (err) {
    console.error('❌ Error revocando firma:', err.message);
    return { success: false, error: err.message };
  }
};

// ────────────────────────────────────────────────
// OBTENER DOCUMENTOS POR FIRMANTE
// ────────────────────────────────────────────────
const getDocumentsBySigner = async (signerAddress) => {
  if (!initialized) return [];

  try {
    const docs = await contract.getDocumentsBySigner(signerAddress);
    return docs;
  } catch (err) {
    console.error('❌ Error obteniendo documentos del firmante:', err.message);
    return [];
  }
};

// ────────────────────────────────────────────────
// TOTAL DE DOCUMENTOS EN BLOCKCHAIN
// ────────────────────────────────────────────────
const getTotalDocuments = async () => {
  if (!initialized) return 0;

  try {
    const total = await contract.getTotalDocuments();
    return Number(total);
  } catch (err) {
    return 0;
  }
};

// ────────────────────────────────────────────────
// INFO DE LA WALLET
// ────────────────────────────────────────────────
const getWalletInfo = async () => {
  if (!initialized) return null;

  try {
    const balance = await provider.getBalance(wallet.address);
    return {
      address: wallet.address,
      balance: ethers.formatEther(balance),
      network: 'sepolia',
      contractAddress: process.env.BLOCKCHAIN_CONTRACT_ADDRESS,
    };
  } catch (err) {
    return null;
  }
};

module.exports = {
  initBlockchain,
  registerSignatureOnBlockchain,
  verifySignatureOnBlockchain,
  revokeSignatureOnBlockchain,
  getDocumentsBySigner,
  getTotalDocuments,
  getWalletInfo,
};