const { makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, delay } = require('@whiskeysockets/baileys');
const fs = require('fs');

const SESSION_FILE_PATH = './sessions.json';

// Verifica se o arquivo de sessão existe e carrega as sessões
let sessions = {};
if (fs.existsSync(SESSION_FILE_PATH)) {
    sessions = JSON.parse(fs.readFileSync(SESSION_FILE_PATH));
}

async function listGroups(socket) {
    try {
        const groups = await socket.groupFetchAllParticipating();
        console.log("Grupos encontrados:");
        for (let id in groups) {
            console.log(`ID: ${id}`);
            console.log(`Nome: ${groups[id].subject}`);
            console.log('---');
        }
    } catch (error) {
        console.error("Erro ao listar grupos:", error);
    }
}

async function createSession(sessionId) {
    const { state, saveCreds } = await useMultiFileAuthState(sessionId);
    const socket = makeWASocket({
        auth: state,
        printQRInTerminal: true,
    });

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log('Logged out');
                delete sessions[sessionId];
                fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessions, null, 2));
            } else {
                console.log('Reconnecting...');
                createSession(sessionId);
            }
        } else if (connection === 'open') {
            console.log("Conexão estabelecida!");

            await listGroups(socket);
        }
    });

    sessions[sessionId] = socket;
    fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessions, null, 2));
}

function getSession(sessionId) {
    return sessions[sessionId];
}

module.exports = {
    createSession,
    getSession,
};