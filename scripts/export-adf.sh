#!/usr/bin/env bash
set -euo pipefail

: "${SUBSCRIPTION:?SUBSCRIPTION is required}"
: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${DEV_FACTORY:?DEV_FACTORY is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"

source_json=""
if [[ -d "$GITHUB_WORKSPACE/adfdev" ]]; then
  source_json=$(find "$GITHUB_WORKSPACE/adfdev" -type f -name '*.json' -print -quit)
elif [[ -e "$GITHUB_WORKSPACE/adfdev" ]]; then
  echo "ADF source path must be a directory: $GITHUB_WORKSPACE/adfdev" >&2
  exit 1
fi

if [[ -z "$source_json" ]]; then
  echo "No ADF source JSON found. Bootstrap only: export and deployment are skipped; existing build files are not used."
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'has-source=false\n' >> "$GITHUB_OUTPUT"
  fi
  exit 0
fi

npm install --prefix build/adf-tools --ignore-scripts @microsoft/azure-data-factory-utilities@1.0.3
node build/adf-tools/node_modules/@microsoft/azure-data-factory-utilities/lib/index \
  export "$GITHUB_WORKSPACE/adfdev" \
  "/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.DataFactory/factories/$DEV_FACTORY" \
  "build/export"
test -s build/export/ARMTemplateForFactory.json
test -s build/export/ARMTemplateParametersForFactory.json
node scripts/prepare-adf.mjs
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'has-source=true\n' >> "$GITHUB_OUTPUT"
fi
