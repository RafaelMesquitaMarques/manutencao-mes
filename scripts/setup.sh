#!/bin/bash
# ─── Setup inicial do projeto MES Manutenção ─────────────────────────────────
# Execute: bash scripts/setup.sh

set -e

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        MES Manutenção · Setup inicial                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Verifica dependências
command -v docker   >/dev/null 2>&1 || { echo "❌  Docker não encontrado. Instale em https://docs.docker.com/get-docker/"; exit 1; }
command -v git      >/dev/null 2>&1 || { echo "❌  Git não encontrado."; exit 1; }

echo "✅  Docker e Git encontrados"

# Cria .env se não existir
if [ ! -f .env ]; then
    cp .env.example .env
    # Gera SECRET_KEY aleatória
    SECRET=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i.bak "s/troque-esta-chave-em-producao/$SECRET/" .env && rm -f .env.bak
    echo "✅  Arquivo .env criado com chave secreta gerada"
else
    echo "ℹ️   Arquivo .env já existe, mantendo configurações"
fi

# Cria diretório de backups
mkdir -p backups
echo "✅  Diretório de backups criado"

# Sobe os containers
echo ""
echo "🚀  Subindo containers Docker..."
docker compose up -d --build

echo ""
echo "⏳  Aguardando banco de dados ficar pronto..."
sleep 8

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅  Plataforma rodando!                                 ║"
echo "║                                                          ║"
echo "║  🌐  Frontend:  http://localhost                         ║"
echo "║  📡  API:       http://localhost/api                     ║"
echo "║  📚  Docs API:  http://localhost/docs                    ║"
echo "║  🔌  MQTT:      localhost:1883                           ║"
echo "║                                                          ║"
echo "║  Para parar:  docker compose down                        ║"
echo "║  Para logs:   docker compose logs -f                     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
