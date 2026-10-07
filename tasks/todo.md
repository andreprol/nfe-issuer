# TODO — NFSe Nacional Integração Direta

## Fase 1: Setup
- [x] T1: `npm install xml-crypto` — instalar dependência de assinatura XMLDSig
- [ ] T2: Baixar XSD oficial do DPS de gov.br → salvar em `tasks/DPS_v1.xsd`

## Fase 2: Módulo nfse-nacional.cjs (arquivo novo)
- [x] T3: `certLoader()` — lê `data/techstore-cert.json`, retorna pfxBuffer + passphrase
- [x] T4: `montarDPS()` — constrói XML da DPS (ID 45 chars validado)
- [x] T5: `assinarDPS()` — XMLDSig RSA-SHA1 via xml-crypto 6.x
- [x] T6: `gzipBase64()` + `mtlsRequest()` — GZIP + Base64 + mTLS POST
- [x] T7: Numeração sequencial persistida em `data/nfse-nacional-seq.json` + rollback
- [x] T8: `handleEmitir()` — handler POST /nfse/emitir
- [x] T9: `handleConsultar()` — handler GET /nfse/consultar
- [x] T10: `handleCancelar()` — handler POST /nfse/cancelar

## ✅ CHECKPOINT A — Revisão humana do módulo antes de tocar em código existente

## Fase 3: emissor-server.cjs (mudança mínima)
- [x] T11: require('./nfse-nacional.cjs') + 3 rotas novas

## ✅ CHECKPOINT B — Reiniciar servidor e confirmar NF-e ainda funciona

## Fase 4: index.html
- [x] T12: Remover chamada automática a `abrirAvisoNfse()` ao navegar para NFS-e
- [x] T13: `emitirNfse()` → POST /nfse/emitir (sem token Focus, com chaveAcesso)
- [x] T14: `nfsePollarPendentes()` + `cancelarNfse()` → /nfse/consultar e /nfse/cancelar com chaveAcesso

## ✅ CHECKPOINT C — Testar UI end-to-end sem produção

## Fase 5: Testes
- [x] T15: Teste completo em homologação (`sefin.producaorestrita.nfse.gov.br`) — 07/10/2026,
      CNAE 9511800, status `autorizado`, chaveAcesso `33045572258969414000103000000000000126109110733449`
- [x] T16: Ajustes pós-teste — 2 erros reais encontrados e corrigidos no teste real (não eram
      o cTribNac, como se suspeitava em 06/07):
      - **E0312 (persistiu mesmo com 010701)**: faltava `<cTribMun>` na `<cServ>`. RJ exige o
        código complementar municipal de 3 dígitos pra desambiguar dentro do cTribNac (ex.:
        140101 cobre 047-059 — "Manutenção de computadores" é especificamente o 051, confirmado
        na planilha oficial `codtribriov2-0`). cTribNac original (140101) estava certo desde o
        início; a correção pra 010701 em 06/07 foi um desvio. `CNAE_PARA_CTN` agora guarda
        `[cTribNac, cTribMun, cNBS]` pros 10 CNAEs mapeados.
      - **E0625**: SEFIN rejeita `<pAliq>` quando ISS não é retido pelo tomador (tpRetISSQN=1)
        pra prestador Simples Nacional sem benefício municipal — o ISS dessa empresa vai
        embutido no DAS, não é calculado por alíquota na nota. `pAliq`/`vTotTribMun` agora só
        são enviados quando `tpRetISSQN === 2` (tomador retém).
      - ⚠️ Pendente verificar depois: `/nfse/consultar` (ADN) devolveu 404 "não encontrada" pra
        essa chave ~30s após autorização — não bloqueia (emissão já volta `autorizado` direto do
        SEFIN, front-end não depende do polling pra essa nota), mas revisitar se o padrão se
        repetir (pode ser atraso de indexação do sandbox restrito, ou path/formato errado).
      - **Reavaliação 07/10/2026 (mesmo dia)**: André pediu pra conferir contra NFS-e reais de
        reparo recebidas de fornecedor (DVC Comércio e Serviços, CNPJ 02.947.559/0001-59, CNAE
        secundário 9511800 — idêntico ao da TechStore). As 3 notas (DVC 9, 10, 11) usam
        `01.07.01/001`, não `14.01.51`. 140101/051 é administrado pelo RJ (autorizou em
        homologação) mas não é a classificação real usada por prestadores desse CNAE — trocado
        de volta pra `010701/001` pra 9511800/9512600. Nessa troca apareceu **E0316** (cNBS
        `102041310` não existe na tabela NBS — era valor inventado, nunca testado, herdado do
        06/07). Corrigido pra `115013000` ("Serviços de suporte em TI", confirmado via
        buscadorncm.com.br/nbs/115013000) — mesmo cNBS aplicado em 6209100 que tinha o mesmo
        valor inventado. Reteste em homologação: `autorizado`,
        chaveAcesso `33045572258969414000103000000000000226101912975906`.
      - ⚠️ cNBS de `150603`/`160201`/`170101`/`110201`/`010401`/`010601` seguem os valores
        originais de 06/07, **nunca testados contra uma emissão real** — só o cTribNac/cTribMun
        foi conferido na planilha oficial. Mesmo padrão de erro (cNBS inventado) pode se repetir
        quando esses CNAEs forem usados pela primeira vez — aí consultar buscadorncm.com.br/nbs/
        antes de assumir que está certo.

## ✅ CHECKPOINT FINAL — Aprovação humana antes de produção
