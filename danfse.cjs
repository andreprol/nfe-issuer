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
    cLocIncid: tag(infNFSe, 'cLocIncid'),

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

// ── Desenho do PDF — grid com bordas, no estilo do DANFSe oficial (conferido
// contra as 3 NFS-e reais da DVC: barras de seção escuras, linhas e colunas
// com borda fina, label pequeno em cima do valor dentro de cada célula) ──────

const PAGE_W   = 595.28;
const PAGE_H   = 841.89;
const MARGEM   = 32;
const LARGURA_UTIL = PAGE_W - MARGEM * 2;
const COR_SECAO = '#2c3e50';
const COR_BORDA = '#999';
const COR_DIV   = '#ccc';

function ensureSpace(doc, y, altura) {
  if (y + altura > PAGE_H - MARGEM) {
    doc.addPage();
    return MARGEM;
  }
  return y;
}

function sectionTitle(doc, y, text) {
  y = ensureSpace(doc, y, 14);
  doc.rect(MARGEM, y, LARGURA_UTIL, 13).fill(COR_SECAO);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(6.8).text(text, MARGEM + 5, y + 3.5);
  doc.fillColor('#000');
  return y + 13;
}

// cells: [{ label, value, w }] — w é fração de 1 (a soma das frações de uma
// linha deve dar 1). Desenha borda externa + divisórias internas + label
// pequeno/valor, com altura calculada pelo texto mais alto da linha.
function row(doc, y, cells) {
  const widths  = cells.map(c => c.w * LARGURA_UTIL);
  const padX    = 4;
  doc.font('Helvetica').fontSize(7.5);
  const alturas = cells.map((c, i) => doc.heightOfString(String(c.value ?? '-'), { width: widths[i] - padX * 2 }));
  const altura  = Math.max(18, 9 + Math.max(...alturas));

  y = ensureSpace(doc, y, altura);

  doc.rect(MARGEM, y, LARGURA_UTIL, altura).stroke(COR_BORDA);
  let x = MARGEM;
  cells.forEach((c, i) => {
    const w = widths[i];
    if (i > 0) doc.moveTo(x, y).lineTo(x, y + altura).stroke(COR_DIV);
    doc.font('Helvetica-Bold').fontSize(5.6).fillColor('#666').text(c.label, x + padX, y + 2.5, { width: w - padX * 2 });
    doc.font('Helvetica').fontSize(7.5).fillColor('#000').text(String(c.value ?? '-'), x + padX, y + 9.5, { width: w - padX * 2 });
    x += w;
  });

  return y + altura;
}

function staticLine(doc, y, text) {
  const altura = 13;
  y = ensureSpace(doc, y, altura);
  doc.rect(MARGEM, y, LARGURA_UTIL, altura).stroke(COR_BORDA);
  doc.font('Helvetica-Oblique').fontSize(6.8).fillColor('#777').text(text, MARGEM + 4, y + 3, { width: LARGURA_UTIL - 8 });
  doc.fillColor('#000');
  return y + altura;
}

async function gerarDanfsePdf({ xml, chaveAcesso, ambiente, cancelada, justificativaCancelamento }) {
  const d = extrairDadosNfse(xml);
  const qrBuffer = await QRCode.toBuffer(chaveAcesso, { type: 'png', width: 72, margin: 1 });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGEM });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = MARGEM;

    // ── Cabeçalho ──
    const topoCabecalho = y;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#2c3e50').text('DANFSe — Documento Auxiliar da NFS-e', MARGEM, y);
    doc.font('Helvetica').fontSize(7.5).fillColor('#666').text('Município: Rio de Janeiro - RJ', MARGEM, y + 15);
    doc.image(qrBuffer, PAGE_W - MARGEM - 54, topoCabecalho - 2, { width: 54 });
    y = topoCabecalho + 56; // limpa a altura do QR antes da caixa da chave

    // ── Chave de acesso ──
    doc.rect(MARGEM, y, LARGURA_UTIL, 20).stroke(COR_BORDA);
    doc.font('Helvetica-Bold').fontSize(5.6).fillColor('#666').text('CHAVE DE ACESSO DA NFS-e', MARGEM + 4, y + 2.5);
    doc.font('Courier').fontSize(8.5).fillColor('#000').text(chaveAcesso, MARGEM + 4, y + 10);
    y += 24;

    if (cancelada) {
      y = ensureSpace(doc, y, 14);
      doc.rect(MARGEM, y, LARGURA_UTIL, 14).fill('#f8d7da');
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#842029').text('⚠ NFS-e CANCELADA' + (justificativaCancelamento ? ` — ${justificativaCancelamento}` : ''), MARGEM + 5, y + 3);
      doc.fillColor('#000');
      y += 18;
    }

    // ── Identificação da NFS-e / DPS ──
    y = row(doc, y, [
      { label: 'NÚMERO DA NFS-e',          value: d.numero || '-', w: 1/3 },
      { label: 'COMPETÊNCIA DA NFS-e',     value: fmtData(d.dCompet), w: 1/3 },
      { label: 'DATA E HORA DA EMISSÃO',   value: fmtDataHora(d.dhProc), w: 1/3 },
    ]);
    y = row(doc, y, [
      { label: 'NÚMERO DA DPS',            value: d.nDPS || '-', w: 0.25 },
      { label: 'SÉRIE DA DPS',             value: d.serie || '-', w: 0.25 },
      { label: 'SITUAÇÃO DA NFS-e',        value: cancelada ? 'Cancelada' : (d.cStat === '100' ? 'NFS-e Gerada' : d.cStat || '-'), w: 0.25 },
      { label: 'AMBIENTE',                 value: ambiente === 'producao' ? 'Produção' : 'Homologação', w: 0.25 },
    ]);

    // ── Prestador ──
    y = sectionTitle(doc, y, 'PRESTADOR / FORNECEDOR');
    y = row(doc, y, [
      { label: 'CNPJ / CPF / NIF',             value: fmtDoc(d.emitCnpj), w: 0.4 },
      { label: 'INDICADOR MUNICIPAL (INSCRIÇÃO)', value: '-', w: 0.3 },
      { label: 'TELEFONE',                     value: fmtFone(d.emitFone), w: 0.3 },
    ]);
    y = row(doc, y, [
      { label: 'NOME / NOME EMPRESARIAL', value: d.emitNome, w: 0.65 },
      { label: 'MUNICÍPIO / SIGLA UF',    value: fmtMun(d.emitMun), w: 0.35 },
    ]);
    y = row(doc, y, [
      { label: 'ENDEREÇO',     value: fmtEnd(d.emitLgr, d.emitNro, d.emitBairro), w: 0.65 },
      { label: 'CÓDIGO IBGE / CEP', value: `${d.emitMun || '-'} / ${fmtCep(d.emitCep)}`, w: 0.35 },
    ]);
    y = row(doc, y, [
      { label: 'E-MAIL', value: d.emitEmail || '-', w: 0.65 },
      { label: 'SIMPLES NACIONAL NA DATA DE COMPETÊNCIA', value: 'Optante - Microempresa ou Empresa de Pequeno Porte', w: 0.35 },
    ]);
    y = row(doc, y, [
      { label: 'REGIME DE APURAÇÃO TRIBUTÁRIA PELO SN', value: 'Regime de apuração dos tributos federais e municipal pelo Simples Nacional', w: 1 },
    ]);

    // ── Tomador ──
    y = sectionTitle(doc, y, 'TOMADOR / ADQUIRENTE');
    y = row(doc, y, [
      { label: 'CNPJ / CPF / NIF',             value: fmtDoc(d.tomaDoc), w: 0.4 },
      { label: 'INDICADOR MUNICIPAL (INSCRIÇÃO)', value: '-', w: 0.3 },
      { label: 'TELEFONE',                     value: '-', w: 0.3 },
    ]);
    y = row(doc, y, [
      { label: 'NOME / NOME EMPRESARIAL', value: d.tomaNome, w: 0.65 },
      { label: 'MUNICÍPIO / SIGLA UF',    value: fmtMun(d.tomaMun), w: 0.35 },
    ]);
    y = row(doc, y, [
      { label: 'ENDEREÇO',          value: fmtEnd(d.tomaLgr, d.tomaNro, d.tomaBairro), w: 0.65 },
      { label: 'CÓDIGO IBGE / CEP', value: `${d.tomaMun || '-'} / ${fmtCep(d.tomaCep)}`, w: 0.35 },
    ]);
    y = row(doc, y, [
      { label: 'E-MAIL', value: d.tomaEmail || '-', w: 1 },
    ]);
    y = staticLine(doc, y, 'DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e');
    y = staticLine(doc, y, 'INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e');

    // ── Serviço prestado ──
    y = sectionTitle(doc, y, 'SERVIÇO PRESTADO');
    y = row(doc, y, [
      { label: 'CÓDIGO DE TRIBUTAÇÃO NACIONAL/MUNICIPAL', value: `${fmtCTrib(d.cTribNac)} / ${d.cTribMun || '-'}`, w: 0.34 },
      { label: 'CÓDIGO DA NBS',                            value: d.cNBS || '-', w: 0.33 },
      { label: 'LOCAL DA PRESTAÇÃO / SIGLA UF / PAÍS',      value: fmtMun(d.cLocPrestacao), w: 0.33 },
    ]);
    y = row(doc, y, [
      { label: '', value: d.xTribMun || d.xTribNac || '-', w: 1 },
    ]);
    y = row(doc, y, [
      { label: 'DESCRIÇÃO DO SERVIÇO', value: d.xDescServ || '-', w: 1 },
    ]);

    // ── Tributação municipal (ISSQN) ──
    const retido = d.tpRetISSQN === '2';
    y = sectionTitle(doc, y, 'TRIBUTAÇÃO MUNICIPAL (ISSQN)');
    y = row(doc, y, [
      { label: 'TIPO DE TRIBUTAÇÃO DO ISSQN',                 value: d.tribISSQN === '1' ? 'Operação Tributável' : '-', w: 0.5 },
      { label: 'MUNICÍPIO / SIGLA UF / PAÍS DE INCIDÊNCIA',   value: fmtMun(d.cLocIncid), w: 0.5 },
    ]);
    y = row(doc, y, [
      { label: 'BC ISSQN',           value: '-', w: 0.25 },
      { label: 'ALÍQUOTA APLICADA',  value: retido && d.pAliq ? `${d.pAliq}%` : '-', w: 0.25 },
      { label: 'RETENÇÃO DO ISSQN',  value: retido ? 'Retido' : 'Não Retido', w: 0.25 },
      { label: 'ISSQN APURADO',      value: '-', w: 0.25 },
    ]);

    // ── Tributação federal (exceto CBS) — Simples Nacional, sem retenção federal ──
    y = sectionTitle(doc, y, 'TRIBUTAÇÃO FEDERAL (EXCETO CBS)');
    y = row(doc, y, [
      { label: 'IRRF',                             value: '-', w: 0.34 },
      { label: 'CONTRIBUIÇÃO PREVIDENCIÁRIA - RETIDA', value: '-', w: 0.33 },
      { label: 'CONTRIBUIÇÕES SOCIAIS - RETIDAS',   value: '-', w: 0.33 },
    ]);
    y = row(doc, y, [
      { label: 'PIS - DÉBITO APURAÇÃO PRÓPRIA',    value: '-', w: 0.34 },
      { label: 'COFINS - DÉBITO APURAÇÃO PRÓPRIA', value: '-', w: 0.33 },
      { label: 'DESCRIÇÃO CONTRIB. SOCIAIS - RETIDAS', value: '-', w: 0.33 },
    ]);

    // ── Tributação IBS/CBS — reforma tributária ainda não vigente ──
    y = sectionTitle(doc, y, 'TRIBUTAÇÃO IBS/CBS');
    y = row(doc, y, [
      { label: 'CST / cClassTrib', value: '-', w: 0.5 },
      { label: 'INDICADOR DE OPERAÇÃO / CÓDIGO IBGE INCIDÊNCIA / MUNICÍPIO INCIDÊNCIA / UF', value: '-', w: 0.5 },
    ]);
    y = row(doc, y, [
      { label: 'EXCLUSÕES E REDUÇÕES DA BASE DE CÁLCULO', value: fmtBRL(0), w: 0.34 },
      { label: 'BASE DE CÁLCULO APÓS EXCLUSÕES E REDUÇÕES', value: '-', w: 0.33 },
      { label: 'RED. ALÍQUOTA IBS / RED. ALÍQUOTA CBS', value: '-', w: 0.33 },
    ]);
    y = row(doc, y, [
      { label: 'ALÍQUOTA - IBS UF / IBS MUN',        value: '-', w: 0.34 },
      { label: 'ALÍQ. EFETIVA MUNICIPAL - IBS',       value: '-', w: 0.33 },
      { label: 'VALOR APURADO MUNICIPAL - IBS',       value: fmtBRL(0), w: 0.33 },
    ]);
    y = row(doc, y, [
      { label: 'ALÍQ. EFETIVA ESTADUAL - IBS',  value: '-', w: 0.34 },
      { label: 'VALOR APURADO ESTADUAL - IBS',  value: fmtBRL(0), w: 0.33 },
      { label: 'VALOR TOTAL APURADO - IBS',     value: fmtBRL(0), w: 0.33 },
    ]);
    y = row(doc, y, [
      { label: 'ALÍQUOTA - CBS',         value: '-', w: 0.34 },
      { label: 'ALÍQUOTA EFETIVA - CBS', value: '-', w: 0.33 },
      { label: 'VALOR TOTAL APURADO - CBS', value: fmtBRL(0), w: 0.33 },
    ]);

    // ── Valor total ──
    y = sectionTitle(doc, y, 'VALOR TOTAL DA NFS-e');
    y = row(doc, y, [
      { label: 'VALOR DA OPERAÇÃO / SERVIÇO', value: fmtBRL(d.vServ), w: 0.34 },
      { label: 'DESCONTO INCONDICIONADO',     value: '-', w: 0.33 },
      { label: 'DESCONTO CONDICIONADO',       value: '-', w: 0.33 },
    ]);
    y = row(doc, y, [
      { label: 'TOTAL DAS RETENÇÕES (ISSQN / FEDERAIS)', value: retido ? fmtBRL(d.pAliq ? parseFloat(d.vServ || 0) * parseFloat(d.pAliq) / 100 : 0) : '-', w: 0.34 },
      { label: 'VALOR LÍQUIDO DA NFS-e', value: fmtBRL(d.vLiq), w: 0.33 },
      { label: 'TOTAL DO IBS/CBS',       value: fmtBRL(0), w: 0.33 },
    ]);
    y = row(doc, y, [
      { label: 'VALOR LÍQUIDO DA NFS-e + IBS/CBS', value: fmtBRL(0), w: 1 },
    ]);

    // ── Informações complementares ──
    y = sectionTitle(doc, y, 'INFORMAÇÕES COMPLEMENTARES');
    y = staticLine(doc, y, 'Totais aproximados dos Tributos cfe. Lei n° 12.741/2012: Federais: -; Estaduais: -; Municipais: -;');

    // ── Rodapé — chave de acesso completa já está no topo, aqui só o número ──
    y = row(doc, y, [
      { label: 'DATA CIENTIFICAÇÃO',         value: '-', w: 0.4 },
      { label: 'IDENTIFICAÇÃO E ASSINATURA', value: '-', w: 0.4 },
      { label: 'N° NFS-e',                   value: d.numero || '-', w: 0.2 },
    ]);
    y = ensureSpace(doc, y, 10);
    doc.font('Helvetica').fontSize(5.6).fillColor('#999').text(`Gerado em ${new Date().toLocaleString('pt-BR')}`, MARGEM, y + 2, { width: LARGURA_UTIL });

    doc.end();
  });
}

module.exports = { gerarDanfsePdf, extrairDadosNfse, fmtDoc, fmtCep, fmtFone, fmtCTrib, fmtData, fmtDataHora, fmtBRL };
