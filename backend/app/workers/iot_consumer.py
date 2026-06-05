"""
Worker IoT: consome mensagens MQTT dos captores,
grava séries temporais no TimescaleDB e gera alertas automáticos.

Substitui a empresa externa que hoje faz este processamento.

Tópicos MQTT esperados:
  usinas/{usina_id}/captores/{captor_codigo}/leitura
  Payload JSON: {"valor": 12.5, "timestamp": "2024-01-01T10:00:00Z"}
"""
import asyncio
import json
import logging
from datetime import datetime, timezone

import aiomqtt
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.models import Captor, LeituraIoT, Alerta, Equipamento

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("iot_worker")


async def processar_leitura(session: AsyncSession, captor_codigo: str, payload: dict):
    """Grava leitura e verifica limites para gerar alerta."""
    
    # Busca captor pelo código MQTT
    result = await session.execute(
        select(Captor).where(Captor.codigo == captor_codigo, Captor.ativo == True)
    )
    captor = result.scalar_one_or_none()
    if not captor:
        log.warning(f"Captor não encontrado: {captor_codigo}")
        return

    valor = float(payload.get("valor", 0))
    ts_str = payload.get("timestamp")
    timestamp = datetime.fromisoformat(ts_str) if ts_str else datetime.now(timezone.utc)

    # Grava leitura (TimescaleDB hypertable)
    leitura = LeituraIoT(
        captor_id=captor.id,
        equipamento_id=captor.equipamento_id,
        timestamp=timestamp,
        valor=valor,
    )
    session.add(leitura)

    # Verifica limites → gera alerta se necessário
    alerta = None
    if captor.limite_max is not None and valor > captor.limite_max:
        alerta = Alerta(
            captor_id=captor.id,
            equipamento_id=captor.equipamento_id,
            tipo="limite_excedido",
            severidade="critico" if valor > captor.limite_max * 1.2 else "aviso",
            valor_lido=valor,
            limite=captor.limite_max,
            mensagem=f"{captor.nome}: valor {valor} {captor.unidade} acima do limite {captor.limite_max}",
        )
    elif captor.limite_min is not None and valor < captor.limite_min:
        alerta = Alerta(
            captor_id=captor.id,
            equipamento_id=captor.equipamento_id,
            tipo="limite_excedido",
            severidade="aviso",
            valor_lido=valor,
            limite=captor.limite_min,
            mensagem=f"{captor.nome}: valor {valor} {captor.unidade} abaixo do limite {captor.limite_min}",
        )

    if alerta:
        session.add(alerta)
        log.warning(f"ALERTA [{alerta.severidade}] {alerta.mensagem}")

    await session.commit()
    log.debug(f"Leitura gravada: {captor_codigo} = {valor} {captor.unidade}")


async def main():
    log.info(f"Conectando ao broker MQTT {settings.MQTT_BROKER}:{settings.MQTT_PORT}")
    
    async with aiomqtt.Client(settings.MQTT_BROKER, settings.MQTT_PORT) as client:
        # Assina todos os tópicos de leitura de todas as usinas
        await client.subscribe("usinas/+/captores/+/leitura")
        log.info("Subscribed: usinas/+/captores/+/leitura")

        async for message in client.messages:
            try:
                topic_parts = str(message.topic).split("/")
                # usinas/{usina_id}/captores/{captor_codigo}/leitura
                captor_codigo = topic_parts[3] if len(topic_parts) >= 4 else None
                if not captor_codigo:
                    continue

                payload = json.loads(message.payload.decode())

                async with AsyncSessionLocal() as session:
                    await processar_leitura(session, captor_codigo, payload)

            except Exception as e:
                log.error(f"Erro processando mensagem: {e}")


if __name__ == "__main__":
    asyncio.run(main())
