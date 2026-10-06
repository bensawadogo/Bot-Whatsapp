#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Génère les 5 workflows n8n AfriBot en JSON.

Usage:
    python generate_n8n_workflows.py --output-dir n8n/workflows

Les expressions JS dans les champs `text` utilisent des chaînes brutes
Python (r-passim) pour éviter les problèmes d'échappement PowerShell/UTF8.
L'encodage de sortie est UTF-8 (json.dump avec ensure_ascii=False).

Endpoints AfriBot API utilisés (authentification requise) :
    GET /api/stats/today      → rapport journalier
    GET /api/stats/weekly     → rapport hebdomadaire
    GET /api/stats/low-stock  → alertes stock bas

Authentification : Authorization: Bearer <JWT dashboard>.
Le JWT est signé avec JWT_SECRET côté AfriBot. Depuis n8n, soit on
utilise une route proxy qui accepte un Basic Auth, soit on stocke un
JWT pré-généré dans la variable d'environnement AFRIBOT_JWT.
"""
import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple


NODE_CREDENTIALS_EVO: Dict[str, str] = {"evolutionApi": {"id": "evo-cred", "name": "Evolution API"}}

JS_SENDER_EXPR = r"""={{ $node["make-senders"].output }}"""
JS_PHONE_EXPR = r"""={{ $json.phone }}"""

JS_DAILY_TEXT = (
    ".EN {{ $json.mode ?? " + '"' + " Production" + '"' + " }} · "
    "{{ $json.shop_label ?? " + '"' + "Ma Boutique" + '"' + " }} — Journal du "
    "{{ $now.toFormat(\"dd/MM/yyyy HH:mm\") }} GMT\n\n"
    "💰 Caisse : {{ $json.cash_total?.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, " + '"' + " " + '"' + ") ?? " + '"' + " —" + '"' + " }} FCFA "
    "({{ $json.cash_orders_count ?? 0 }} ventes)\n"
    "📱 WhatsApp : {{ $json.wa_orders_count ?? 0 }} "
    "({{ $json.wa_revenue?.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, " + '"' + " " + '"' + ") ?? " + '"' + " —" + '"' + " }} FCFA)\n"
    "✅ Paiements SUCCESS : {{ $json.success_payments_count ?? 0 }} / {{ $json.pending_payments_count ?? 0 }} en attente\n"
    "📦 Stock bas : {{ $json.low_stock_count ?? 0 }} articles\n"
    "💬 Messages aujourd\u0027hui : {{ $json.messages_count ?? 0 }}"
)

JS_HOURLY_TEXT = (
    "⏰ Point d\u0027étape horaire {{ $now.toFormat(\"HH:mm\") }} GMT · "
    "{{ $json.shop_label ?? " + '"' + "Ma Boutique" + '"' + " }}\n"
    "🆕 Commandes dernières 60 min : {{ $json.wa_orders_last_hour ?? 0 }}\n"
    "💰 CA dernière heure : {{ $json.hourly_revenue_last_hour?.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, " + '"' + " " + '"' + ") ?? " + '"' + " —" + '"' + " }} FCFA\n"
    "📊 Moyenne/heure (24h) : {{ $json.hourly_avg_24h?.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, " + '"' + " " + '"' + ") ?? " + '"' + " —" + '"' + " }} FCFA\n"
    "📈 CA département 24h : {{ $json.department_revenue_24h?.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, " + '"' + " " + '"' + ") ?? " + '"' + " —" + '"' + " }} FCFA\n"
    "⚠️ Stock bas : {{ $json.low_stock_count ?? 0 }} articles"
)

JS_FOLLOWUP_TEXT = (
    "Bonjour {{ $json.customerName ?? " + '"' + "client" + '"' + " }} \U0001f44b\n\n"
    "Votre commande #{{ $json.orderId }} est en attente de règlement.\n"
    "• Prestations : {{ $json.amount ?? 0 }} FCFA\n"
    "• Durée : {{ $json.paxCount ?? 1 }} passager(s)\n\n"
    "\U0001f449 Pour finaliser, envoyez le montant exact à 22177 60 00 000 (site ou en boutique).\n"
    "\U0001f4a1 Payement possible : cash ou Mobile Money.\n\n"
    "À très vite !"
)

JS_STOCK_ALERT_TEXT = (
    "\U0001f6a8 Alertes stock bas AfriBot · {{ $now.toFormat(\"dd/MM HH:mm\") }} GMT\n\n"
    "Votre boutique a besoin de réapprovisionner :\n"
    "{{ $json.summary ?? " + '"' + "Aucun résumé disponible (voir API)" + '"' + " }}\n\n"
    "Voir le catalogue et commander en back-office AfriBot."
)

JS_BROADCAST_TEXT = "📢 {{ $node[" + '"' + "dynamique-message" + '"' + "].json.text }}"


def make_node(
    node_id: int,
    node_name: str,
    node_type: str,
    node_type_version: float,
    position: List[int],
    parameters: Dict[str, Any],
    credentials: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "parameters": parameters,
        "id": node_id,
        "name": node_name,
        "type": node_type,
        "typeVersion": node_type_version,
        "position": position,
    }
    if credentials is not None:
        data["credentials"] = credentials
    return data


def make_connections(
    conn_specs: List[Tuple[str, List[str], Optional[Dict[str, str]]]],
) -> Dict[str, Any]:
    conn: Dict[str, Any] = {}
    for spec in conn_specs:
        branches: Optional[Dict[str, str]] = None
        from_node, to_nodes = spec[0], spec[1]
        if len(spec) > 2:
            branches = spec[2]
        if branches:
            conn[from_node] = {}
            for branch, target in branches.items():
                conn[from_node][branch] = [
                    [{"node": target, "type": "main", "index": 0}]
                ]
        else:
            conn[from_node] = {
                "main": [[{"node": n, "type": "main", "index": 0}] for n in to_nodes]
            }
    return conn


def build_workflow(
    name: str, nodes: List[Dict], connections: Dict[str, Any]
) -> Dict[str, Any]:
    return {
        "name": name,
        "nodes": nodes,
        "connections": connections,
        "meta": {
            "instanceId": "afribot-n8n",
            "templateDemonstration": False,
        },
    }


def build_daily_report() -> Dict[str, Any]:
    """Workflow 01 — Rapport journalier (chaque jour à 05:00 GMT)."""
    nodes = [
        make_node(
            1, "schedule-daily", "n8n-nodes-base.scheduleTrigger", 1.2,
            [260, 300],
            {"triggerTimes": {"mode": "everyDay", "cronExpression": "0 5 * * *", "daysFilter": []}},
        ),
        make_node(
            2, "fetch-daily", "n8n-nodes-base.httpRequest", 4.1,
            [500, 300],
            {
                "url": "={{ $env.AFRIBOT_API_URL }}/api/stats/today",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "Authorization", "value": "Bearer {{ $env.AFRIBOT_JWT }}"}
                    ]
                },
                "options": {},
            },
        ),
        make_node(
            3, "send-daily", "n8n-nodes-base.evolutionApi", 2.0,
            [760, 300],
            {
                "sender": "={{ $env.MERCHANT_PHONE }}",
                "receiver": JS_SENDER_EXPR,
                "text": JS_DAILY_TEXT,
                "options": {},
            },
            credentials=NODE_CREDENTIALS_EVO,
        ),
    ]
    connections = make_connections([
        ("schedule-daily", ["fetch-daily"]),
        ("fetch-daily", ["send-daily"]),
    ])
    return build_workflow("AfriBot — Rapport journalier", nodes, connections)


def build_weekly_report() -> Dict[str, Any]:
    """Workflow 02 — Rapport hebdomadaire (chaque lundi à 06:00 GMT)."""
    nodes = [
        make_node(
            1, "schedule-weekly", "n8n-nodes-base.scheduleTrigger", 1.2,
            [260, 300],
            {"triggerTimes": {"mode": "everyWeek", "cronExpression": "0 6 * * 1", "daysFilter": []}},
        ),
        make_node(
            2, "fetch-weekly", "n8n-nodes-base.httpRequest", 4.1,
            [500, 300],
            {
                "url": "={{ $env.AFRIBOT_API_URL }}/api/stats/weekly",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "Authorization", "value": "Bearer {{ $env.AFRIBOT_JWT }}"}
                    ]
                },
                "options": {},
            },
        ),
        make_node(
            3, "send-weekly", "n8n-nodes-base.evolutionApi", 2.0,
            [760, 300],
            {
                "sender": "={{ $env.MERCHANT_PHONE }}",
                "receiver": JS_SENDER_EXPR,
                "text": JS_HOURLY_TEXT,
                "options": {},
            },
            credentials=NODE_CREDENTIALS_EVO,
        ),
    ]
    connections = make_connections([
        ("schedule-weekly", ["fetch-weekly"]),
        ("fetch-weekly", ["send-weekly"]),
    ])
    return build_workflow("AfriBot — Rapport hebdomadaire", nodes, connections)


def build_followup() -> Dict[str, Any]:
    """Workflow 03 — Relance commande (webhook déclenché par AfriBot)."""
    nodes = [
        make_node(
            201, "webhook-followup", "n8n-nodes-base.webhook", 1.0,
            [100, 300],
            {"httpMethod": "POST", "path": "followup"},
        ),
        make_node(
            203, "send-followup", "n8n-nodes-base.evolutionApi", 2.0,
            [500, 300],
            {
                "sender": "={{ $env.MERCHANT_PHONE }}",
                "receiver": JS_PHONE_EXPR,
                "text": JS_FOLLOWUP_TEXT,
                "options": {},
            },
            credentials=NODE_CREDENTIALS_EVO,
        ),
    ]
    connections = make_connections([
        ("webhook-followup", ["send-followup"]),
    ])
    return build_workflow("AfriBot — Relance Commande", nodes, connections)


def build_stock_alert() -> Dict[str, Any]:
    """Workflow 04 — Alerte stock bas (toutes les heures à :30)."""
    nodes = [
        make_node(
            301, "schedule-stock", "n8n-nodes-base.scheduleTrigger", 1.2,
            [260, 300],
            {"triggerTimes": {"mode": "everyHour", "minute": 30}},
        ),
        make_node(
            302, "fetch-stock", "n8n-nodes-base.httpRequest", 4.1,
            [500, 300],
            {
                "url": "={{ $env.AFRIBOT_API_URL }}/api/stats/low-stock",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "Authorization", "value": "Bearer {{ $env.AFRIBOT_JWT }}"}
                    ]
                },
                "options": {},
            },
        ),
        make_node(
            303, "send-stock", "n8n-nodes-base.evolutionApi", 2.0,
            [760, 300],
            {
                "sender": "={{ $env.MERCHANT_PHONE }}",
                "receiver": JS_SENDER_EXPR,
                "text": JS_STOCK_ALERT_TEXT,
                "options": {},
            },
            credentials=NODE_CREDENTIALS_EVO,
        ),
    ]
    connections = make_connections([
        ("schedule-stock", ["fetch-stock"]),
        ("fetch-stock", ["send-stock"]),
    ])
    return build_workflow("AfriBot — Alerte Stock", nodes, connections)


def build_broadcast() -> Dict[str, Any]:
    """Workflow 05 — Broadcast (déclenché manuellement)."""
    nodes = [
        make_node(
            401, "manual-trigger", "n8n-nodes-base.manualTrigger", 1.0,
            [260, 300],
            {},
        ),
        make_node(
            403, "send-broadcast", "n8n-nodes-base.evolutionApi", 2.0,
            [500, 300],
            {
                "sender": "={{ $env.MERCHANT_PHONE }}",
                "receiver": JS_PHONE_EXPR,
                "text": JS_BROADCAST_TEXT,
                "options": {},
            },
            credentials=NODE_CREDENTIALS_EVO,
        ),
    ]
    connections = make_connections([
        ("manual-trigger", ["send-broadcast"]),
    ])
    return build_workflow("AfriBot — Broadcast", nodes, connections)


WORKFLOWS = {
    "workflow-01-daily-report.json": build_daily_report,
    "workflow-02-weekly-report.json": build_weekly_report,
    "workflow-03-followup.json": build_followup,
    "workflow-04-stock-alert.json": build_stock_alert,
    "workflow-05-broadcast.json": build_broadcast,
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Génère les 5 workflows n8n pour AfriBot."
    )
    parser.add_argument(
        "--output-dir",
        default=os.path.join(os.path.dirname(__file__), "workflows"),
        help="Répertoire de sortie des fichiers JSON workflow.",
    )
    args = parser.parse_args()

    out_dir = os.path.realpath(args.output_dir)
    os.makedirs(out_dir, exist_ok=True)

    for filename, builder in WORKFLOWS.items():
        workflow = builder()
        path = os.path.join(out_dir, filename)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(workflow, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print("%s (%s)" % (filename, "OK"))

    print("\nGeneration terminee : %d workflow(s) dans %s" % (len(WORKFLOWS), out_dir))


if __name__ == "__main__":
    main()
