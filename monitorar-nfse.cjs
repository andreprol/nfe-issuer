/**
 * Monitor NFSe Nacional — RJ / Simples Nacional
 *
 * Testa diariamente se a Prefeitura do Rio de Janeiro cadastrou os códigos
 * de tributação nacional (CTN) para empresas do Simples Nacional no sistema
 * nacional NFSe. Quando liberado, notifica via Windows + e-mail.
 *
 * Agendado via Windows Task Scheduler (ver instruções ao final).
 */

'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

// ── Configurações ──────────────────────────────────────────────────────────────
const TOKEN_HOM    = 'HGy1sJJi5KMoOaKw68IWw7cXczkzQFv9';
const CNPJ         = '58969414000103';
const MUN_RJ       = 3304557;
const EMAIL_DEST   = 'andreprol1980@gmail.com';

// Códigos a testar — todos devem parar de dar E0312 para considerar liberado
const CODIGOS_TESTE = [
  { cTribNac: '150603', nbs: '107020000', descricao: 'Coleta e entrega de documentos' },
  { cTribNac: '140101', nbs: '120012000', descricao: 'Manutenção de computadores'     },
  { cTribNac: '160201', nbs: '105011110', descricao: 'Transporte municipal de carga'  },
];

// Caminhos
const DIR    = path.dirname(__filename);
const LOG    = path.join(DIR, 'logs', 'monitor-nfse.log');
const STATUS = path.join(DIR, 'data', 'nfse-monitor-status.json');

// ── Helpers ────────────────────────────────────────────────────────────────────
function log(msg) {
  const linha = `[${new Date().toLocaleString('pt-BR')}] ${msg}`;
  console.log(linha);
  try {
    fs.mkdirSync(path.join(DIR, 'logs'), { recursive: true });
    fs.appendFileSync(LOG, linha + '\n');
  } catch(_) {}
}

function salvarStatus(dados) {
  try {
    fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
    fs.writeFileSync(STATUS, JSON.stringify({ ...dados, atualizadoEm: new Date().toISOString() }, null, 2));
  } catch(_) {}
}

function focusGet(ref) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'homologacao.focusnfe.com.br',
      path:     `/v2/nfsen/${ref}?completa=0`,
      method:   'GET',
      auth:     `${TOKEN_HOM}:`,
      headers:  { 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch(_) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.end();
  });
}

function focusPost(ref, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const opts = {
      hostname: 'homologacao.focusnfe.com.br',
      path:     `/v2/nfsen?ref=${ref}`,
      method:   'POST',
      auth:     `${TOKEN_HOM}:`,
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch(_) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.write(data);
    req.end();
  });
}

function notificarWindows(titulo, msg) {
  try {
    // Toast notification via PowerShell
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      $n = New-Object System.Windows.Forms.NotifyIcon
      $n.Icon = [System.Drawing.SystemIcons]::Information
      $n.Visible = $true
      $n.ShowBalloonTip(15000, '${titulo.replace(/'/g, '')}', '${msg.replace(/'/g, '')}', [System.Windows.Forms.ToolTipIcon]::Info)
      Start-Sleep -s 16
      $n.Dispose()
    `.trim();
    execSync(`powershell -NonInteractive -Command "${script.replace(/\n\s*/g, '; ')}"`, { timeout: 20000 });
  } catch(_) {}
}

async function testarCodigo(codigo, indice) {
  const ref = `nfsen-monitor-${CNPJ}-${codigo.cTribNac}-${Date.now()}`;
  const agora = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dataEmissao = `${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}T08:00:00-03:00`;

  const payload = {
    data_emissao:                  dataEmissao,
    data_competencia:              dataEmissao.slice(0, 10),
    codigo_municipio_emissora:     MUN_RJ,
    cnpj_prestador:                CNPJ,
    codigo_opcao_simples_nacional: 1,
    regime_especial_tributacao:    0,
    codigo_municipio_prestacao:    MUN_RJ,
    codigo_tributacao_nacional_iss: codigo.cTribNac,
    codigo_nbs:                    codigo.nbs,
    codigo_cnae:                   '5320202',
    descricao_servico:             'Teste monitoramento automatico NFSe',
    valor_servico:                 1.00,
    tributacao_iss:                1,
    tipo_retencao_iss:             1,
    cnpj_tomador:                  '28481336000132',
    razao_social_tomador:          'TOMADOR TESTE MONITOR',
  };

  const envio = await focusPost(ref, payload);

  // Schema error = código passou pela validação do município (progresso!)
  if (envio.status === 422) {
    const msg = envio.body?.mensagem || '';
    return { codigo: codigo.cTribNac, resultado: 'schema_error', mensagem: msg, liberado: true };
  }

  if (envio.status !== 202) {
    return { codigo: codigo.cTribNac, resultado: 'erro_envio', mensagem: `HTTP ${envio.status}`, liberado: false };
  }

  // Aguarda resposta da prefeitura (máx 45s)
  await new Promise(r => setTimeout(r, 20000));
  const consulta = await focusGet(ref);
  const status   = consulta.body?.status || 'desconhecido';
  const erros    = consulta.body?.erros  || [];
  const codErro  = erros[0]?.codigo || '';

  if (codErro === 'E0312') {
    return { codigo: codigo.cTribNac, resultado: 'E0312', mensagem: 'RJ ainda não administra este código', liberado: false };
  }

  if (codErro === 'E0310') {
    return { codigo: codigo.cTribNac, resultado: 'E0310', mensagem: 'Código não existe na lista nacional', liberado: false };
  }

  // Qualquer outro resultado (E0237, autorizado, etc.) = passou do E0312!
  return { codigo: codigo.cTribNac, resultado: codErro || status, mensagem: erros[0]?.mensagem || status, liberado: true };
}

// ── Principal ──────────────────────────────────────────────────────────────────
async function main() {
  log('══════════════════════════════════════════════');
  log('Iniciando verificação NFSe Nacional — RJ');
  log('══════════════════════════════════════════════');

  const resultados = [];
  let totalLiberados = 0;

  for (const codigo of CODIGOS_TESTE) {
    log(`Testando código ${codigo.cTribNac} (${codigo.descricao})...`);
    const r = await testarCodigo(codigo, CODIGOS_TESTE.indexOf(codigo));
    resultados.push({ ...r, descricao: codigo.descricao });
    log(`  → ${r.liberado ? '✅ LIBERADO' : '❌ BLOQUEADO'} — ${r.resultado}: ${r.mensagem}`);
    if (r.liberado) totalLiberados++;
    // Pausa entre testes para não sobrecarregar a API
    await new Promise(r => setTimeout(r, 3000));
  }

  const tudoLiberado = totalLiberados === CODIGOS_TESTE.length;
  const parcialLiberado = totalLiberados > 0;

  salvarStatus({
    ultimaVerificacao: new Date().toISOString(),
    tudoLiberado,
    parcialLiberado,
    totalLiberados,
    totalCodigos: CODIGOS_TESTE.length,
    resultados,
  });

  if (tudoLiberado) {
    log('');
    log('🎉🎉🎉 TODOS OS CÓDIGOS LIBERADOS! NFSe pode ser emitida pela aplicação! 🎉🎉🎉');
    log('');
    notificarWindows(
      '✅ NFSe LIBERADA — RJ Logística',
      'A Prefeitura do RJ cadastrou os códigos! Acesse o emissor e emita NFS-e normalmente.'
    );
    tentarEnviarEmail(
      '🎉 NFSe Nacional LIBERADA para sua empresa!',
      `Boas notícias!\n\nA Prefeitura do Rio de Janeiro cadastrou os códigos de tributação nacional para empresas do Simples Nacional no Sistema Nacional NFS-e.\n\nTodos os ${CODIGOS_TESTE.length} códigos testados passaram:\n${resultados.map(r => `  ✅ ${r.codigo} — ${r.descricao}`).join('\n')}\n\nAcesse o Emissor de Notas e emita suas NFS-e normalmente:\nhttps://emissor.rjlogisticaetecnologia.com.br\n\n---\nMonitor NFSe — RJ Logística e Tecnologia`
    );
  } else if (parcialLiberado) {
    log(`⚠️ ${totalLiberados}/${CODIGOS_TESTE.length} códigos liberados — verificar manualmente.`);
    notificarWindows(
      `⚠️ NFSe parcialmente liberada (${totalLiberados}/${CODIGOS_TESTE.length})`,
      'Alguns códigos NFSe foram liberados pelo RJ. Verifique o Emissor de Notas.'
    );
  } else {
    log(`Status: RJ ainda não cadastrou os códigos. Próxima verificação amanhã.`);
  }

  log('Verificação concluída.');
}

function tentarEnviarEmail(assunto, corpo) {
  try {
    // Tenta via servidor de e-mail local (porta 3001)
    const data = JSON.stringify({
      smtp: { host: 'smtp.gmail.com', porta: 587, usuario: '', senha: '', nomeRemetente: 'Monitor NFSe' },
      remetentesEmpresa: ['andreprol@andreprol.com.br'],
      destinatarios: [EMAIL_DEST],
      assunto,
      corpo,
    });
    const req = require('http').request(
      { hostname: 'localhost', port: 3001, path: '/send-email', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => log(`E-mail: HTTP ${res.statusCode}`)
    );
    req.on('error', () => log('E-mail: servidor local indisponível (configure SMTP nas configurações do sistema)'));
    req.write(data);
    req.end();
  } catch(_) {}
}

main().catch(e => log(`ERRO: ${e.message}`));
