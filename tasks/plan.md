# Plano de Implementação: NFSe Nacional — Integração Direta

## Visão Geral

Substituir a integração Focus NFe para NFSe (que falha com E0312 para Simples Nacional no RJ) por uma
integração direta com o portal nacional `adn.nfse.gov.br`. O certificado A1 já está armazenado no
servidor (`data/techstore-cert.json`). A NF-e via Focus NFe **não é tocada** em nenhuma etapa.

---

## Decisões de Arquitetura

| Decisão | Escolha | Motivo |
|---------|---------|--------|
| Estrutura de arquivos | Novo módulo `nfse-nacional.cjs` + integração mínima em `emissor-server.cjs` | Isolamento total — qualquer bug novo não afeta NF-e ou dados |
| Formato da API nacional | XML + XMLDSig + GZIP + Base64 via mTLS | Especificado pelo gov.br e confirmado por implementações reais |
| Assinatura XML | `xml-crypto` (npm) | Biblioteca padrão da comunidade BR para XMLDSig |
| Construção XML | Template strings (sem lib extra) | DPS tem estrutura fixa e pequena; evita dependência desnecessária |
| Compressão | `zlib` nativo do Node.js | Sem dependência extra |
| mTLS | `https.request` com opções `pfx` + `passphrase` | Suporte nativo do Node.js HTTPS |
| Rotas novas | `/nfse/emitir`, `/nfse/consultar`, `/nfse/cancelar` | Paralelas às `/focus/nfse/*` — não há colisão |
| Rotas Focus NFSe | Mantidas intactas | Preserva histórico e evita risco de regressão |

---

## Grafo de Dependências

```
techstore-cert.json (armazenado no servidor)
        │
        ▼
[T3] certLoader (lê PFX + senha do arquivo)
        │
        ├──▶ [T4] montarDPS (XML builder)
        │           │
        │           ▼
        │    [T5] assinarDPS (xml-crypto XMLDSig)
        │           │
        │           ▼
        │    [T6] comprimirEnviar (zlib GZIP + Base64 + mTLS POST)
        │           │
        │           ├──▶ [T8] handler POST /nfse/emitir
        │           ├──▶ [T9] handler GET  /nfse/consultar
        │           └──▶ [T10] handler POST /nfse/cancelar
        │
        ▼
[T11] emissor-server.cjs: require + 3 rotas novas
        │
        ▼
[T13] index.html: emitirNfse() → /nfse/emitir
[T14] index.html: polling → /nfse/consultar
[T15] index.html: modal aviso → modal real de emissão
```

---

## Fase 1: Setup (sem tocar em nenhum arquivo existente)

### Task 1: Instalar dependências
**Descrição:** Instalar `xml-crypto` para assinatura XMLDSig. Não requer mudança em nenhum arquivo do projeto.

**Acceptance criteria:**
- [ ] `npm install xml-crypto` executa sem erro
- [ ] `package.json` lista `xml-crypto` em `dependencies`
- [ ] `node -e "require('xml-crypto')"` não lança exceção

**Verificação:** `node -e "const xc = require('xml-crypto'); console.log('ok:', typeof xc.SignedXml)"`

**Dependências:** Nenhuma

**Arquivos tocados:** `package.json`, `package-lock.json`

**Tamanho:** XS

---

### Task 2: Buscar e salvar o XSD oficial do DPS
**Descrição:** Baixar o schema XSD da DPS do portal gov.br e salvar em `tasks/DPS_v1.xsd` para
referência durante o desenvolvimento. Usado como fonte de verdade para os campos obrigatórios do XML.

**Acceptance criteria:**
- [ ] Arquivo `tasks/DPS_v1.xsd` existe e contém o schema completo
- [ ] Campos de `infDPS`, `emit`, `toma`, `serv`, `valores` estão identificados

**Verificação:** Leitura manual do XSD confirmando campos críticos: `tpAmb`, `dhEmi`, `CNPJ`, `cTribNac`, `cNBS`, `vServ`

**Dependências:** Nenhuma

**Arquivos tocados:** `tasks/DPS_v1.xsd` (novo)

**Tamanho:** XS

---

## Checkpoint: Fase 1
- [ ] `xml-crypto` instalado e importável
- [ ] XSD disponível como referência
- [ ] Nenhum arquivo existente modificado

---

## Fase 2: Módulo NFSe Nacional (arquivo novo — risco zero para NF-e)

### Task 3: certLoader — carregamento do certificado
**Descrição:** Função que lê `data/techstore-cert.json`, decodifica o PFX de Base64 e retorna
`{ pfxBuffer, passphrase }` prontos para uso no mTLS e na assinatura.

**Acceptance criteria:**
- [ ] `certLoader()` lê o arquivo correto sem lançar exceção se cert existe
- [ ] Retorna `null` com log claro se `techstore-cert.json` não existe ou está malformado
- [ ] Não expõe a senha em logs

**Verificação:** `node -e "const {certLoader} = require('./nfse-nacional.cjs'); console.log(certLoader()?.pfxBuffer?.length > 0)"` → `true`

**Dependências:** Task 1

**Arquivos tocados:** `nfse-nacional.cjs` (novo)

**Tamanho:** S

---

### Task 4: montarDPS — XML builder
**Descrição:** Função `montarDPS(dados, config)` que constrói o XML da DPS conforme o schema
oficial. Campos fixos: `cLocEmi=3304557` (RJ), `opSimpNac=1`, `tpEmit=2`.
Mapeamento CNAE→cTribNac+cNBS reutilizado do código Focus existente.

Estrutura da DPS:
```xml
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse">
  <infDPS Id="DPS{cnpj}{serie}{numero}{dataHoraEmissao}">
    <tpAmb>1</tpAmb>          <!-- 1=prod, 2=hom -->
    <dhEmi>{ISO8601}</dhEmi>
    <verAplic>1.00</verAplic>
    <serie>1</serie>
    <nDPS>{numero}</nDPS>
    <dCompet>{YYYY-MM-DD}</dCompet>
    <tpEmit>2</tpEmit>
    <cLocEmi>3304557</cLocEmi>
    <emit>
      <CNPJ>{cnpj}</CNPJ>
      <regTrib>
        <opSimpNac>1</opSimpNac>
        <regApTribSN>1</regApTribSN>
        <regEspTrib>0</regEspTrib>
      </regTrib>
    </emit>
    <toma>
      <!-- CNPJ ou CPF + xNome + endereço -->
    </toma>
    <serv>
      <locPrest><cLocPrestacao>3304557</cLocPrestacao></locPrest>
      <cServ>
        <cTribNac>{6 dígitos}</cTribNac>
        <cNBS>{9 dígitos}</cNBS>
        <CNAE>{cnae}</CNAE>
      </cServ>
      <xDescServ>{discriminacao}</xDescServ>
    </serv>
    <valores>
      <vServPrest><vServ>{valor}</vServ></vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <cLocIncid>3304557</cLocIncid>
          <tpRetISSQN>{issRetido}</tpRetISSQN>
        </tribMun>
      </trib>
    </valores>
  </infDPS>
  <!-- <Signature> inserida pela Task 5 -->
</DPS>
```

**Acceptance criteria:**
- [ ] XML gerado é um string UTF-8 bem formado
- [ ] `Id` do `infDPS` segue padrão `DPS{cnpj}{serie}{nDPS}{yyyyMMddHHmmss}`
- [ ] CNPJ tomador cai em `<CNPJ>`, CPF em `<CPF>`
- [ ] Campos numéricos (`vServ`) formatados com 2 casas decimais, ponto como separador
- [ ] `tpAmb` = 1 para produção, 2 para homologação

**Verificação:** `montarDPS(dadosTeste, configTeste)` retorna string XML; validar estrutura manualmente com VS Code ou browser

**Dependências:** Task 3

**Arquivos tocados:** `nfse-nacional.cjs`

**Tamanho:** M

---

### Task 5: assinarDPS — assinatura XMLDSig
**Descrição:** Função `assinarDPS(xmlStr, pfxBuffer, passphrase)` que usa `xml-crypto` para
inserir a assinatura `<Signature>` conforme padrão ICP-Brasil:
- Algoritmo: RSA-SHA1
- Canonicalização: C14N (`http://www.w3.org/TR/2001/REC-xml-c14n-20010315`)
- Referência: `#DPS{id}` (o `infDPS`)
- Transform: `enveloped-signature`
- `<KeyInfo>` com `<X509Certificate>` (PEM sem cabeçalho)

**Acceptance criteria:**
- [ ] XML retornado contém `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">`
- [ ] `<DigestValue>` e `<SignatureValue>` são strings Base64 não-vazias
- [ ] `<X509Certificate>` contém o certificado público
- [ ] Verificação de assinatura com `xml-crypto SignedXml.checkSignature` retorna `true`

**Verificação:**
```js
const xml = assinarDPS(xmlTeste, pfxBuffer, senha);
const verify = new SignedXml();
verify.loadSignature(xml);
console.log(verify.checkSignature(xml)); // true
```

**Dependências:** Task 4

**Arquivos tocados:** `nfse-nacional.cjs`

**Tamanho:** M

---

### Task 6: comprimirEnviar — GZIP + Base64 + mTLS POST
**Descrição:** Função `enviarParaNacionalAsync(xmlAssinado, pfxBuffer, passphrase, ambiente)` que:
1. GZIP comprime o XML com `zlib.gzip`
2. Converte para Base64
3. Monta JSON: `{ dps: "<base64>" }` (ou envia raw — verificar Swagger)
4. Faz `https.request` com `pfx: pfxBuffer, passphrase` para mTLS
5. POST para `adn.nfse.gov.br/contribuintes/v1/dps` (prod) ou `adn.producaorestrita.nfse.gov.br/...` (hom)

**Acceptance criteria:**
- [ ] A requisição inclui o certificado cliente na negociação TLS
- [ ] Resposta HTTP 200/201 é parseada como JSON
- [ ] Erros de rede lançam exceção com mensagem legível
- [ ] Ambiente de homologação usa host `adn.producaorestrita.nfse.gov.br`

**Verificação:** Teste real contra homologação (Fase 5)

**Dependências:** Task 5

**Arquivos tocados:** `nfse-nacional.cjs`

**Tamanho:** M

---

### Task 7: Numeração sequencial de DPS
**Descrição:** O campo `nDPS` deve ser sequencial por CNPJ. Implementar contador persistido em
`data/nfse-nacional-seq.json` com leitura/incremento atômico.

**Acceptance criteria:**
- [ ] Primeiro DPS emitido tem `nDPS=1`
- [ ] Cada emissão bem-sucedida incrementa o contador
- [ ] Falha de comunicação não incrementa o contador
- [ ] Arquivo criado automaticamente se não existir

**Verificação:** Emitir 2 notas em sequência → verificar `nDPS` 1 e 2 no JSON das notas salvas

**Dependências:** Task 3

**Arquivos tocados:** `nfse-nacional.cjs`

**Tamanho:** S

---

### Task 8: Handler POST /nfse/emitir
**Descrição:** Handler que orquestra o fluxo completo:
1. Lê corpo da requisição (`dados`, `config`)
2. Chama `certLoader()` → erro 400 se cert não existe
3. `montarDPS` → `assinarDPS` → `enviarParaNacionalAsync`
4. Retorna `{ ok: true, chaveAcesso, numero, status }` ou `{ ok: false, erro }`

Response de sucesso:
```json
{ "ok": true, "chaveAcesso": "...(50 chars)...", "numero": 42, "status": "autorizado", "ambiente": "producao" }
```

**Acceptance criteria:**
- [ ] Sem certificado → HTTP 400 `"Certificado digital não configurado"`
- [ ] Token Focus não é exigido (rota totalmente independente)
- [ ] Sucesso retorna `chaveAcesso` de 50 caracteres
- [ ] Erros da API nacional retornam HTTP 502 com `erro` legível

**Verificação:** `curl -X POST http://localhost:3003/nfse/emitir -d '...'` → resposta JSON estruturada

**Dependências:** Tasks 6, 7

**Arquivos tocados:** `nfse-nacional.cjs`

**Tamanho:** S

---

### Task 9: Handler GET /nfse/consultar
**Descrição:** Handler `GET /nfse/consultar?chaveAcesso={50chars}&ambiente={prod|hom}` que
consulta o status da NFS-e diretamente no portal nacional.

**Acceptance criteria:**
- [ ] `chaveAcesso` ausente → HTTP 400
- [ ] Retorna `{ status, numero, pdf_url, xml_url }` normalizados
- [ ] mTLS também usado nesta rota

**Verificação:** Após emissão bem-sucedida, consultar a chave retornada

**Dependências:** Task 6

**Arquivos tocados:** `nfse-nacional.cjs`

**Tamanho:** S

---

### Task 10: Handler POST /nfse/cancelar
**Descrição:** Handler que envia evento de cancelamento para o portal nacional. Requer
`chaveAcesso` e `justificativa` (mínimo 15 caracteres conforme spec).

**Acceptance criteria:**
- [ ] `chaveAcesso` ausente → HTTP 400
- [ ] `justificativa` menor que 15 chars → HTTP 400
- [ ] Sucesso retorna `{ ok: true, status: "cancelado" }`
- [ ] NFS-e não encontrada retorna erro legível

**Dependências:** Task 6

**Arquivos tocados:** `nfse-nacional.cjs`

**Tamanho:** S

---

## Checkpoint: Fase 2
- [ ] `nfse-nacional.cjs` existe e carrega sem erro (`node -e "require('./nfse-nacional.cjs')"`)
- [ ] Assinatura XMLDSig verificável com `xml-crypto`
- [ ] Nenhum arquivo existente foi modificado
- [ ] Revisão humana do módulo antes de prosseguir

---

## Fase 3: Integração em emissor-server.cjs (mudança cirúrgica)

### Task 11: Adicionar 3 rotas em emissor-server.cjs
**Descrição:** Adicionar `require('./nfse-nacional.cjs')` e 3 blocos de roteamento ao
`emissor-server.cjs`. As rotas Focus NFSe (`/focus/nfse/*`) **não são removidas nem alteradas**.

Mudança no roteador (após as rotas Focus existentes):
```js
const nfseNacional = require('./nfse-nacional.cjs');

// POST /nfse/emitir
if (req.method === 'POST' && pathname === '/nfse/emitir')
  return nfseNacional.handleEmitir(req, res);

// GET /nfse/consultar
if (req.method === 'GET' && pathname === '/nfse/consultar')
  return nfseNacional.handleConsultar(req, res, parsed);

// POST /nfse/cancelar
if (req.method === 'POST' && pathname === '/nfse/cancelar')
  return nfseNacional.handleCancelar(req, res);
```

**Acceptance criteria:**
- [ ] Servidor reinicia sem erro após a mudança
- [ ] `GET /ping` ainda responde (NF-e intacta)
- [ ] `POST /focus/nfe/emitir` ainda funciona (NF-e intacta)
- [ ] `GET /nfse/consultar?chaveAcesso=invalida` retorna 400 JSON (nova rota funcionando)
- [ ] Nenhuma rota existente retorna 404 que antes retornava 200

**Verificação:**
```bash
curl http://localhost:3003/focus/ping           # { ok: true }
curl http://localhost:3003/nfse/consultar       # { ok:false, erro:"chaveAcesso obrigatória" }
```

**Dependências:** Task 10

**Arquivos tocados:** `emissor-server.cjs`

**Tamanho:** S (3 blocos if + 1 require)

---

## Checkpoint: Fase 3
- [ ] `nssm restart EmissorNotas` reinicia sem erro
- [ ] NF-e: emitir uma nota de teste para confirmar regressão zero
- [ ] Rota `/nfse/consultar` responde 400 com erro JSON (sem crash)

---

## Fase 4: Frontend (index.html)

### Task 12: Remover bloqueio do modal de aviso
**Descrição:** Atualmente, `navegarPara('nfse')` chama `abrirAvisoNfse()` que mostra o modal de
aviso e redireciona para o portal. Remover essa chamada automática — o modal de aviso ainda
existe como fallback mas não é exibido automaticamente.

**Acceptance criteria:**
- [ ] Navegar para NFS-e abre a seção normalmente sem modal de aviso
- [ ] Modal de aviso ainda existe no HTML (não excluído) caso seja útil manualmente
- [ ] Botão "Emitir NFS-e" ainda funciona

**Arquivos tocados:** `index.html` (1 linha)

**Tamanho:** XS

---

### Task 13: Atualizar emitirNfse() — nova rota + nova chave
**Descrição:** Mudar `fetch('/focus/nfse/emitir', ...)` para `fetch('/nfse/emitir', ...)`.
Remover a dependência de `token` Focus NFe (a nova rota não precisa). Salvar `chaveAcesso` no
registro da nota em vez de `ref`.

Mudanças:
- `fetch('/nfse/emitir', ...)` sem `token` no body
- Registro na lista: `chaveAcesso: data.chaveAcesso` (em vez de `ref: data.ref`)
- Polling dispara com `data.chaveAcesso` em vez de `data.ref`

**Acceptance criteria:**
- [ ] Emissão sem token Focus configurado funciona normalmente
- [ ] Nota salva com `chaveAcesso` (50 chars)
- [ ] Status inicial salvo como `'aguardando'`

**Arquivos tocados:** `index.html`

**Tamanho:** S

---

### Task 14: Atualizar nfsePollarPendentes() — nova rota
**Descrição:** Mudar polling para usar `/nfse/consultar?chaveAcesso={...}` em vez de
`/focus/nfse/consultar?ref={...}`. Adaptar leitura dos campos da resposta
(`chaveAcesso`, `numero`, `pdf_url`, `xml_url`).

**Acceptance criteria:**
- [ ] Notas com `status='aguardando'` são consultadas pela nova rota
- [ ] `status: 'autorizado'` atualiza a nota com `numero`, `pdf_url`, `xml_url`
- [ ] Notas antigas com `ref` (Focus) não são afetadas pelo polling novo

**Arquivos tocados:** `index.html`

**Tamanho:** S

---

## Checkpoint: Fase 4
- [ ] Clicar "Emitir NFS-e" abre o modal sem aviso automático
- [ ] Preencher o formulário e submeter não exibe erro de token Focus
- [ ] Requisição para `/nfse/emitir` aparece no Network tab do DevTools

---

## Fase 5: Homologação e Ajustes

### Task 15: Teste completo em homologação
**Descrição:** Emitir uma NFS-e real em ambiente de homologação (`adn.producaorestrita.nfse.gov.br`)
e verificar o ciclo completo: emissão → polling → autorização → PDF disponível.

**Acceptance criteria:**
- [ ] Emissão retorna HTTP 200 com `chaveAcesso` de 50 chars
- [ ] Polling retorna `status: 'autorizado'` em até 2 minutos
- [ ] `pdf_url` aponta para PDF acessível
- [ ] Nota aparece na lista da UI com status verde

**Verificação:** Screenshot da lista de NFS-e com pelo menos 1 nota autorizada

**Dependências:** Tasks 11, 14

**Tamanho:** N/A (teste)

---

### Task 16: Ajustes pós-teste (reserva)
**Descrição:** Tarefa reservada para corrigir discrepâncias encontradas no teste de homologação
(campos XML incorretos, formato de resposta diferente do esperado, etc.).

**Tamanho:** Variável

---

## Checkpoint Final
- [ ] Nota emitida com sucesso em homologação e visível na UI
- [ ] NF-e: emissão de uma nota de teste confirma regressão zero
- [ ] Token Focus NFe não é mais exigido para emitir NFS-e
- [ ] Aprovação humana antes de testar em produção

---

## Riscos e Mitigações

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Schema DPS diferente do esperado | Alto | Baixar XSD oficial antes de implementar (Task 2) |
| Endpoint homologação exige cert ICP-Brasil real | Alto | Verificar se aceita cert auto-assinado; se não, testar direto em produção com nota baixo valor |
| Formato do payload (JSON vs XML) diferente | Médio | Inspecionar requisição do TabNews + Swagger antes de implementar Task 6 |
| mTLS: Node.js rejeitando cert gov.br auto-assinado | Médio | Usar `rejectUnauthorized: false` em homologação |
| Numeração DPS conflitante após reteste | Baixo | Resetar `nfse-nacional-seq.json` em homologação |
| Regressão em NF-e | Zero esperado | Rotas novas adicionadas sem tocar nas existentes |

---

## Questões Abertas (requerem resposta antes de Task 6)

1. **Formato do payload:** O endpoint `POST /nfse` aceita JSON com campo `dps` em Base64+GZIP,
   ou recebe o XML comprimido diretamente no body com `Content-Type: application/gzip`?
   → Verificar com Swagger ou implementação TabNews antes de codar Task 6.

2. **Homologação com cert real:** O ambiente `producaorestrita.nfse.gov.br` exige certificado
   ICP-Brasil válido ou aceita qualquer cert?
   → Se exigir cert real, pular direto para produção com valor mínimo (R$0,01).

3. **URL exata do endpoint:** É `/contribuintes/v1/dps` ou `/v1/nfse` ou outro path?
   → Confirmar via Swagger antes de Task 6.
