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

Deployment enablement was explicitly approved after the OIDC identity and
scoped Azure permissions were configured. The deployment job permits only
pushes to `dev`/`qa`; feature pushes and PRs cannot enter it. Merge the reviewed
enablement change to `dev` to trigger a new deployment run. A deployment job
skipped on a PR is expected, and re-running an old skipped push run still uses
that run's original workflow revision.
An absent source root or a source root with no JSON files is an explicit,
successful bootstrap no-op. `export-adf.sh` writes `has-source=false` to
`GITHUB_OUTPUT` when available, skips npm/export/preparation and never reads
existing build files. The workflow skips Azure login and all deployment checks
for that case. A source path that exists but is not a directory fails explicitly.

With source present, the deployment job uses OIDC repository variables
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and per-environment
concurrency. The first enabled push run must verify Azure login and ARM access;
configuration alone is not proof of working authentication.
`export-adf.sh` writes `has-source=true` only after export and
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

The preparation code deploys datasets and pipelines only. Factory, integration
runtime and all linked-service definitions are excluded from the final ARM
template; Terraform owns these resources. Complete definitions can remain in
Git as export/authoring context without becoming deployment targets.
The current `adfdev` snapshots include the Dev factory, `ir-azure-dev` and the
three Dev Key Vault/SQL linked services. They must be pushed to the selected
feature branch before those services appear in ADF Studio Git mode. Refresh
the snapshots when their Terraform-managed settings change; do not edit their
connection settings independently in Git or deploy them through artifact CI/CD.
The current deployable source consists of `SqlTable_source_customers`,
`SqlTable_destination_customers` and `pl_sql_copy_customers`. The Copy activity
uses explicit three-column mappings, insert-only writes and no automatic retries;
no pre-copy cleanup or table creation is configured.
ADF Studio Save all authorization is unresolved; the approved authoring route
is normal Git commits/pushes on the feature branch, not Studio Publish.
QA maps `ls_adls_dev` to `ls_adls_qa`, `ls_kv_dev` to `ls_kv_qa`,
`ls_sql_source_dev` to `ls_sql_source_qa`, `ls_sql_destination_dev` to
`ls_sql_destination_qa`, `ir-azure-dev` references to `ir-azure-qa`,
`DelimitedText_sink` to `sink/qa/output` and SQL sink schema `dev` to `qa`.
Complete connection-string secret references are configured per environment in
Terraform, not rewritten in the artifact template. The operator supplies each
secret's server, database and credentials privately in Key Vault. Unsupported resource types,
dynamic artifact references and missing Git references fail explicitly.

Preflight expects all referenced linked services and IRs to exist in the target.
It reads the external SQL linked services, validates runtime and the complete
connection-string secret references, and follows their Key Vault references to
validate those linked services too. SQL services must use an AzureKeyVaultSecret
connectionString with the expected environment/role secret and vault reference,
without a separate password property. Inline or redacted connection strings and
legacy split-password configuration are rejected in this mode.
The hidden secret contents, including server/database/username/password, are
not inspected by preflight; connection tests are required to validate them.
It uses only ARM GET requests; it does not read secret values, authenticate to
SQL, test firewall connectivity or prove SQL permissions.
Review compatibility mappings against new artifacts before enabling deployment.

SQL databases, schemas, tables, runtime users and permissions are prepared
manually by the user, outside ADF CI/CD. Matching complete SQL connection strings
must already be available in Key Vault. The temporary demo's administrator
credentials are not least privilege, even with secret-scoped ADF access.
This repository's deployment automation consumes
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
