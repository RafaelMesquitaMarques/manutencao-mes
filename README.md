# MES Manutenção — Plataforma de Gestão e Monitoramento Industrial

Plataforma completa de manutenção com evolução para MES (Manufacturing Execution System), multi-usina, multi-usuário e multi-idioma. Substitui sistemas externos de monitoramento de captores, centralizando tudo em uma única plataforma sob controle interno.

## Arquitetura

```
manutencao-mes/
├── backend/                  # API FastAPI (Python)
│   └── app/
│       ├── api/routes/       # Endpoints REST por módulo
│       ├── core/             # Configurações, segurança, JWT
│       ├── db/               # Sessão e base SQLAlchemy
│       ├── models/           # Tabelas do banco (ORM)
│       ├── schemas/          # Validação Pydantic (input/output)
│       ├── services/         # Lógica de negócio
│       └── workers/
│           └── iot_consumer.py  # Consome MQTT dos captores → TimescaleDB
├── frontend/                 # React + Vite + Tailwind
│   └── src/
│       ├── pages/            # Telas principais
│       ├── components/       # Componentes reutilizáveis
│       ├── i18n/             # Traduções PT | EN | FR
│       └── store/            # Estado global (Zustand)
├── nginx/                    # Proxy reverso
├── scripts/
│   ├── init_db.sql           # Hypertable TimescaleDB + índices
│   ├── mosquitto.conf        # Broker MQTT (captores IoT)
│   └── setup.sh              # Setup com um comando
├── backups/                  # Backups automáticos diários
├── docker-compose.yml
└── .env.example
```

## Pré-requisitos

- Docker Desktop (Windows/Mac) ou Docker Engine (Linux)
- Git
- 4 GB RAM disponível (recomendado 8 GB)

## Instalação (um comando)

```bash
git clone https://github.com/seu-usuario/manutencao-mes.git
cd manutencao-mes
bash scripts/setup.sh
```

Após o setup:

| Serviço | URL |
|---------|-----|
| Plataforma | http://localhost |
| API REST | http://localhost/api |
| Documentação API | http://localhost/docs |
| MQTT Broker | localhost:1883 |

## Módulos

| Módulo | Descrição |
|--------|-----------|
| Ordens de Serviço | Corretiva, preventiva, preditiva. Geração automática por alerta IoT |
| Equipamentos | Ficha técnica, QR Code, horímetro, histórico completo |
| Planos de Manutenção | Gatilho por calendário, horímetro ou ciclos |
| Estoque | MRP leve, ponto de reposição, custo por OS |
| IoT / Captores | Ingestão MQTT, séries temporais, alertas automáticos |
| KPIs | MTBF, MTTR, OEE, disponibilidade por equipamento |
| Multi-idioma | Português, Inglês, Francês |

## Evolução planejada

```
Fase 1 · Agora    → CMMS local (este repositório)
Fase 2 · 3-6m     → Ingestão IoT dos captores existentes
Fase 3 · 12m+     → MES completo + preditiva com ML + multi-usina cloud
```

## Integração com captores

Os captores publicam dados via MQTT no tópico:
```
usinas/{usina_id}/captores/{captor_codigo}/leitura
```
Payload:
```json
{ "valor": 12.5, "timestamp": "2024-01-01T10:00:00Z" }
```

O `iot_consumer` processa em tempo real, grava no TimescaleDB e gera alertas e OS automáticas quando limites são excedidos — internalizando o que hoje é feito por empresa externa.

## Comandos úteis

```bash
# Subir
docker compose up -d

# Ver logs em tempo real
docker compose logs -f

# Parar
docker compose down

# Recriar após mudanças no código
docker compose up -d --build

# Acessar banco diretamente
docker exec -it mes_db psql -U mesadmin -d manutencao
```
