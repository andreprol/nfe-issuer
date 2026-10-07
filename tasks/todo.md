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
- [ ] T15: Teste completo em homologação (`sefin.producaorestrita.nfse.gov.br`)
- [ ] T16: Ajustes pós-teste (reserva)

## ✅ CHECKPOINT FINAL — Aprovação humana antes de produção
