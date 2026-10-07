'use strict';

const FORMA_PAG = {
  'dinheiro':    '01',
  'pix':         '17',
  'credito':     '03',
  'debito':      '04',
  'boleto':      '15',
  'transferencia': '03',
};

const CNAE_CTN = {
  '5320202': ['150603', '107020000'],
  '5320201': ['260101', '105011500'],
  '4930202': ['160201', '105011110'],
  '9511800': ['140101', '120012000'],
};

function selecionarAmbiente(ambienteStr) {
  return (ambienteStr || '').includes('Produção') ? 'producao' : 'homologacao';
}

// Ano-mês no fuso local a partir de um timestamp ISO (UTC ou com offset).
// slice(0,7) direto na string UTC erra o mês para notas emitidas entre
// 21h-23h59 BRT (viram 00h-02h59 UTC do dia seguinte).
function mesAnoLocal(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function montarPayloadFocus(dados, config) {
  const { nNF, naturezaOp, tpNF, cliente, itens, pagamento, infAdicional } = dados;
  const cnpjLimpo    = (config.cnpj || '').replace(/\D/g, '');
  const destDocLimpo = (cliente.doc || '').replace(/\D/g, '');
  const _now = new Date();
  const _br  = new Date(_now.getTime() - 3 * 3600000);
  const _pad = n => String(n).padStart(2, '0');
  const agora = `${_br.getUTCFullYear()}-${_pad(_br.getUTCMonth()+1)}-${_pad(_br.getUTCDate())}T${_pad(_br.getUTCHours())}:${_pad(_br.getUTCMinutes())}:${_pad(_br.getUTCSeconds())}-03:00`;
  const ref   = `nfe-${cnpjLimpo}-${nNF}-${Date.now()}`;

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

function montarPayloadNfse(dados, config) {
  const { tomador, servico, regimeEspecial, infAdicional } = dados;
  const cnpjLimpo = (config.cnpj || '').replace(/\D/g, '');
  const _now = new Date();
  const _br  = new Date(_now.getTime() - 3 * 3600000);
  const _pad = n => String(n).padStart(2, '0');
  const agora = `${_br.getUTCFullYear()}-${_pad(_br.getUTCMonth()+1)}-${_pad(_br.getUTCDate())}T${_pad(_br.getUTCHours())}:${_pad(_br.getUTCMinutes())}:${_pad(_br.getUTCSeconds())}-03:00`;
  const ref   = `nfsen-${cnpjLimpo}-${Date.now()}`;

  const tomDoc       = (tomador.doc || '').replace(/\D/g, '');
  const valorServico = parseFloat(servico.valor || 0);
  const cnaeLimpo    = (servico.cnae || '5320202').replace(/\D/g, '');
  const [cTribNac, codigoNbs] = CNAE_CTN[cnaeLimpo] || ['150603', '107020000'];

  const payload = {
    data_emissao:                  agora,
    data_competencia:              agora.slice(0, 10),
    codigo_municipio_emissora:     3304557,
    cnpj_prestador:                cnpjLimpo,
    codigo_opcao_simples_nacional: 1,
    regime_especial_tributacao:    parseInt(regimeEspecial || '0'),
    codigo_municipio_prestacao:    3304557,
    codigo_tributacao_nacional_iss: cTribNac,
    codigo_nbs:                    codigoNbs,
    codigo_cnae:                   cnaeLimpo,
    descricao_servico:             servico.discriminacao || '',
    valor_servico:                 valorServico,
    tributacao_iss:                1,
    tipo_retencao_iss:             parseInt(servico.issRetido || '2'),
  };

  if (tomDoc.length === 14)      payload.cnpj_tomador = tomDoc;
  else if (tomDoc.length === 11) payload.cpf_tomador  = tomDoc;
  payload.razao_social_tomador = tomador.nome || 'CONSUMIDOR NAO IDENTIFICADO';
  if (tomador.email) payload.email_tomador = tomador.email;

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

module.exports = { FORMA_PAG, CNAE_CTN, selecionarAmbiente, montarPayloadFocus, montarPayloadNfse, mesAnoLocal };
