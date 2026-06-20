"""
Maintenance Intelligence — AI Language Layer
============================================
Transforms structured findings (from intelligence_calculator.py) into
clear, professional natural language insights using the Anthropic API.

Graceful degradation: if ANTHROPIC_API_KEY is not set, returns a
structured text summary built from the findings dict without any AI call.
The system remains fully functional in calculator-only mode.

Language support: en (English), fr (French), es (Spanish).
Machine names, part codes, and technical identifiers are NEVER translated.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

ANTHROPIC_API_URL  = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL    = "claude-sonnet-4-6"
MAX_TOKENS         = 2000
# LLM generations of up to MAX_TOKENS routinely take 30-60s — a 30s timeout
# causes intermittent ReadTimeout and silent fallback to non-AI text.
HTTP_TIMEOUT       = 120.0


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def generate_insight_text(
    findings: dict,
    language: str = "en",
    insight_type: str = "full_report",
) -> tuple[str, bool]:
    """
    Main entry point.

    Args:
        findings:     Structured findings dict from intelligence_calculator.
        language:     Target language code: 'en', 'fr', or 'es'.
        insight_type: Which aspect to focus on.

    Returns:
        (insight_text, ai_generated)
        ai_generated=True if Anthropic API was used,
        ai_generated=False if fallback structured text was used.
    """
    if not settings.anthropic_api_key:
        logger.warning("ANTHROPIC_API_KEY not set — using structured fallback text.")
        return _build_fallback_text(findings, language), False

    try:
        text = await _call_anthropic(findings, language, insight_type)
        return text, True
    except Exception as exc:
        logger.error("Anthropic API call failed: %s — falling back to structured text.", exc)
        return _build_fallback_text(findings, language), False


# ---------------------------------------------------------------------------
# Anthropic API call
# ---------------------------------------------------------------------------

async def _call_anthropic(
    findings: dict,
    language: str,
    insight_type: str,
) -> str:
    """
    Calls Anthropic API with a structured prompt.
    Returns the generated insight text.
    """
    prompt = _build_prompt(findings, language, insight_type)

    headers = {
        "x-api-key":         settings.anthropic_api_key,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
    }

    body = {
        "model":      ANTHROPIC_MODEL,
        "max_tokens": MAX_TOKENS,
        "system":     _system_prompt(language),
        "messages":   [{"role": "user", "content": prompt}],
    }

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.post(ANTHROPIC_API_URL, headers=headers, json=body)
        response.raise_for_status()
        data = response.json()

    # Extract text from response
    content_blocks = data.get("content", [])
    text_blocks = [b["text"] for b in content_blocks if b.get("type") == "text"]
    return "\n\n".join(text_blocks).strip()


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

def _system_prompt(language: str) -> str:
    lang_instructions = {
        "en": "Respond in English.",
        "fr": "Réponds en français. Utilise un langage professionnel et naturel — pas de traduction littérale.",
        "es": "Responde en español. Utiliza lenguaje profesional y natural — no una traducción literal.",
    }
    lang_note = lang_instructions.get(language, lang_instructions["en"])

    return f"""You are a Maintenance Intelligence Copilot for an industrial plant (Foliot Furniture).
Your role is to analyze structured maintenance data and generate clear, professional insights
for the maintenance team.

CRITICAL RULES — follow these without exception:
1. Never invent data. Only interpret what is explicitly in the JSON you receive.
2. Never say a machine "will" fail. Use "shows increased risk" or "is approaching its historical MTBF".
3. Never blame a technician. Focus on workload distribution and knowledge sharing opportunities.
4. Clearly distinguish between FACTS, TRENDS, and RECOMMENDATIONS.
5. If a value is null or missing, state "insufficient data" — do not estimate.
6. Machine names, part codes, ticket numbers, and technical identifiers must NEVER be translated.
7. Keep the tone operational and professional — this is read by maintenance supervisors.

OUTPUT FORMAT:
Use this structure for each section:
- Start with a brief headline observation (1 sentence)
- Follow with evidence (specific numbers from the data)
- End with a clear recommended action (use "Recommended action:" prefix)

{lang_note}"""


# ---------------------------------------------------------------------------
# User prompt builder
# ---------------------------------------------------------------------------

def _build_prompt(findings: dict, language: str, insight_type: str) -> str:
    """
    Builds the user-facing prompt containing the findings JSON
    and instructions tailored to the insight type.
    """

    # Serialize only the relevant parts to keep the prompt focused
    relevant = _extract_relevant_findings(findings, insight_type)
    findings_json = json.dumps(relevant, indent=2, default=str)

    focus_instructions = {
        "daily_summary": _focus_daily_summary(language),
        "machine_risk":  _focus_machine_risk(language),
        "top_irritants": _focus_irritants(language),
        "trend_analysis": _focus_trends(language),
        "spare_parts":   _focus_spare_parts(language),
        "technician_workload": _focus_technicians(language),
        "full_report":   _focus_full_report(language),
    }
    focus = focus_instructions.get(insight_type, focus_instructions["full_report"])

    return f"""Here is the structured maintenance data for the analysis period:

```json
{findings_json}
```

{focus}

Important reminders:
- MTBF values are calculated from maintenance ticket intervals (not machine stop sensors).
  Always refer to them as "time between intervention calls" or "ticket-based MTBF".
- Any null value = insufficient data. Do not estimate or extrapolate.
- Insufficient data warnings from the data: {findings.get("insufficient_data_warnings", [])}"""


def _focus_daily_summary(lang: str) -> str:
    instructions = {
        "en": """Generate a concise maintenance summary covering:
1. Overall activity (tickets, alerts, downtime)
2. MTTR status and trend
3. MTBF status and trend  
4. Top 2 machines requiring attention
5. Critical spare parts situation
6. Top 3 recommended priorities for today

Keep it under 300 words. Use specific numbers.""",

        "fr": """Génère un résumé de maintenance concis couvrant :
1. Activité globale (tickets, alertes, temps d'arrêt)
2. Statut et tendance du MTTR
3. Statut et tendance du MTBF
4. Les 2 machines les plus préoccupantes
5. Situation des pièces de rechange critiques
6. Les 3 priorités recommandées pour aujourd'hui

Maximum 300 mots. Utilise des chiffres précis.""",

        "es": """Genera un resumen de mantenimiento conciso que cubra:
1. Actividad general (tickets, alertas, tiempo de paro)
2. Estado y tendencia del MTTR
3. Estado y tendencia del MTBF
4. Las 2 máquinas que requieren más atención
5. Situación de repuestos críticos
6. Las 3 prioridades recomendadas para hoy

Máximo 300 palabras. Usa números específicos.""",
    }
    return instructions.get(lang, instructions["en"])


def _focus_machine_risk(lang: str) -> str:
    instructions = {
        "en": """Analyze the machine risk scores and generate a risk report:
- For each critical or high-risk machine: explain WHY it is at risk (use the specific data)
- Mention the ticket-based MTBF if available
- Recommend a specific inspection or action for each at-risk machine
- Do NOT say the machine "will fail" — use "shows increased risk based on historical patterns"
""",
        "fr": """Analyse les scores de risque machines et génère un rapport de risque :
- Pour chaque machine critique ou à risque élevé : explique POURQUOI elle est à risque (utilise les données)
- Mentionne le MTBF basé sur les tickets si disponible
- Recommande une inspection ou action spécifique pour chaque machine à risque
- Ne dis PAS que la machine "va tomber en panne" — utilise "présente un risque accru selon l'historique"
""",
        "es": """Analiza las puntuaciones de riesgo de las máquinas y genera un informe:
- Para cada máquina crítica o de alto riesgo: explica POR QUÉ está en riesgo (usa los datos específicos)
- Menciona el MTBF basado en tickets si está disponible
- Recomienda una inspección o acción específica para cada máquina en riesgo
- NO digas que la máquina "va a fallar" — usa "muestra mayor riesgo según el historial"
""",
    }
    return instructions.get(lang, instructions["en"])


def _focus_irritants(lang: str) -> str:
    instructions = {
        "en": """Analyze the top maintenance irritants and generate a ranked analysis:
For each irritant (rank 1-5):
- State the machine name and its rank
- Provide evidence: ticket count, downtime, MTTR, recurrence score
- Assess the operational impact
- Give a specific recommended action (e.g., standardize procedure, inspect component, review PM plan)
- State the risk level
""",
        "fr": """Analyse les principaux irritants de maintenance et génère une analyse classée :
Pour chaque irritant (rang 1-5) :
- Indique le nom de la machine et son rang
- Fournis les preuves : nombre de tickets, temps d'arrêt, MTTR, score de récurrence
- Évalue l'impact opérationnel
- Donne une action recommandée précise (ex : standardiser la procédure, inspecter composant, revoir plan PM)
- Indique le niveau de risque
""",
        "es": """Analiza los principales irritantes de mantenimiento y genera un análisis clasificado:
Para cada irritante (rango 1-5):
- Indica el nombre de la máquina y su rango
- Proporciona evidencia: número de tickets, tiempo de paro, MTTR, puntuación de recurrencia
- Evalúa el impacto operacional
- Da una acción recomendada específica (ej: estandarizar procedimiento, inspeccionar componente, revisar plan PM)
- Indica el nivel de riesgo
""",
    }
    return instructions.get(lang, instructions["en"])


def _focus_trends(lang: str) -> str:
    instructions = {
        "en": """Analyze the maintenance trends and explain what is improving, stable, or deteriorating.
Focus on:
- Overall MTTR and MTBF trend (what changed and why it matters)
- Per-machine ticket count trends (which machines are getting worse or better)
- Highlight any abnormal variations that need investigation
Use plain language — a maintenance supervisor should understand immediately.""",
        "fr": """Analyse les tendances de maintenance et explique ce qui s'améliore, reste stable ou se dégrade.
Focus sur :
- Tendance globale du MTTR et du MTBF (ce qui a changé et pourquoi c'est important)
- Tendances du nombre de tickets par machine (quelles machines se dégradent ou s'améliorent)
- Mettre en évidence les variations anormales qui nécessitent une investigation
Utilise un langage clair — un superviseur de maintenance doit comprendre immédiatement.""",
        "es": """Analiza las tendencias de mantenimiento y explica qué está mejorando, estable o deteriorándose.
Enfócate en:
- Tendencia general de MTTR y MTBF (qué cambió y por qué importa)
- Tendencias del conteo de tickets por máquina (qué máquinas empeoran o mejoran)
- Destacar variaciones anormales que necesitan investigación
Usa lenguaje claro — un supervisor de mantenimiento debe entender inmediatamente.""",
    }
    return instructions.get(lang, instructions["en"])


def _focus_spare_parts(lang: str) -> str:
    instructions = {
        "en": """Analyze the spare parts risk situation:
- List parts that are critical (below minimum stock or abnormal consumption)
- For each critical part: current qty, minimum qty, consumption trend, linked machines
- Recommend specific replenishment actions
- Highlight parts linked to high-frequency failures (recurrence risk)
- If consumption is abnormal, suggest investigating the root cause.""",
        "fr": """Analyse la situation de risque des pièces de rechange :
- Liste les pièces critiques (sous le stock minimum ou consommation anormale)
- Pour chaque pièce critique : quantité actuelle, quantité minimum, tendance consommation, machines liées
- Recommande des actions de réapprovisionnement spécifiques
- Signale les pièces liées à des pannes fréquentes (risque de récurrence)
- Si la consommation est anormale, suggère d'enquêter sur la cause racine.""",
        "es": """Analiza la situación de riesgo de repuestos:
- Lista las piezas críticas (por debajo del stock mínimo o consumo anormal)
- Para cada pieza crítica: cantidad actual, cantidad mínima, tendencia de consumo, máquinas vinculadas
- Recomienda acciones específicas de reabastecimiento
- Destaca piezas vinculadas a fallas frecuentes (riesgo de recurrencia)
- Si el consumo es anormal, sugiere investigar la causa raíz.""",
    }
    return instructions.get(lang, instructions["en"])


def _focus_technicians(lang: str) -> str:
    instructions = {
        "en": """Analyze the technician workload distribution.
IMPORTANT: Be supportive and constructive. Never criticize individual performance.
Focus on:
- Workload distribution: is it balanced or concentrated?
- Identify concentration risk (if 2 technicians handle >60% of tickets)
- Specialty coverage: are there gaps in coverage?
- Recommend workload balancing or cross-training opportunities
Frame everything as team improvement, not individual assessment.""",
        "fr": """Analyse la distribution de la charge de travail des techniciens.
IMPORTANT : Soyez constructif et bienveillant. Ne critiquez jamais les performances individuelles.
Focus sur :
- Distribution de la charge : est-elle équilibrée ou concentrée ?
- Identifier le risque de concentration (si 2 techniciens gèrent >60% des tickets)
- Couverture par spécialité : y a-t-il des lacunes ?
- Recommander l'équilibrage des charges ou des opportunités de formation croisée
Cadrer tout cela comme une amélioration d'équipe, pas une évaluation individuelle.""",
        "es": """Analiza la distribución de carga de trabajo de los técnicos.
IMPORTANTE: Sé constructivo y de apoyo. Nunca critiques el desempeño individual.
Enfócate en:
- Distribución de carga: ¿está equilibrada o concentrada?
- Identificar riesgo de concentración (si 2 técnicos manejan >60% de los tickets)
- Cobertura por especialidad: ¿hay brechas?
- Recomendar balanceo de carga u oportunidades de capacitación cruzada
Encuadra todo como mejora del equipo, no evaluación individual.""",
    }
    return instructions.get(lang, instructions["en"])


def _focus_full_report(lang: str) -> str:
    instructions = {
        "en": """Generate a complete Maintenance Intelligence Report with these sections:

## Summary
Brief overview of the period (2-3 sentences, key numbers).

## Machine Risk Monitor
Top critical and high-risk machines with evidence and recommended actions.

## Top Irritants
Ranked list of the biggest maintenance problems with impact and actions.

## Trends
What improved, stayed stable, or deteriorated compared to the previous period.

## Spare Parts Alerts
Parts requiring immediate attention with specific recommendations.

## Technician Workload
Workload distribution insights and any balance/training recommendations.

## Priority Actions for This Shift
3-5 specific, actionable priorities ordered by urgency.

Keep each section concise. Use specific data. Total report under 600 words.""",

        "fr": """Génère un Rapport Complet d'Intelligence de Maintenance avec ces sections :

## Résumé
Vue d'ensemble de la période (2-3 phrases, chiffres clés).

## Moniteur de Risque Machines
Machines critiques et à risque élevé avec preuves et actions recommandées.

## Principaux Irritants
Liste classée des problèmes de maintenance les plus importants avec impact et actions.

## Tendances
Ce qui s'est amélioré, stabilisé ou dégradé par rapport à la période précédente.

## Alertes Pièces de Rechange
Pièces nécessitant une attention immédiate avec recommandations spécifiques.

## Charge de Travail Techniciens
Analyse de la distribution et recommandations d'équilibrage ou formation.

## Actions Prioritaires pour ce Quart
3-5 priorités spécifiques et actionnables, par ordre d'urgence.

Chaque section doit être concise. Utilise des données précises. Maximum 600 mots.""",

        "es": """Genera un Reporte Completo de Inteligencia de Mantenimiento con estas secciones:

## Resumen
Visión general del período (2-3 oraciones, números clave).

## Monitor de Riesgo de Máquinas
Máquinas críticas y de alto riesgo con evidencia y acciones recomendadas.

## Principales Irritantes
Lista clasificada de los mayores problemas de mantenimiento con impacto y acciones.

## Tendencias
Qué mejoró, se mantuvo estable o se deterioró comparado con el período anterior.

## Alertas de Repuestos
Piezas que requieren atención inmediata con recomendaciones específicas.

## Carga de Trabajo de Técnicos
Análisis de distribución y recomendaciones de balanceo o capacitación.

## Acciones Prioritarias para este Turno
3-5 prioridades específicas y accionables, ordenadas por urgencia.

Cada sección debe ser concisa. Usa datos específicos. Máximo 600 palabras.""",
    }
    return instructions.get(lang, instructions["en"])


# ---------------------------------------------------------------------------
# Relevant findings extractor (reduce prompt size)
# ---------------------------------------------------------------------------

def _extract_relevant_findings(findings: dict, insight_type: str) -> dict:
    """
    Returns a subset of findings relevant to the insight type.
    Keeps prompts focused and reduces token usage.
    """
    base = {
        "period_start":           findings.get("period_start"),
        "period_end":             findings.get("period_end"),
        "total_tickets":          findings.get("total_tickets"),
        "total_alerts":           findings.get("total_alerts"),
        "total_downtime_minutes": findings.get("total_downtime_minutes"),
        "overdue_alerts":         findings.get("overdue_alerts"),
    }

    if insight_type in ("daily_summary", "full_report"):
        return {
            **base,
            "avg_mttr_minutes":       findings.get("avg_mttr_minutes"),
            "mttr_trend":             findings.get("mttr_trend"),
            "mttr_change_pct":        findings.get("mttr_change_pct"),
            "avg_mtbf_days":          findings.get("avg_mtbf_days"),
            "mtbf_trend":             findings.get("mtbf_trend"),
            "mtbf_change_pct":        findings.get("mtbf_change_pct"),
            "machine_risks":          findings.get("machine_risks", [])[:5],
            "top_irritants":          findings.get("top_irritants", []),
            "trends":                 findings.get("trends", []),
            "spare_parts_at_risk":    findings.get("spare_parts_at_risk", [])[:5],
            "technician_workload":    findings.get("technician_workload", []),
            "concentration_risk":     findings.get("concentration_risk"),
            "parts_below_minimum":    findings.get("parts_below_minimum"),
        }

    elif insight_type == "machine_risk":
        return {
            **base,
            "avg_mtbf_days":       findings.get("avg_mtbf_days"),
            "machines_with_mtbf":  findings.get("machines_with_mtbf"),
            "machine_risks":       findings.get("machine_risks", []),
            "critical_machines":   findings.get("critical_machines"),
            "high_risk_machines":  findings.get("high_risk_machines"),
        }

    elif insight_type == "top_irritants":
        return {**base, "top_irritants": findings.get("top_irritants", [])}

    elif insight_type == "trend_analysis":
        return {
            **base,
            "mttr_trend":      findings.get("mttr_trend"),
            "mttr_change_pct": findings.get("mttr_change_pct"),
            "mtbf_trend":      findings.get("mtbf_trend"),
            "mtbf_change_pct": findings.get("mtbf_change_pct"),
            "trends":          findings.get("trends", []),
        }

    elif insight_type == "spare_parts":
        return {
            **base,
            "spare_parts_at_risk": findings.get("spare_parts_at_risk", []),
            "parts_below_minimum": findings.get("parts_below_minimum"),
        }

    elif insight_type == "technician_workload":
        return {
            **base,
            "technician_workload": findings.get("technician_workload", []),
            "concentration_risk":  findings.get("concentration_risk"),
        }

    return findings  # fallback: send everything


# ---------------------------------------------------------------------------
# Fallback structured text (no API key required)
# ---------------------------------------------------------------------------

def _build_fallback_text(findings: dict, language: str) -> str:
    """
    Generates a structured text summary directly from findings data.
    Used when ANTHROPIC_API_KEY is not configured.
    No external calls. Always works.
    """
    labels = {
        "en": {
            "title":         "Maintenance Intelligence Summary",
            "note":          "Note: AI narrative disabled — configure ANTHROPIC_API_KEY for full insights.",
            "period":        "Period",
            "tickets":       "Total tickets",
            "alerts":        "Total alerts",
            "downtime":      "Total downtime",
            "mttr":          "Average MTTR",
            "mtbf":          "Average MTBF (ticket-based)",
            "minutes":       "min",
            "days":          "days",
            "at_risk":       "Machines at risk",
            "irritants":     "Top irritants",
            "parts":         "Parts below minimum stock",
            "data_warnings": "Data warnings",
            "no_data":       "Insufficient data",
        },
        "fr": {
            "title":         "Résumé Intelligence de Maintenance",
            "note":          "Note : Narration AI désactivée — configurez ANTHROPIC_API_KEY pour les insights complets.",
            "period":        "Période",
            "tickets":       "Tickets totaux",
            "alerts":        "Alertes totales",
            "downtime":      "Temps d'arrêt total",
            "mttr":          "MTTR moyen",
            "mtbf":          "MTBF moyen (basé sur tickets)",
            "minutes":       "min",
            "days":          "jours",
            "at_risk":       "Machines à risque",
            "irritants":     "Principaux irritants",
            "parts":         "Pièces sous stock minimum",
            "data_warnings": "Avertissements données",
            "no_data":       "Données insuffisantes",
        },
        "es": {
            "title":         "Resumen de Inteligencia de Mantenimiento",
            "note":          "Nota: Narrativa AI desactivada — configure ANTHROPIC_API_KEY para insights completos.",
            "period":        "Período",
            "tickets":       "Tickets totales",
            "alerts":        "Alertas totales",
            "downtime":      "Tiempo de paro total",
            "mttr":          "MTTR promedio",
            "mtbf":          "MTBF promedio (basado en tickets)",
            "minutes":       "min",
            "days":          "días",
            "at_risk":       "Máquinas en riesgo",
            "irritants":     "Principales irritantes",
            "parts":         "Piezas bajo stock mínimo",
            "data_warnings": "Advertencias de datos",
            "no_data":       "Datos insuficientes",
        },
    }

    L = labels.get(language, labels["en"])

    period_start = findings.get("period_start", "")[:10]
    period_end   = findings.get("period_end",   "")[:10]
    mttr         = findings.get("avg_mttr_minutes")
    mtbf         = findings.get("avg_mtbf_days")

    mttr_str = f"{mttr:.0f} {L['minutes']}" if mttr else L['no_data']
    mtbf_str = f"{mtbf:.1f} {L['days']}" if mtbf else L['no_data']

    lines = [
        f"# {L['title']}",
        f"",
        f"⚠️ {L['note']}",
        f"",
        f"**{L['period']}:** {period_start} → {period_end}",
        f"**{L['tickets']}:** {findings.get('total_tickets', 0)}",
        f"**{L['alerts']}:** {findings.get('total_alerts', 0)}",
        f"**{L['downtime']}:** {findings.get('total_downtime_minutes', 0)} {L['minutes']}",
        f"**{L['mttr']}:** {mttr_str}",
        f"**{L['mtbf']}:** {mtbf_str}",
        f"",
    ]

    # Machine risks
    risks = findings.get("machine_risks", [])
    at_risk = [r for r in risks if r["risk_level"] in ("high", "critical")]
    if at_risk:
        lines.append(f"**{L['at_risk']}:** {', '.join(r['machine_name'] for r in at_risk[:3])}")

    # Top irritants
    irritants = findings.get("top_irritants", [])
    if irritants:
        lines.append(f"**{L['irritants']}:** {', '.join(i['machine_name'] for i in irritants[:3])}")

    # Parts
    lines.append(f"**{L['parts']}:** {findings.get('parts_below_minimum', 0)}")

    # Data warnings
    warnings = findings.get("insufficient_data_warnings", [])
    if warnings:
        lines.append(f"")
        lines.append(f"**{L['data_warnings']}:**")
        for w in warnings[:5]:
            lines.append(f"- {w}")

    return "\n".join(lines)
