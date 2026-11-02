#!/bin/sh
# Runs after `azd provision`: writes .env for local development and creates the Foundry agent.
set -e
cd "$(dirname "$0")/.."

echo "Writing .env from the azd environment..."
: > .env
for key in AZURE_VOICELIVE_ENDPOINT FOUNDRY_PROJECT_ENDPOINT FOUNDRY_PROJECT_NAME MODEL_DEPLOYMENT_NAME AGENT_NAME; do
  echo "$key=$(azd env get-value "$key")" >> .env
done

if [ ! -x .venv/bin/python ]; then
  echo "Creating .venv..."
  python3 -m venv .venv
fi
.venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt

echo "Creating the Foundry prompt agent (role assignments can take a minute to propagate)..."
attempt=1
while [ $attempt -le 5 ]; do
  if .venv/bin/python agent/create_agent.py; then exit 0; fi
  echo "Attempt $attempt failed, retrying in 30 seconds..."
  attempt=$((attempt + 1))
  sleep 30
done
exit 1
