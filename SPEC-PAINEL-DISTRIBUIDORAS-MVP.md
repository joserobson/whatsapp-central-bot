# SPEC-PAINEL-001 — Painel de distribuidoras

**Versão:** 1.2 — 19/10/2026

**Status:** implementado e testado localmente; validação visual e homologação na VPS pendentes.

**Método:** TDD, com ciclos Red → Green → Refactor por comportamento.

## 1. Objetivo e decisões

Permitir que um administrador edite as mensagens e os contatos dos representantes de cada distribuidora pelo navegador, sem editar JSON manualmente e sem reiniciar o bot.

- Um único serviço `whatsapp-central-bot`, processo Node.js, servidor Fastify e container. Manter uma réplica.
- Interface HTML/CSS/JavaScript servida pelo próprio Fastify, na porta existente. Sem aplicação frontend separada, servidor adicional, Redis ou novo banco.
- Reutilizar a Evolution, as instâncias e as credenciais existentes para envio.
- Usar o volume persistente `bot-state` existente para configuração editável e SQLite.
- Esta especificação estende a spec original: substitui, para este MVP, a exclusão do painel do escopo e a regra de configuração ativa exclusivamente somente leitura. As demais regras do bot continuam válidas.

## 2. Escopo funcional

### RF-01 — Acesso administrativo

Disponibilizar `/admin/` com login de um administrador compartilhado. Todas as distribuidoras configuradas ficam disponíveis para esse administrador, inclusive as desativadas, identificadas como tal.

Não haverá cadastro público, recuperação de senha, múltiplos perfis ou isolamento de usuários por distribuidora neste MVP.

### RF-02 — Seleção e edição

Listar distribuidoras por `displayName` e permitir editar somente:

| Campo | Regra |
| --- | --- |
| `welcomeText` | Obrigatório; até 1.000 caracteres. |
| `closingText` | Opcional; até 500 caracteres. Vazio omite o encerramento, como na referência. |
| `prefilledText` | Obrigatório; até 500 caracteres; usado nos links dos representantes. |
| `agents` | Exatamente três representantes no editor. |
| `agents[].label` | Obrigatório; até 80 caracteres; identificação interna, não exibida na resposta. |
| `agents[].phoneE164` | Número internacional válido, somente dígitos, incluindo DDI e DDD. |

Reutilizar `validateConfig` como fonte das regras, incluindo a exceção explícita `allowDuplicateAgentPhones`. Ajustar o validador para aceitar `closingText` vazio; manter compatibilidade com configurações anteriores. Não permitir alterar essa exceção pelo painel.

Preservar `instance`, `displayName`, `enabled`, cooldown, contatos ignorados e demais propriedades. Não criar, remover ou ativar distribuidoras pelo painel. Uma distribuidora legada desativada com quantidade diferente de três representantes pode ser listada; para salvar no editor, deverá conter exatamente três.

### RF-03 — Prévia e experiência

- Exibir prévia dos textos e links usando a mesma montagem de resposta do bot (`buildReply`), sem enviar mensagens reais.
- Apresentar a prévia em um balão claro sobre fundo neutro, inspirado na imagem enviada, com quebras de linha preservadas. Não reproduzir moldura de celular, barra de status, logotipo ou controles do WhatsApp.
- Mostrar validações por campo, estado de salvamento, confirmação e falhas sem descartar o formulário.
- Avisar antes de trocar de distribuidora ou sair da página com alterações pendentes.
- Em conflito, pedir recarga e preservar o rascunho para comparação; nunca sobrescrever silenciosamente.
- Usar rótulos acessíveis, navegação por teclado e layout utilizável em celular e desktop.

### RF-05 — Template da resposta conforme referência

A imagem enviada pelo usuário define a composição da mensagem: um parágrafo de saudação e orientação, uma linha em branco e três contatos precedidos de `☎️`, um por linha. Não incluir nomes dos representantes, bolinhas verdes, setas, negrito automático na saudação ou itálico automático no encerramento.

Texto sugerido, editável por distribuidora:

> Olá, que bom tê-lo conosco, clique em algum número abaixo e inicie uma conversa com um de nossos atendentes físicos.

No transporte atual de texto simples, manter links explícitos `wa.me` com a mensagem pré-preenchida codificada. Não prometer um número com hiperlink de título personalizado: a aparência azul e o reconhecimento de números são controlados pelo aplicativo WhatsApp. A prévia deve mostrar o conteúdo efetivamente enviado, sem esconder URLs atrás de números.

Formato de saída, com placeholders explicativos que não são números válidos:

```text
{welcomeText}

☎️ https://wa.me/{phoneE164_1}?text={prefilledText_codificado}
☎️ https://wa.me/{phoneE164_2}?text={prefilledText_codificado}
☎️ https://wa.me/{phoneE164_3}?text={prefilledText_codificado}
```

Se `closingText` estiver preenchido, acrescentar uma linha em branco e seu texto ao final. Se vazio, a resposta termina no terceiro contato, seguindo a referência. Não copiar os telefones ou a identidade visual da imagem para exemplos públicos nem substituir contatos reais automaticamente.

A alteração do template não autoriza remover o cooldown: a política de reenvio continua pendente de decisão separada.

### RF-04 — Efeito da gravação

Salvar apenas a distribuidora selecionada e aplicar a configuração sem restart. O sucesso somente será informado após persistência e ativação da nova versão.

O próximo processamento pelo worker usa a configuração ativa. Uma chamada de envio já iniciada pode concluir com o texto anterior. Salvar não dispara mensagem, não apaga fila, não reinicia cooldown e não altera deduplicação.

## 3. Arquitetura e persistência

Responsabilidades propostas, sujeitas a ajustes pequenos durante o TDD:

- `src/admin/`: autenticação, rotas administrativas e arquivos estáticos.
- `src/config.js`: validação, versão, leitura e gravação coordenadas.
- `src/app.js`: registrar o painel e a API junto às rotas existentes.
- `src/server.js`: inicialização, parâmetros e bootstrap da configuração.
- `test/`: testes de comportamento com `node:test`, arquivos temporários e `app.inject`.

### Configuração ativa e bootstrap

- Manter `CONFIG_PATH=/app/config/distribuidoras.json` como arquivo inicial, montado somente para leitura.
- Introduzir `CONFIG_WRITABLE_PATH=/app/data/distribuidoras.json` como fonte ativa no volume `bot-state`.
- Na primeira execução, se o arquivo editável não existir, validar e copiar o arquivo inicial por publicação atômica. Preservar todos os valores existentes.
- Se o arquivo editável existir, ele prevalece e não será substituído pelo seed, inclusive em deploys posteriores.
- Arquivo editável inválido no boot: manter o serviço sem prontidão e impedir gravações até reparo operacional. Não retornar silenciosamente ao seed antigo.
- Arquivo inválido durante reload: preservar a última versão válida em memória; bloquear gravações sobre conteúdo inválido até reparo.
- O deploy pode continuar atualizando o seed, mas deve documentar que isso não substitui a configuração ativa já inicializada.
- Incluir arquivos do painel no mesmo Dockerfile. Garantir escrita em `/app/data` pelo usuário `node`.

### Escrita e concorrência

Serializar leituras de reload e gravações administrativas no processo. Cada salvamento exige a versão global lida pelo cliente e compara essa versão com a configuração persistida atual, sob a mesma coordenação.

Validar o documento completo candidato, gravar temporário no mesmo diretório, sincronizar e renomear atomicamente antes de publicar a versão em memória. Se a persistência falhar, não informar sucesso nem alterar a configuração ativa; limpar temporários quando possível. No reinício, carregar o último arquivo publicado completo.

Duas gravações baseadas na mesma versão: somente uma pode vencer; a outra recebe conflito, inclusive quando editam distribuidoras diferentes. Reload não pode reativar uma versão antiga após um salvamento.

Edição manual do arquivo ativo exige janela operacional sem gravações pelo painel e publicação atômica. Concorrência com escritores externos não faz parte da garantia deste MVP.

## 4. Contrato HTTP proposto

API administrativa em `/admin/api`, respostas JSON, sem cache e com autenticação em todas as operações de dados.

| Método e rota | Comportamento |
| --- | --- |
| `POST /admin/api/login` | Valida usuário/senha; cria sessão e retorna token CSRF. |
| `GET /admin/api/session` | Retorna estado autenticado e token CSRF para recarga da página. |
| `POST /admin/api/logout` | Invalida sessão e remove cookie; exige CSRF. |
| `GET /admin/api/companies` | Retorna identificadores, nomes e estado de ativação. |
| `GET /admin/api/companies/:instance` | Retorna campos editáveis e versão global via `ETag`. |
| `POST /admin/api/companies/:instance/preview` | Valida o rascunho e retorna texto gerado; exige CSRF; não persiste nem envia. |
| `PUT /admin/api/companies/:instance` | Exige `If-Match` com o `ETag` lido e CSRF; salva campos permitidos e retorna nova versão. |

PUT substitui o conjunto completo de campos editáveis da distribuidora; propriedades extras são rejeitadas. O servidor preserva os demais campos a partir do documento ativo, sem aceitar JSON completo do navegador.

Erros: `400` para JSON ou estrutura inválida; `401` sem sessão válida; `403` para CSRF/origem inválida; `404` para instância inexistente; `412` para versão divergente; `422` para valores inválidos; `428` para ausência de `If-Match`; `429` por excesso de tentativas de login; `503` para configuração indisponível ou falha de persistência. Erros não expõem caminhos, segredos ou conteúdo completo da configuração.

## 5. Autenticação e publicação

- Novos parâmetros: `ADMIN_ENABLED` (padrão `false`), `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH_B64` (transporte preferencial do hash; também aceita `ADMIN_PASSWORD_HASH`), `ADMIN_ORIGIN`, `ADMIN_ALLOW_HTTP` e `CONFIG_WRITABLE_PATH`.
- Documentar formato versionado de hash com salt e `scrypt` do Node; fornecer comando para gerar o hash sem colocar senha no histórico do shell. Não persistir senha em texto puro.
- Painel habilitado exige credenciais válidas no boot. Desabilitado retorna `404` em suas rotas e preserva o funcionamento atual do bot.
- Sessões opacas e aleatórias em memória, duração absoluta de oito horas, invalidadas no logout e no reinício. Não usar `localStorage` para credenciais ou sessão.
- Cookie `HttpOnly`, `SameSite=Strict`, restrito a `/admin`; `Secure` obrigatório em produção HTTPS. HTTP somente no desenvolvimento local.
- Exigir token CSRF e validar origem nas operações administrativas mutáveis, incluindo a prévia; login aceita somente JSON e origem compatível.
- Limitar login a cinco falhas por IP em 15 minutos, com resposta genérica. Confiar em cabeçalhos de proxy somente de proxies explicitamente configurados.
- Renderizar textos como conteúdo, nunca como HTML; aplicar política de conteúdo restritiva e não registrar senhas, cookies, tokens, textos ou telefones nos logs.
- Publicar somente `/admin/` no proxy HTTPS já disponível na infraestrutura. Manter `/metrics`, `/health/*` e webhook privados; Evolution continua usando a URL interna atual.
- Produção exige proxy HTTPS existente; o modo HTTP explícito é restrito a origem loopback fora de produção. Não publicar uma porta HTTP administrativa na internet nem criar container adicional. Sem proxy utilizável, a ativação em produção fica pendente dessa configuração.
- No Actions, hash e usuário administrativo são configuração privada; evitar interpolação de `$` do hash pelo Compose, usando transporte que preserve seu valor literal.

## 6. Critérios de aceite e testes

| ID | Comportamento verificável |
| --- | --- |
| CA-01 | Painel e webhook executam na mesma imagem, serviço, processo e porta, sem container adicional. |
| CA-02 | Sem login, dados não são acessíveis; login inválido é genérico e limitado; sessão expira e logout a invalida. |
| CA-03 | Ausência de CSRF, origem inválida e campos extras impedem gravação sem alterar arquivo ou memória. |
| CA-04 | Editar Alfa modifica somente seus textos/representantes; Beta, Gama e campos operacionais permanecem iguais. |
| CA-05 | Textos vazios/longos, telefone inválido e quantidade diferente de três representantes são rejeitados; duplicados respeitam a exceção existente. |
| CA-06 | Prévia coincide com `buildReply`, codifica links e exibe conteúdo hostil como texto; não chama Evolution. |
| CA-07 | Salvar retorna nova versão; próximo envio elegível usa a alteração sem reiniciar e preserva cooldown/deduplicação. |
| CA-08 | Reinício e recriação do container com o mesmo volume preservam as edições; atualizar seed não as sobrescreve. |
| CA-09 | Conflito de versão retorna `412`; duas gravações simultâneas com mesma versão produzem um sucesso e um conflito. |
| CA-10 | Falhas de escrita, sincronização ou rename preservam a versão anterior; reload concorrente não retrocede a configuração. |
| CA-11 | Seed inválido não inicializa configuração; arquivo ativo inválido não é substituído automaticamente; readiness e bloqueio de escrita seguem a seção 3. |
| CA-12 | Suite atual continua passando: webhook autenticado, isolamento, cooldown, deduplicação, reload e entrega ambígua. |
| CA-13 | Interface funciona em celular e desktop, preserva rascunho em falhas/conflitos e avisa sobre alterações pendentes. |
| CA-14 | Painel desabilitado não publica rotas administrativas; proxy publica somente `/admin/` e mantém diagnósticos privados. |
| CA-15 | Resposta contém saudação sem decoração automática e três linhas `☎️` com links na ordem configurada, sem labels; encerramento vazio é aceito e omitido, preenchido aparece ao final. |
| CA-16 | Prévia segue o balão da referência e exibe as URLs reais; caracteres especiais da mensagem pré-preenchida são codificados; nenhuma imagem ou dado real da referência é necessário em produção. |

## 7. Plano de TDD

Para cada incremento: escrever teste comportamental, executar e observar falha pelo motivo esperado (Red); implementar o mínimo para passar (Green); refatorar e executar a suite completa (Refactor). Não criar toda a implementação antes dos testes.

1. **Persistência:** bootstrap, prevalência do arquivo ativo, validação, publicação atômica, falhas e reinício (CA-08, CA-10, CA-11).
2. **Concorrência:** versão obrigatória, conflito simultâneo e coordenação com reload (CA-09, CA-10).
3. **Autenticação:** habilitação, login, limitação, cookie, expiração, logout, origem e CSRF (CA-02, CA-03, CA-14).
4. **Template e API:** primeiro testar ordem dos contatos, ausência de labels/decorações, encerramento opcional e codificação dos links; depois implementar montagem compartilhada, campos permitidos, isolamento e validações (CA-04 a CA-06, CA-15, CA-16).
5. **Integração com worker:** resposta atualizada e estado operacional preservado (CA-07, CA-12).
6. **Interface:** testar comportamentos de formulário e conteúdo hostil antes de conectar a UI; conferir visualmente os fluxos em celular/desktop (CA-06, CA-13).
7. **Empacotamento e operação:** conferir assets na imagem, Compose, bootstrap com volume existente e sobrevivência à recriação (CA-01, CA-08, CA-14).

Usar `node:test`, `node:assert/strict`, `app.inject`, diretórios temporários, relógio injetável e falhas de filesystem simuladas. Não contactar a Evolution nos testes automatizados. Executar `npm test` em cada incremento e antes de entregar.

Registrar evidência Red/Green por incremento na implementação. Verificação de imagem, proxy e navegador complementa os testes; testes locais não comprovam deploy ou envio real no WhatsApp.

## 8. Migração, riscos e reversão

- Antes de habilitar o painel, fazer backup privado do JSON original e do volume existente. Não versionar dados reais.
- Primeiro boot importa o JSON atual sem trocar instâncias, contatos ou mensagens. Homologar com dados fictícios antes da carga real.
- Um rollback de código que volte a ler apenas o seed pode usar dados antigos: exportar a configuração ativa validada para o caminho esperado pela versão anterior antes da reversão.
- Backup/restauração deve incluir `/app/data/distribuidoras.json` e SQLite. Remover o volume elimina ambos; recriar container preservando o volume não os elimina.
- Disco cheio e permissões inadequadas devem produzir erro visível, sem confirmação falsa. Concorrência depende da restrição de uma réplica.
- Login compartilhado não oferece atribuição individual; logs registram somente operação, instância, resultado e versão, sem dados de contato.

## 9. Fora do escopo e aprovação

Ficam fora: novo container, SPA independente, multiusuário, cadastro de distribuidoras, alteração de instâncias/credenciais pelo painel, quantidade variável de representantes, envio de teste, campanhas, histórico navegável de versões e migração para outro provedor.

Implementação autorizada pelo usuário após a versão 1.1. README, ambiente de exemplo, Dockerfile, Compose e workflow foram atualizados junto ao código. A política de cooldown não foi removida.

## 10. Evidências de implementação

- **Persistência e template — Red:** três testes falharam: ausência de bootstrap, ausência de `update` e saída da mensagem no formato anterior. **Green:** os três testes passaram com armazenamento coordenado e template atualizado; suite total de sete testes nesse incremento.
- **API administrativa — Red:** teste falhou pela ausência do módulo administrativo. Após criação, o teste exercitou os endpoints e detectou a exigência de JSON também no logout; a chamada de teste foi corrigida para respeitar o contrato. **Green:** autenticação, sessão, CSRF, prévia, edição, conflito, expiração e logout passaram.
- **Formulário — Red:** teste falhou pela ausência do modelo do formulário. **Green:** validações por campo, detecção de alterações e mensagens de conflito passaram; suite total de dez testes nesse incremento.
- **Regressões adicionais:** quinze testes passaram na suite completa, incluindo integração da edição com worker e falhas de abertura, escrita, sincronização e rename, além de reload concorrente e rejeição de campos extras/origens inválidas.
- **Empacotamento:** imagem construída com sucesso; ambos os Composes passaram em `config --quiet` (VPS com nome de rede fictício apenas para validação estrutural). Nenhum container adicional foi iniciado e nenhum deploy executado.
- **Pendente:** navegador indisponível nesta sessão; aparência em desktop/celular, diálogos de alterações pendentes, fluxo completo no navegador, proxy HTTPS, recriação real com volume e WhatsApp real exigem homologação. Testes HTTP/filesystem não substituem essas verificações.
