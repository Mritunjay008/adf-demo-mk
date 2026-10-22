# adf-demo-mk

Azure Data Factory artifact CI/CD, reset for a fresh start on 22 October 2026.

## Current baseline

The previous ADF definitions have been removed. The configured ADF source root
is still `/adfdev`; it will be populated when new definitions are saved on a
feature branch. Git does not track empty directories, so the source root may
be absent in a fresh checkout.

Infrastructure is managed in the separate Terraform workspace. The reset
baseline contains only these resources in Central India:

| Resource | Name |
| --- | --- |
| Resource group | `rg-adf-poc` |
| Dev factory | `adf-poc-dev-mk-001` |
| QA factory | `adf-poc-qa-mk-001` |

Both factories have system-assigned managed identities. Dev Git configuration
is a separate user-managed setup step and must be reflected in Terraform before
future applies. QA must not be connected to Git.

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
- `adfdev`: future ADF source definitions, currently empty.
- `build`: ignored, generated deployment files and export tooling.
- [Historical POC summary](POC-SUMMARY.md) and [historical phases](phases.md):
  pre-reset records, not current setup instructions.

SQL setup is manual and outside this repository's automation. No database setup
scripts are included. The retained preparation/checking code still contains
the previous bounded SQL/ADLS mappings; review those assumptions against the
new design before enabling deployment.

## Next steps

1. Configure/confirm Dev Git integration with collaboration branch `dev`, root
   `/adfdev`, import disabled and a feature working branch.
2. Recreate the deployment identity, Dev/QA OIDC trust, Azure permissions and
   GitHub repository variables.
3. Agree on the new pipeline and its dependencies. Prepare SQL resources,
   secrets, access and connectivity manually as required.
4. Save new ADF definitions on a feature branch and align the deployment
   mappings and preflight checks with those resources.
5. Validate a non-empty export, then remove the deployment pause in a reviewed PR.
6. Test Dev first, then promote to QA. Pipeline execution needs separate approval.

## Local validation

Requires Node.js 22 and Bash. On Windows the tests locate Git Bash through
`git --exec-path`.

```powershell
node --test scripts\adf.test.mjs
```

Tests use synthetic ARM exports, mocked Azure responses and isolated Bash
bootstrap checks. They do not create Azure resources or run ADF pipelines.