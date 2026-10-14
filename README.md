# Folgado · serviço de pedidos

Guarda a prévia e a estampa em tamanho real de cada pedido feito no "Monte a sua" e gera uma página privada para o dono ver e baixar.

Fluxo: o site envia as imagens (POST /api/pedido) → recebe um link (/p/FLG-MMDD-XXXX/token) → o link vai dentro da mensagem do WhatsApp.

Arquivos: server.js (sem dependências), Dockerfile, package.json.

Variáveis de ambiente
- ALLOWED_ORIGIN = https://folgado.bernassx.cloud (site autorizado a enviar)
- PUBLIC_URL = https://pedidos.bernassx.cloud (endereço deste serviço)
- RETENTION_DAYS = 60 (dias até apagar pedidos antigos)
- DATA_DIR = /data (já vem no Dockerfile; monte um volume aqui)
- PORT = 3000

Privacidade: a página mostra só o resumo da estampa e as imagens (sem nome, telefone ou endereço). O link tem um código secreto de 24 caracteres; quem não tem o link não acha o pedido.
