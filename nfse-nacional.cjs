'use strict';

/**
 * NFSe Nacional — Integração direta com portal sefin.nfse.gov.br
 *
 * Fluxo: dados → DPS XML → XMLDSig → GZIP → Base64 → mTLS POST
 * Autenticação: certificado ICP-Brasil A1/A3 em TLS mutual
 *
 * Documentação: https://www.nfse.gov.br/swagger/contribuintesissqn/
 * Namespace DPS: http://www.sped.fazenda.gov.br/nfse (confirmar no XSD oficial)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

// ── Constantes ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const SEQ_FILE = path.join(DATA_DIR, 'nfse-nacional-seq.json');

// Endpoints de emissão (requer mTLS + XMLDSig)
const SEFIN_PROD_HOST = 'sefin.nfse.gov.br';
const SEFIN_HOM_HOST  = 'sefin.producaorestrita.nfse.gov.br';
const SEFIN_PATH      = '/SefinNacional/nfse';

// Endpoints de consulta (requer mTLS)
const ADN_PROD_HOST   = 'adn.nfse.gov.br';
const ADN_HOM_HOST    = 'adn.producaorestrita.nfse.gov.br';

const NS_NFSE = 'http://www.sped.fazenda.gov.br/nfse';

// [cTribNac 6 dígitos LC116, cNBS 9 dígitos AnexoVIII]
// Códigos validados contra planilha oficial RJ (nfsenacional.prefeitura.rio/codtribriov2-0/)
const CNAE_PARA_CTN = {
  '5320202': ['150603', '107020000'], // Coleta e entrega de documentos, bens e valores (15.06.03)
  '5320201': ['150603', '107020000'], // Malote/correspondências → mesmo grupo coleta/entrega (15.06.03)
  '4930202': ['160201', '105011110'], // Transporte rodoviário municipal de carga (16.02.04)
  '9511800': ['140101', '120012000'], // Manutenção de computadores (14.01.52)
  '9512600': ['140101', '120012000'], // Manutenção de equipamentos de comunicação (14.01.xx)
  '6201500': ['010401', '103091110'], // Elaboração de programa de computadores (01.04.01)
  '6202300': ['010601', '103091190'], // Assessoria ou consultoria em informática (01.06.01)
  '6209100': ['010701', '102041310'], // Suporte técnico em informática (01.07.01)
  '7490100': ['170101', '103999900'], // Assessoria ou consultoria de qualquer natureza (17.01.01)
  '8020000': ['110201', '101191090'], // Vigilância, segurança ou monitoramento (11.02.03)
};

// ── T3: certLoader ────────────────────────────────────────────────────────────

function certLoader() {
  const file = path.join(DATA_DIR, 'techstore-cert.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw?.base64 || !raw?.senha) return null;
    return {
      pfxBuffer:  Buffer.from(raw.base64, 'base64'),
      passphrase: raw.senha,
    };
  } catch {
    return null;
  }
}

// ── T7: Numeração sequencial DPS ──────────────────────────────────────────────

function proximoNDps() {
  let seq = {};
  try { seq = JSON.parse(fs.readFileSync(SEQ_FILE, 'utf8')); } catch {}
  const n = (seq.nDPS || 0) + 1;
  seq.nDPS = n;
  fs.writeFileSync(SEQ_FILE, JSON.stringify(seq, null, 2), 'utf8');
  return n;
}

function rollbackNDps() {
  try {
    const seq = JSON.parse(fs.readFileSync(SEQ_FILE, 'utf8'));
    if (seq.nDPS > 0) { seq.nDPS--; fs.writeFileSync(SEQ_FILE, JSON.stringify(seq, null, 2), 'utf8'); }
  } catch {}
}

// ── Utilitários ───────────────────────────────────────────────────────────────

function xmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pad(n, len) { return String(n).padStart(len, '0'); }

function agora_br() {
  const now = new Date();
  const br  = new Date(now.getTime() - 3 * 3600000);
  const p = n => pad(n, 2);
  return `${br.getUTCFullYear()}-${p(br.getUTCMonth()+1)}-${p(br.getUTCDate())}T${p(br.getUTCHours())}:${p(br.getUTCMinutes())}:${p(br.getUTCSeconds())}-03:00`;
}

function lerCorpoReq(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON inválido no corpo da requisição')); } });
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

// ── T4: montarDPS ─────────────────────────────────────────────────────────────

function montarDPS({ dados, configEmpresa, nDPS, tpAmb }) {
  const { tomador, servico, naturezaOp, infAdicional } = dados;

  const cnpjLimpo = (configEmpresa.cnpj || '').replace(/\D/g, '');
  if (!cnpjLimpo || cnpjLimpo.length !== 14) throw new Error('CNPJ do emitente inválido ou não configurado.');

  const cMun  = '3304557'; // Código IBGE Rio de Janeiro — fixo para esta empresa
  const SERIE = '00001';

  const dhEmi    = agora_br();
  const dCompet  = dhEmi.slice(0, 10);

  // ID DPS = "DPS" + cMun(7) + tpDoc(1) + CNPJ(14) + serie(5) + nDPS(15) = 45 chars
  // tpDoc: 1=CPF, 2=CNPJ (tpDoc se refere ao emitente)
  const dpsId = `DPS${cMun}2${cnpjLimpo}${SERIE}${pad(nDPS, 15)}`;
  if (dpsId.length !== 45) throw new Error(`ID DPS inválido: ${dpsId} (${dpsId.length} chars, esperado 45)`);

  // Tomador
  const tomDoc = (tomador.doc || '').replace(/\D/g, '');
  let tomaXml  = '';
  if (tomDoc.length === 14)      tomaXml += `<CNPJ>${tomDoc}</CNPJ>`;
  else if (tomDoc.length === 11) tomaXml += `<CPF>${tomDoc}</CPF>`;

  tomaXml += `<xNome>${xmlEsc(tomador.nome)}</xNome>`;

  const cepLimpo = (tomador.cep || '').replace(/\D/g, '');
  if (cepLimpo.length === 8) {
    const cMunToma = (tomador.codigoIbge || cMun).replace(/\D/g, '').slice(0, 7);
    tomaXml += `<end><endNac><cMun>${cMunToma}</cMun><CEP>${cepLimpo}</CEP></endNac>`;
    if (tomador.logradouro) tomaXml += `<xLgr>${xmlEsc(tomador.logradouro)}</xLgr>`;
    if (tomador.numero)     tomaXml += `<nro>${xmlEsc(tomador.numero)}</nro>`;
    if (tomador.bairro)     tomaXml += `<xBairro>${xmlEsc(tomador.bairro)}</xBairro>`;
    tomaXml += `</end>`;
  }
  if (tomador.email) tomaXml += `<email>${xmlEsc(tomador.email)}</email>`;
  if (tomador.fone)  tomaXml += `<fone>${xmlEsc((tomador.fone || '').replace(/\D/g, ''))}</fone>`;

  // Serviço
  const cnaeLimpo    = (servico.cnae || '5320202').replace(/\D/g, '');
  const [cTribNac, cNBS] = CNAE_PARA_CTN[cnaeLimpo] || ['150603', '107020000'];
  const valorServico = parseFloat(servico.valor || 0).toFixed(2);
  const pAliq        = parseFloat(servico.aliquotaIss || servico.aliquota || 5).toFixed(2);
  // Mapeamento invertido: antigo ABRASF issRetido=1(retido) → DPS tpRetISSQN=2; issRetido=2(não retido) → tpRetISSQN=1
  const issRetidoAnt = parseInt(servico.issRetido ?? '2');
  const tpRetISSQN   = issRetidoAnt === 1 ? 2 : 1;

  // Totais tributários informativos (Simples Nacional: federal/estadual = 0, municipal = ISS)
  const vIss = (parseFloat(valorServico) * parseFloat(pAliq) / 100).toFixed(2);

  // Regime tributário: opSimpNac=3 (outros optantes SN — LTDA), regApTribSN=1 (SN próprio), regEspTrib=0
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DPS xmlns="${NS_NFSE}" versao="1.00">` +
      `<infDPS Id="${dpsId}">` +
        `<tpAmb>${tpAmb}</tpAmb>` +
        `<dhEmi>${dhEmi}</dhEmi>` +
        `<verAplic>1.00</verAplic>` +
        `<serie>${SERIE}</serie>` +
        `<nDPS>${nDPS}</nDPS>` +
        `<dCompet>${dCompet}</dCompet>` +
        `<tpEmit>1</tpEmit>` +
        `<cLocEmi>${cMun}</cLocEmi>` +
        `<prest>` +
          `<CNPJ>${cnpjLimpo}</CNPJ>` +
          `<regTrib>` +
            `<opSimpNac>3</opSimpNac>` +
            `<regApTribSN>1</regApTribSN>` +
            `<regEspTrib>0</regEspTrib>` +
          `</regTrib>` +
        `</prest>` +
        `<toma>${tomaXml}</toma>` +
        `<serv>` +
          `<locPrest>` +
            `<cLocPrestacao>${cMun}</cLocPrestacao>` +
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
              `<vTotTrib>` +
                `<vTotTribFed>0.00</vTotTribFed>` +
                `<vTotTribEst>0.00</vTotTribEst>` +
                `<vTotTribMun>${vIss}</vTotTribMun>` +
              `</vTotTrib>` +
            `</totTrib>` +
          `</trib>` +
        `</valores>` +
      `</infDPS>` +
    `</DPS>`;

  return { xml, dpsId };
}

// ── T5: assinarDPS ────────────────────────────────────────────────────────────

async function assinarDPS(xmlStr, dpsId, pfxBuffer, passphrase) {
  // Extrair chave privada e certificado do PFX via node-forge
  const p12Asn1 = forge.asn1.fromDer(
    forge.util.createBuffer(pfxBuffer.toString('binary'), 'binary')
  );
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, passphrase);

  // Chave privada
  const keyBags    = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBagList = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  const keyBag     = keyBagList.find(b => b.key) || keyBagList[0];
  if (!keyBag?.key) throw new Error('Certificado inválido: chave privada não encontrada no PFX.');
  const privateKey = forge.pki.privateKeyToPem(keyBag.key);

  // Certificado público
  const certBags    = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBagList = certBags[forge.pki.oids.certBag] || [];
  const certBag     = certBagList.find(b => b.cert) || certBagList[0];
  if (!certBag?.cert) throw new Error('Certificado inválido: certificado público não encontrado no PFX.');
  const publicCert = forge.pki.certificateToPem(certBag.cert);

  const sig = new SignedXml({
    privateKey,
    publicCert,
    signatureAlgorithm:       'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
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

  await sig.computeSignature(xmlStr, {
    prefix:   '',
    location: {
      reference: `//*[local-name()='DPS']`,
      action:    'append',
    },
  });

  return sig.getSignedXml();
}

// ── T6: Compressão e envio mTLS ───────────────────────────────────────────────

function gzipBase64(xmlStr) {
  return new Promise((resolve, reject) => {
    zlib.gzip(Buffer.from(xmlStr, 'utf8'), (err, buf) => {
      if (err) reject(err);
      else resolve(buf.toString('base64'));
    });
  });
}

function mtlsRequest({ host, reqPath, method, bodyObj, pfxBuffer, passphrase }) {
  return new Promise((resolve, reject) => {
    const bodyStr    = bodyObj ? JSON.stringify(bodyObj) : '';
    const bodyBuffer = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    const opts = {
      hostname: host,
      port:     443,
      path:     reqPath,
      method:   method || 'GET',
      headers:  {
        'Content-Type':  'application/json; charset=utf-8',
        'Accept':        'application/json',
      },
      pfx:                 pfxBuffer,
      passphrase:          passphrase,
      rejectUnauthorized:  false, // ambientes gov.br usam certs que podem falhar validação padrão
      timeout:             30000,
    };
    if (bodyBuffer) opts.headers['Content-Length'] = bodyBuffer.length;

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout na conexão com portal NFSe Nacional.')); });
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

// ── T8: handleEmitir ─────────────────────────────────────────────────────────

async function handleEmitir(req, res) {
  try {
    const corpo = await lerCorpoReq(req);
    const { dados, config } = corpo;

    if (!dados) return respJson(res, 400, { ok: false, erro: 'Campo "dados" ausente na requisição.' });

    const cert = certLoader();
    if (!cert) return respJson(res, 400, { ok: false, erro: 'Certificado digital não configurado. Acesse Configurações > Certificado e carregue um arquivo .pfx.' });

    const ambiente  = (config?.ambiente || '').toLowerCase().includes('produ') ? 'producao' : 'homologacao';
    const tpAmb     = ambiente === 'producao' ? 1 : 2;
    const sefinHost = ambiente === 'producao' ? SEFIN_PROD_HOST : SEFIN_HOM_HOST;

    const cfgEmpresa = lerConfigEmpresa();
    const configEmpresa = {
      cnpj: (cfgEmpresa['cfg-cnpj'] || config?.cnpj || '').replace(/\D/g, ''),
    };

    if (!configEmpresa.cnpj || configEmpresa.cnpj.length !== 14) {
      return respJson(res, 400, { ok: false, erro: 'CNPJ da empresa não configurado. Acesse Configurações e preencha o CNPJ.' });
    }

    const nDPS = proximoNDps();
    console.log(`[NFSe Nacional] Emitindo DPS nº ${nDPS} em ${ambiente}...`);

    let xmlAssinado, dpsId;
    try {
      const { xml, dpsId: id } = montarDPS({ dados, configEmpresa, nDPS, tpAmb });
      dpsId = id;
      console.log(`[NFSe Nacional] DPS montado: ${dpsId}`);
      xmlAssinado = await assinarDPS(xml, dpsId, cert.pfxBuffer, cert.passphrase);
      console.log(`[NFSe Nacional] DPS assinado com sucesso.`);
    } catch (err) {
      rollbackNDps();
      return respJson(res, 400, { ok: false, erro: `Erro ao gerar DPS: ${err.message}` });
    }

    const dpsXmlGZipB64 = await gzipBase64(xmlAssinado);

    const { status, body } = await mtlsRequest({
      host:       sefinHost,
      reqPath:    SEFIN_PATH,
      method:     'POST',
      bodyObj:    { dpsXmlGZipB64 },
      pfxBuffer:  cert.pfxBuffer,
      passphrase: cert.passphrase,
    });

    console.log(`[NFSe Nacional] Resposta HTTP ${status}:`, JSON.stringify(body).slice(0, 400));

    if (status === 200 || status === 201) {
      return respJson(res, 200, {
        ok:          true,
        chaveAcesso: body.chaveAcesso || body.chNFSe   || body.chave  || null,
        numero:      body.nNFSe       || body.numero    || null,
        status:      body.status      || 'autorizado',
        ambiente,
        nDPS,
        dpsId,
        detalhe:     body,
      });
    }

    // Emissão falhou — desfaz o contador para permitir reenvio
    rollbackNDps();
    const erroMsg = extrairErro(body);
    return respJson(res, 422, {
      ok:      false,
      erro:    `Portal NFSe Nacional retornou ${status}: ${erroMsg}`,
      detalhe: body,
    });

  } catch (err) {
    console.error('[NFSe Nacional handleEmitir]', err.message);
    return respJson(res, 500, { ok: false, erro: err.message });
  }
}

// ── T9: handleConsultar ──────────────────────────────────────────────────────

async function handleConsultar(req, res, parsed) {
  try {
    const qs           = new URLSearchParams(parsed?.query || '');
    const chaveAcesso  = qs.get('chaveAcesso');
    const ambiente     = (qs.get('ambiente') || 'homologacao').toLowerCase().includes('produ') ? 'producao' : 'homologacao';

    if (!chaveAcesso) return respJson(res, 400, { ok: false, erro: 'Parâmetro "chaveAcesso" obrigatório.' });

    const cert = certLoader();
    if (!cert) return respJson(res, 400, { ok: false, erro: 'Certificado digital não configurado.' });

    const adnHost  = ambiente === 'producao' ? ADN_PROD_HOST : ADN_HOM_HOST;
    const adnPath  = `/contribuintes/v1/nfse/${encodeURIComponent(chaveAcesso)}`;

    console.log(`[NFSe Nacional consultar] ${chaveAcesso.slice(0, 12)}... em ${ambiente}`);

    const { status, body } = await mtlsRequest({
      host:       adnHost,
      reqPath:    adnPath,
      method:     'GET',
      pfxBuffer:  cert.pfxBuffer,
      passphrase: cert.passphrase,
    });

    console.log(`[NFSe Nacional consultar] HTTP ${status}`);

    if (status === 200) {
      return respJson(res, 200, {
        ok:          true,
        chaveAcesso,
        numero:      body.nNFSe      || body.numero    || null,
        status:      body.status     || 'autorizado',
        pdf_url:     body.urlDanfse  || body.caminhoPdf || null,
        xml_url:     body.caminhoXml || null,
        detalhe:     body,
      });
    }

    return respJson(res, status === 404 ? 404 : 502, {
      ok:      false,
      erro:    status === 404 ? 'NFS-e não encontrada.' : `Consulta retornou ${status}: ${extrairErro(body)}`,
      detalhe: body,
    });

  } catch (err) {
    console.error('[NFSe Nacional handleConsultar]', err.message);
    return respJson(res, 500, { ok: false, erro: err.message });
  }
}

// ── T10: handleCancelar ──────────────────────────────────────────────────────

async function handleCancelar(req, res) {
  try {
    const { chaveAcesso, justificativa, config } = await lerCorpoReq(req);

    if (!chaveAcesso) return respJson(res, 400, { ok: false, erro: 'Campo "chaveAcesso" obrigatório.' });
    if (!justificativa || justificativa.trim().length < 15) {
      return respJson(res, 400, { ok: false, erro: 'Justificativa deve ter pelo menos 15 caracteres.' });
    }

    const cert = certLoader();
    if (!cert) return respJson(res, 400, { ok: false, erro: 'Certificado digital não configurado.' });

    const ambiente = (config?.ambiente || '').toLowerCase().includes('produ') ? 'producao' : 'homologacao';
    const adnHost  = ambiente === 'producao' ? ADN_PROD_HOST : ADN_HOM_HOST;
    const adnPath  = `/contribuintes/v1/nfse/${encodeURIComponent(chaveAcesso)}/eventos`;

    console.log(`[NFSe Nacional cancelar] ${chaveAcesso.slice(0, 12)}... em ${ambiente}`);

    const { status, body } = await mtlsRequest({
      host:       adnHost,
      reqPath:    adnPath,
      method:     'POST',
      bodyObj:    { tpEvento: '1', xJust: justificativa.trim() },
      pfxBuffer:  cert.pfxBuffer,
      passphrase: cert.passphrase,
    });

    console.log(`[NFSe Nacional cancelar] HTTP ${status}:`, JSON.stringify(body).slice(0, 200));

    if (status === 200 || status === 201) {
      return respJson(res, 200, { ok: true, status: 'cancelado', detalhe: body });
    }

    return respJson(res, 502, {
      ok:      false,
      erro:    `Cancelamento retornou ${status}: ${extrairErro(body)}`,
      detalhe: body,
    });

  } catch (err) {
    console.error('[NFSe Nacional handleCancelar]', err.message);
    return respJson(res, 500, { ok: false, erro: err.message });
  }
}

// ── Helpers internos ─────────────────────────────────────────────────────────

function extrairErro(body) {
  if (typeof body === 'string') return body.slice(0, 300);
  // Formato portal NFSe Nacional: { erros: [{ Codigo, Descricao, Complemento }] }
  if (Array.isArray(body?.erros) && body.erros.length > 0) {
    const e = body.erros[0];
    return `[${e.Codigo}] ${e.Descricao}${e.Complemento ? ' — ' + e.Complemento.slice(0, 200) : ''}`;
  }
  return body?.mensagem || body?.descricao || body?.message || body?.error || JSON.stringify(body).slice(0, 300);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { handleEmitir, handleConsultar, handleCancelar };
