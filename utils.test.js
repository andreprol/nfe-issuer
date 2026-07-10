'use strict';

const { FORMA_PAG, CNAE_CTN, selecionarAmbiente, montarPayloadFocus, montarPayloadNfse } = require('./utils.cjs');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const dadosNfeBase = {
  nNF: '42',
  naturezaOp: 'Venda de Mercadoria',
  tpNF: '1',
  pagamento: 'pix',
  infAdicional: '',
  cliente: {
    doc: '12.345.678/0001-90',
    nome: 'ACME LTDA',
    logradouro: 'Rua A',
    numero: '100',
    bairro: 'Centro',
    xMun: 'Rio de Janeiro',
    uf: 'RJ',
    cep: '20000-000',
    ie: '',
  },
  itens: [
    { sku: 'P001', nome: 'Notebook', ncm: '8471.30.19', cfop: '5102', unidade: 'UN', qCom: '1', vUnCom: '2500.00', vProd: '2500.00' },
  ],
};

const configBase = { cnpj: '00.623.904/0010-73', ambiente: 'Homologação' };

const dadosNfseBase = {
  tomador: {
    doc: '123.456.789-09',
    nome: 'João da Silva',
    cep: '23042-530',
    logradouro: 'Rua Manuel Beckmann',
    numero: '834',
    bairro: 'Campo Grande',
    codigoMun: '3304557',
  },
  servico: {
    cnae: '9511800',
    discriminacao: 'Manutenção de computador',
    valor: '350.00',
    issRetido: '2',
  },
  regimeEspecial: '0',
  infAdicional: '',
};

// ── selecionarAmbiente ────────────────────────────────────────────────────────

describe('selecionarAmbiente', () => {
  it("'Produção' → 'producao'", () => {
    expect(selecionarAmbiente('Produção')).toBe('producao');
  });

  it("'Homologação' → 'homologacao'", () => {
    expect(selecionarAmbiente('Homologação')).toBe('homologacao');
  });

  it('string vazia → homologacao', () => {
    expect(selecionarAmbiente('')).toBe('homologacao');
  });

  it('undefined → homologacao', () => {
    expect(selecionarAmbiente(undefined)).toBe('homologacao');
  });
});

// ── montarPayloadFocus ────────────────────────────────────────────────────────

describe('montarPayloadFocus', () => {
  it('CNPJ destinatário (14 dígitos) → cnpj_destinatario', () => {
    const { payload } = montarPayloadFocus(dadosNfeBase, configBase);
    expect(payload.cnpj_destinatario).toBe('12345678000190');
    expect(payload.cpf_destinatario).toBeUndefined();
  });

  it('CPF destinatário (11 dígitos) → cpf_destinatario com padStart 11', () => {
    const dados = { ...dadosNfeBase, cliente: { ...dadosNfeBase.cliente, doc: '123.456.789-09' } };
    const { payload } = montarPayloadFocus(dados, configBase);
    expect(payload.cpf_destinatario).toBe('12345678909');
    expect(payload.cnpj_destinatario).toBeUndefined();
  });

  it('IE com valor → indicador_ie_destinatario = 1 + inscricao_estadual_destinatario', () => {
    const dados = { ...dadosNfeBase, cliente: { ...dadosNfeBase.cliente, ie: 'SP-123456' } };
    const { payload } = montarPayloadFocus(dados, configBase);
    expect(payload.indicador_ie_destinatario).toBe(1);
    expect(payload.inscricao_estadual_destinatario).toBe('123456');
  });

  it('IE = ISENTO → indicador_ie_destinatario = 2', () => {
    const dados = { ...dadosNfeBase, cliente: { ...dadosNfeBase.cliente, ie: 'ISENTO' } };
    const { payload } = montarPayloadFocus(dados, configBase);
    expect(payload.indicador_ie_destinatario).toBe(2);
    expect(payload.inscricao_estadual_destinatario).toBeUndefined();
  });

  it('IE vazio → indicador_ie_destinatario = 9', () => {
    const { payload } = montarPayloadFocus(dadosNfeBase, configBase);
    expect(payload.indicador_ie_destinatario).toBe(9);
  });

  it("pagamento 'dinheiro' → forma_pagamento '01'", () => {
    const dados = { ...dadosNfeBase, pagamento: 'dinheiro' };
    const { payload } = montarPayloadFocus(dados, configBase);
    expect(payload.formas_pagamento[0].forma_pagamento).toBe('01');
  });

  it("pagamento 'pix' → forma_pagamento '17'", () => {
    const { payload } = montarPayloadFocus(dadosNfeBase, configBase);
    expect(payload.formas_pagamento[0].forma_pagamento).toBe('17');
  });

  it('pagamento desconhecido → fallback forma_pagamento = undefined (FORMA_PAG fallback)', () => {
    const dados = { ...dadosNfeBase, pagamento: 'criptomoeda' };
    const { payload } = montarPayloadFocus(dados, configBase);
    // Sem match no FORMA_PAG → codPag = undefined, mas o código usa || '01'
    expect(payload.formas_pagamento[0].forma_pagamento).toBe('01');
  });

  it("ref começa com 'nfe-'", () => {
    const { ref } = montarPayloadFocus(dadosNfeBase, configBase);
    expect(ref).toMatch(/^nfe-/);
  });

  it('items mapeados com quantidade = length do array itens', () => {
    const itens = [
      { sku: 'A1', nome: 'Item 1', ncm: '8471', cfop: '5102', unidade: 'UN', qCom: '2', vUnCom: '100', vProd: '200' },
      { sku: 'A2', nome: 'Item 2', ncm: '8471', cfop: '5102', unidade: 'UN', qCom: '1', vUnCom: '50',  vProd: '50'  },
    ];
    const dados = { ...dadosNfeBase, itens };
    const { payload } = montarPayloadFocus(dados, configBase);
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0].numero_item).toBe(1);
    expect(payload.items[1].numero_item).toBe(2);
    expect(payload.items[0].valor_bruto).toBe(200);
    expect(payload.items[0].quantidade_comercial).toBe(2);
  });

  it('total da NF soma vProd de todos os itens', () => {
    const itens = [
      { sku: 'X1', qCom: '1', vUnCom: '100', vProd: '100' },
      { sku: 'X2', qCom: '2', vUnCom: '50',  vProd: '100' },
    ];
    const dados = { ...dadosNfeBase, itens };
    const { payload } = montarPayloadFocus(dados, configBase);
    expect(payload.formas_pagamento[0].valor_pagamento).toBeCloseTo(200);
  });

  it('cnpj_emitente limpo (sem máscara)', () => {
    const { payload } = montarPayloadFocus(dadosNfeBase, configBase);
    expect(payload.cnpj_emitente).toBe('00623904001073');
  });
});

// ── montarPayloadNfse ─────────────────────────────────────────────────────────

describe('montarPayloadNfse', () => {
  it("CNAE '9511800' → cTribNac '140101', codigoNbs '120012000'", () => {
    const { payload } = montarPayloadNfse(dadosNfseBase, configBase);
    expect(payload.codigo_tributacao_nacional_iss).toBe('140101');
    expect(payload.codigo_nbs).toBe('120012000');
  });

  it("CNAE '5320202' → cTribNac '150603'", () => {
    const dados = { ...dadosNfseBase, servico: { ...dadosNfseBase.servico, cnae: '5320202' } };
    const { payload } = montarPayloadNfse(dados, configBase);
    expect(payload.codigo_tributacao_nacional_iss).toBe('150603');
  });

  it('CNAE desconhecido → fallback 150603 / 107020000', () => {
    const dados = { ...dadosNfseBase, servico: { ...dadosNfseBase.servico, cnae: '9999999' } };
    const { payload } = montarPayloadNfse(dados, configBase);
    expect(payload.codigo_tributacao_nacional_iss).toBe('150603');
    expect(payload.codigo_nbs).toBe('107020000');
  });

  it('tomador CPF (11 dígitos) → cpf_tomador', () => {
    const { payload } = montarPayloadNfse(dadosNfseBase, configBase);
    expect(payload.cpf_tomador).toBe('12345678909');
    expect(payload.cnpj_tomador).toBeUndefined();
  });

  it('tomador CNPJ (14 dígitos) → cnpj_tomador', () => {
    const dados = { ...dadosNfseBase, tomador: { ...dadosNfseBase.tomador, doc: '12.345.678/0001-90' } };
    const { payload } = montarPayloadNfse(dados, configBase);
    expect(payload.cnpj_tomador).toBe('12345678000190');
    expect(payload.cpf_tomador).toBeUndefined();
  });

  it('CEP vazio → endereço do tomador NÃO incluído', () => {
    const dados = { ...dadosNfseBase, tomador: { ...dadosNfseBase.tomador, cep: '' } };
    const { payload } = montarPayloadNfse(dados, configBase);
    expect(payload.cep_tomador).toBeUndefined();
    expect(payload.logradouro_tomador).toBeUndefined();
  });

  it('CEP preenchido → cep_tomador e logradouro_tomador presentes', () => {
    const { payload } = montarPayloadNfse(dadosNfseBase, configBase);
    expect(payload.cep_tomador).toBe('23042530');
    expect(payload.logradouro_tomador).toBe('Rua Manuel Beckmann');
  });

  it("ref começa com 'nfsen-'", () => {
    const { ref } = montarPayloadNfse(dadosNfseBase, configBase);
    expect(ref).toMatch(/^nfsen-/);
  });

  it('valor_servico parseado como número', () => {
    const { payload } = montarPayloadNfse(dadosNfseBase, configBase);
    expect(payload.valor_servico).toBe(350);
  });

  it('email_tomador incluído quando presente', () => {
    const dados = { ...dadosNfseBase, tomador: { ...dadosNfseBase.tomador, email: 'joao@exemplo.com' } };
    const { payload } = montarPayloadNfse(dados, configBase);
    expect(payload.email_tomador).toBe('joao@exemplo.com');
  });

  it('email_tomador ausente quando tomador não tem email', () => {
    const { payload } = montarPayloadNfse(dadosNfseBase, configBase);
    expect(payload.email_tomador).toBeUndefined();
  });
});
