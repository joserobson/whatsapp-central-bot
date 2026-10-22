# WhatsApp Central | DigiArk

Serviço Node.js que recebe eventos `MESSAGES_UPSERT` da Evolution API e responde à primeira mensagem direta de cada contato com três links de atendimento. O estado de deduplicação e cooldown fica em SQLite persistente. A [especificação](SPEC-DIGIARK-WHATSAPP-DISTRIBUIDORAS.md) detalha as regras.

O painel administrativo do MVP está descrito na [SPEC-PAINEL-001](SPEC-PAINEL-DISTRIBUIDORAS-MVP.md). Ele roda no mesmo processo Fastify, porta e container do bot, com HTML/CSS/JavaScript local e sem novos serviços ou dependências.

## Arquivos e testes

- `src/`: webhook Fastify, validação, SQLite e worker de envio.
- `config/distribuidoras.example.json`: modelo publicável, com todas as empresas desativadas.
- `config/distribuidoras.json`: configuração inicial privada, ignorada pelo Git e montada somente para leitura.
- `/app/data/distribuidoras.json`: configuração ativa editável no volume `bot-state`; criada a partir do arquivo inicial somente quando ainda não existe.
- `compose.yaml`: desenvolvimento local, com acesso em `127.0.0.1:3010`.
- `compose.vps.yaml`: uma réplica na rede Docker privada da Evolution, sem porta publicada.

Use Node.js 22 ou superior. Para validar: `npm ci` e `npm test`. Não há etapa de compilação.

## Publicação no GitHub

O remoto `origin` já aponta para `https://github.com/joserobson/whatsapp-central-bot.git`. Antes da primeira publicação, confirme que o repositório remoto existe e que sua conta tem permissão de escrita. Revise `git status --short --ignored`, `git diff --cached --name-only` e `git diff --cached --check`; faça o primeiro commit e envie a branch `master` com `git push -u origin master`. Se quiser usar outra branch principal, ajuste também o comando de clone e atualização na VPS. `.env`, `.local/`, `data/` e `config/distribuidoras.json` estão ignorados; publique apenas os exemplos. Não force a inclusão de arquivos ignorados.

## Deploy pelo GitHub Actions

O workflow `.github/workflows/deploy-vps.yml` é iniciado manualmente em **Actions > Deploy VPS > Run workflow** depois da publicação da branch `master`. Ele executa os testes, gera os arquivos privados a partir de GitHub Secrets e Variables, transfere esses arquivos por SSH e executa o Compose na VPS. O usuário SSH precisa ter acesso ao Docker e permissão de escrita no diretório escolhido. O checkout da VPS precisa conseguir ler este repositório.

Configure estes **Secrets** do repositório:

| Nome | Conteúdo |
| --- | --- |
| `EVOLUTION_API_KEY` | Chave da Evolution instalada na VPS. |
| `WEBHOOK_SHARED_SECRET` | Segredo enviado no cabeçalho `x-webhook-secret`. |
| `DISTRIBUIDORAS_JSON` | JSON completo e válido de `config/distribuidoras.json`. |
| `VPS_HOST` | Host público da VPS para SSH. |
| `VPS_USER` | Usuário SSH com acesso ao Docker. |
| `VPS_SSH_KEY` | Chave privada SSH dedicada ao deploy. |
| `VPS_SSH_KNOWN_HOSTS` | Linha de `known_hosts` com a chave pública do servidor SSH, conferida por um canal confiável. |

Configure estas **Variables** do repositório:

| Nome | Conteúdo |
| --- | --- |
| `VPS_DEPLOY_PATH` | Diretório absoluto na VPS, por exemplo `/opt/digiark/whatsapp-central-bot`. |
| `EVOLUTION_DOCKER_NETWORK` | Nome real da rede Docker usada pela Evolution. |
| `EVOLUTION_BASE_URL` | Endereço interno da Evolution acessível ao bot, por exemplo `http://evolution-api:8080`. |
| `CONFIG_POLL_MS`, `WORKER_POLL_MS`, `RETENTION_DAYS` | Ajustes operacionais opcionais; o serviço usa seus padrões se ficarem vazios. |

Não coloque chaves, segredo do webhook ou telefones das distribuidoras em Variables. O workflow não configura o webhook na Evolution: faça essa etapa depois que o bot estiver pronto e alcançável pela rede Docker.

## Configuração na VPS

1. Na VPS, identifique o **nome da rede Docker compartilhada com a Evolution** e o nome ou alias DNS do container da Evolution. Consulte `docker network ls` e `docker inspect <container-evolution> --format '{{json .NetworkSettings.Networks}}'`. Confirme também a porta interna da API. O exemplo abaixo usa `evolution-api:8080`; ajuste à instalação real. O container da Evolution precisa estar conectado a essa rede.
2. Clone `https://github.com/joserobson/whatsapp-central-bot.git` em um diretório persistente, por exemplo `/opt/digiark/whatsapp-central-bot`, e entre nele. Se o repositório for privado, use uma credencial de leitura própria da VPS. Copie `.env.example` para `.env` e defina `EVOLUTION_DOCKER_NETWORK`, `EVOLUTION_BASE_URL`, a chave da **Evolution dessa VPS** em `EVOLUTION_API_KEY` e um segredo aleatório de pelo menos 16 caracteres em `WEBHOOK_SHARED_SECRET` (por exemplo, gerado com `openssl rand -hex 32`). Deixe `.env` acessível apenas ao administrador do serviço (`chmod 600 .env`). Não publique esses valores no GitHub.
3. Copie `config/distribuidoras.example.json` para `config/distribuidoras.json`. Preencha o nome exato de cada instância, textos e três números E.164 válidos por empresa, somente dígitos em `phoneE164`. Ative cada empresa com `enabled: true` somente após conferir seus dados. Telefones duplicados exigem `allowDuplicateAgentPhones: true` explicitamente.
4. Execute `docker compose -f compose.vps.yaml config --quiet` para conferir a interpolação sem exibir os segredos e `docker compose -f compose.vps.yaml up -d --build`. Veja `docker compose -f compose.vps.yaml ps` e `docker compose -f compose.vps.yaml logs --tail=100 whatsapp-central-bot`. O volume `bot-state` preserva o SQLite entre recriações; mantenha **uma única réplica**.
5. A partir de um container na mesma rede, consulte `http://whatsapp-central-bot:3000/health/ready`. A resposta 200 confirma JSON válido e SQLite disponível. Ela não comprova entrega real de mensagens. Se usar um container temporário para a consulta, conecte-o à rede `EVOLUTION_DOCKER_NETWORK`.

## Webhook da Evolution

Para cada instância habilitada, configure `POST /webhook/set/{instance}` na Evolution com `MESSAGES_UPSERT`, `byEvents: false`, `base64: false`, URL `http://whatsapp-central-bot:3000/webhooks/evolution` e cabeçalho `x-webhook-secret` igual a `WEBHOOK_SHARED_SECRET`. Exemplo do corpo usado pela API v2:

```json
{
  "webhook": {
    "enabled": true,
    "url": "http://whatsapp-central-bot:3000/webhooks/evolution",
    "byEvents": false,
    "base64": false,
    "headers": { "x-webhook-secret": "<valor-de-WEBHOOK_SHARED_SECRET>" },
    "events": ["MESSAGES_UPSERT"]
  }
}
```

Confirme o formato aceito pela versão instalada e consulte `GET /webhook/find/{instance}` após gravar, inclusive depois de reiniciar a Evolution. Um POST ao bot sem o segredo retorna 401. Teste com uma mensagem enviada por **outro** WhatsApp: a primeira deve gerar `reply_sent` nos logs; uma repetição durante o cooldown deve gerar `cooldown_active`. Confira também a conexão da instância e a resposta recebida no aparelho. A Evolution entrega o webhook pela rede interna e o bot chama a API pela `EVOLUTION_BASE_URL`.

## Nginx Proxy Manager

O Nginx Proxy Manager pode continuar publicando a Evolution, mas **não precisa publicar o bot** nem criar um novo Proxy Host para ele. Ambos se comunicam pela rede Docker compartilhada, sem porta do bot publicada no host. O bot também expõe `/health/live`, `/health/ready` e `/metrics` sem autenticação; mantenha esses caminhos privados. Se a Evolution estiver em modo `host` ou fora de uma rede Docker compartilhável, adapte a topologia antes de configurar o webhook, usando um endereço interno alcançável com autenticação e sem expor as rotas de diagnóstico.

## Operação

Com `CONFIG_WRITABLE_PATH` configurado (padrão dos Composes), o bot verifica o arquivo ativo `/app/data/distribuidoras.json` periodicamente. Mudanças no seed `config/distribuidoras.json` e no Secret `DISTRIBUIDORAS_JSON` não substituem edições já inicializadas. Sem `CONFIG_WRITABLE_PATH`, permanece a leitura legada de `CONFIG_PATH`, com painel desabilitado.

Um JSON ativo inválido durante a execução preserva a última configuração válida e bloqueia gravações pelo painel até reparo. No boot, um arquivo ativo inválido deixa o serviço sem prontidão; ele não é substituído pelo seed. Edições manuais exigem pausa de gravações administrativas e publicação por arquivo temporário/rename. Não editar simultaneamente pelo painel e por ferramentas externas.

Ao atualizar o código, execute `git pull` e `docker compose -f compose.vps.yaml up -d --build`; faça backup privado do JSON e SQLite do volume antes de mudanças operacionais. Nunca remova o volume para atualizar o serviço. Para rollback a uma versão legada, exporte primeiro o JSON ativo validado para o caminho usado por essa versão, evitando retornar aos contatos antigos do seed. Falhas de envio ambíguas não são repetidas automaticamente: reconcilie na Evolution antes de alterar o estado manualmente.

## Painel administrativo

1. Gere uma senha com `npm run admin:password` no terminal. A entrada fica oculta e exige confirmação. Guarde a linha `ADMIN_PASSWORD_HASH_B64` como segredo; base64 é transporte do hash, não criptografia adicional. O formato interno é `scrypt-v1$salt_hex$hash_hex`, com salt aleatório de 16 bytes e chave de 64 bytes. A aplicação também aceita `ADMIN_PASSWORD_HASH` diretamente, mas prefira a variante base64 para não interpolar `$` no Compose.
2. Configure `ADMIN_ENABLED=true`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH_B64` e `ADMIN_ORIGIN=https://central.example.com` no `.env` privado. `ADMIN_ORIGIN` deve ser a origem exata, sem caminho ou barra final. No Actions, use Variables `ADMIN_ENABLED`, `ADMIN_ORIGIN` e Secrets `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH_B64`. Nenhuma senha vem configurada por padrão.
3. No proxy HTTPS existente, encaminhe **somente `/admin/`** para `http://whatsapp-central-bot:3000/admin/`, preservando o prefixo. O proxy precisa alcançar a rede Docker existente. Não encaminhe a raiz, `/metrics`, `/health/*` ou webhook para acesso público. Não é necessário publicar porta do bot na VPS nem criar container adicional.
4. Acesse `/admin/`, entre, escolha a distribuidora, edite, atualize a prévia e salve. Uma gravação concorrente retorna conflito; “Recarregar versão salva” permite comparar sem perder o rascunho. Sessões expiram após oito horas, logout ou reinício. Reiniciar requer novo login, mas preserva configuração.

O editor mantém três representantes. No formato texto, nomes são identificação interna; a resposta mostra saudação, três linhas `☎️ https://wa.me/...` e encerramento opcional. A prévia usa o texto efetivamente enviado. O bot não controla a aparência dos links no aplicativo WhatsApp. O intervalo entre respostas pode ser editado por distribuidora, de 1 a 720 horas, mantendo 24 horas como padrão. O novo intervalo considera o horário da última resposta, sem disparar envio.

Em **Liberar nova resposta**, informe o telefone do cliente com DDI e DDD, somente dígitos, e confirme. A ação limpa somente a espera desse contato na distribuidora selecionada; ele receberá resposta ao enviar uma nova mensagem. O histórico e a deduplicação são preservados, mensagens antigas não são reenviadas e contatos ignorados continuam ignorados.

Para desenvolvimento no host, forneça variáveis de ambiente com caminhos locais graváveis (`CONFIG_PATH`, `CONFIG_WRITABLE_PATH`, `SQLITE_PATH`), `ADMIN_ORIGIN=http://127.0.0.1:3000` e `ADMIN_ALLOW_HTTP=true`; rode `npm start`. O comando não carrega `.env` automaticamente; no Node pode usar `node --env-file=.env src/server.js` após ajustar os caminhos. HTTP administrativo é aceito apenas em loopback e fora de `NODE_ENV=production`. O container de produção exige HTTPS pelo proxy; um túnel isolado sem HTTPS não habilita seu cookie administrativo.

O limitador de login usa o IP da conexão, sem confiar em `X-Forwarded-For`. Atrás do proxy, as cinco falhas em 15 minutos são compartilhadas pelos usuários que chegam por esse proxy. Não configurar confiança irrestrita em headers. Credenciais, sessões, conteúdo e telefones não devem aparecer em logs.

### Domínio de teste com nip.io

Para homologação, usar `central.<IP-PUBLICO-DA-VPS>.nip.io`. O nip.io resolve o IP embutido no nome, sem criar zona DNS própria. Exemplo documental: `central.203.0.113.10.nip.io` (substituir pelo IP real; esse IP de exemplo não serve para acesso).

- URL do painel: `https://central.<IP-PUBLICO-DA-VPS>.nip.io/admin/`.
- Variable `ADMIN_ORIGIN`: `https://central.<IP-PUBLICO-DA-VPS>.nip.io`, sem barra final.
- Variable `ADMIN_ENABLED`: `true`; manter usuário e hash nos Secrets administrativos existentes.
- No Nginx Proxy Manager existente, configurar o hostname exato e emitir certificado Let's Encrypt para ele; DNS automático não configura o proxy nem o certificado.
- Encaminhar somente o prefixo `/admin/`, preservando-o, para o container `whatsapp-central-bot` na porta `3000`; retornar `404` nos demais caminhos desse hostname. Não usar encaminhamento irrestrito da raiz para o bot.
- Conferir que o proxy alcança o bot pela rede Docker e que a validação HTTP-01 do certificado alcança o proxy na porta 80. O acesso ao painel usa HTTPS na porta 443. Nenhum serviço ou container adicional é necessário.

Após o deploy e a configuração do proxy, validar login, edição, prévia, persistência após recriação e ausência de acesso público a `/metrics`, `/health/live` e `/webhooks/evolution`. Referência do serviço DNS: [nip.io](https://nip.io/).

A instância da Evolution também pode ser alterada no editor de cada distribuidora. Use o nome exato de uma instância existente (letras, números, hífen e sublinhado), sem reutilizar a instância de outra distribuidora. O painel não cria instâncias na Evolution nem configura seus webhooks. Após salvar, o roteamento passa a usar a nova instância; eventos e intervalos anteriores permanecem vinculados à instância antiga, sem migração ou reenvio automático.

## Formatos de mensagem

No painel, cada distribuidora pode escolher **Texto com links** (padrão) ou
**Botões com links (experimental)**. Configurações antigas continuam enviando texto.
O campo opcional `messageFormat` aceita `text`, `buttons`, `list`, `vcard` ou `image`.

**Imagem com links** envia uma única mensagem por `/message/sendMedia/{instance}`,
com a imagem no topo e a saudação, três links e encerramento na legenda.
Respeita a opção de incluir mensagem pré-preenchida nos links. No campo **URL da
imagem**, informe uma URL HTTPS acessível pela Evolution, sem credenciais.
Deixe vazio para usar o banner de exemplo incluído na aplicação, enviado em
base64; o envio do exemplo não depende de acesso ao site da foto. A prévia usa
o mesmo arquivo local e mostra um aviso se uma imagem personalizada não carregar.

Imagem de exemplo: hortifruti, baixada de [Unsplash](https://images.unsplash.com/photo-1542838132-92c53300491e?w=1000&h=500&fit=crop&q=75),
incluída em `src/admin/public/example-banner.jpg` (1000 x 500, JPEG).
O campo opcional de configuração é `imageUrl`; configurações antigas continuam
válidas. Se o envio ficar incerto, não há repetição automática nem fallback.

### Upload de imagem pelo painel

Em **Imagem com links**, selecione um JPEG ou PNG de até 5 MB e clique em
**Enviar e visualizar**. O servidor decodifica o arquivo, confere o formato real,
recusa corrupção/animação e imagens acima de 40 milhões de pixels, corrige a
orientação, remove metadados, reduz para até 2048 pixels por lado e prepara JPEG
(transparência fica branca). Esse limite de dimensões é uma escolha da aplicação,
não um requisito de tamanho de banner do WhatsApp. Prefira banners horizontais,
por exemplo 1200 × 600. [Formatos de imagem no WhatsApp](https://whatsappbusiness.com/blog/media-messages-via-app/).

O upload só altera o rascunho: clique em **Salvar alterações** para usar a imagem.
O arquivo enviado tem prioridade sobre a URL; **Usar imagem de exemplo** limpa
essa seleção e a URL no rascunho. Para usar URL depois de um upload, limpe a seleção
e preencha a URL. O arquivo anterior não é apagado ao trocar a imagem.

Os JPEGs preparados ficam em `images/` ao lado do JSON gravável (na VPS,
`/app/data/images` no volume existente), com identificadores derivados do conteúdo.
O JSON guarda apenas `imageId`, sem base64. Prévia e upload exigem sessão; gravações
exigem origem e CSRF válidos. O worker lê o arquivo local e envia base64 à Evolution,
sem URL pública; arquivo ausente interrompe o envio, sem trocar pelo exemplo.
O backup do deploy inclui essa pasta. Preserve os arquivos ao restaurar o JSON.

O endpoint de upload usa JSON/base64 e aceita até 7 MB de corpo, isoladamente;
as demais rotas mantêm o limite de 64 KB. No proxy reverso do painel, configure
`client_max_body_size 8m;` para permitir arquivos de 5 MB com a expansão do base64.
Se o proxy recusar, o painel mostra a falha sem alterar a configuração ativa.

**Contatos (vCard)** envia a saudação e o encerramento em texto e depois os três
representantes agrupados via `/message/sendContact/{instance}`, com nome,
telefone e distribuidora. Não usa imagem, URL ou mensagem pré-preenchida.
A aparência do grupo e as ações disponíveis precisam ser conferidas no WhatsApp.
A prévia ilustra as duas mensagens, sem realizar envio.

O progresso desse envio é persistido nas colunas `delivery_plan` e `delivery_step`
do SQLite (adicionadas automaticamente). Se os contatos forem recusados após a
saudação, uma tentativa posterior retoma somente a etapa pendente, inclusive
após reinício, usando os contatos originalmente preparados. O cooldown começa
após a saudação para impedir novos menus durante a tentativa e é atualizado na
conclusão. Falhas incertas em qualquer etapa exigem reconciliação manual e não
provocam reenvio automático. Faça backup privado do volume antes de atualizar.

A opção **Incluir mensagem pré-preenchida no link** controla o parâmetro `?text=`
em todos os formatos, inclusive na resposta após escolher um item da lista.
Desmarcada (`includePrefilledText: false`), gera somente `https://wa.me/numero`.
O texto configurado é preservado e pode ficar vazio enquanto a opção estiver
desativada. Sem esse campo na configuração, o comportamento anterior é mantido.

**Lista de atendentes (experimental)** usa `/message/sendList/{instance}` e
apresenta os três representantes em um menu **Escolher atendente**. Os nomes
devem ter até 24 caracteres. A escolha envia uma resposta ao bot, que retorna
somente o link do representante selecionado; o item da lista não abre uma URL.
A prévia permite abrir o menu e simular a escolha sem enviar mensagens.

A seleção válida é processada mesmo durante o intervalo do menu, respeitando
contatos ignorados e deduplicação. Ela não renova nem apaga o cooldown do menu.
Seleções de representantes alterados ou de uma distribuidora que saiu do formato
lista são descartadas. Uma coluna opcional `selection_id` é adicionada ao SQLite
automaticamente, preservando os eventos existentes. Faça backup do volume antes
do deploy; mantenha uma réplica. A aparência e entrega precisam de teste real
na Evolution, assim como no formato de botões.

Botões usam `/message/sendButtons/{instance}`, com três botões de URL `wa.me`
e a mensagem pré-preenchida. Os nomes dos representantes aparecem nos botões e
devem ter até 20 caracteres. A prévia exibe botões verticais como ilustração;
o suporte e a aparência real dependem da versão/conexão da Evolution e do WhatsApp.
Uma resposta HTTP de sucesso não comprova que os botões apareceram no aparelho.

Para testar: salve o formato, use **Liberar nova resposta** para seu contato e
envie uma nova mensagem ao bot. Confira no aparelho os três botões e seus destinos.
Para comparar, selecione texto, salve e repita a liberação e a nova mensagem.
Não há fallback automático para texto em caso de falha ou entrega incerta.
