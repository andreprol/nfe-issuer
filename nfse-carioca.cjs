'use strict';

/**
 * NFS-e Nacional — Integração com ADN (Ambiente de Dados Nacional)
 *
 * Fluxo: dados → DPS XML → XMLDSig (infDPS) → mTLS POST /nfse
 * Padrão: NFS-e Nacional v1.00 (DPS_v1.00.xsd)
 *         xmlns http://www.sped.fazenda.gov.br/nfse
 *
 * PCRJ migrou para NFS-e Nacional em 01/01/2026.
 * O antigo webservice ABRASF v1 (notacariocahom.rio.gov.br) rejeita datas ≥ 2026.
 *
 * Endpoints:
 *   Produção:    https://adn.nfse.gov.br/nfse
 *   Homologação: https://adn.producaorestrita.nfse.gov.br/nfse
 *
 * Autenticação: mTLS com certificado ICP-Brasil A1 (mesmo PFX já configurado no app)
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

const gzipAsync = buf => new Promise((res, rej) => zlib.gzip(buf, (e, b) => e ? rej(e) : res(b)));

// ── Constantes ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const SEQ_FILE = path.join(DATA_DIR, 'nfse-carioca-seq.json');

const NS_NFSE = 'http://www.sped.fazenda.gov.br/nfse';

const PROD_HOST = 'sefin.nfse.gov.br';
const HOM_HOST  = 'sefin.producaorestrita.nfse.gov.br';
const API_PATH  = '/SefinNacional/nfse';

// Rio de Janeiro — código IBGE 7 dígitos (cLocEmi, cLocPrestacao padrão)
const C_MUN_RJ = '3304557';

// Mapeamento CNAE → {cTribNac: código nacional ISSQN 6 dígitos, cNBS: código NBS 9 dígitos}
// cTribNac = código LC 116/2003 sem pontos, 6 dígitos (ex: "140115" = subitem 14.01.15)
// cNBS     = Nomenclatura Brasileira de Serviços, 9 dígitos (verificar tabela oficial NBS/MDIC)
const CNAE_MAP = {
  '9511800': { cTribNac: '140115', cNBS: '102041900' }, // Manutenção de computadores e periféricos
  '9512600': { cTribNac: '140115', cNBS: '102041900' }, // Manutenção de equipamentos de comunicação
  '6201500': { cTribNac: '010102', cNBS: '103091110' }, // Desenvolvimento de programas de computador sob encomenda
  '6202300': { cTribNac: '170100', cNBS: '103091190' }, // Desenvolvimento e licenciamento de programas
  '6209100': { cTribNac: '010700', cNBS: '102041310' }, // Suporte técnico em informática
  '5320202': { cTribNac: '150603', cNBS: '106051000' }, // Coleta e entrega de encomendas e documentos
  '5320201': { cTribNac: '150603', cNBS: '106051000' }, // Serviços de malote e correspondência
  '7490100': { cTribNac: '170100', cNBS: '103999900' }, // Atividades profissionais especializadas
  '8020000': { cTribNac: '110203', cNBS: '101191090' }, // Vigilância e segurança privada
};

// ── Helpers ─────────────────────────────────────────────────────────────────────

function xmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Retorna datetime atual em BRT com offset: "2026-07-06T10:00:00-03:00"
function dhEmiAgora() {
  const now = new Date();
  const br  = new Date(now.getTime() - 3 * 3600_000);
  const p   = n => String(n).padStart(2, '0');
  return `${br.getUTCFullYear()}-${p(br.getUTCMonth()+1)}-${p(br.getUTCDate())}T${p(br.getUTCHours())}:${p(br.getUTCMinutes())}:${p(br.getUTCSeconds())}-03:00`;
}

// Retorna data atual em BRT: "2026-07-06"
function dCompetHoje() {
  const now = new Date();
  const br  = new Date(now.getTime() - 3 * 3600_000);
  const p   = n => String(n).padStart(2, '0');
  return `${br.getUTCFullYear()}-${p(br.getUTCMonth()+1)}-${p(br.getUTCDate())}`;
}

function lerCorpoReq(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

function respJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function lerConfigEmpresa() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'techstore-config.json'), 'utf8') || '{}'); }
  catch { return {}; }
}

function extrairTagTexto(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([^<]*)<`));
  return m ? m[1].trim() : null;
}

// ── Certificado ─────────────────────────────────────────────────────────────────

function certLoader() {
  const file = path.join(DATA_DIR, 'techstore-cert.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw?.base64 || !raw?.senha) return null;
    return { pfxBuffer: Buffer.from(raw.base64, 'base64'), passphrase: raw.senha };
  } catch { return null; }
}

// ── Sequência DPS ────────────────────────────────────────────────────────────────

function proximoNDps() {
  let seq = {};
  try { seq = JSON.parse(fs.readFileSync(SEQ_FILE, 'utf8')); } catch {}
  const n = (seq.nRps || 0) + 1;
  seq.nRps = n;
  fs.writeFileSync(SEQ_FILE, JSON.stringify(seq, null, 2), 'utf8');
  return n;
}

function rollbackNDps() {
  try {
    const seq = JSON.parse(fs.readFileSync(SEQ_FILE, 'utf8'));
    if (seq.nRps > 0) { seq.nRps--; fs.writeFileSync(SEQ_FILE, JSON.stringify(seq, null, 2), 'utf8'); }
  } catch {}
}

// ── Montagem da DPS XML ─────────────────────────────────────────────────────────
//
// Estrutura baseada em DPS_v1.00.xsd (NFS-e Nacional v1.00, set/2025)
// Campos obrigatórios para prestador Simples Nacional, serviço doméstico, sem tomador exterior.
//
function montarDPS({ nDps, cnpj, inscMun, dados, tpAmb }) {
  const { tomador, servico } = dados;
  const dpsId = `DPS-${cnpj}-${nDps}`;

  // ── Serviço ──
  const cnaeLimpo = (servico.cnae || '9511800').replace(/\D/g, '');
  const svcMap    = CNAE_MAP[cnaeLimpo] || CNAE_MAP['9511800'];

  // Override manual tem prioridade sobre o mapa CNAE
  const cTribNac = servico.codigoTributacao || svcMap.cTribNac;
  const cNBS     = servico.codigoNBS        || svcMap.cNBS;

  const valorServico = parseFloat(servico.valor || 0).toFixed(2);

  // aliquota: app envia valor percentual (ex: 5 = 5%)
  const pAliq = parseFloat(servico.aliquotaIss || servico.aliquota || 5).toFixed(2);

  // issRetido (convenção antiga): 1=retido, 2=não retido
  // tpRetISSQN (DPS):             1=não retido, 2=retido pelo tomador
  const issRetidoAntig = parseInt(servico.issRetido ?? '2');
  const tpRetISSQN     = issRetidoAntig === 1 ? '2' : '1';

  // ── Tomador — identificação ──
  const tomDoc = (tomador.doc || '').replace(/\D/g, '');
  let tomIdXml = '';
  if      (tomDoc.length === 14) tomIdXml = `<CNPJ>${tomDoc}</CNPJ>`;
  else if (tomDoc.length === 11) tomIdXml = `<CPF>${tomDoc}</CPF>`;

  // ── Tomador — endereço nacional (opcional; obrigatório quando ISS retido) ──
  let tomEndXml = '';
  const cepLimpo = (tomador.cep || '').replace(/\D/g, '');
  if (cepLimpo.length === 8) {
    const cMunToma = (tomador.codigoIbge || C_MUN_RJ).replace(/\D/g, '').slice(0, 7);
    tomEndXml =
      `<end>` +
        `<endNac>` +
          `<cMun>${cMunToma}</cMun>` +
          `<CEP>${cepLimpo}</CEP>` +
        `</endNac>` +
        `<xLgr>${xmlEsc(tomador.logradouro || '')}</xLgr>` +
        `<nro>${xmlEsc(tomador.numero || 'SN')}</nro>` +
        (tomador.complemento ? `<xCpl>${xmlEsc(tomador.complemento)}</xCpl>` : '') +
        `<xBairro>${xmlEsc(tomador.bairro || '')}</xBairro>` +
      `</end>`;
  }

  // ── Local de prestação ──
  const cLocPrestacao = (servico.codigoMunicipioPrestacao || C_MUN_RJ).replace(/\D/g, '').slice(0, 7);

  // ── Monta DPS XML ──
  const dpsXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DPS xmlns="${NS_NFSE}" versao="1.00">` +
      `<infDPS Id="${dpsId}">` +
        `<tpAmb>${tpAmb || '2'}</tpAmb>` +
        `<dhEmi>${dhEmiAgora()}</dhEmi>` +
        `<verAplic>emissor-notas-1.0</verAplic>` +
        `<serie>1</serie>` +
        `<nDPS>${nDps}</nDPS>` +
        `<dCompet>${dCompetHoje()}</dCompet>` +
        `<tpEmit>1</tpEmit>` +
        `<cLocEmi>${C_MUN_RJ}</cLocEmi>` +

        `<prest>` +
          `<CNPJ>${cnpj}</CNPJ>` +
          `<IM>${inscMun}</IM>` +
          `<regTrib>` +
            `<opSimpNac>3</opSimpNac>` +
            `<regEspTrib>0</regEspTrib>` +
          `</regTrib>` +
        `</prest>` +

        (tomIdXml
          ? `<toma>` +
              tomIdXml +
              (tomador.nome ? `<xNome>${xmlEsc(tomador.nome)}</xNome>` : '') +
              tomEndXml +
            `</toma>`
          : ''
        ) +

        `<serv>` +
          `<locPrest>` +
            `<cLocPrestacao>${cLocPrestacao}</cLocPrestacao>` +
          `</locPrest>` +
          `<cServ>` +
            `<cTribNac>${cTribNac}</cTribNac>` +
            `<xDescServ>${xmlEsc(servico.discriminacao)}</xDescServ>` +
            `<cNBS>${cNBS}</cNBS>` +
          `</cServ>` +
        `</serv>` +

        `<valores>` +
          `<vServPrest>` +
            `<vServ>${valorServico}</vServ>` +
          `</vServPrest>` +
          `<trib>` +
            `<tribMun>` +
              `<tribISSQN>1</tribISSQN>` +
              `<tpRetISSQN>${tpRetISSQN}</tpRetISSQN>` +
              `<pAliq>${pAliq}</pAliq>` +
            `</tribMun>` +
            `<totTrib>` +
              `<indTotTrib>0</indTotTrib>` +
            `</totTrib>` +
          `</trib>` +
        `</valores>` +

      `</infDPS>` +
    `</DPS>`;

  return { dpsXml, dpsId };
}

// ── Assinatura XMLDSig da infDPS ─────────────────────────────────────────────────
//
// Assina o elemento <infDPS Id="DPS-..."> com enveloped signature (RSA-SHA1 + C14N)
// A <Signature> é inserida como último filho de <infDPS>.
//
async function assinarDPS(dpsXml, dpsId, pfxBuffer, passphrase) {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary'), 'binary'));
  const p12     = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, passphrase);

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag  = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || []).find(b => b.key);
  if (!keyBag?.key) throw new Error('Chave privada não encontrada no PFX.');
  const privateKey = forge.pki.privateKeyToPem(keyBag.key);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag  = (certBags[forge.pki.oids.certBag] || []).find(b => b.cert);
  if (!certBag?.cert) throw new Error('Certificado público não encontrado no PFX.');
  const publicCert = forge.pki.certificateToPem(certBag.cert);

  const sig = new SignedXml({
    privateKey,
    publicCert,
    signatureAlgorithm:        'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });

  sig.addReference({
    xpath:           `//*[@Id='${dpsId}']`,
    transforms:      [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    uri:             `#${dpsId}`,
    isEmptyUri:      false,
  });

  await sig.computeSignature(dpsXml, {
    prefix:   '',
    location: {
      reference: `//*[local-name()='infDPS']`,
      action:    'append',
    },
  });

  return sig.getSignedXml();
}

// ── Requisições HTTPS mTLS ──────────────────────────────────────────────────────

function apiRequest({ host, apiPath, method, body, pfxBuffer, passphrase, contentType }) {
  return new Promise((resolve, reject) => {
    const buf     = body ? Buffer.from(body, 'utf8') : null;
    const headers = { 'Accept': 'application/json' };
    if (buf && buf.length > 0) {
      headers['Content-Type']   = contentType || 'application/json; charset=utf-8';
      headers['Content-Length'] = buf.length;
    }

    const opts = {
      hostname:           host,
      port:               443,
      path:               apiPath,
      method:             method || 'POST',
      headers,
      pfx:                pfxBuffer,
      passphrase,
      rejectUnauthorized: false,
      timeout:            30000,
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout na conexão com ADN NFS-e Nacional.')); });
    if (buf && buf.length > 0) req.write(buf);
    req.end();
  });
}

// ── Parsing de respostas da API ─────────────────────────────────────────────────

function parsearRespostaEmissao(rawResp, status) {
  // SEFIN retorna JSON
  const trimmed = (rawResp || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(rawResp);
      if (status < 400 && json.chNFSe) {
        return { ok: true, chNFSe: json.chNFSe, nNFSe: json.nNFSe, dhEmi: json.dhEmi || json.dhProc };
      }
      const erros = Array.isArray(json.errors) ? json.errors.map(e => e.message || JSON.stringify(e)).join('; ')
                  : Array.isArray(json.erros)  ? json.erros.map(e => e.mensagem || JSON.stringify(e)).join('; ')
                  : null;
      const msg = json.message || json.mensagem || json.erro || erros || JSON.stringify(json).slice(0, 400);
      const cod = json.code || json.codigo;
      return { ok: false, erro: cod ? `[${cod}] ${msg}` : msg };
    } catch {}
  }

  // Fallback XML (legado ou resposta de erro em XML)
  if (status >= 400) {
    const cod = extrairTagTexto(rawResp, 'codigo') || extrairTagTexto(rawResp, 'Codigo');
    const msg = extrairTagTexto(rawResp, 'mensagem') || extrairTagTexto(rawResp, 'Mensagem')
             || extrairTagTexto(rawResp, 'xMotivo') || rawResp.slice(0, 300) || `HTTP ${status}`;
    return { ok: false, erro: cod ? `[${cod}] ${msg}` : msg };
  }

  const chNFSe = extrairTagTexto(rawResp, 'chNFSe');
  const nNFSe  = extrairTagTexto(rawResp, 'nNFSe');
  const dhEmi  = extrairTagTexto(rawResp, 'dhEmi') || extrairTagTexto(rawResp, 'dhProc');
  if (chNFSe || nNFSe) return { ok: true, chNFSe, nNFSe, dhEmi };

  const cod = extrairTagTexto(rawResp, 'codigo') || extrairTagTexto(rawResp, 'Codigo');
  const msg = extrairTagTexto(rawResp, 'xMotivo') || extrairTagTexto(rawResp, 'mensagem')
           || extrairTagTexto(rawResp, 'Mensagem') || rawResp.slice(0, 500) || `HTTP ${status}`;
  return { ok: false, erro: cod ? `[${cod}] ${msg}` : msg };
}

// ── handleEmitir ────────────────────────────────────────────────────────────────

async function handleEmitir(req, res) {
  try {
    const corpo = await lerCorpoReq(req);
    const { dados, config } = corpo;

    if (!dados) return respJson(res, 400, { ok: false, erro: 'Campo "dados" ausente.' });

    const cert = certLoader();
    if (!cert) return respJson(res, 400, { ok: false, erro: 'Certificado digital não configurado. Acesse Configurações > Certificado.' });

    const cfgEmpresa = lerConfigEmpresa();
    const cnpj       = (cfgEmpresa['cfg-cnpj'] || config?.cnpj || '').replace(/\D/g, '');
    const inscMun    = cfgEmpresa['cfg-inscricao-municipal'] || config?.inscricaoMunicipal || '';

    if (!cnpj || cnpj.length !== 14) return respJson(res, 400, { ok: false, erro: 'CNPJ não configurado. Acesse Configurações.' });
    if (!inscMun) return respJson(res, 400, { ok: false, erro: 'Inscrição Municipal não configurada. Acesse Configurações e preencha o campo "Inscrição Municipal ISS".' });

    const producao = (config?.ambiente || '').toLowerCase().includes('produ');
    const ambiente = producao ? 'producao' : 'homologacao';
    const apiHost  = producao ? PROD_HOST : HOM_HOST;
    const tpAmb    = producao ? '1' : '2';

    const nDps = proximoNDps();
    console.log(`[NFS-e Nacional] Emitindo DPS nº ${nDps} em ${ambiente}...`);

    let dpsAssinada;
    try {
      const { dpsXml, dpsId } = montarDPS({ nDps, cnpj, inscMun, dados, tpAmb });
      dpsAssinada = await assinarDPS(dpsXml, dpsId, cert.pfxBuffer, cert.passphrase);
      console.log(`[NFS-e Nacional] DPS ${dpsId} assinada.`);
    } catch (err) {
      rollbackNDps();
      return respJson(res, 400, { ok: false, erro: `Erro ao assinar DPS: ${err.message}` });
    }

    // DPS → gzip → base64 → JSON {dpsXmlGZipB64}
    let bodyJson;
    try {
      const dpsGzipped    = await gzipAsync(Buffer.from(dpsAssinada, 'utf8'));
      const dpsXmlGZipB64 = dpsGzipped.toString('base64');
      bodyJson = JSON.stringify({ dpsXmlGZipB64 });
    } catch (err) {
      rollbackNDps();
      return respJson(res, 400, { ok: false, erro: `Erro ao compactar DPS: ${err.message}` });
    }

    let resposta;
    try {
      resposta = await apiRequest({
        host:        apiHost,
        apiPath:     API_PATH,
        method:      'POST',
        body:        bodyJson,
        pfxBuffer:   cert.pfxBuffer,
        passphrase:  cert.passphrase,
        contentType: 'application/json; charset=utf-8',
      });
    } catch (err) {
      rollbackNDps();
      return respJson(res, 500, { ok: false, erro: `Erro de comunicação com ADN: ${err.message}` });
    }

    console.log(`[NFS-e Nacional] HTTP ${resposta.status}, resposta:`, resposta.body.slice(0, 500));

    const resultado = parsearRespostaEmissao(resposta.body, resposta.status);

    if (resultado.ok) {
      return respJson(res, 200, {
        ok:                true,
        chaveAcesso:       resultado.chNFSe,
        numero:            resultado.nNFSe,
        codigoVerificacao: resultado.chNFSe ? resultado.chNFSe.slice(-9) : '',
        dataEmissao:       resultado.dhEmi,
        status:            'autorizado',
        ambiente,
        nRps:              nDps,
      });
    }

    rollbackNDps();
    const erroDetalhe = resultado.erro
      || (resposta.body ? resposta.body.slice(0, 600) : `sem corpo`)
      || `HTTP ${resposta.status}`;
    return respJson(res, 422, {
      ok:      false,
      erro:    `ADN HTTP ${resposta.status} — ${erroDetalhe}`,
      xmlResp: resposta.body,
    });

  } catch (err) {
    console.error('[NFS-e Nacional handleEmitir]', err.message);
    return respJson(res, 500, { ok: false, erro: err.message });
  }
}

// ── handleConsultar ─────────────────────────────────────────────────────────────

async function handleConsultar(req, res, parsed) {
  try {
    const qs          = new URLSearchParams(parsed?.query || '');
    const chaveAcesso = qs.get('chaveAcesso');
    const producao    = (qs.get('ambiente') || '').toLowerCase().includes('produ');
    const ambiente    = producao ? 'producao' : 'homologacao';

    if (!chaveAcesso) return respJson(res, 400, { ok: false, erro: 'Parâmetro "chaveAcesso" obrigatório.' });

    const cert = certLoader();
    if (!cert) return respJson(res, 400, { ok: false, erro: 'Certificado não configurado.' });

    const apiHost = producao ? PROD_HOST : HOM_HOST;
    const chNFSe  = chaveAcesso.split(':')[0];

    const resposta = await apiRequest({
      host:       apiHost,
      apiPath:    `${API_PATH}/${chNFSe}`,
      method:     'GET',
      body:       '',
      pfxBuffer:  cert.pfxBuffer,
      passphrase: cert.passphrase,
    });

    console.log(`[NFS-e Nacional consultar] HTTP ${resposta.status}`);

    const nNFSe      = extrairTagTexto(resposta.body, 'nNFSe');
    const chNFSeResp = extrairTagTexto(resposta.body, 'chNFSe') || chNFSe;

    if (resposta.status === 200 && (nNFSe || chNFSeResp)) {
      return respJson(res, 200, {
        ok:                true,
        chaveAcesso:       chNFSeResp,
        numero:            nNFSe,
        codigoVerificacao: chNFSeResp ? chNFSeResp.slice(-9) : '',
        status:            'autorizado',
      });
    }

    const msg = extrairTagTexto(resposta.body, 'xMotivo')
             || extrairTagTexto(resposta.body, 'mensagem')
             || 'NFS-e não encontrada.';
    return respJson(res, 404, { ok: false, erro: msg });

  } catch (err) {
    console.error('[NFS-e Nacional handleConsultar]', err.message);
    return respJson(res, 500, { ok: false, erro: err.message });
  }
}

// ── handleCancelar ──────────────────────────────────────────────────────────────

async function handleCancelar(req, res) {
  try {
    const { chaveAcesso, justificativa, config } = await lerCorpoReq(req);

    if (!chaveAcesso) return respJson(res, 400, { ok: false, erro: 'Campo "chaveAcesso" obrigatório.' });
    if (!justificativa || justificativa.trim().length < 15) {
      return respJson(res, 400, { ok: false, erro: 'Justificativa deve ter pelo menos 15 caracteres.' });
    }

    const cert = certLoader();
    if (!cert) return respJson(res, 400, { ok: false, erro: 'Certificado não configurado.' });

    const producao = (config?.ambiente || '').toLowerCase().includes('produ');
    const ambiente = producao ? 'producao' : 'homologacao';
    const apiHost  = producao ? PROD_HOST : HOM_HOST;

    const chNFSe = chaveAcesso.split(':')[0];

    // Evento de cancelamento — tpEvento 110111 (cancelamento pelo contribuinte)
    const eventoXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<evCancNFSe xmlns="${NS_NFSE}" versao="1.00">` +
        `<infEvento Id="E${chNFSe}">` +
          `<chNFSe>${chNFSe}</chNFSe>` +
          `<dhEvento>${dhEmiAgora()}</dhEvento>` +
          `<tpEvento>110111</tpEvento>` +
          `<detEvento>` +
            `<xJust>${xmlEsc(justificativa.slice(0, 255))}</xJust>` +
          `</detEvento>` +
        `</infEvento>` +
      `</evCancNFSe>`;

    const resposta = await apiRequest({
      host:       apiHost,
      apiPath:    `${API_PATH}/${chNFSe}/eventos`,
      method:     'POST',
      body:       eventoXml,
      pfxBuffer:  cert.pfxBuffer,
      passphrase: cert.passphrase,
    });

    console.log(`[NFS-e Nacional cancelar] HTTP ${resposta.status}`);

    if (resposta.status === 200 || resposta.status === 201) {
      return respJson(res, 200, { ok: true, status: 'cancelado' });
    }

    const msg = extrairTagTexto(resposta.body, 'xMotivo')
             || extrairTagTexto(resposta.body, 'mensagem')
             || resposta.body.slice(0, 300);
    return respJson(res, 422, {
      ok:      false,
      erro:    `Erro no cancelamento: ${msg}`,
      xmlResp: resposta.body.slice(0, 500),
    });

  } catch (err) {
    console.error('[NFS-e Nacional handleCancelar]', err.message);
    return respJson(res, 500, { ok: false, erro: err.message });
  }
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = { handleEmitir, handleConsultar, handleCancelar };
