/**
 * Emissor de Notas — Servidor Principal
 * Porta: 3003
 * - Serve o index.html e arquivos estáticos
 * - Proxy reverso para email-server (3001) e sefaz-server (3002)
 * - Permite acesso remoto via Tailscale/IP
 */

'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── NFSe Nacional (SEFIN) — RJ usa sistema federal desde 01/01/2026 ────────────
const nfseCarioca = require('./nfse-nacional.cjs');

// ── Focus NFe ─────────────────────────────────────────────────────────────────
const FOCUS_HOM  = 'homologacao.focusnfe.com.br';
const FOCUS_PROD = 'api.focusnfe.com.br';

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

function focusRequest({ host, path: fPath, method, token, body }) {
  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(token + ':').toString('base64');
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: host, port: 443, path: fPath, method: method || 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout Focus NFe')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const FORMA_PAG = { 'dinheiro':'01','pix':'17','credito':'03','debito':'04','boleto':'15','transferencia':'03' };

function montarPayloadFocus(dados, config) {
  const { nNF, serie, naturezaOp, tpNF, cliente, itens, pagamento, infAdicional } = dados;
  const cnpjLimpo    = (config.cnpj || '').replace(/\D/g, '');
  const destDocLimpo = (cliente.doc || '').replace(/\D/g, '');
  const _now = new Date();
  const _br  = new Date(_now.getTime() - 3 * 3600000);
  const _pad = n => String(n).padStart(2, '0');
  const agora = `${_br.getUTCFullYear()}-${_pad(_br.getUTCMonth()+1)}-${_pad(_br.getUTCDate())}T${_pad(_br.getUTCHours())}:${_pad(_br.getUTCMinutes())}:${_pad(_br.getUTCSeconds())}-03:00`;
  const ref          = `nfe-${cnpjLimpo}-${nNF}-${Date.now()}`;

  const payload = {
    cnpj_emitente: cnpjLimpo,
    ref,
    natureza_operacao:  naturezaOp || 'Venda de Mercadoria',
    data_emissao:       agora,
    tipo_documento:     parseInt(tpNF || '1'),
    finalidade_emissao: 1,
    forma_pagamento:    0,
    modalidade_frete:   9,
    presenca_comprador: 1,
    regime_tributario:  1,
    informacoes_adicionais_contribuinte: infAdicional || '',
  };

  if (destDocLimpo.length === 14) payload.cnpj_destinatario = destDocLimpo;
  else payload.cpf_destinatario = destDocLimpo.padStart(11, '0');

  payload.nome_destinatario       = cliente.nome      || 'CONSUMIDOR NAO IDENTIFICADO';
  payload.logradouro_destinatario = cliente.logradouro || 'Não informado';
  payload.numero_destinatario     = cliente.numero     || 'S/N';
  payload.bairro_destinatario     = cliente.bairro     || 'Centro';
  payload.municipio_destinatario  = cliente.xMun       || 'Rio de Janeiro';
  payload.uf_destinatario         = cliente.uf         || 'RJ';
  payload.cep_destinatario        = (cliente.cep || '').replace(/\D/g, '');
  const ieDest = (cliente.ie || '').trim();
  const ieDestDigitos = ieDest.replace(/\D/g, '');
  if (ieDest && ieDest.toUpperCase() !== 'ISENTO') {
    payload.indicador_ie_destinatario = 1;
    payload.inscricao_estadual_destinatario = ieDestDigitos;
  } else if (ieDest.toUpperCase() === 'ISENTO') {
    payload.indicador_ie_destinatario = 2;
  } else {
    payload.indicador_ie_destinatario = 9;
  }

  payload.items = itens.map((item, idx) => ({
    numero_item:               idx + 1,
    codigo_produto:            item.sku      || String(idx + 1).padStart(4, '0'),
    descricao:                 (item.nome    || '').slice(0, 120),
    codigo_ncm:                (item.ncm     || '').replace(/\D/g, ''),
    cfop:                      item.cfop     || '5102',
    unidade_comercial:         item.unidade  || 'UN',
    quantidade_comercial:      parseFloat(item.qCom   || 1),
    valor_unitario_comercial:  parseFloat(item.vUnCom || 0),
    valor_bruto:               parseFloat(item.vProd  || 0),
    unidade_tributavel:        item.unidade  || 'UN',
    quantidade_tributavel:     parseFloat(item.qCom   || 1),
    valor_unitario_tributavel: parseFloat(item.vUnCom || 0),
    icms_situacao_tributaria:     String(item.csosn || '102'),
    icms_origem:                  parseInt(item.origem || '0'),
    inclui_no_total:              1,
    pis_situacao_tributaria:      item.cstPis    || '07',
    pis_base_calculo:             0,
    pis_aliquota_percentual:      0,
    pis_valor:                    0,
    cofins_situacao_tributaria:   item.cstCofins || '07',
    cofins_base_calculo:          0,
    cofins_aliquota_percentual:   0,
    cofins_valor:                 0,
  }));

  const pagLower = (pagamento || 'pix').toLowerCase();
  const codPag   = FORMA_PAG[pagLower.split(' ')[0]] || '01';
  const totalNF  = itens.reduce((s, i) => s + parseFloat(i.vProd || 0), 0);
  payload.formas_pagamento = [{ forma_pagamento: codPag, valor_pagamento: totalNF }];

  return { payload, ref };
}

const STATUS_PENDENTES = ['processando', 'processando_autorizacao', 'recebido', 'em_processamento'];

async function aguardarAutorizacaoFocus(host, ref, token, tentativas = 20) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const { status, body } = await focusRequest({ host, path: `/v2/nfe/${ref}`, method: 'GET', token, body: null });
    if (status === 200 && !STATUS_PENDENTES.includes(body.status)) return { status, body };
  }
  return { status: 408, body: { status: 'timeout', mensagem: 'Tempo esgotado aguardando SEFAZ.' } };
}

// ── NFS-e ─────────────────────────────────────────────────────────────────────
const STATUS_PENDENTES_NFSE = ['processando', 'recebido', 'em_processamento', 'processando_autorizacao'];

function montarPayloadNfse(dados, config) {
  const { tomador, servico, naturezaOp, regimeEspecial, infAdicional } = dados;
  const cnpjLimpo  = (config.cnpj || '').replace(/\D/g, '');
  const inscMun    = (config.inscricaoMunicipal || '16269891').replace(/\D/g, '');
  const _now = new Date();
  const _br  = new Date(_now.getTime() - 3 * 3600000);
  const _pad = n => String(n).padStart(2, '0');
  const agora = `${_br.getUTCFullYear()}-${_pad(_br.getUTCMonth()+1)}-${_pad(_br.getUTCDate())}T${_pad(_br.getUTCHours())}:${_pad(_br.getUTCMinutes())}:${_pad(_br.getUTCSeconds())}-03:00`;
  const ref   = `nfsen-${cnpjLimpo}-${Date.now()}`;

  const tomDoc = (tomador.doc || '').replace(/\D/g, '');

  const valorServico = parseFloat(servico.valor || 0);

  // Mapeamento CNAE → [cTribNac 6 dígitos LC116, NBS 9 dígitos AnexoVIII]
  // Fonte: nfsenacional.prefeitura.rio/codtribriov2-0/ + gov.br AnexoVIII (jun/2026)
  const CNAE_CTN = {
    '5320202': ['150603', '107020000'], // Coleta e entrega de documentos, bens e valores
    '5320201': ['260101', '105011500'], // Coleta/remessa de correspondências (malote)
    '4930202': ['160201', '105011110'], // Transporte rodoviário municipal de carga
    '9511800': ['140101', '120012000'], // Manutenção e reparação de computadores
  };
  const cnaeLimpo = (servico.cnae || '5320202').replace(/\D/g, '');
  const [cTribNac, codigoNbs] = CNAE_CTN[cnaeLimpo] || ['150603', '107020000'];

  // NFSe Nacional (/v2/nfsen) — payload baseado no exemplo oficial Focus NFe
  const payload = {
    data_emissao:                  agora,
    data_competencia:              agora.slice(0, 10),
    codigo_municipio_emissora:     3304557,

    // Prestador (inscrição municipal não deve ser enviada no Ambiente Nacional para RJ)
    cnpj_prestador: cnpjLimpo,
    codigo_opcao_simples_nacional: 1,
    regime_especial_tributacao:    parseInt(regimeEspecial || '0'),

    // Serviço
    codigo_municipio_prestacao:     3304557,
    codigo_tributacao_nacional_iss: cTribNac,
    codigo_nbs:                     codigoNbs,
    codigo_cnae:                    cnaeLimpo,
    descricao_servico:             servico.discriminacao || '',
    valor_servico:                 valorServico,

    // Tributação ISS
    tributacao_iss:    1,
    tipo_retencao_iss: parseInt(servico.issRetido || '2'),
  };

  // Tomador — doc obrigatório
  if (tomDoc.length === 14)      payload.cnpj_tomador = tomDoc;
  else if (tomDoc.length === 11) payload.cpf_tomador  = tomDoc;
  payload.razao_social_tomador = tomador.nome  || 'CONSUMIDOR NAO IDENTIFICADO';
  if (tomador.email) payload.email_tomador = tomador.email;

  // Endereço do tomador — só inclui se CEP preenchido
  const cepLimpo = (tomador.cep || '').replace(/\D/g, '');
  if (cepLimpo) {
    payload.cep_tomador              = cepLimpo;
    payload.logradouro_tomador       = tomador.logradouro  || '';
    payload.numero_tomador           = tomador.numero      || 'S/N';
    payload.bairro_tomador           = tomador.bairro      || '';
    payload.codigo_municipio_tomador = parseInt(tomador.codigoMun || '3304557');
  }

  if (infAdicional) payload.informacoes_adicionais = infAdicional;

  return { payload, ref };
}

async function aguardarAutorizacaoNfse(host, ref, token, tentativas = 40) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise(r => setTimeout(r, 30000));
    // Rio de Janeiro usa NFSe Nacional → endpoint /v2/nfsen
    const { status, body } = await focusRequest({ host, path: `/v2/nfsen/${ref}`, method: 'GET', token, body: null });
    console.log(`[NFS-e poll ${i+1}/${tentativas}] status HTTP: ${status}, status nota: ${body?.status}`);
    if (status === 200 && !STATUS_PENDENTES_NFSE.includes(body.status)) return { status, body };
    if (status === 404) return { status, body };
  }
  return { status: 408, body: { status: 'timeout', mensagem: 'Tempo esgotado aguardando prefeitura.' } };
}

async function handleFocusNfseEmitir(req, res) {
  try {
    const body = await lerCorpo(req);
    const { token, dados, config } = body;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Token Focus NFe não informado.' })); return; }

    const amb  = (config.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;

    // Lê CNPJ e inscrição municipal direto do config salvo no servidor
    let configEmpresa = {};
    try { configEmpresa = JSON.parse(dbRead('techstore-config') || '{}'); } catch(_) {}
    const configCompleto = {
      ...config,
      cnpj:               (configEmpresa['cfg-cnpj']          || config.cnpj || '').replace(/\D/g,''),
      inscricaoMunicipal: (configEmpresa['cfg-im']             || config.inscricaoMunicipal || '16269891').replace(/\D/g,''),
      razaoSocial:         configEmpresa['cfg-razao-social']   || config.razaoSocial || 'RIO DE JANEIRO LOGISTICA E TECNOLOGIA LTDA',
      cep:                (configEmpresa['cfg-cep']            || '23042530').replace(/\D/g,''),
      logradouro:          configEmpresa['cfg-logradouro']     || 'Rua Manuel Beckmann',
      numero:              configEmpresa['cfg-numero']         || '834',
      complemento:         configEmpresa['cfg-complemento']   || '',
      bairro:              configEmpresa['cfg-bairro']         || 'Campo Grande',
    };

    const { payload, ref } = montarPayloadNfse(dados, configCompleto);

    console.log('[NFS-e payload] cnpj:', payload.cnpj_prestador, 'inscMun:', payload.inscricao_municipal_prestador);
    // Rio de Janeiro usa NFSe Nacional → endpoint /v2/nfsen
    const envio = await focusRequest({ host, path: `/v2/nfsen?ref=${ref}`, method: 'POST', token, body: payload });
    console.log('[NFS-e envio] status:', envio.status, 'body:', JSON.stringify(envio.body).slice(0, 300));

    if (![200, 201, 202].includes(envio.status)) {
      let erros = '—';
      try {
        erros = (envio.body?.erros || []).map(e => e.mensagem).join('; ') || String(envio.body);
      } catch(_) { erros = String(envio.body); }
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:false, erro:`Focus NFe rejeitou (${envio.status}): ${erros}`, detalhe: String(envio.body) }));
      return;
    }

    // Retorna imediatamente com status "aguardando" — prefeitura processa de forma assíncrona
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, status: 'aguardando', ref, ambiente: amb }));
  } catch (err) {
    console.error('[NFS-e erro]', err.message);
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:false, erro: err.message }));
  }
}

async function handleFocusNfseCancelar(req, res) {
  try {
    const body = await lerCorpo(req);
    const { token, ref, justificativa, config } = body;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Token não informado.' })); return; }
    if (!ref)   { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Referência (ref) não informada.' })); return; }

    const amb  = (config?.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;

    const result = await focusRequest({
      host,
      path: `/v2/nfsen/${ref}`,
      method: 'DELETE',
      token,
      body: { justificativa: justificativa || 'Cancelamento solicitado pelo emitente.' },
    });

    if ([200, 201, 202].includes(result.status)) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, status: result.body?.status, msg: 'Cancelamento solicitado com sucesso.', detalhe: result.body }));
    } else {
      const erros = result.body?.erros?.map(e => e.mensagem).join('; ') || JSON.stringify(result.body);
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, erro: `Focus NFe: ${erros}`, detalhe: result.body }));
    }
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

async function handleFocusNfseConsultar(req, res, ref, token, config) {
  try {
    const amb  = (config?.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;
    const result = await focusRequest({ host, path: `/v2/nfsen/${ref}`, method: 'GET', token, body: null });
    console.log(`[NFS-e consulta] ref: ${ref} → status HTTP: ${result.status}, status nota: ${result.body?.status}, erros: ${JSON.stringify(result.body?.erros || result.body?.mensagem_sefaz || result.body?.mensagem || '').slice(0,400)}`);
    res.writeHead(result.status === 200 ? 200 : 404, {'Content-Type':'application/json'});
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

async function handleFocusEmitir(req, res) {
  try {
    const body   = await lerCorpo(req);
    const { token, dados, config } = body;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Token Focus NFe não informado.' })); return; }

    const amb  = (config.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;
    const { payload, ref } = montarPayloadFocus(dados, config);

    const envio = await focusRequest({ host, path: `/v2/nfe?ref=${ref}`, method: 'POST', token, body: payload });
    if (![200, 201, 202].includes(envio.status)) {
      const erros = envio.body?.erros?.map(e => e.mensagem).join('; ') || JSON.stringify(envio.body);
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:false, erro:`Focus NFe rejeitou: ${erros}`, detalhe: envio.body }));
      return;
    }

    const resultado = await aguardarAutorizacaoFocus(host, ref, token);
    const nfe = resultado.body;

    if (nfe.status === 'autorizado') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, status:nfe.status, chave:nfe.chave_nfe, nProt:nfe.numero_protocolo, serie:nfe.serie, numero:nfe.numero, danfe_url:nfe.caminho_danfe_etiqueta||nfe.caminho_danfe, xml_url:nfe.caminho_xml_nota_fiscal, ref }));
    } else {
      res.writeHead(422, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:false, erro: nfe.mensagem_sefaz || nfe.mensagem || nfe.status, status: nfe.status, detalhe: nfe }));
    }
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:false, erro: err.message }));
  }
}

async function handleFocusCancelar(req, res) {
  try {
    const body = await lerCorpo(req);
    const { token, ref, justificativa, config } = body;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Token não informado.' })); return; }
    if (!ref)   { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Referência (ref) não informada.' })); return; }

    const amb  = (config?.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;

    const result = await focusRequest({
      host,
      path: `/v2/nfe/${ref}`,
      method: 'DELETE',
      token,
      body: { justificativa: justificativa || 'Cancelamento solicitado pelo emitente.' },
    });

    if ([200, 201, 202].includes(result.status)) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, status: result.body?.status, msg: 'Cancelamento solicitado com sucesso.', detalhe: result.body }));
    } else {
      const erros = result.body?.erros?.map(e => e.mensagem).join('; ') || JSON.stringify(result.body);
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, erro: `Focus NFe: ${erros}`, detalhe: result.body }));
    }
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

const PORTA = 3003;
const DIR   = __dirname;

// ── Armazenamento de dados no servidor ───────────────────────────────────────
const DATA_DIR = path.join(DIR, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const DB_KEYS = new Set([
  'techstore-config', 'techstore-produtos', 'techstore-clientes',
  'techstore-notas-emitidas', 'techstore-nfse-emitidas', 'techstore-usuarios', 'techstore-convites',
  'techstore-cert', 'techstore-nfe-ultNSU',
]);

function dbRead(key) {
  const file = path.join(DATA_DIR, key + '.json');
  if (!fs.existsSync(file)) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function dbWrite(key, body) {
  fs.writeFileSync(path.join(DATA_DIR, key + '.json'), body, 'utf8');
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Proxy reverso para serviços locais ────────────────────────────────────────
function proxyRequest(req, res, targetPort, targetPath) {
  const opts = {
    hostname: '127.0.0.1',
    port:     targetPort,
    path:     targetPath,
    method:   req.method,
    headers:  { ...req.headers, host: `127.0.0.1:${targetPort}` },
  };

  const proxyReq = http.request(opts, proxyRes => {
    // CORS para acesso remoto
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    const servico = targetPort === 3001 ? 'Email Server' : 'SEFAZ Server';
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      erro: `${servico} não está rodando (porta ${targetPort}). Contate o administrador.`,
    }));
  });

  req.pipe(proxyReq);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── Proxy: /email/* → porta 3001 ──
  if (pathname.startsWith('/email/')) {
    const target = pathname.replace('/email', '');
    return proxyRequest(req, res, 3001, target + (parsed.search || ''));
  }

  // ── Proxy: /sefaz/* → porta 3002 ──
  if (pathname.startsWith('/sefaz/')) {
    const target = pathname.replace('/sefaz', '');
    return proxyRequest(req, res, 3002, target + (parsed.search || ''));
  }

  // ── API de dados: GET /api/data/:key ──
  if (req.method === 'GET' && pathname.startsWith('/api/data/')) {
    const key = pathname.slice('/api/data/'.length);
    if (!DB_KEYS.has(key)) { res.writeHead(404, {'Content-Type':'application/json'}); res.end('null'); return; }
    const data = dbRead(key);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end(data !== null ? data : 'null');
    return;
  }

  // ── API de dados: POST /api/data/:key ──
  if (req.method === 'POST' && pathname.startsWith('/api/data/')) {
    const key = pathname.slice('/api/data/'.length);
    if (!DB_KEYS.has(key)) { res.writeHead(403, {'Content-Type':'application/json'}); res.end('{"ok":false}'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        JSON.parse(body); // valida JSON antes de salvar
        dbWrite(key, body);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end('{"ok":true}');
      } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end('{"ok":false,"erro":"JSON inválido"}');
      }
    });
    return;
  }

  // ── Proxy download Focus NFe: /focus/download?url=...&token=... ──
  if (req.method === 'GET' && pathname === '/focus/download') {
    try {
      const qs      = new URLSearchParams(parsed.query || '');
      const fileUrl = qs.get('url');
      const token   = qs.get('token') || '';
if (!fileUrl) { res.writeHead(400); res.end('url obrigatória'); return; }
      const target  = new URL(fileUrl);
      const auth    = Buffer.from(token + ':').toString('base64');
      const reqOpts = {
        hostname: target.hostname, port: 443,
        path: target.pathname + (target.search || ''),
        method: 'GET',
        headers: { 'Authorization': `Basic ${auth}` },
      };
      const proxyR = https.request(reqOpts, proxyRes => {
        const ct = proxyRes.headers['content-type'] || 'application/octet-stream';
        res.writeHead(proxyRes.statusCode, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
        proxyRes.pipe(res);
      });
      proxyR.on('error', e => { res.writeHead(502); res.end(e.message); });
      proxyR.end();
    } catch(e) {
      console.error('[download] erro:', e.message);
      res.writeHead(400); res.end('Erro: ' + e.message);
    }
    return;
  }

  // ── Focus NFe: /focus/nfe/emitir ──
  if (req.method === 'POST' && pathname === '/focus/nfe/emitir') {
    return handleFocusEmitir(req, res);
  }

  // ── Focus NFe: /focus/nfe/cancelar ──
  if (req.method === 'POST' && pathname === '/focus/nfe/cancelar') {
    return handleFocusCancelar(req, res);
  }

  // ── Focus NFS-e: /focus/nfse/emitir ──
  if (req.method === 'POST' && pathname === '/focus/nfse/emitir') {
    return handleFocusNfseEmitir(req, res);
  }

  // ── Focus NFS-e: /focus/nfse/cancelar ──
  if (req.method === 'POST' && pathname === '/focus/nfse/cancelar') {
    return handleFocusNfseCancelar(req, res);
  }

  // ── Focus NFS-e: /focus/nfse/consultar?ref=...&token=...&ambiente=... ──
  if (req.method === 'GET' && pathname === '/focus/nfse/consultar') {
    const qs     = new URLSearchParams(parsed.query || '');
    const ref    = qs.get('ref');
    const token  = qs.get('token') || '';
    const config = { ambiente: qs.get('ambiente') || '' };
    if (!ref) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'ref obrigatório' })); return; }
    return handleFocusNfseConsultar(req, res, ref, token, config);
  }

  // ── NFSe Nota Carioca: /nfse/emitir ──────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/nfse/emitir') {
    return nfseCarioca.handleEmitir(req, res);
  }

  // ── NFSe Nota Carioca: /nfse/consultar?chaveAcesso=...&ambiente=... ──────────
  if (req.method === 'GET' && pathname === '/nfse/consultar') {
    return nfseCarioca.handleConsultar(req, res, parsed);
  }

  // ── NFSe Nota Carioca: /nfse/cancelar ────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/nfse/cancelar') {
    return nfseCarioca.handleCancelar(req, res);
  }

  // ── Ping Focus NFe ──
  if (pathname === '/focus/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'Focus NFe pronto.' }));
    return;
  }

  // ── Arquivos estáticos ──
  let filePath = path.join(DIR, pathname === '/' ? 'index.html' : pathname);

  // Segurança: não permite sair da pasta
  if (!filePath.startsWith(DIR)) {
    res.writeHead(403);
    res.end('Proibido');
    return;
  }

  // Se o arquivo não existe, serve index.html (SPA fallback)
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIR, 'index.html');
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Arquivo não encontrado: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type':  mimeType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

server.listen(PORTA, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Emissor de Notas — Servidor Principal      ║');
  console.log(`║   Porta: ${PORTA}  — Acesso local e remoto       ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Local:   http://localhost:${PORTA}`);
  console.log(`  Rede:    http://0.0.0.0:${PORTA}`);
  console.log('');
  console.log('  Rotas proxy:');
  console.log('    /email/*  → porta 3001 (Email Server)');
  console.log('    /sefaz/*  → porta 3002 (SEFAZ Server)');
  console.log('');
  console.log('Pressione Ctrl+C para encerrar.');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Porta ${PORTA} já está em uso.\n`);
  } else {
    console.error('\n❌ Erro:', err.message);
  }
  process.exit(1);
});
