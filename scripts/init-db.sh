#!/bin/bash
# =============================================================================
# AfriBot — initialisation des bases de données PostgreSQL
# Crée les bases supplémentaires au démarrage de PostgreSQL.
# Ce script est exécuté automatiquement par l'image postgres officielle
# lors du PREMIER démarrage (dossier docker-entrypoint-initdb.d/, volume vide).
# =============================================================================

set -e

# Bases supplémentaires à créer (variable du docker-compose.yml).
# Défaut : chatwoot_db si POSTGRES_MULTIPLE_DATABASES n'est pas défini.
MULTIPLE_DBS="${POSTGRES_MULTIPLE_DATABASES:-chatwoot_db}"

# Fonction de création de base si elle n'existe pas
create_db_if_not_exists() {
  local DB_NAME=$1
  echo "Vérification de la base de données : $DB_NAME"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE $DB_NAME'
    WHERE NOT EXISTS (
      SELECT FROM pg_database WHERE datname = '$DB_NAME'
    )\gexec
    GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $POSTGRES_USER;
EOSQL
  echo "Base $DB_NAME prête."
}

# Crée chaque base listée dans POSTGRES_MULTIPLE_DATABASES (séparées par espaces ou virgules)
for DB in $(echo "$MULTIPLE_DBS" | tr ',' ' '); do
  create_db_if_not_exists "$DB"
done

# La base AfriBot (${POSTGRES_DB}) est créée automatiquement
# par la variable POSTGRES_DB de l'image officielle postgres

echo "Initialisation des bases de données terminée."