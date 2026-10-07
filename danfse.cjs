'use strict';

/**
 * DANFSe próprio — gov.br (SEFIN/ADN) não expõe endpoint de PDF, só o XML
 * assinado (ver nfse-nacional.cjs). Este módulo lê esse XML e desenha uma
 * representação em PDF com os mesmos campos do DANFSe v2.0 oficial (layout
 * conferido contra 3 NFS-e reais recebidas de fornecedor — DVC Comércio e
 * Serviços). NÃO é o leiaute oficial do Sistema Nacional NFS-e: os dados são
 * os mesmos do XML assinado pelo SEFIN, mas o desenho é nosso.
 */

const PDFDocument = require('pdfkit');
const QRCode       = require('qrcode');

// Só RJ por enquanto — único município onde esta empresa presta serviço.
const MUNICIPIOS = { '3304557': 'Rio de Janeiro / RJ' };

// ── Extração de campos do XML (regex simples — schema conhecido, sem tags
// repetidas dentro de cada bloco já escopado; ver nfse-nacional.cjs p/ o
// mesmo padrão em decodificarNfseXml) ──────────────────────────────────────

function tag(xml, name) {
  if (!xml) return null;
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1] : null;
}

function block(xml, name) {
  if (!xml) return '';
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
}

function extrairDadosNfse(xml) {
  const infNFSe   = block(xml, 'infNFSe');
  const emit      = block(infNFSe, 'emit');
  const enderEmit = block(emit, 'enderNac');
  const valoresN  = block(infNFSe, 'valores');
  const dps       = block(infNFSe, 'DPS');
  const infDPS    = block(dps, 'infDPS');
  const toma      = block(infDPS, 'toma');
  const tomaEnd   = block(toma, 'end');
  const tomaEndN  = block(tomaEnd, 'endNac');
  const serv      = block(infDPS, 'serv');
  const cServ     = block(serv, 'cServ');
  const valoresD  = block(infDPS, 'valores');
  const vServP    = block(valoresD, 'vServPrest');
  const trib      = block(valoresD, 'trib');
  const tribMun   = block(trib, 'tribMun');

  return {
    numero:    tag(infNFSe, 'nNFSe'),
    cStat:     tag(infNFSe, 'cStat'),
    dhProc:    tag(infNFSe, 'dhProc'),
    xTribNac:  tag(infNFSe, 'xTribNac'),
    xTribMun:  tag(infNFSe, 'xTribMun'),
    xNBS:      tag(infNFSe, 'xNBS'),
    vLiq:      tag(valoresN, 'vLiq'),

    emitCnpj:   tag(emit, 'CNPJ'),
    emitNome:   tag(emit, 'xNome'),
    emitLgr:    tag(enderEmit, 'xLgr'),
    emitNro:    tag(enderEmit, 'nro'),
    emitBairro: tag(enderEmit, 'xBairro'),
    emitMun:    tag(enderEmit, 'cMun'),
    emitCep:    tag(enderEmit, 'CEP'),
    emitFone:   tag(emit, 'fone'),
    emitEmail:  tag(emit, 'email'),

    tpAmb:   tag(infDPS, 'tpAmb'),
    dhEmi:   tag(infDPS, 'dhEmi'),
    serie:   tag(infDPS, 'serie'),
    nDPS:    tag(infDPS, 'nDPS'),
    dCompet: tag(infDPS, 'dCompet'),

    tomaDoc:    tag(toma, 'CNPJ') || tag(toma, 'CPF'),
    tomaNome:   tag(toma, 'xNome'),
    tomaLgr:    tag(tomaEnd, 'xLgr'),
    tomaNro:    tag(tomaEnd, 'nro'),
    tomaBairro: tag(tomaEnd, 'xBairro'),
    tomaMun:    tag(tomaEndN, 'cMun'),
    tomaCep:    tag(tomaEndN, 'CEP'),
    tomaEmail:  tag(toma, 'email'),

    cLocPrestacao: tag(serv, 'cLocPrestacao'),
    cTribNac:      tag(cServ, 'cTribNac'),
    cTribMun:      tag(cServ, 'cTribMun'),
    xDescServ:     tag(cServ, 'xDescServ'),
    cNBS:          tag(cServ, 'cNBS'),

    vServ:      tag(vServP, 'vServ'),
    tribISSQN:  tag(tribMun, 'tribISSQN'),
    tpRetISSQN: tag(tribMun, 'tpRetISSQN'),
    pAliq:      tag(tribMun, 'pAliq'),
  };
}

// ── Formatação ───────────────────────────────────────────────────────────────

function fmtDoc(doc) {
  if (!doc) return '-';
  const d = doc.replace(/\D/g, '');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return doc;
}
function fmtCep(cep)   { return cep  ? cep.replace(/(\d{5})(\d{3})/, '$1-$2') : '-'; }
function fmtFone(fone) { return fone ? fone.replace(/(\d{2})(\d{4,5})(\d{4})/, '($1) $2-$3') : '-'; }
function fmtMun(cMun)  { return MUNICIPIOS[cMun] || (cMun || '-'); }
function fmtCTrib(c)   { return (c && c.length === 6) ? `${c.slice(0,2)}.${c.slice(2,4)}.${c.slice(4,6)}` : (c || '-'); }
function fmtData(iso) {
  if (!iso) return '-';
  const [data] = iso.split('T');
  const [y, m, d] = data.split('-');
  return `${d}/${m}/${y}`;
}
function fmtDataHora(iso) {
  if (!iso) return '-';
  const [data, hora] = iso.split('T');
  const [y, m, d] = data.split('-');
  return `${d}/${m}/${y} ${hora ? hora.slice(0, 8) : ''}`;
}
function fmtBRL(v) {
  return 'R$ ' + parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtEnd(lgr, nro, bairro) {
  const partes = [lgr, nro, bairro].filter(Boolean);
  return partes.length ? partes.join(', ') : '-';
}

// ── Desenho do PDF ───────────────────────────────────────────────────────────

const MARGEM = 36;
const LARGURA_UTIL = 595.28 - MARGEM * 2;

function sectionTitle(doc, y, text) {
  doc.rect(MARGEM, y, LARGURA_UTIL, 16).fill('#2c3e50');
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8).text(text, MARGEM + 6, y + 4);
  doc.fillColor('#000');
  return y + 16;
}

function field(doc, x, y, w, label, value) {
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#555').text(label, x, y, { width: w });
  doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(value || '-', x, y + 9, { width: w });
}

async function gerarDanfsePdf({ xml, chaveAcesso, ambiente, cancelada, justificativaCancelamento }) {
  const d = extrairDadosNfse(xml);
  const qrBuffer = await QRCode.toBuffer(chaveAcesso, { type: 'png', width: 100, margin: 1 });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGEM });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = MARGEM;

    // ── Cabeçalho ──
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#2c3e50').text('DANFSe — Documento Auxiliar da NFS-e', MARGEM, y);
    doc.font('Helvetica').fontSize(8).fillColor('#666').text('Município: Rio de Janeiro - RJ   •   Sistema Nacional NFS-e', MARGEM, y + 17);
    doc.image(qrBuffer, 595.28 - MARGEM - 70, y - 4, { width: 70 });
    y += 36;

    doc.font('Helvetica').fontSize(7).fillColor('#a33').text(
      'Documento gerado automaticamente a partir do XML assinado pelo SEFIN Nacional — não é o leiaute oficial do ' +
      'Sistema Nacional NFS-e (que não disponibiliza PDF via API). Para a via oficial, consulte a chave de acesso ' +
      'abaixo em nfse.gov.br/ConsultaPublica.',
      MARGEM, y, { width: LARGURA_UTIL - 80 }
    );
    doc.fillColor('#000');
    y += 30;

    // ── Chave de acesso ──
    doc.rect(MARGEM, y, LARGURA_UTIL, 22).stroke('#999');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#555').text('CHAVE DE ACESSO DA NFS-e', MARGEM + 6, y + 3);
    doc.font('Courier').fontSize(10).fillColor('#000').text(chaveAcesso, MARGEM + 6, y + 11);
    y += 30;

    if (cancelada) {
      doc.rect(MARGEM, y, LARGURA_UTIL, 16).fill('#f8d7da');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#842029').text('⚠ NFS-e CANCELADA' + (justificativaCancelamento ? ` — ${justificativaCancelamento}` : ''), MARGEM + 6, y + 4);
      doc.fillColor('#000');
      y += 22;
    }

    // ── Linha: número / competência / emissão ──
    const col3 = LARGURA_UTIL / 3;
    field(doc, MARGEM,            y, col3, 'NÚMERO DA NFS-e',                d.numero || '-');
    field(doc, MARGEM + col3,     y, col3, 'COMPETÊNCIA DA NFS-e',           fmtData(d.dCompet));
    field(doc, MARGEM + col3 * 2, y, col3, 'DATA E HORA DA EMISSÃO',         fmtDataHora(d.dhProc));
    y += 24;
    field(doc, MARGEM,            y, col3, 'NÚMERO DA DPS',                  d.nDPS || '-');
    field(doc, MARGEM + col3,     y, col3, 'SÉRIE DA DPS',                   d.serie || '-');
    field(doc, MARGEM + col3 * 2, y, col3, 'SITUAÇÃO',                       cancelada ? 'Cancelada' : (d.cStat === '100' ? 'NFS-e Gerada' : d.cStat || '-'));
    y += 24;
    field(doc, MARGEM,            y, col3, 'AMBIENTE',                       ambiente === 'producao' ? 'Produção' : 'Homologação');
    y += 20;

    // ── Prestador ──
    y = sectionTitle(doc, y, 'PRESTADOR / FORNECEDOR');
    y += 4;
    const col2 = LARGURA_UTIL / 2;
    field(doc, MARGEM,        y, col2, 'CNPJ',                 fmtDoc(d.emitCnpj));
    field(doc, MARGEM + col2, y, col2, 'TELEFONE',             fmtFone(d.emitFone));
    y += 22;
    field(doc, MARGEM,        y, col2, 'NOME / NOME EMPRESARIAL', d.emitNome);
    field(doc, MARGEM + col2, y, col2, 'MUNICÍPIO / UF',          fmtMun(d.emitMun));
    y += 22;
    field(doc, MARGEM,        y, col2, 'ENDEREÇO',             fmtEnd(d.emitLgr, d.emitNro, d.emitBairro));
    field(doc, MARGEM + col2, y, col2, 'CEP / E-MAIL',         `${fmtCep(d.emitCep)}  ${d.emitEmail || ''}`);
    y += 26;

    // ── Tomador ──
    y = sectionTitle(doc, y, 'TOMADOR / ADQUIRENTE');
    y += 4;
    field(doc, MARGEM,        y, col2, 'CNPJ / CPF',           fmtDoc(d.tomaDoc));
    field(doc, MARGEM + col2, y, col2, 'MUNICÍPIO / UF',       fmtMun(d.tomaMun));
    y += 22;
    field(doc, MARGEM,        y, col2, 'NOME / NOME EMPRESARIAL', d.tomaNome);
    field(doc, MARGEM + col2, y, col2, 'CEP',                     fmtCep(d.tomaCep));
    y += 22;
    field(doc, MARGEM,        y, col2, 'ENDEREÇO',             fmtEnd(d.tomaLgr, d.tomaNro, d.tomaBairro));
    field(doc, MARGEM + col2, y, col2, 'E-MAIL',               d.tomaEmail || '-');
    y += 26;

    // ── Serviço prestado ──
    y = sectionTitle(doc, y, 'SERVIÇO PRESTADO');
    y += 4;
    field(doc, MARGEM,            y, col3, 'CÓD. TRIBUTAÇÃO NACIONAL/MUNICIPAL', `${fmtCTrib(d.cTribNac)} / ${d.cTribMun || '-'}`);
    field(doc, MARGEM + col3,     y, col3, 'CÓDIGO NBS',                          d.cNBS || '-');
    field(doc, MARGEM + col3 * 2, y, col3, 'LOCAL DA PRESTAÇÃO',                  fmtMun(d.cLocPrestacao));
    y += 22;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#555').text((d.xTribMun || d.xTribNac || '').toUpperCase(), MARGEM, y, { width: LARGURA_UTIL });
    y += 10;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#555').text('DESCRIÇÃO DO SERVIÇO', MARGEM, y);
    y += 9;
    const descHeight = doc.font('Helvetica').fontSize(8.5).fillColor('#000').heightOfString(d.xDescServ || '-', { width: LARGURA_UTIL });
    doc.text(d.xDescServ || '-', MARGEM, y, { width: LARGURA_UTIL });
    y += descHeight + 10;

    // ── Tributação municipal (ISSQN) ──
    y = sectionTitle(doc, y, 'TRIBUTAÇÃO MUNICIPAL (ISSQN)');
    y += 4;
    const retido = d.tpRetISSQN === '2';
    field(doc, MARGEM,            y, col3, 'TIPO DE TRIBUTAÇÃO',  d.tribISSQN === '1' ? 'Operação Tributável' : '-');
    field(doc, MARGEM + col3,     y, col3, 'RETENÇÃO DO ISSQN',   retido ? 'Retido' : 'Não Retido');
    field(doc, MARGEM + col3 * 2, y, col3, 'ALÍQUOTA APLICADA',   retido && d.pAliq ? `${d.pAliq}%` : '-');
    y += 26;

    // ── Tributação federal / IBS-CBS (reforma ainda não ativa — tudo "-") ──
    y = sectionTitle(doc, y, 'TRIBUTAÇÃO FEDERAL (EXCETO CBS) E IBS/CBS');
    y += 4;
    doc.font('Helvetica').fontSize(7.5).fillColor('#777').text(
      'IRRF: -    Contrib. Previdenciária Retida: -    PIS: -    COFINS: -    CST/cClassTrib: -    IBS/CBS: R$ 0,00 (reforma tributária ainda não vigente)',
      MARGEM, y, { width: LARGURA_UTIL }
    );
    doc.fillColor('#000');
    y += 22;

    // ── Valor total ──
    y = sectionTitle(doc, y, 'VALOR TOTAL DA NFS-e');
    y += 4;
    field(doc, MARGEM,            y, col3, 'VALOR DA OPERAÇÃO / SERVIÇO', fmtBRL(d.vServ));
    field(doc, MARGEM + col3,     y, col3, 'VALOR LÍQUIDO DA NFS-e',      fmtBRL(d.vLiq));
    field(doc, MARGEM + col3 * 2, y, col3, 'TOTAL DO IBS/CBS',            fmtBRL(0));
    y += 28;

    // ── Informações complementares ──
    doc.font('Helvetica').fontSize(7).fillColor('#777').text(
      'Totais aproximados dos Tributos cfe. Lei n° 12.741/2012: Federais: -; Estaduais: -; Municipais: -;',
      MARGEM, y, { width: LARGURA_UTIL }
    );
    doc.fillColor('#000');
    y += 20;

    // ── Rodapé ──
    doc.moveTo(MARGEM, y).lineTo(595.28 - MARGEM, y).stroke('#ccc');
    y += 6;
    doc.font('Helvetica').fontSize(6.5).fillColor('#999').text(
      `Gerado em ${new Date().toLocaleString('pt-BR')} — N° NFS-e / Chave: ${d.numero || '-'} / ${chaveAcesso}`,
      MARGEM, y, { width: LARGURA_UTIL }
    );

    doc.end();
  });
}

module.exports = { gerarDanfsePdf, extrairDadosNfse, fmtDoc, fmtCep, fmtFone, fmtCTrib, fmtData, fmtDataHora, fmtBRL };
