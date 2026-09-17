# Replay do Turno (Factory Map) — arquitetura e limites

> Entregue em 2026-09-17. Modo adicional do Factory Map que reproduz no mapa o
> que aconteceu num turno ou período passado. **Zero tabelas novas, zero
> colunas novas, zero linhas novas** — é leitura pura do histórico que a
> plataforma já grava.

---

## 1. Por que não houve modelo novo

O pedido era reproduzir estados de máquina, OFs em passagem e eventos
relevantes. Antes de propor gravação nova, o inventário do que já existe:

| Sinal do replay | Tabela que já o guarda | Cobertura |
|---|---|---|
| Paradas com justificação | `machine_stops` (`started_at`/`ended_at`, categoria, subcategoria, comentário, operador) | Completa |
| Intervenção de manutenção (roxo) | `machine_interventions` (`started_at`/`completed_at`) + `intervention_technicians` (check-in/out) | Completa |
| Chamado aberto (âmbar) | `maintenance_tickets` (`opened_at`, `completed_at`, `closed_by_technician_at`) | Completa |
| OF por equipamento ao longo do tempo | `job_order_runs` — o ledger de passagens, uma linha por scan | Completa |
| Produção real | `machine_production_hourly` (hora real, contagem, rejeitos, OF) | Por hora |
| Buffer Pit Stop | `pit_stop_movements` (append-only, in/out com timestamp) | Ao nível da OF |
| Alertas / rejeitos | `maintenance_alerts.created_at`, `reject_logs.created_at` | Completa |
| Turnos | `machines.shifts_config` (hora de parede da planta) | Completa |

`job_order_runs` foi desenhado como histórico ("uma linha por scan — volume
baixo, guardado ≥10 anos") e é exatamente o que o replay precisa para as OFs.
Para os estados, o que falta é um log de `machines.current_status` — mas o
estado ao vivo já é *derivado* das mesmas três fontes acima
(`app/services/live_status.py`), portanto derivá-lo no passado usa as mesmas
regras em vez de introduzir uma segunda verdade.

Conclusão: **duplicar estado num log de replay seria armazenar o que já se pode
reconstruir.** O custo de armazenamento do replay é nulo.

## 2. Precedência de estado

Em cada instante, a camada de maior prioridade que cobre esse momento ganha a
cor (`app/services/factory_replay.py::_resolve_segments`):

| Prioridade | Camada | Estado |
|---|---|---|
| 3 | Intervenção ativa | `intervention` (roxo) |
| 2 | Parada aberta | `maintenance` / `planned_stop` / `stopped` / `unjustified`, conforme o tipo da categoria |
| 1 | Ticket de manutenção aberto | `maintenance` (âmbar) |
| 0 | Nada registado | `running` (verde) |

Espelha `live_status.effective_status` + o que os endpoints de parada escrevem
em `machines.current_status`. Cada segmento carrega `source`
(`stop`/`intervention`/`ticket`/`baseline`/`no_history`) e a UI mostra essa
proveniência, para que "verde por ausência de evento" nunca se confunda com
"verde medido".

Os intervalos de ticket viajam à parte (`ticket_spans`): o badge âmbar continua
exato mesmo quando uma parada vermelha ganha a cor do bloco.

## 3. Forma da API

```
GET /api/factory-replay/{plant_id}/windows?date=YYYY-MM-DD
    → turnos que a planta opera nesse dia local (agregados de shifts_config)
      + a janela do dia inteiro

GET /api/factory-replay/{plant_id}/timeline?start=ISO&end=ISO
    → { tracks[], of_runs[], pit_events[], pit_moved_before[],
        production[], events[] }
```

Tudo é chaveado por `equipment_id` — o mesmo id que `MapMachine.id` já usa —
por isso o frontend reaproveita geometria, cores, filtros, zonas e vistas sem
nenhuma tradução.

A janela inteira vem **num único fetch** (intervalos, não amostras), portanto
reproduzir, pausar, acelerar e saltar são operações locais, sem rede. Janela
máxima 24 h; `end` é cortado em "agora" (o futuro não tem histórico).

Acesso: `factory_map:view` + pertencer à planta — quem vê a fábrica ao vivo
pode revê-la.

## 4. Integração no mapa

`ReplayIndex.overlayAt(t)` devolve **exatamente a mesma forma** que o push do
WebSocket ao vivo entrega a `applyStatus()`. Ligar o replay troca a fonte, não
o renderizador: 2D (React Flow), 3D (Three.js), legenda com contagens, badges
de fila nos transportadores e pictogramas de técnico funcionam sem alteração.

Enquanto o replay está ativo ficam **suspensos**: o WS de estado, o poll de
fallback de 30 s, o poll do Pit Stop, o poll dos "spots" de OF, a meteorologia,
as leituras de temperatura e os KPIs ao vivo de 30 dias. Sair do replay
recarrega o mapa e religa tudo. O modo de edição fica indisponível no replay.

## 5. Limitações (assumidas, não preenchidas com dados inventados)

1. **Sem log de `current_status`.** O estado é reconstruído. Uma máquina sem
   nenhum evento registado aparece verde — como apareceria também ao vivo.
2. **O rosa `unjustified` raramente reaparece.** A categoria da parada é
   gravada na justificação, muitas vezes depois do facto; o histórico guarda só
   o valor final, logo a parada aparece já justificada desde o início.
3. **Telemetria de cobot não é historizada** (`robot_cell_states` é estado
   atual). No replay, transportadores e cobots seguem integralmente a
   máquina-mãe.
4. **Operador ao longo do tempo é parcial** — vem de `job_order_runs.operator_id`
   e `machine_stops.operator_id`; o kiosk não historiza `current_operator`.
5. **Fila planeada (`pipeline_ofs`) e placares das linhas (`line_stats`) não
   são historizáveis** — ficam ocultos no replay em vez de mostrar valor ao vivo.
6. **Pilhas 3D do Pit Stop não são reconstruídas** nesta entrega: o buffer
   renderiza vazio e as entradas/saídas aparecem no traço da OF. O ledger
   permite reconstruí-las depois (saldo por componente até T) — ver §6.
7. **Temperatura ambiente e meteorologia** não têm reconstrução no mapa
   (`sensor_readings` tem histórico, mas os termómetros do mapa mostram estado
   atual); ficam sem leitura no replay.
8. **Fila parqueada nas máquinas** conta as OFs cuja última passagem ocorreu na
   janela ou nas 72 h anteriores (`CARRY_IN_HOURS`); OFs paradas há mais tempo
   não entram na fila de arrasto.

## 6. Próximos passos possíveis

- Reconstruir as pilhas do Pit Stop por instante (saldo por componente =
  Σ in − Σ out até T, já suportado pelo ledger) e alimentar `pitStop` no 3D.
- Reproduzir as leituras de temperatura a partir de `sensor_readings`
  (hypertable, já tem o histórico).
- Exportar um resumo do turno reproduzido (paradas por causa, OFs concluídas)
  para a reunião de produção.

## 7. Ficheiros

| Caminho | Papel |
|---|---|
| `backend/app/services/factory_replay.py` | Reconstrução (álgebra de intervalos + leituras) |
| `backend/app/api/routes/factory_replay.py` | `/api/factory-replay` (2 endpoints, só GET) |
| `backend/tests/test_factory_replay.py` | Precedência, recorte, janelas de turno, montagem |
| `frontend/src/api/factoryReplay.ts` | Cliente + tipos |
| `frontend/src/pages/FactoryMap/replay/replayModel.ts` | Índice em memória + `overlayAt(t)` |
| `frontend/src/pages/FactoryMap/replay/useReplay.ts` | Relógio de reprodução |
| `frontend/src/pages/FactoryMap/replay/ReplayBar.tsx` | Barra de transporte + régua |
| `frontend/src/pages/FactoryMap/replay/ReplayMachineDetail.tsx` | Máquina no instante |
| `frontend/src/pages/FactoryMap/replay/ReplayOfDetail.tsx` | Percurso da OF |
| `frontend/src/pages/FactoryMap/replay/replayModel.test.ts` | Estado, herança, filas, buffer |
