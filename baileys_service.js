import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcodeTerminal from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_FOLDER_PATH = path.join(__dirname, 'sessions_path');
if (!fs.existsSync(SESSION_FOLDER_PATH)) {
    fs.mkdirSync(SESSION_FOLDER_PATH);  // Cria a pasta se não existir
}

const sessions = {};
const sessionOptions = new Map();
const messageStores = new Map();
const reconnectTimers = new Map();
const baseLogger = Pino({ level: process.env.BAILEYS_LOG_LEVEL || 'info' });
const MAX_STORED_MESSAGES = 500;
const pendingPairingRequests = new Set();

function ensureMessageStore(sessionId) {
    if (!messageStores.has(sessionId)) {
        messageStores.set(sessionId, { byKey: new Map(), order: [] });
    }
    return messageStores.get(sessionId);
}

function messageKeyId(key) {
    return `${key.remoteJid || ''}:${key.id || ''}`;
}

function trimMessageStore(store) {
    while (store.order.length > MAX_STORED_MESSAGES) {
        const oldest = store.order.shift();
        if (oldest) {
            store.byKey.delete(oldest);
        }
    }
}

function clearReconnectTimer(sessionId) {
    const timer = reconnectTimers.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(sessionId);
    }
}

function removeSessionArtifacts(sessionId, sessionPath) {
    clearReconnectTimer(sessionId);
    delete sessions[sessionId];
    messageStores.delete(sessionId);
    sessionOptions.delete(sessionId);
    pendingPairingRequests.delete(sessionId);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
}

function extractStatusCode(lastDisconnect) {
    if (!lastDisconnect || !lastDisconnect.error) {
        return undefined;
    }

    const { error } = lastDisconnect;
    return (
        error?.output?.statusCode ??
        error?.statusCode ??
        error?.status ??
        (typeof error?.code === 'number' ? error.code : undefined)
    );
}

async function initialiseSocket(sessionId, sessionPath, options = {}) {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sessionLogger = baseLogger.child({ sessionId });
    const messageStore = ensureMessageStore(sessionId);
    const phoneNumber = options.phoneNumber?.replace(/\D/g, '') || undefined;
    const shouldRequestPairingCode = Boolean(phoneNumber);

    // Fetch latest WA version
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Sessão ${sessionId}: usando WA v${version.join('.')}, isLatest: ${isLatest}`);

    const socket = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, sessionLogger),
        },
        logger: sessionLogger,
        browser: shouldRequestPairingCode ? Browsers.macOS('Chrome') : Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            const stored = messageStore.byKey.get(messageKeyId(key));
            return stored?.message;
        },
    });

    // Pairing code para clientes Web
    if (shouldRequestPairingCode && !socket.authState.creds.registered) {
        try {
            const code = await socket.requestPairingCode(phoneNumber);
            console.log(`Código de pareamento para a sessão ${sessionId}: ${code}`);
        } catch (err) {
            console.error(`Erro ao solicitar código de pareamento para a sessão ${sessionId}:`, err);
        }
    }

    // Usa ev.process para lidar com eventos em batch (padrão v7)
    socket.ev.process(async (events) => {
        // Atualização de conexão
        if (events['connection.update']) {
            const update = events['connection.update'];
            const { connection, lastDisconnect, qr, isOnline } = update;

            if (qr) {
                console.log(`QR code gerado para a sessão ${sessionId}. Escaneie para autenticar.`);
                qrcodeTerminal.generate(qr, { small: true });
            }

            if (typeof isOnline === 'boolean') {
                console.log(`Sessão ${sessionId} está ${isOnline ? 'online' : 'offline'}.`);
            }

            if (connection) {
                console.log(`connection.update -> sessão ${sessionId}: estado='${connection}'`);
            }

            if (connection === 'open') {
                console.log(`Sessão ${sessionId} conectada com sucesso!`);
                pendingPairingRequests.delete(sessionId);
                listGroups(socket);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`Sessão ${sessionId} desconectada permanentemente (logged out).`);
                    removeSessionArtifacts(sessionId, sessionPath);
                    return;
                }

                if (statusCode === 405) {
                    console.log(`Sessão ${sessionId} inválida (405). Removendo credenciais corrompidas.`);
                    removeSessionArtifacts(sessionId, sessionPath);
                    return;
                }

                // Reconectar em outros casos
                console.log(`Reconectando sessão ${sessionId}... (código: ${statusCode ?? 'desconhecido'})`);
                delete sessions[sessionId];
                clearReconnectTimer(sessionId);
                
                const timer = setTimeout(() => {
                    reconnectTimers.delete(sessionId);
                    loadSession(sessionId).catch((err) => {
                        console.error(`Erro ao tentar reconectar sessão ${sessionId}:`, err);
                    });
                }, 3000);
                reconnectTimers.set(sessionId, timer);
            }
        }

        // Credenciais atualizadas
        if (events['creds.update']) {
            await saveCreds();
        }

        // Mensagens recebidas
        if (events['messages.upsert']) {
            const { messages, type } = events['messages.upsert'];
            
            messages.forEach((msg) => {
                if (!msg?.message || !msg.key?.id) {
                    return;
                }

                const composedKey = messageKeyId(msg.key);
                if (!messageStore.byKey.has(composedKey)) {
                    messageStore.order.push(composedKey);
                }

                messageStore.byKey.set(composedKey, msg);
                trimMessageStore(messageStore);
            });
        }
    });

    sessions[sessionId] = socket;
    if (shouldRequestPairingCode) {
        sessionOptions.set(sessionId, { phoneNumber });
    }
    return socket;
}

// Função para carregar sessões de forma persistente do sistema de arquivos
async function loadSession(sessionId) {
    if (!sessionId) {
        throw new Error('sessionId é obrigatório para carregar uma sessão');
    }

    if (sessions[sessionId]) {
        return sessions[sessionId];
    }

    const sessionPath = path.join(SESSION_FOLDER_PATH, `${sessionId}`);
    if (!fs.existsSync(sessionPath)) {
        return null;
    }

    const options = sessionOptions.get(sessionId);
    return initialiseSocket(sessionId, sessionPath, options);
}

// Função para criar uma nova sessão
async function createSession(sessionId, options = {}) {
    if (!sessionId) {
        throw new Error('sessionId é obrigatório para criar uma sessão');
    }

    if (sessions[sessionId]) {
        return sessions[sessionId];
    }

    const sessionPath = path.join(SESSION_FOLDER_PATH, `${sessionId}`);
    return initialiseSocket(sessionId, sessionPath, options);
}

// Função para recuperar uma sessão existente da memória
function getSession(sessionId) {
    return sessions[sessionId];
}

// Função para listar os grupos
async function listGroups(socket) {
    try {
        const groups = await socket.groupFetchAllParticipating();
        console.log('Grupos encontrados:');
        Object.entries(groups).forEach(([id, group]) => {
            console.log(`ID: ${id}, Nome: ${group.subject}`);
        });
    } catch (error) {
        console.error('Erro ao listar grupos:', error);
    }
}

// Função para carregar todas as sessões salvas automaticamente no início
async function loadAllSessions() {
    const entries = fs.readdirSync(SESSION_FOLDER_PATH, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const sessionId = entry.name;
        try {
            await loadSession(sessionId);
        } catch (error) {
            console.error(`Falha ao carregar sessão ${sessionId}:`, error);
        }
    }
}

export {
    createSession,
    getSession,
    loadAllSessions,
};
