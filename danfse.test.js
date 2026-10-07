'use strict';

const { extrairDadosNfse, fmtDoc, fmtCep, fmtFone, fmtCTrib, fmtData, fmtDataHora, fmtBRL } = require('./danfse.cjs');

// XML real baixado via /nfse/xml em homologação (07/10/2026), com IDs/dados
// trocados — mantém a mesma estrutura de tags que o SEFIN realmente devolve.
const XML_REAL = `<?xml version="1.0" encoding="utf-8"?><NFSe versao="1.01" xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS33045572258969414000103000000000001326109535246212"><xLocEmi>Rio de Janeiro</xLocEmi><xLocPrestacao>Rio de Janeiro</xLocPrestacao><nNFSe>13</nNFSe><cLocIncid>3304557</cLocIncid><xLocIncid>Rio de Janeiro</xLocIncid><xTribNac>Suporte técnico em informática, inclusive instalação, configuração e manutenção de programas de computação e bancos de dados.</xTribNac><xTribMun>Suporte técnico em informática.</xTribMun><xNBS>Serviços de suporte em tecnologia da informação (TI)</xNBS><verAplic>SefinNacional_1.6.0</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><procEmi>1</procEmi><cStat>100</cStat><dhProc>2026-10-07T16:35:58-03:00</dhProc><nDFSe>159404192</nDFSe><emit><CNPJ>58969414000103</CNPJ><xNome>RIO DE JANEIRO LOGISTICA E TECNOLOGIA LTDA</xNome><enderNac><xLgr>RUA MANUEL BECKMAN</xLgr><nro>834</nro><xBairro>CAMPO GRANDE</xBairro><cMun>3304557</cMun><UF>RJ</UF><CEP>23042530</CEP></enderNac><fone>2197200314</fone><email>contato@exemplo.com.br</email></emit><valores><vLiq>175.00</vLiq></valores><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infDPS Id="DPS330455725896941400010300001000000000000003"><tpAmb>1</tpAmb><dhEmi>2026-10-07T16:35:57-03:00</dhEmi><verAplic>1.00</verAplic><serie>00001</serie><nDPS>3</nDPS><dCompet>2026-10-07</dCompet><tpEmit>1</tpEmit><cLocEmi>3304557</cLocEmi><prest><CNPJ>58969414000103</CNPJ><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest><toma><CNPJ>03574234000130</CNPJ><xNome>DELIRIO METROPOLITANO LTDA</xNome><end><endNac><cMun>3304557</cMun><CEP>22775040</CEP></endNac><xLgr>Av. Embaixador Abelardo Bueno</xLgr><nro>1300</nro><xBairro>Jacarepaguá</xBairro></end><email>tomador@exemplo.com.br</email></toma><serv><locPrest><cLocPrestacao>3304557</cLocPrestacao></locPrest><cServ><cTribNac>010701</cTribNac><cTribMun>001</cTribMun><xDescServ>Troca de capacitor e limpeza de conectores da placa mãe Gigabyte H610-M</xDescServ><cNBS>115013000</cNBS></cServ></serv><valores><vServPrest><vServ>175.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><totTrib><vTotTrib><vTotTribFed>0.00</vTotTribFed><vTotTribEst>0.00</vTotTribEst><vTotTribMun>0.00</vTotTribMun></vTotTrib></totTrib></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

describe('extrairDadosNfse', () => {
  const d = extrairDadosNfse(XML_REAL);

  it('número e status da NFS-e (de dentro do XML, não campo solto no JSON)', () => {
    expect(d.numero).toBe('13');
    expect(d.cStat).toBe('100');
  });

  it('dados do prestador (emit) — não confunde com o CNPJ do tomador', () => {
    expect(d.emitCnpj).toBe('58969414000103');
    expect(d.emitNome).toBe('RIO DE JANEIRO LOGISTICA E TECNOLOGIA LTDA');
    expect(d.emitLgr).toBe('RUA MANUEL BECKMAN');
    expect(d.emitCep).toBe('23042530');
  });

  it('dados do tomador (toma) — endereço vem de <end>, não de <enderNac>', () => {
    expect(d.tomaDoc).toBe('03574234000130');
    expect(d.tomaNome).toBe('DELIRIO METROPOLITANO LTDA');
    expect(d.tomaLgr).toBe('Av. Embaixador Abelardo Bueno');
    expect(d.tomaBairro).toBe('Jacarepaguá');
    expect(d.tomaCep).toBe('22775040');
  });

  it('serviço — cTribNac/cTribMun/cNBS/descrição', () => {
    expect(d.cTribNac).toBe('010701');
    expect(d.cTribMun).toBe('001');
    expect(d.cNBS).toBe('115013000');
    expect(d.xDescServ).toContain('Troca de capacitor');
  });

  it('valores — vServ e vLiq não se confundem (blocos diferentes de <valores>)', () => {
    expect(d.vServ).toBe('175.00');
    expect(d.vLiq).toBe('175.00');
  });

  it('tributação ISSQN — não retido (tpRetISSQN=1)', () => {
    expect(d.tribISSQN).toBe('1');
    expect(d.tpRetISSQN).toBe('1');
  });
});

describe('formatadores', () => {
  it('fmtDoc: CNPJ com máscara', () => {
    expect(fmtDoc('58969414000103')).toBe('58.969.414/0001-03');
  });

  it('fmtDoc: CPF com máscara', () => {
    expect(fmtDoc('12345678901')).toBe('123.456.789-01');
  });

  it('fmtDoc: vazio retorna traço', () => {
    expect(fmtDoc(null)).toBe('-');
  });

  it('fmtCep: com máscara', () => {
    expect(fmtCep('22775040')).toBe('22775-040');
  });

  it('fmtFone: com DDD e máscara (10 dígitos → 4+4)', () => {
    expect(fmtFone('2197200314')).toBe('(21) 9720-0314');
  });

  it('fmtFone: celular 11 dígitos → 5+4', () => {
    expect(fmtFone('21987654321')).toBe('(21) 98765-4321');
  });

  it('fmtCTrib: "010701" → "01.07.01"', () => {
    expect(fmtCTrib('010701')).toBe('01.07.01');
  });

  it('fmtData: ISO → dd/mm/yyyy', () => {
    expect(fmtData('2026-10-07')).toBe('07/10/2026');
  });

  it('fmtDataHora: ISO com hora → dd/mm/yyyy hh:mm:ss', () => {
    expect(fmtDataHora('2026-10-07T16:35:58-03:00')).toBe('07/10/2026 16:35:58');
  });

  it('fmtBRL: formata em reais com 2 casas', () => {
    expect(fmtBRL('175')).toBe('R$ 175,00');
    expect(fmtBRL(0)).toBe('R$ 0,00');
  });
});
