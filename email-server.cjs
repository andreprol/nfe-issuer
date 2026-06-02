/**
 * Servidor de E-mail Local — TechStore
 * Porta: 3001
 * Conta padrão: andreprol1980@gmail.com (Gmail)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function liberarPorta(porta) {
  try {
    const output = execSync(`netstat -ano | findstr :${porta}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const linhas = output.split('\n').filter(l => l.includes('LISTENING'));
    for (const linha of linhas) {
      const partes = linha.trim().split(/\s+/);
      const procId = partes[partes.length - 1];
      if (procId && procId !== String(process.pid)) {
        try { execSync(`taskkill /PID ${procId} /F`, { stdio: 'ignore' }); } catch {}
        console.log(`Processo ${procId} encerrado (porta ${porta} liberada)`);
      }
    }
  } catch {}
}

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch {
  const globalModules = require('child_process')
    .execSync('npm root -g').toString().trim();
  nodemailer = require(path.join(globalModules, 'nodemailer'));
}

const PORTA = 3001;

// Armazena config em AppData — persiste entre reinstalações do projeto
const APP_DATA_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'EmissorDeNotas'
);
const CONFIG_FILE = path.join(APP_DATA_DIR, 'config.json');
const CONFIG_FILE_LEGADO = path.join(__dirname, 'config.json');

if (!fs.existsSync(APP_DATA_DIR)) fs.mkdirSync(APP_DATA_DIR, { recursive: true });

// Migra senha do local antigo (config.json na pasta do projeto)
if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(CONFIG_FILE_LEGADO)) {
  try {
    fs.copyFileSync(CONFIG_FILE_LEGADO, CONFIG_FILE);
    console.log('Senha migrada de config.json (pasta projeto) → AppData\\EmissorDeNotas');
  } catch {}
}

let _currentOrigin = '*';

// Configuração Gmail — fixa, só a senha é variável
const GMAIL = {
  host: 'smtp.gmail.com',
  port: 587,
  user: 'andreprol1980@gmail.com',
  nomeRemetente: 'Emissor de Notas',
};

function lerConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

function salvarConfig(dados) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(dados, null, 2), 'utf8'); }
  catch (e) { console.error('Erro ao salvar config:', e.message); }
}

function headers(res, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': _currentOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function htmlTeste(emailEmpresa, destinatarios, nomeEmpresa) {
  const nomeExibido = nomeEmpresa || 'Emissor de Notas';

  const listaDestinatarios = destinatarios.map(e => `
              <tr>
                <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;">
                  <table cellpadding="0" cellspacing="0"><tr>
                    <td style="width:8px;height:8px;background:#3b82f6;border-radius:50%;vertical-align:middle;font-size:0;">&nbsp;</td>
                    <td style="padding-left:10px;font-size:14px;color:#1e40af;font-weight:500;font-family:Arial,Helvetica,sans-serif;">${e}</td>
                  </tr></table>
                </td>
              </tr>`).join('');

  const agora = new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Emissor de Notas - Confirmacao de E-mail</title>
</head>
<body style="margin:0;padding:0;background-color:#eef2f7;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef2f7;padding:40px 16px;">
    <tr><td align="center">

      <table cellpadding="0" cellspacing="0" style="width:100%;max-width:580px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12);">

        <tr>
          <td style="background:#3b82f6;height:5px;font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <tr>
          <td style="background:#1d4ed8;padding:28px 40px 24px;">
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#ffffff;border-radius:8px;padding:6px 16px;">
                  <span style="font-size:18px;font-weight:900;color:#1d4ed8;letter-spacing:-0.5px;font-family:Arial,Helvetica,sans-serif;">${nomeExibido}</span>
                </td>
              </tr>
            </table>
            <p style="margin:14px 0 2px;font-size:21px;font-weight:700;color:#ffffff;line-height:1.3;font-family:Arial,Helvetica,sans-serif;">Sistema de Notas Fiscais</p>
            <p style="margin:0;font-size:13px;color:#bfdbfe;font-family:Arial,Helvetica,sans-serif;">Confirmacao de Configuracao de E-mail</p>
          </td>
        </tr>

        <tr>
          <td style="background-color:#f0fdf4;padding:15px 40px;border-bottom:2px solid #bbf7d0;">
            <table cellpadding="0" cellspacing="0"><tr>
              <td style="width:30px;height:30px;background:#16a34a;border-radius:50%;text-align:center;vertical-align:middle;">
                <span style="font-size:18px;font-weight:700;color:#ffffff;line-height:30px;font-family:Arial,Helvetica,sans-serif;">&#10003;</span>
              </td>
              <td style="padding-left:12px;font-size:15px;font-weight:700;color:#15803d;font-family:Arial,Helvetica,sans-serif;">
                Conexao Gmail validada com sucesso!
              </td>
            </tr></table>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 28px;">

            <p style="margin:0 0 26px;font-size:15px;color:#4b5563;line-height:1.75;font-family:Arial,Helvetica,sans-serif;">
              As configuracoes de e-mail do <strong style="color:#1d4ed8;">${nomeExibido}</strong> estao corretas e funcionando. O sistema esta pronto para enviar <strong>Notas Fiscais Eletronicas</strong> automaticamente para seus clientes.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8faff;border-radius:12px;border:1px solid #dbeafe;margin-bottom:24px;">
              <tr>
                <td style="padding:22px 26px;">

                  <p style="margin:0 0 16px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1.2px;font-family:Arial,Helvetica,sans-serif;">DETALHES DO ENVIO</p>

                  <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#6b7280;font-family:Arial,Helvetica,sans-serif;">REMETENTE DA EMPRESA</p>
                  <table cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
                    <tr>
                      <td style="background:#eff6ff;border-radius:20px;padding:8px 16px;">
                        <span style="font-size:14px;color:#1e40af;font-weight:600;font-family:Arial,Helvetica,sans-serif;">${emailEmpresa}</span>
                      </td>
                    </tr>
                  </table>

                  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
                    <tr><td style="border-top:1px solid #e2e8f0;height:1px;font-size:0;">&nbsp;</td></tr>
                  </table>

                  <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#6b7280;font-family:Arial,Helvetica,sans-serif;">DESTINATARIOS DE NF-e</p>
                  <table width="100%" cellpadding="0" cellspacing="0">
                    ${listaDestinatarios}
                  </table>

                </td>
              </tr>
            </table>

            <table width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid #f59e0b;background:#fffbeb;border-radius:0 8px 8px 0;">
              <tr>
                <td style="padding:14px 18px;">
                  <p style="margin:0;font-size:13px;color:#92400e;line-height:1.65;font-family:Arial,Helvetica,sans-serif;">
                    <strong>Proximo passo:</strong> Cadastre seus clientes no sistema e emita a primeira Nota Fiscal pelo Emissor de Notas.
                  </p>
                </td>
              </tr>
            </table>

          </td>
        </tr>

        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;">
            <table width="100%" cellpadding="0" cellspacing="0"><tr>
              <td valign="middle">
                <p style="margin:0 0 2px;font-size:13px;font-weight:700;color:#374151;font-family:Arial,Helvetica,sans-serif;">${nomeExibido}</p>
                <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">Gerado automaticamente &bull; ${agora}</p>
              </td>
              <td align="right" valign="middle">
                <table cellpadding="0" cellspacing="0"><tr>
                  <td style="background:#1d4ed8;border-radius:6px;padding:7px 14px;">
                    <span style="font-size:11px;font-weight:800;color:#ffffff;letter-spacing:1px;font-family:Arial,Helvetica,sans-serif;">NF-e</span>
                  </td>
                </tr></table>
              </td>
            </tr></table>
          </td>
        </tr>

      </table>

      <table style="width:100%;max-width:580px;margin-top:18px;" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center">
            <p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,Helvetica,sans-serif;">Este e-mail foi gerado automaticamente. Nao responda esta mensagem.</p>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>

</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  _currentOrigin = req.headers.origin || '*';
  if (req.method === 'OPTIONS') { headers(res); res.end('{}'); return; }

  if (req.method === 'POST' && req.url === '/send-email') {
    try {
      const body = await lerCorpo(req);
      const { remetentesEmpresa, destinatarios, assunto } = body;

      const config = lerConfig();
      const senha = config.senha || '';

      if (!senha) {
        headers(res, 400);
        res.end(JSON.stringify({ ok: false, erro: 'App Password não configurada. Acesse Configurações → E-mail de Envio e informe a senha.' }));
        return;
      }
      if (!Array.isArray(destinatarios) || !destinatarios.length) {
        headers(res, 400);
        res.end(JSON.stringify({ ok: false, erro: 'Nenhum destinatário de NF-e informado.' }));
        return;
      }

      const transporter = nodemailer.createTransport({
        host: GMAIL.host,
        port: GMAIL.port,
        secure: false,
        auth: { user: GMAIL.user, pass: senha },
        tls: { rejectUnauthorized: false },
      });

      await transporter.verify();

      const emailEmpresa = (Array.isArray(remetentesEmpresa) && remetentesEmpresa[0]) || GMAIL.user;
      const nomeRemetente = config.nomeRemetente || GMAIL.nomeRemetente;
      const remetente = `"${nomeRemetente}" <${GMAIL.user}>`;

      await transporter.sendMail({
        from: remetente,
        replyTo: emailEmpresa,
        to: destinatarios.join(', '),
        subject: assunto || 'Teste de E-mail — Emissor de Notas',
        html: htmlTeste(emailEmpresa, destinatarios, nomeRemetente),
        encoding: 'base64',
      });

      headers(res);
      res.end(JSON.stringify({ ok: true, remetente: emailEmpresa, destinatarios }));
    } catch (err) {
      headers(res, 500);
      res.end(JSON.stringify({ ok: false, erro: err.message }));
    }
    return;
  }

  if (req.url === '/ping') {
    const config = lerConfig();
    headers(res);
    res.end(JSON.stringify({ ok: true, msg: 'Servidor de e-mail ativo.', email: GMAIL.user, configurado: !!config.senha }));
    return;
  }

  // Salva apenas a App Password (e opcionalmente nomeRemetente)
  if (req.method === 'POST' && req.url === '/set-password') {
    try {
      const body = await lerCorpo(req);
      const config = lerConfig();
      if (body.senha) config.senha = body.senha;
      if (body.nomeRemetente) config.nomeRemetente = body.nomeRemetente;
      salvarConfig(config);
      headers(res);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      headers(res, 500);
      res.end(JSON.stringify({ ok: false, erro: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/get-config') {
    const config = lerConfig();
    headers(res);
    // Nunca retornar a senha — só confirmar se está configurada
    res.end(JSON.stringify({ ok: true, email: GMAIL.user, configurado: !!config.senha }));
    return;
  }

  headers(res, 404);
  res.end(JSON.stringify({ ok: false, erro: 'Rota não encontrada.' }));
});

liberarPorta(PORTA);

server.listen(PORTA, '127.0.0.1', () => {
  const config = lerConfig();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Emissor de Notas — Servidor de E-mail  ║');
  console.log(`║   Porta: ${PORTA}   Status: ATIVO              ║`);
  console.log(`║   Gmail: ${GMAIL.user}  ║`);
  console.log(`║   App Password: ${config.senha ? '✅ configurada' : '❌ não configurada'}              ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('Aguardando requisições...');
  console.log('Pressione Ctrl+C para encerrar.');
});

let _retentativas = 0;
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    if (_retentativas < 5) {
      _retentativas++;
      console.log(`⚠️ Porta ${PORTA} em uso. Liberando e tentando (${_retentativas}/5)...`);
      liberarPorta(PORTA);
      setTimeout(() => server.listen(PORTA, '127.0.0.1'), 2000 * _retentativas);
    } else {
      // Nunca sair — deixa o PM2 aguardar sem restart loop
      console.error(`❌ Porta ${PORTA} bloqueada após 5 tentativas. Aguardando 60s antes de tentar novamente...`);
      _retentativas = 0;
      setTimeout(() => { liberarPorta(PORTA); server.listen(PORTA, '127.0.0.1'); }, 60000);
    }
  } else {
    console.error('\n❌ Erro fatal:', err.message, '\n');
    process.exit(1);
  }
});
