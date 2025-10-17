import express from 'express';
import {
    createSession,
    getSession,
    loadAllSessions,
} from './baileys_service.js';

const app = express();
const port = 7000;

app.use(express.json());

// Carregar todas as sessões salvas ao iniciar o servidor
loadAllSessions().then(() => {
    console.log('Todas as sessões salvas foram carregadas.');
});

// Endpoint para criar sessão
app.post('/create-session', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;

    try {
        await createSession(sessionId, { phoneNumber });
        if (phoneNumber) {
            res.status(200).send(`Sessão '${sessionId}' criada. Aguarde o código de pareamento enviado no terminal.`);
        } else {
            res.status(200).send(`Sessão '${sessionId}' criada. Escaneie o QR Code no terminal.`);
        }
    } catch (error) {
        console.error("Erro ao criar sessão:", error);
        res.status(500).send('Erro ao criar sessão');
    }
});

// Endpoint para solicitar código de pareamento
app.post('/request-pairing-code', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;
    const session = getSession(sessionId);

    if (!session) {
        return res.status(404).send('Sessão não encontrada');
    }

    if (!phoneNumber) {
        return res.status(400).send('O campo "phoneNumber" é obrigatório');
    }

    try {
        const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
        const code = await session.requestPairingCode(cleanPhoneNumber);
        console.log(`Código de pareamento para sessão ${sessionId}: ${code}`);
        res.status(200).json({ code, message: 'Código de pareamento gerado com sucesso' });
    } catch (error) {
        console.error("Erro ao solicitar código de pareamento:", error);
        res.status(500).send(`Erro ao solicitar código: ${error.message}`);
    }
});

// Endpoint para enviar mensagem
app.post('/send-message', async (req, res) => {
    const { sessionId, to, message } = req.body;
    const session = getSession(sessionId);

    if (!session) {
        return res.status(404).send('Sessão não encontrada');
    }

    try {
        if (!to || !message) {
            return res.status(400).send('O campo "to" e "message" são obrigatórios');
        }

        await session.sendMessage(to, { text: message });
        res.status(200).send('Mensagem enviada com sucesso!');
    } catch (error) {
        console.error("Erro ao enviar mensagem:", error);
        res.status(500).send(`Erro ao enviar mensagem: ${error.message}`);
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
