# -*- mode: powershell -*-
# workflow-02 : AfriBot — Rapport hebdomadaire
$fn = 'c:\BOT-WHATSAPP\n8n\workflows\workflow-02-weekly-report.json'
$w = @'
{
  "name": "AfriBot — Rapport hebdomadaire",
  "nodes": [
    {
      "parameters": {
        "triggerTimes": {
          "mode": "everyWeek",
          "cronExpression": "0 6 * * 1",
          "daysFilter": []
        }
      },
      "id": "schedule-weekly",
      "name": "Planifier lundi 06:00 GMT",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [260, 300]
    },
    {
      "parameters": {
        "url": "={{ $env.AFRIBOT_API_URL }}/api/stats/weekly",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "Bearer {{ $env.AFRIBOT_JWT }}"
            }
          ]
        },
        "options": {}
      },
      "id": "fetch-weekly",
      "name": "AfriBot /api/stats/weekly",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.1,
      "position": [500, 300]
    },
    {
      "parameters": {
        "sender": "={{ $env.MERCHANT_PHONE }}",
        "receiver": "={{ $node[\"make-senders\"].output }}",
        "text": "📊 Rapport hebdomadaire · {{ $now.toFormat(\"dd/MM/yyyy\") }} GMT\n\n💰 CA semaine : {{ $json.weekly_revenue?.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, \" \") ?? \" —\" }} FCFA\n📦 Commandes : {{ $json.weekly_orders_count ?? 0 }}\n✅ Paiements confirmés : {{ $json.weekly_payments_count ?? 0 }}\n📦 Stock bas : {{ $json.low_stock_count ?? 0 }} articles",
        "options": {}
      },
      "id": "send-weekly",
      "name": "Envoyer rapport hebdomadaire",
      "type": "n8n-nodes-base.evolutionApi",
      "typeVersion": 2,
      "position": [760, 300],
      "credentials": {
        "evolutionApi": {
          "id": "evo-cred",
          "name": "Evolution API"
        }
      }
    }
  ],
  "connections": {
    "Planifier lundi 06:00 GMT": {
      "main": [[{"node": "AfriBot /api/stats/weekly", "type": "main", "index": 0}]]
    },
    "AfriBot /api/stats/weekly": {
      "main": [[{"node": "Envoyer rapport hebdomadaire", "type": "main", "index": 0}]]
    }
  },
  "meta": {
    "instanceId": "afribot-n8n",
    "templateDemonstration": false
  }
}
'@

Set-Content -Path $fn -Value $w -Encoding UTF8 -NoNewline
Write-Host "✓ workflow-02-weekly-report.json"
