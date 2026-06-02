'use strict';
/**
 * Focus NFe Server — Emissor de Notas
 * Porta: 3004
 * Proxy local para a API REST da Focus NFe (homologação e produção)
 * Docs: https://focusnfe.com.br/doc/
 */
const http  = require('http');
const https = require('https');

const PORTA = 3004;
const BASE_HOM  = 'homologacao.focusnfe.com.br';
const BASE_PROD = 'api.focusnfe.com.br';

// ── Helpers ───────────────────────────────────────────────────────────────────

function headers(res, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

function focusRequest({ host, path, method, token, body }) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(token + ':').toString('base64');
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: host,
      port: 443,
      path,
      method: method || 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json; charset=utf-8',
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

// ── Monta payload Focus NFe a partir dos dados do sistema ────────────────────

const FORMA_PAG = {
  'dinheiro': '01', 'pix': '17', 'credito': '03', 'debito': '04',
  'boleto': '15', 'transferencia': '03', 'pix': '17',
};

function montarPayload(dados, config) {
  const {
    nNF, serie, naturezaOp, tpNF, cliente, itens, pagamento, infAdicional,
  } = dados;

  const cnpjLimpo    = (config.cnpj || '').replace(/\D/g, '');
  const destDocLimpo = (cliente.doc || '').replace(/\D/g, '');
  const agora        = new Date().toISOString().replace('Z', '-03:00').slice(0, 22) + ':00';
  const ref          = `nfe-${cnpjLimpo}-${nNF}-${Date.now()}`;

  const payload = {
    cnpj_emitente:          cnpjLimpo,
    ref,
    natureza_operacao:      naturezaOp || 'Venda de Mercadoria',
    data_emissao:           agora,
    data_entrada_saida:     agora,
    tipo_documento:         parseInt(tpNF || '1'),
    finalidade_emissao:     1,
    forma_pagamento:        0,
    presenca_comprador:     1,
    informacoes_adicionais_contribuinte: infAdicional || '',
  };

  // Destinatário
  if (destDocLimpo.length === 14) {
    payload.cnpj_destinatario = destDocLimpo;
  } else {
    payload.cpf_destinatario = destDocLimpo.padStart(11, '0');
  }
  payload.nome_destinatario         = cliente.nome || 'CONSUMIDOR NAO IDENTIFICADO';
  payload.logradouro_destinatario   = cliente.logradouro || 'Não informado';
  payload.numero_destinatario       = cliente.numero || 'S/N';
  payload.bairro_destinatario       = cliente.bairro || 'Centro';
  payload.municipio_destinatario    = cliente.xMun   || 'Rio de Janeiro';
  payload.uf_destinatario           = cliente.uf     || 'RJ';
  payload.cep_destinatario          = (cliente.cep || '').replace(/\D/g, '');
  payload.indicador_ie_destinatario = 9;

  // Itens
  payload.items = itens.map((item, idx) => {
    const vProd = parseFloat(item.vProd || 0);
    const qCom  = parseFloat(item.qCom  || 1);
    const csosn = String(item.csosn || '102');

    const det = {
      numero_item:                 idx + 1,
      codigo_produto:              item.sku        || String(idx + 1).padStart(4, '0'),
      descricao:                   (item.nome      || '').slice(0, 120),
      codigo_ncm:                  (item.ncm       || '').replace(/\D/g, ''),
      cfop:                        item.cfop       || '5102',
      unidade_comercial:           item.unidade    || 'UN',
      quantidade_comercial:        qCom,
      valor_unitario_comercial:    parseFloat(item.vUnCom || vProd / qCom),
      valor_bruto:                 vProd,
      unidade_tributavel:          item.unidade    || 'UN',
      quantidade_tributavel:       qCom,
      valor_unitario_tributavel:   parseFloat(item.vUnCom || vProd / qCom),
      codigo_situacao_tributaria:  csosn,
      origem_mercadoria:           parseInt(item.origem || '0'),
      codigo_beneficio_fiscal:     '',
      inclui_no_total:             1,
      pis_situacao_tributaria:     item.cstPis     || '07',
      cofins_situacao_tributaria:  item.cstCofins  || '07',
    };

    return det;
  });

  // Pagamento
  const pagLower = (pagamento || 'pix').toLowerCase();
  const codPag   = FORMA_PAG[pagLower.split(' ')[0]] || '01';
  const totalNF  = itens.reduce((s, i) => s + parseFloat(i.vProd || 0), 0);
  payload.formas_pagamento = [{ forma_pagamento: codPag, valor_pagamento: totalNF }];

  return { payload, ref };
}

// ── Polling: aguarda autorização (até 30s) ───────────────────────────────────

async function aguardarAutorizacao(host, ref, token, tentativas = 10) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const { status, body } = await focusRequest({
      host, path: `/v2/nfe/${ref}`, method: 'GET', token, body: null,
    });
    if (status === 200 && body.status !== 'processando') {
      return { status, body };
    }
  }
  return { status: 408, body: { status: 'timeout', mensagem: 'Tempo esgotado aguardando SEFAZ.' } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { headers(res); res.end('{}'); return; }

  if (req.url === '/ping') {
    headers(res);
    res.end(JSON.stringify({ ok: true, msg: 'Focus NFe Server ativo.', porta: PORTA }));
    return;
  }

  // ── POST /focus/nfe/emitir ──
  if (req.method === 'POST' && req.url === '/focus/nfe/emitir') {
    try {
      const body    = await lerCorpo(req);
      const { token, dados, config } = body;

      if (!token) {
        headers(res, 400);
        res.end(JSON.stringify({ ok: false, erro: 'Token Focus NFe não informado. Configure nas Configurações do sistema.' }));
        return;
      }

      const amb  = (config.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
      const host = amb === 'producao' ? BASE_PROD : BASE_HOM;

      const { payload, ref } = montarPayload(dados, config);

      // Envia para Focus NFe
      const envio = await focusRequest({
        host, path: `/v2/nfe?ref=${ref}`, method: 'POST', token, body: payload,
      });

      if (envio.status !== 200 && envio.status !== 201 && envio.status !== 202) {
        headers(res, 502);
        const erros = envio.body?.erros?.map(e => e.mensagem).join('; ') || JSON.stringify(envio.body);
        res.end(JSON.stringify({ ok: false, erro: `Focus NFe rejeitou: ${erros}`, detalhe: envio.body }));
        return;
      }

      // Aguarda processamento
      const resultado = await aguardarAutorizacao(host, ref, token);
      const nfe       = resultado.body;

      if (nfe.status === 'autorizado') {
        headers(res);
        res.end(JSON.stringify({
          ok:          true,
          status:      nfe.status,
          chave:       nfe.chave_nfe,
          nProt:       nfe.numero_protocolo,
          serie:       nfe.serie,
          numero:      nfe.numero,
          danfe_url:   nfe.caminho_danfe_etiqueta || nfe.caminho_danfe,
          xml_url:     nfe.caminho_xml_nota_fiscal,
          ref,
        }));
      } else {
        headers(res, 422);
        const motivo = nfe.mensagem_sefaz || nfe.mensagem || nfe.status;
        res.end(JSON.stringify({ ok: false, erro: motivo, status: nfe.status, detalhe: nfe }));
      }

    } catch (err) {
      headers(res, 500);
      res.end(JSON.stringify({ ok: false, erro: err.message }));
    }
    return;
  }

  // ── POST /focus/nfe/cancelar ──
  if (req.method === 'POST' && req.url === '/focus/nfe/cancelar') {
    try {
      const body = await lerCorpo(req);
      const { token, ref, justificativa, config } = body;
      const amb  = (config?.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
      const host = amb === 'producao' ? BASE_PROD : BASE_HOM;

      const resp = await focusRequest({
        host, path: `/v2/nfe/${ref}`, method: 'DELETE', token,
        body: { justificativa: justificativa || 'Cancelamento solicitado pelo emitente.' },
      });

      headers(res, resp.status === 200 ? 200 : 502);
      res.end(JSON.stringify(resp.status === 200
        ? { ok: true, msg: 'Nota cancelada com sucesso.' }
        : { ok: false, erro: resp.body?.mensagem || 'Erro ao cancelar.', detalhe: resp.body }
      ));
    } catch (err) {
      headers(res, 500);
      res.end(JSON.stringify({ ok: false, erro: err.message }));
    }
    return;
  }

  headers(res, 404);
  res.end(JSON.stringify({ ok: false, erro: 'Rota não encontrada.' }));
});

server.listen(PORTA, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Focus NFe Server                          ║');
  console.log(`║   Porta: ${PORTA}   Ambiente: homologação/prod    ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('Aguardando requisições do Emissor de Notas...');
  console.log('Pressione Ctrl+C para encerrar.');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Porta ${PORTA} já está em uso.\n`);
  } else {
    console.error('\n❌ Erro:', err.message, '\n');
  }
  process.exit(1);
});
