/**
 * SEFAZ Server — Emissor de Notas (RJ Logística e Tecnologia)
 * Porta: 3002
 * Implementa: NF-e DistDFe (consulta NF-e recebidas) + NF-e Autorização (emissão)
 * Protocolo: SOAP 1.2 + XML-DSig (RSA-SHA256 + C14N)
 */

'use strict';
const http  = require('http');
const https = require('https');
const forge = require('node-forge');
const crypto = require('crypto');

const PORTA = 3002;

// ── Endpoints SEFAZ por ambiente ──────────────────────────────────────────────
const ENDPOINTS = {
  producao: {
    // DistDFe: serviço nacional de distribuição (nome correto: NFeDistribuicaoDFe)
    distDFe:    'www1.nfe.fazenda.gov.br',
    distDFePath:'/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
    // RJ usa SVRS (Sefaz Virtual do RS)
    autorizacao:    'nfe.svrs.rs.gov.br',
    autorizacaoPath:'/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    retorno:        'nfe.svrs.rs.gov.br',
    retornoPath:    '/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
  },
  homologacao: {
    distDFe:    'hom1.nfe.fazenda.gov.br',
    distDFePath:'/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
    autorizacao:    'nfe-homologacao.svrs.rs.gov.br',
    autorizacaoPath:'/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    retorno:        'nfe-homologacao.svrs.rs.gov.br',
    retornoPath:    '/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
  },
};

// ── Códigos UF ─────────────────────────────────────────────────────────────────
const UF_CODIGO = {
  'AC':12,'AL':27,'AP':16,'AM':13,'BA':29,'CE':23,'DF':53,'ES':32,'GO':52,
  'MA':21,'MT':51,'MS':50,'MG':31,'PA':15,'PB':25,'PR':41,'PE':26,'PI':22,
  'RJ':33,'RN':24,'RS':43,'RO':11,'RR':14,'SC':42,'SP':35,'SE':28,'TO':17,
};

// ── CORS Headers ───────────────────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 1: CERTIFICADO DIGITAL (PKCS#12)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Carrega o certificado A1 a partir de Base64.
 * @param {string} base64  - conteúdo do .pfx em Base64
 * @param {string} senha   - senha do .pfx
 * @returns {{ privateKey, cert, certPem, keyPem, p12 }}
 */
function carregarCertificado(base64, senha) {
  const binStr = Buffer.from(base64, 'base64').toString('binary');
  const p12Asn = forge.asn1.fromDer(binStr);
  const p12    = forge.pkcs12.pkcs12FromAsn1(p12Asn, false, senha);

  // Extrai chave privada
  let privateKey = null;
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyArr  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];
  if (keyArr && keyArr.length > 0) privateKey = keyArr[0].key;

  // Extrai certificado
  let cert = null;
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certArr  = certBags[forge.pki.oids.certBag];
  if (certArr && certArr.length > 0) cert = certArr[0].cert;

  if (!privateKey || !cert) throw new Error('Certificado ou chave privada não encontrados no .pfx');

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem  = forge.pki.privateKeyToPem(privateKey);

  return { privateKey, cert, certPem, keyPem };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 2: XML-DSIG (Assinatura Digital XML)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Canonicalização C14N simplificada para NF-e (remove declaração XML, normaliza atributos).
 */
function c14n(xml) {
  return xml
    .replace(/<\?xml[^?]*\?>\s*/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * SHA256 em Base64 de um texto.
 */
function sha256b64(texto) {
  return crypto.createHash('sha256').update(texto, 'utf8').digest('base64');
}

/**
 * Assina o XML da NF-e conforme XML-DSig (RSA-SHA256).
 * Assume que o XML possui um elemento com atributo "Id" para referenciar.
 */
function assinarXml(xmlStr, certObj) {
  const { privateKey, certPem } = certObj;

  // Extrai o elemento a ser assinado (infNFe com Id)
  const matchId = xmlStr.match(/Id="(NFe[^"]+)"/);
  if (!matchId) throw new Error('Elemento com Id não encontrado no XML');
  const id = matchId[1];

  // Extrai o conteúdo do elemento referenciado para digest
  const tagRe = new RegExp(`<infNFe[^>]*Id="${id}"[\\s\\S]*?</infNFe>`);
  const match = xmlStr.match(tagRe);
  if (!match) throw new Error('Elemento infNFe não encontrado');

  const conteudoRef = c14n(match[0]);
  const digestValue = sha256b64(conteudoRef);

  // Monta SignedInfo
  const signedInfo = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<Reference URI="#${id}">` +
      `<Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms>` +
      `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
      `<DigestValue>${digestValue}</DigestValue>` +
    `</Reference>` +
  `</SignedInfo>`;

  // Assina o SignedInfo com RSA-SHA256
  const forgeKey = forge.pki.privateKeyFromPem(forge.pki.privateKeyToPem(privateKey));
  const md       = forge.md.sha256.create();
  md.update(c14n(signedInfo), 'utf8');
  const signatureBytes = forgeKey.sign(md);
  const signatureValue = forge.util.encode64(signatureBytes);

  // Extrai X509Certificate (sem cabeçalho PEM)
  const x509 = certPem
    .replace('-----BEGIN CERTIFICATE-----', '')
    .replace('-----END CERTIFICATE-----', '')
    .replace(/\s+/g, '');

  // Monta bloco Signature
  const signature = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    signedInfo +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${x509}</X509Certificate></X509Data></KeyInfo>` +
  `</Signature>`;

  // Injeta a assinatura antes do fechamento do elemento pai (nfeProc ou NFe)
  return xmlStr.replace('</infNFe>', `</infNFe>`) // mantém infNFe
               .replace(/<\/NFe>/, `${signature}</NFe>`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 3: SOAP HTTP com autenticação por certificado
// ═══════════════════════════════════════════════════════════════════════════════

function soapRequest({ host, path, soapAction, envelope, certObj }) {
  return new Promise((resolve, reject) => {
    const { certPem, keyPem } = certObj;

    const body = Buffer.from(envelope, 'utf-8');
    // SOAP 1.2: action vai no Content-Type, não como header separado
    const contentType = soapAction
      ? `application/soap+xml; charset=utf-8; action="${soapAction}"`
      : 'application/soap+xml; charset=utf-8';
    const opts = {
      hostname: host,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
      },
      cert: certPem,
      key:  keyPem,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      timeout: 30000,
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout na requisição SEFAZ')); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 4: DistDFe — Consulta NF-e Recebidas
// ═══════════════════════════════════════════════════════════════════════════════

function escapeXml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildDistDFeEnvelope({ cnpj, uf, ultNSU, ambiente }) {
  const tpAmb    = ambiente === 'producao' ? '1' : '2';
  const cUFAutor = UF_CODIGO[uf] || 33;
  const nsuFmt   = String(ultNSU || '0').padStart(15, '0');
  const cnpjLimpo = cnpj.replace(/\D/g,'');

  // XML interno — será colocado como conteúdo de nfeDadosMsg (não escapado pois o wsdl aceita xsd:anyType)
  const distDFeInt =
    `<distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<cUFAutor>${cUFAutor}</cUFAutor>` +
      `<CNPJ>${cnpjLimpo}</CNPJ>` +
      `<distNSU><ultNSU>${nsuFmt}</ultNSU></distNSU>` +
    `</distDFeInt>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope` +
      ` xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"` +
      ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
      ` xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
      `<soap12:Body>` +
        `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
          `<nfeDadosMsg>${distDFeInt}</nfeDadosMsg>` +
        `</nfeDistDFeInteresse>` +
      `</soap12:Body>` +
    `</soap12:Envelope>`
  );
}

function parseDistDFeResponse(xml) {
  // Extrai retDistDFeInt
  const matchRet = xml.match(/<retDistDFeInt[^>]*>([\s\S]*?)<\/retDistDFeInt>/);
  if (!matchRet) return { ok: false, erro: 'Resposta inesperada do SEFAZ', xml };

  const ret     = matchRet[1];
  const cStat   = (ret.match(/<cStat>(\d+)<\/cStat>/) || [])[1] || '';
  const xMotivo = (ret.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] || '';
  const ultNSU  = (ret.match(/<ultNSU>(\d+)<\/ultNSU>/) || [])[1] || '0';
  const maxNSU  = (ret.match(/<maxNSU>(\d+)<\/maxNSU>/) || [])[1] || '0';

  // Extrai lista de documentos
  const docs = [];
  const docRe = /<docZip NSU="(\d+)" schema="([^"]+)"[^>]*>([^<]+)<\/docZip>/g;
  let m;
  while ((m = docRe.exec(ret)) !== null) {
    try {
      const xmlDoc = Buffer.from(m[3], 'base64').toString('utf-8');
      // Descomprime se necessário (gzip)
      docs.push({ nsu: m[1], schema: m[2], xml: xmlDoc });
    } catch(_) {}
  }

  // Parse básico de cada NF-e
  const notas = docs.map(d => {
    const x = d.xml;
    return {
      numero:    (x.match(/<nNF>(\d+)<\/nNF>/) || [])[1] || '—',
      serie:     (x.match(/<serie>(\d+)<\/serie>/) || [])[1] || '—',
      chaveAcesso: (x.match(/Id="NFe(\d{44})"/) || [])[1] || '',
      emitente:  (x.match(/<emit>[\s\S]*?<xNome>([^<]+)<\/xNome>/) || [])[1] || '—',
      cnpjEmit:  (x.match(/<emit>[\s\S]*?<CNPJ>([^<]+)<\/CNPJ>/) || [])[1] || '—',
      emissao:   (x.match(/<dhEmi>([^<]+)<\/dhEmi>/) || [])[1] || '—',
      natureza:  (x.match(/<natOp>([^<]+)<\/natOp>/) || [])[1] || '—',
      valor:     parseFloat((x.match(/<vNF>([^<]+)<\/vNF>/) || [])[1] || '0'),
      situacao:  d.schema.includes('procEvento') ? 'Cancelada' : 'Autorizada',
      nsu:       d.nsu,
      xmlBruto:  x,
    };
  });

  return { ok: true, cStat, xMotivo, ultNSU, maxNSU, notas };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 5: NF-e — Geração do XML e Emissão
// ═══════════════════════════════════════════════════════════════════════════════

function gerarChaveNFe({ cUF, aamm, cnpjEmit, mod, serie, nNF, tpEmis, cNF }) {
  const base = `${cUF}${aamm}${cnpjEmit.replace(/\D/g,'')}${mod}${String(serie).padStart(3,'0')}${String(nNF).padStart(9,'0')}${tpEmis}${String(cNF).padStart(8,'0')}`;
  // Cálculo do dígito verificador (módulo 11)
  let soma = 0, peso = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    soma += parseInt(base[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  const cDV   = resto < 2 ? 0 : 11 - resto;
  return base + cDV;
}

function formatarData(d) {
  // Retorna YYYY-MM-DDTHH:mm:ss-03:00
  const dt = d instanceof Date ? d : new Date(d);
  const pad = n => String(n).padStart(2,'0');
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}-03:00`;
}

/**
 * Monta o XML da NF-e 4.0 a partir dos dados do formulário.
 */
function montarNFeXml(dados, config) {
  const {
    nNF, serie, naturezaOp, tpNF, cliente, itens, pagamento, infAdicional,
  } = dados;

  const {
    cnpj, ie, razaoSocial, uf, cMun, xMun, xLgr, nro, xBairro, cep, fone,
    csc, cscId, ambiente, regime,
  } = config;

  const cnpjLimpo = (cnpj || '').replace(/\D/g,'');
  const tpAmb     = ambiente === 'producao' ? '1' : '2';
  const cUF       = UF_CODIGO[uf] || 33;
  const mod       = '55';
  const tpEmis    = '1';
  const cNF       = String(Math.floor(Math.random() * 99999999)).padStart(8,'0');
  const aamm      = new Date().toISOString().slice(2,4) + new Date().toISOString().slice(5,7);
  const chave     = gerarChaveNFe({ cUF, aamm, cnpjEmit: cnpjLimpo, mod, serie: serie||'1', nNF, tpEmis, cNF });
  const dhEmi     = formatarData(new Date());

  // Totais
  const vBC  = itens.reduce((s,i) => s + parseFloat(i.vBC  || i.vProd || 0), 0);
  const vICMS= itens.reduce((s,i) => s + parseFloat(i.vICMS || 0), 0);
  const vProd= itens.reduce((s,i) => s + parseFloat(i.vProd || 0), 0);
  const vNF  = vProd; // simplificado (sem frete, desconto, etc.)

  // Destinatário
  const destCnpj = (cliente.doc||'').replace(/\D/g,'');
  const destTag  = destCnpj.length === 14 ? `<CNPJ>${destCnpj}</CNPJ>` : `<CPF>${destCnpj.padStart(11,'0')}</CPF>`;

  // Itens
  const detsXml = itens.map((item, idx) => {
    const nItem  = idx + 1;
    const vProdI = parseFloat(item.vProd || 0).toFixed(2);
    const qCom   = parseFloat(item.qCom  || 1).toFixed(4);
    const vUnCom = parseFloat(item.vUnCom|| item.vProd || 0).toFixed(2);
    const csosn  = item.csosn || '102';
    const cstPis = item.cstPis || '07';
    const cstCofins = item.cstCofins || '07';

    return `<det nItem="${nItem}">` +
      `<prod>` +
        `<cProd>${item.sku||String(nItem).padStart(4,'0')}</cProd>` +
        `<cEAN>SEM GTIN</cEAN>` +
        `<xProd>${(item.nome||'').slice(0,120)}</xProd>` +
        `<NCM>${(item.ncm||'').replace(/\D/g,'')}</NCM>` +
        `<CFOP>${item.cfop||'5102'}</CFOP>` +
        `<uCom>${item.unidade||'UN'}</uCom>` +
        `<qCom>${qCom}</qCom>` +
        `<vUnCom>${vUnCom}</vUnCom>` +
        `<vProd>${vProdI}</vProd>` +
        `<cEANTrib>SEM GTIN</cEANTrib>` +
        `<uTrib>${item.unidade||'UN'}</uTrib>` +
        `<qTrib>${qCom}</qTrib>` +
        `<vUnTrib>${vUnCom}</vUnTrib>` +
        `<indTot>1</indTot>` +
      `</prod>` +
      `<imposto>` +
        `<ICMS><ICMSSN${csosn}>` +
          `<orig>${item.origem||'0'}</orig>` +
          `<CSOSN>${csosn}</CSOSN>` +
        `</ICMSSN${csosn}></ICMS>` +
        `<PIS><PISNT><CST>${cstPis}</CST></PISNT></PIS>` +
        `<COFINS><COFINSNT><CST>${cstCofins}</CST></COFINSNT></COFINS>` +
      `</imposto>` +
    `</det>`;
  }).join('');

  // Pagamento
  const tPag = { 'dinheiro':'01', 'pix':'17', 'debito':'04', 'credito':'03', 'boleto':'15', 'transferencia':'03' };
  const codPag = tPag[(pagamento||'').toLowerCase().split(' ')[0]] || '01';

  const infNFe = `<infNFe versao="4.00" Id="NFe${chave}" xmlns="http://www.portalfiscal.inf.br/nfe">` +
    `<ide>` +
      `<cUF>${cUF}</cUF>` +
      `<cNF>${cNF}</cNF>` +
      `<natOp>${naturezaOp||'Venda de Mercadoria'}</natOp>` +
      `<mod>55</mod>` +
      `<serie>${serie||1}</serie>` +
      `<nNF>${nNF}</nNF>` +
      `<dhEmi>${dhEmi}</dhEmi>` +
      `<tpNF>${tpNF||'1'}</tpNF>` +
      `<idDest>1</idDest>` +
      `<cMunFG>${cMun||3304557}</cMunFG>` +
      `<tpImp>1</tpImp>` +
      `<tpEmis>1</tpEmis>` +
      `<cDV>${chave.slice(-1)}</cDV>` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<finNFe>1</finNFe>` +
      `<indFinal>1</indFinal>` +
      `<indPres>1</indPres>` +
      `<procEmi>0</procEmi>` +
      `<verProc>1.0</verProc>` +
    `</ide>` +
    `<emit>` +
      `<CNPJ>${cnpjLimpo}</CNPJ>` +
      `<xNome>${razaoSocial||'Empresa'}</xNome>` +
      `<enderEmit>` +
        `<xLgr>${xLgr||'Rua não informada'}</xLgr>` +
        `<nro>${nro||'S/N'}</nro>` +
        `<xBairro>${xBairro||'Centro'}</xBairro>` +
        `<cMun>${cMun||3304557}</cMun>` +
        `<xMun>${xMun||'Rio de Janeiro'}</xMun>` +
        `<UF>${uf||'RJ'}</UF>` +
        `<CEP>${(cep||'').replace(/\D/g,'')}</CEP>` +
        `<cPais>1058</cPais>` +
        `<xPais>Brasil</xPais>` +
        `${fone ? `<fone>${fone.replace(/\D/g,'')}</fone>` : ''}` +
      `</enderEmit>` +
      `<IE>${(ie||'').replace(/\D/g,'')}</IE>` +
      `<CRT>${regime==='Simples Nacional'?'1':regime==='Lucro Presumido'?'3':'3'}</CRT>` +
    `</emit>` +
    `<dest>` +
      `${destTag}` +
      `<xNome>${cliente.nome||'CONSUMIDOR NAO IDENTIFICADO'}</xNome>` +
      `<enderDest>` +
        `<xLgr>${cliente.logradouro||'Não informado'}</xLgr>` +
        `<nro>${cliente.numero||'S/N'}</nro>` +
        `<xBairro>${cliente.bairro||'Não informado'}</xBairro>` +
        `<cMun>${cliente.cMun||3304557}</cMun>` +
        `<xMun>${cliente.xMun||'Rio de Janeiro'}</xMun>` +
        `<UF>${cliente.uf||'RJ'}</UF>` +
        `<CEP>${(cliente.cep||'').replace(/\D/g,'')}</CEP>` +
        `<cPais>1058</cPais>` +
        `<xPais>Brasil</xPais>` +
      `</enderDest>` +
      `<indIEDest>9</indIEDest>` +
    `</dest>` +
    detsXml +
    `<total>` +
      `<ICMSTot>` +
        `<vBC>${vBC.toFixed(2)}</vBC>` +
        `<vICMS>${vICMS.toFixed(2)}</vICMS>` +
        `<vICMSDeson>0.00</vICMSDeson>` +
        `<vFCP>0.00</vFCP>` +
        `<vBCST>0.00</vBCST>` +
        `<vST>0.00</vST>` +
        `<vFCPST>0.00</vFCPST>` +
        `<vFCPSTRet>0.00</vFCPSTRet>` +
        `<vProd>${vProd.toFixed(2)}</vProd>` +
        `<vFrete>0.00</vFrete>` +
        `<vSeg>0.00</vSeg>` +
        `<vDesc>0.00</vDesc>` +
        `<vII>0.00</vII>` +
        `<vIPI>0.00</vIPI>` +
        `<vIPIDevol>0.00</vIPIDevol>` +
        `<vPIS>0.00</vPIS>` +
        `<vCOFINS>0.00</vCOFINS>` +
        `<vOutro>0.00</vOutro>` +
        `<vNF>${vNF.toFixed(2)}</vNF>` +
      `</ICMSTot>` +
    `</total>` +
    `<transp><modFrete>9</modFrete></transp>` +
    `<pag><detPag><tPag>${codPag}</tPag><vPag>${vNF.toFixed(2)}</vPag></detPag></pag>` +
    `<infAdic><infCpl>${infAdicional||''}</infCpl></infAdic>` +
  `</infNFe>`;

  return `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFe}</NFe>`;
}

function buildNFeEnvelope(nfeXmlAssinado, nNF, serie, tpAmb) {
  const idLote = String(Date.now()).slice(-15);
  return `<?xml version="1.0" encoding="UTF-8"?>` +
  `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Header/>` +
    `<soap12:Body>` +
      `<nfeAutorizacaoLote xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">` +
        `<nfeDadosMsg>` +
          `<enviNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
            `<idLote>${idLote}</idLote>` +
            `<indSinc>1</indSinc>` +
            `${nfeXmlAssinado}` +
          `</enviNFe>` +
        `</nfeDadosMsg>` +
      `</nfeAutorizacaoLote>` +
    `</soap12:Body>` +
  `</soap12:Envelope>`;
}

function parseNFeAutorizacaoResponse(xml) {
  const cStat   = (xml.match(/<cStat>(\d+)<\/cStat>/)   || [])[1] || '';
  const xMotivo = (xml.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] || '';
  const nProt   = (xml.match(/<nProt>(\d+)<\/nProt>/)   || [])[1] || '';
  const chave   = (xml.match(/<chNFe>(\d{44})<\/chNFe>/) || [])[1] || '';
  const dhRec   = (xml.match(/<dhRecbto>([^<]+)<\/dhRecbto>/) || [])[1] || '';

  // cStat 100 = Autorizado; 150 = Autorizado fora do prazo
  const autorizado = cStat === '100' || cStat === '150';
  return { ok: autorizado, cStat, xMotivo, nProt, chave, dhRec };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 6: HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { headers(res); res.end('{}'); return; }

  // ── Ping ──
  if (req.url === '/ping') {
    headers(res);
    res.end(JSON.stringify({ ok: true, msg: 'SEFAZ Server ativo.', porta: PORTA }));
    return;
  }

  // ── POST /nfe/consultar-recebidas ──
  if (req.method === 'POST' && req.url === '/nfe/consultar-recebidas') {
    try {
      const body = await lerCorpo(req);
      const { certBase64, certSenha, cnpj, uf, ultNSU, ambiente } = body;

      if (!certBase64 || !certSenha) {
        headers(res, 400);
        res.end(JSON.stringify({ ok: false, erro: 'Certificado não informado. Configure nas Configurações do sistema.' }));
        return;
      }

      const certObj = carregarCertificado(certBase64, certSenha);
      const amb     = ambiente === 'Homologação (teste)' ? 'homologacao' : 'producao';
      const ep      = ENDPOINTS[amb];
      const envelope = buildDistDFeEnvelope({ cnpj, uf: uf||'RJ', ultNSU: ultNSU||0, ambiente: amb });

      const { status, body: xmlResp } = await soapRequest({
        host:       ep.distDFe,
        path:       ep.distDFePath,
        soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse',
        envelope,
        certObj,
      });

      if (status !== 200) {
        headers(res, 502);
        res.end(JSON.stringify({ ok: false, erro: `SEFAZ retornou HTTP ${status}`, xmlResp }));
        return;
      }

      const resultado = parseDistDFeResponse(xmlResp);
      headers(res);
      res.end(JSON.stringify({ ...resultado, notas: resultado.notas || [] }));

    } catch (err) {
      headers(res, 500);
      res.end(JSON.stringify({ ok: false, erro: err.message }));
    }
    return;
  }

  // ── POST /nfe/emitir ──
  if (req.method === 'POST' && req.url === '/nfe/emitir') {
    try {
      const body = await lerCorpo(req);
      const { certBase64, certSenha, dados, config } = body;

      if (!certBase64 || !certSenha) {
        headers(res, 400);
        res.end(JSON.stringify({ ok: false, erro: 'Certificado não informado.' }));
        return;
      }

      const certObj = carregarCertificado(certBase64, certSenha);
      const amb     = config.ambiente === 'Homologação (teste)' ? 'homologacao' : 'producao';
      const ep      = ENDPOINTS[amb];
      const tpAmb   = amb === 'producao' ? '1' : '2';

      // Monta e assina o XML
      const xmlBruto    = montarNFeXml(dados, config);
      const xmlAssinado = assinarXml(xmlBruto, certObj);
      const envelope    = buildNFeEnvelope(xmlAssinado, dados.nNF, dados.serie || '1', tpAmb);

      const { status, body: xmlResp } = await soapRequest({
        host:       ep.autorizacao,
        path:       ep.autorizacaoPath,
        soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
        envelope,
        certObj,
      });

      if (status !== 200) {
        headers(res, 502);
        res.end(JSON.stringify({ ok: false, erro: `SEFAZ retornou HTTP ${status}`, xmlResp }));
        return;
      }

      const resultado = parseNFeAutorizacaoResponse(xmlResp);
      headers(res);
      res.end(JSON.stringify({ ...resultado, xmlAssinado }));

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
  console.log('║   RJ Logística — SEFAZ Server               ║');
  console.log(`║   Porta: ${PORTA}   Endpoints: DistDFe + NF-e      ║`);
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
