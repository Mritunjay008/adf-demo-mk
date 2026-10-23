# adf-demo-mk

Azure Data Factory artifact CI/CD, reset for a fresh start on 22 October 2026.

## Current baseline

The previous ADF definitions have been removed. The source root `/adfdev` now
contains the current Dev factory, managed IR and three linked-service definitions
as safe Git authoring/export context. They contain Key Vault references, not
secret values. The source also contains the two SQL datasets and a single
insert-only Copy Customers pipeline, authored through the normal Git workflow.

ADF Studio can read the feature branch, but its **Save all** GitHub commit
authorization currently fails even after reconnecting. That issue is not fixed
by Git-file authoring. Until it is resolved, save definition changes in the
repository using the already-authorized Git client rather than repeatedly
reconnecting or weakening repository protections. Back up unsaved ADF drafts
before refreshing to load pushed definitions.

Infrastructure is managed in the separate Terraform workspace. The basic
Terraform configuration contains these resources in Central India:

| Resource | Name |
| --- | --- |
| Resource group | `rg-adf-poc` |
| Dev factory | `adf-poc-dev-mk-001` |
| QA factory | `adf-poc-qa-mk-001` |
| Dev Azure integration runtime | `ir-azure-dev` |
| QA Azure integration runtime | `ir-azure-qa` |
| SQL connection-string Key Vault | `kv-adfpocmk-4d070b73` |
| Dev linked services | `ls_kv_dev`, `ls_sql_source_dev`, `ls_sql_destination_dev` |
| QA linked services | `ls_kv_qa`, `ls_sql_source_qa`, `ls_sql_destination_qa` |

Both factories have system-assigned managed identities. Dev is connected to
GitHub repository `Mritunjay008/adf-demo-mk`, with collaboration branch `dev`,
root `/adfdev` and Studio publishing disabled. Terraform preserves that existing
configuration. QA is not connected to Git.

The SQL server `sql-adf-poc-mk-4d070b73` and databases
`sqldb-adf-poc-source` / `sqldb-adf-poc-destination` are managed manually,
not by this Terraform workspace. Each complete SQL connection string is stored
manually in Key Vault and referenced by name. Terraform owns all linked services;
ADF artifact CI/CD owns datasets and pipelines only. OIDC setup is still pending.

Terraform creates a Standard, RBAC-enabled Key Vault and grants its current
Azure user the vault-scoped Key Vault Secrets Officer role for manual secret
management. It does not create, read or output any secret values. Each ADF
identity gets Key Vault Secrets User access only at its two SQL connection-string
scopes, not across the shared vault. Separate environment vaults should be
considered beyond this basic POC.

SQL linked services use the environment's Azure IR and Key Vault linked service.
They use `key_vault_connection_string`, with no inline connection string or
separate password reference. Terraform does not read the secret values or store
the complete strings in state.

| Linked service | Complete connection-string secret |
| --- | --- |
| `ls_sql_source_dev` | `sql-dev-source-connection-string` |
| `ls_sql_destination_dev` | `sql-dev-destination-connection-string` |
| `ls_sql_source_qa` | `sql-qa-source-connection-string` |
| `ls_sql_destination_qa` | `sql-qa-destination-connection-string` |

The old password-only secrets were soft-deleted, not purged. Do not run the old
reader-password repair helper; it references a retired secret.

The user selected `pocsqladmin` for temporary, disposable demo connections.
An administrator connection grants full SQL privileges regardless of the
secret-level RBAC scopes; it does not provide reader/writer or Dev/QA SQL
isolation. Replace it with least-privilege accounts before any production or
real-data use. Never share the complete strings in chat or commit them to Git.

SQL firewall access must allow the Azure IR before connection tests can pass;
this automation does not change the manually managed SQL network rules.

On 23 October 2026, ADF connection tests succeeded for all four SQL linked
services in Dev and QA. These tests validate connectivity/authentication only;
no copy pipeline was run and no table data was moved.

The basic vault uses public connectivity with RBAC authorization, seven-day
soft-delete retention and no purge protection. Terraform will not automatically
purge or recover deleted vaults. Review network restrictions and purge protection
before using this resettable POC design for production.

## Bootstrap safety

Azure deployment is unconditionally paused by the `false &&` condition on the
workflow's deployment job. Repository variables cannot override this pause.
Remove that prefix only in a reviewed change after the new deployment
prerequisites are ready and approved.

Pull requests into `dev` still run tests and source validation without Azure
login. If `/adfdev` is absent or contains no JSON files, export reports a
bootstrap no-op: it does not install export tools, generate ARM templates or
consume old build output. Even when deployment is enabled, an empty source
skips Azure login and deployment.

## Branching

1. Make changes on `feature/*`; never commit or push directly to `dev`.
2. Open a reviewed PR into `dev`, the default and ADF collaboration branch.
3. After bootstrap is complete and the deployment pause is removed, merging into `dev`
   deploys Dev.
4. Promote `dev` to `qa` through a PR to deploy QA.

Enforce PR-only changes with GitHub branch protection/rulesets. Do not use
ADF Studio Publish for this CI/CD flow. Keep the default `adf_publish` setting
if needed; that branch is not used by the workflow.

## Repository contents

- [Workflow](.github/workflows/deploy-dev.yml): PR validation and gated deployment.
- [Scripts](scripts/README.md): export, template preparation, checks and tests.
- [adfdev](adfdev): datasets/pipeline plus Terraform-owned authoring context.
- `build`: ignored, generated deployment files and export tooling.

SQL setup is manual and outside this repository's automation. No database setup
scripts are included. The retained preparation/checking code still contains
the previous bounded SQL/ADLS mappings; review those assumptions against the
new design before enabling deployment. Complete definitions remain export
context when saved to Git, but factory, IR and all linked-service resources
are excluded from the final ARM deployment.

## SQL copy flow

| Definition | Purpose |
| --- | --- |
| [SqlTable_source_customers](adfdev/dataset/SqlTable_source_customers.json) | Reads `dbo.Customers` through `ls_sql_source_dev` |
| [SqlTable_destination_customers](adfdev/dataset/SqlTable_destination_customers.json) | Writes `dev.Customers` through `ls_sql_destination_dev` |
| [pl_sql_copy_customers](adfdev/pipeline/pl_sql_copy_customers.json) | Copies `CustomerId`, `FullName` and `Email` with explicit mappings |

QA preparation maps the linked services to their `_qa` counterparts and the
destination schema to `qa`. Each target ARM template contains only these two
datasets and this pipeline; the factory, IR and linked services remain excluded.

The copy is insert-only, has no automatic retries, and uses existing tables.
It does not truncate, delete, recreate or upsert data. Do not run it repeatedly
against the same primary keys; duplicates will fail. Pipeline execution and
the initial empty-destination check need separate approval.

## Next steps

1. Review the Git-authored datasets and pipeline on the feature branch. After
   the push is verified, select that branch and refresh ADF Studio to load them;
   retain backups before discarding unsaved local drafts. Do not Publish or Debug.
2. Terraform still owns the factory, IR and linked services; artifact CI/CD
   excludes them. Refresh context snapshots when Terraform changes their settings.
   Never put secret values in Git, chat, Terraform inputs or state.
3. Recreate the deployment identity, Dev/QA OIDC trust,
   Azure permissions and GitHub repository variables.
4. Validate a non-empty export, then remove the deployment pause in a reviewed PR.
5. Promote the completed feature work to Dev, test it, then promote to QA.
   Pipeline execution needs separate approval.

## Local validation

Requires Node.js 22 and Bash. On Windows the tests locate Git Bash through
`git --exec-path`.

```powershell
node --test scripts\adf.test.mjs
```

Tests use synthetic ARM exports, mocked Azure responses and isolated Bash
bootstrap checks. They do not create Azure resources or run ADF pipelines.