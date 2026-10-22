# Bounded ADF artifact CI/CD

Work on separate `feature/*` branches, open reviewed PRs into `dev`, then promote
`dev` to `qa` through a PR. Do not push directly to `dev` or use ADF Studio Publish.
Repository rulesets/branch protection must enforce PR-only changes separately;
the workflow cannot distinguish a merge push from a direct push.

PRs targeting `dev` validate the proposed merge checkout with Node tests and
ADF Utilities export. This job has read-only repository permissions, no OIDC
permission, no Azure login and no deployment. When ADF source JSON exists,
export requires network access to npm and Microsoft's public ADF utility bundle,
but no Azure deployment credentials.

Azure deployment is unconditionally paused by `false &&` in the deployment
job's condition. Repository variables cannot bypass this pause. Remove the prefix
only in a reviewed change after the new prerequisites are ready and approved;
the remaining condition then permits only pushes to `dev`/`qa`.
An absent source root or a source root with no JSON files is an explicit,
successful bootstrap no-op. `export-adf.sh` writes `has-source=false` to
`GITHUB_OUTPUT` when available, skips npm/export/preparation and never reads
existing build files. The workflow skips Azure login and all deployment checks
for that case. A source path that exists but is not a directory fails explicitly.

With source present, the deployment job uses OIDC repository variables
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and per-environment
concurrency. Recreate and verify the deployment identity and permissions before
enabling it. `export-adf.sh` writes `has-source=true` only after export and
preparation succeed. It uses
ADF Utilities **1.0.3** with the required **relative** `build/export` output.
`prepare-adf.mjs` preserves generated parameters/variables/functions, rebuilds
artifact dependencies and writes `build/adf/template.json` and `parameters.json`.
`check-adf.mjs` checks external dependencies and deployed artifacts using only
GET requests. The existing `azure/bicep-deploy@v2` actions perform ARM validation
and creation. Their shared `createDeploymentDefinition` explicitly sets
`properties.mode: "Incremental"` for both operations, with no workflow input
that can select Complete mode. Verified on 22 October 2026 against `v2` at
`6c6f3b33210f45a96ef8fffc73b388cb8cfce32b` in the action's
[deployment implementation](https://github.com/Azure/bicep-deploy/blob/6c6f3b33210f45a96ef8fffc73b388cb8cfce32b/packages/bicep-deploy-common/src/deployments.ts).
The existing `@v2` tag is retained; recheck this contract when upgrading it.
Azure CLI/action failures fail the job; no pipeline is executed.

The retained preparation code supports datasets, pipelines and approved linked services. Factory and
integration runtime definitions are excluded. External ADLS linked services and
IRs must already exist. The approved linked-service scope is:
`ls_kv_dev`, `ls_sql_source_dev`, `ls_sql_destination_dev` (mapped per target).
QA maps `ls_adls_dev` to `ls_adls_qa`, `ls_kv_dev` to `ls_kv_qa`,
`ls_sql_source_dev` to `ls_sql_source_qa`, `ls_sql_destination_dev` to
`ls_sql_destination_qa`, `ir-azure-dev` references to `ir-azure-qa`,
`DelimitedText_sink` to `sink/qa/output`, SQL sink schema `dev` to `qa`,
and SQL secret/user references to QA values. Unsupported resource types,
dynamic artifact references and missing Git references fail explicitly.

These mappings are compatibility behavior, not fresh resource definitions.
Review them against the new artifacts before enabling deployment. The current
preflight also expects referenced linked services to exist already in the target;
resolve that bootstrap requirement before the first non-empty deployment.

SQL databases, schemas, tables, runtime users and permissions are prepared
manually by the user, outside ADF CI/CD. Matching runtime passwords must already
be available in Key Vault. This repository's deployment automation consumes
those existing resources; it does not run database setup or populate secrets.

Matching names update and new names create. Removing or renaming a Git artifact
**never automatically deletes the old live artifact**. There is no inventory,
blob lease, storage-state access or cleanup pass. Existing state containers and
blobs are not touched. An empty artifact set is a successful no-op. The workflow
does not change ADF collaboration settings, infrastructure, trigger state or
existing artifacts whose definitions are absent from the deployment.

Run the offline checks from the repository root with Node.js 22 and Bash.
On Windows, Git Bash is located through `git --exec-path`:

```powershell
node --test scripts\adf.test.mjs
```

These checks use synthetic ARM fixtures rather than deployment source files, so
removing all `adfdev` definitions does not break the tests. Bash checks run in
temporary workspaces with npm, node and az stubbed to fail if called unexpectedly;
they cover absent/empty source, stale build files, invalid source paths and
exporter failure propagation without network access or Azure login.
They do not prove live RBAC, OIDC, ADF service validation or successful Azure
deployment. Azure deployment and pipeline execution require separate approval.
