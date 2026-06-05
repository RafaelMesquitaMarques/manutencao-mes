-- Inicialização do banco de dados MES Manutenção
-- Executado automaticamente pelo Docker na primeira subida

-- Habilita extensão TimescaleDB (já incluída na imagem)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Cria hypertable para séries temporais dos captores IoT
-- (executado após o SQLAlchemy criar a tabela via Alembic/create_all)
-- Este bloco é idempotente: não falha se já existir

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'leituras_iot'
  ) THEN
    PERFORM create_hypertable(
      'leituras_iot', 'timestamp',
      if_not_exists => TRUE,
      chunk_time_interval => INTERVAL '7 days'
    );

    -- Política de compressão automática (dados > 30 dias)
    PERFORM add_compression_policy(
      'leituras_iot',
      INTERVAL '30 days',
      if_not_exists => TRUE
    );

    -- Política de retenção (apaga dados > 2 anos)
    PERFORM add_retention_policy(
      'leituras_iot',
      INTERVAL '2 years',
      if_not_exists => TRUE
    );
  END IF;
END $$;

-- Índices adicionais para performance
CREATE INDEX IF NOT EXISTS idx_leituras_captor_ts
  ON leituras_iot (captor_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_leituras_equip_ts
  ON leituras_iot (equipamento_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_os_status
  ON ordens_servico (status, data_abertura DESC);

CREATE INDEX IF NOT EXISTS idx_os_equipamento
  ON ordens_servico (equipamento_id, status);

CREATE INDEX IF NOT EXISTS idx_alertas_nao_reconhecidos
  ON alertas (reconhecido, criado_em DESC)
  WHERE reconhecido = false;
