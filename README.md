# WhatsApp Central | DigiArk

Serviço Node.js que recebe eventos `MESSAGES_UPSERT` da Evolution API e responde à primeira mensagem direta de cada contato com três links de atendimento. O estado de deduplicação e cooldown fica em SQLite persistente. A [especificação](SPEC-DIGIARK-WHATSAPP-DISTRIBUIDORAS.md) detalha as regras.

## Arquivos e testes

- `src/`: webhook Fastify, validação, SQLite e worker de envio.
- `config/distribuidoras.example.json`: modelo publicável, com todas as empresas desativadas.
- `config/distribuidoras.json`: configuração real, ignorada pelo Git e montada somente para leitura.
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

O bot verifica alterações em `config/distribuidoras.json` periodicamente. Publique mudanças gravando um arquivo temporário no mesmo diretório e renomeando-o para o nome final; confira `config_reloaded` nos logs. Um JSON inválido preserva a última configuração válida. Ao atualizar o código, execute `git pull` e `docker compose -f compose.vps.yaml up -d --build`; faça backup do volume SQLite antes de mudanças operacionais. Falhas de envio ambíguas não são repetidas automaticamente: reconcilie na Evolution antes de alterar o estado manualmente.
