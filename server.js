const express = require('express');
const { createSession, getSession } = require('./baileys_service');

const app = express();
const port = 7000;

// Middleware para processar JSON
app.use(express.json());

// Endpoint para criar sessão
app.post('/create-session', async (req, res) => {
    const { sessionId } = req.body;

    try {
        await createSession(sessionId);
        res.status(200).send(`Sessão '${sessionId}' criada. Escaneie o QR Code no terminal.`);
        
    } catch (error) {
        console.error("Erro ao criar sessão:", error);
        res.status(500).send('Erro ao criar sessão');
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
        // Verificar se o "to" está em um formato válido
        if (!to || !message) {
            return res.status(400).send('O campo "to" e "message" são obrigatórios');
        }

        // Enviar a mensagem para um grupo ou número
        await session.sendMessage(to, { text: message });
        res.status(200).send('Mensagem enviada com sucesso!');
    } catch (error) {
        console.error("Erro ao enviar mensagem:", error);
        res.status(500).send(`Erro ao enviar mensagem: ${error.message}`);
    }
});


// Iniciar servidor
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
