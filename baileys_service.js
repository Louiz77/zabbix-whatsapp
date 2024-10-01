const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const SESSION_FOLDER_PATH = path.join(__dirname, 'sessions_path');
if (!fs.existsSync(SESSION_FOLDER_PATH)) {
    fs.mkdirSync(SESSION_FOLDER_PATH);  // Cria a pasta se não existir
}

let sessions = {};

// Função para carregar sessões de forma persistente do sistema de arquivos
async function loadSession(sessionId) {
    const sessionPath = path.join(SESSION_FOLDER_PATH, `${sessionId}`);
    if (fs.existsSync(sessionPath)) {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,  // Não exibir o QR code, pois estamos carregando uma sessão existente
        });

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`Sessão ${sessionId} desconectada permanentemente.`);
                    delete sessions[sessionId];
                    fs.unlinkSync(sessionPath);  // Remover sessão do sistema de arquivos
                } else {
                    console.log('Reconectando...', sessionId);
                    loadSession(sessionId);  // Tentar reconectar automaticamente
                }
            } else if (connection === 'open') {
                console.log(`Sessão ${sessionId} conectada!`);
            }
        });

        sessions[sessionId] = socket;
        return socket;
    }
    return null;
}

// Função para criar uma nova sessão
async function createSession(sessionId) {
    const sessionPath = path.join(SESSION_FOLDER_PATH, `${sessionId}`);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const socket = makeWASocket({
        auth: state,
        printQRInTerminal: true,  // Exibir o QR Code no terminal ao criar nova sessão
    });

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log(`Sessão ${sessionId} desconectada.`);
                delete sessions[sessionId];
                fs.unlinkSync(sessionPath);  // Remover sessão desconectada
            } else {
                console.log('Reconectando...', sessionId);
                loadSession(sessionId);  // Tentar reconectar
            }
        } else if (connection === 'open') {
            console.log(`Sessão ${sessionId} conectada!`);
        }
    });

    sessions[sessionId] = socket;
    return socket;
}

// Função para recuperar uma sessão existente da memória
function getSession(sessionId) {
    return sessions[sessionId];
}

// Função para carregar todas as sessões salvas automaticamente no início
async function loadAllSessions() {
    const sessionFiles = fs.readdirSync(SESSION_FOLDER_PATH);
    for (const file of sessionFiles) {
        const sessionId = path.basename(file);
        await loadSession(sessionId);  // Carregar cada sessão individualmente
    }
}

module.exports = {
    createSession,
    getSession,
    loadAllSessions,
};
