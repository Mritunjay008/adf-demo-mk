import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareArtifacts, sqlConnectionSecrets, targetForEvent } from './prepare-adf.mjs';
import { checkArtifacts } from './check-adf.mjs';

const root = new URL('../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');
const prefix = 'Microsoft.DataFactory/factories';
const envFor = branch => ({
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/heads/${branch}`,
  SUBSCRIPTION: 'test-subscription', RESOURCE_GROUP: 'test-group',
});

function exported() {
  const reference = (type, name) => ({ type: `${type}Reference`, referenceName: name });
  const artifact = (kind, name, properties) => ({
    type: kind ? `${prefix}/${kind}` : prefix,
    name: `[concat(parameters('factoryName'), '/${name}')]`,
    properties,
    dependsOn: ['old-generated-dependency'],
  });
  const resources = [
    artifact('', 'test-factory', {}),
    artifact('integrationRuntimes', 'ir-azure-dev', { type: 'Managed' }),
    artifact('linkedServices', 'ls_adls_dev', {
      type: 'AzureBlobFS',
      connectVia: reference('IntegrationRuntime', 'ir-azure-dev'),
      typeProperties: { url: 'https://example.dfs.core.windows.net' },
    }),
    artifact('linkedServices', 'ls_kv_dev', {
      type: 'AzureKeyVault',
      typeProperties: { baseUrl: 'https://example.vault.azure.net/' },
    }),
  ];
  for (const role of ['source', 'destination']) {
    resources.push(artifact('linkedServices', `ls_sql_${role}_dev`, {
      type: 'AzureSqlDatabase',
      connectVia: reference('IntegrationRuntime', 'ir-azure-dev'),
      typeProperties: {
        connectionString: {
          type: 'AzureKeyVaultSecret', secretName: sqlConnectionSecrets.dev[role],
          store: reference('LinkedService', 'ls_kv_dev'),
        },
      },
    }));
  }
  for (const [name, fileSystem, folderPath] of [
    ['DelimitedText_source', 'source', 'input'],
    ['DelimitedText_sink', 'sink', 'output'],
  ]) {
    resources.push(artifact('datasets', name, {
      type: 'DelimitedText',
      linkedServiceName: reference('LinkedService', 'ls_adls_dev'),
      typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem, folderPath } },
    }));
  }
  for (const [role, schema] of [['source', 'dbo'], ['destination', 'dev']]) {
    resources.push(artifact('datasets', `SqlTable_${role}_customers`, {
      type: 'AzureSqlTable',
      linkedServiceName: reference('LinkedService', `ls_sql_${role}_dev`),
      typeProperties: { schema, table: 'Customers' },
    }));
  }
  for (const [name, input, output] of [
    ['pl_dev_copy_test', 'DelimitedText_source', 'DelimitedText_sink'],
    ['pl_sql_copy_customers', 'SqlTable_source_customers', 'SqlTable_destination_customers'],
  ]) {
    resources.push(artifact('pipelines', name, {
      activities: [{
        name: 'copy', type: 'Copy',
        inputs: [reference('Dataset', input)], outputs: [reference('Dataset', output)],
      }],
    }));
  }
  return {
    template: {
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      parameters: { factoryName: { type: 'string' }, generatedSetting: { type: 'string' } },
      variables: { generated: "[parameters('generatedSetting')]" },
      functions: [], resources,
    },
    parameters: { parameters: { factoryName: { value: 'source' }, generatedSetting: { value: 'keep-me' } } },
  };
}

function runExport(t, setup) {
  const workspace = fs.mkdtempSync(path.join(tmpdir(), 'adf-bootstrap-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const bin = path.join(workspace, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['npm', 'node', 'az']) {
    const command = path.join(bin, name);
    fs.writeFileSync(command, `#!/usr/bin/env bash\nprintf '${name}' > tool-called.txt\nexit 97\n`);
    fs.chmodSync(command, 0o755);
  }
  const templatePath = path.join(workspace, 'build', 'adf', 'template.json');
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(templatePath, '{"resources":[{"name":"stale"}]}');
  setup(workspace);

  const bash = process.platform === 'win32'
    ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
      '..', '..', '..', 'bin', 'bash.exe')
    : 'bash';
  const env = {
    ...process.env, SUBSCRIPTION: 'test-subscription', RESOURCE_GROUP: 'test-group',
    DEV_FACTORY: 'test-factory', GITHUB_WORKSPACE: '.', GITHUB_OUTPUT: 'github-output.txt',
  };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const bashPaths = process.platform === 'win32'
    ? [path.dirname(bash), path.resolve(path.dirname(bash), '..', 'usr', 'bin')] : [];
  env[pathKey] = [bin, ...bashPaths, env[pathKey] || ''].join(path.delimiter);
  const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
    cwd: workspace, env, input: read('scripts/export-adf.sh'), encoding: 'utf8',
  });
  assert.ifError(result.error);
  return { workspace, result, templatePath };
}

function prepared(branch, source = exported()) {
  return prepareArtifacts(source.template, source.parameters, targetForEvent(envFor(branch)));
}

function mockAzure(branch, template, options = {}) {
  const target = targetForEvent(envFor(branch));
  const untouched = { name: 'absent-from-git', properties: { marker: 'preserve' } };
  const live = new Map([['pipelines/absent-from-git', untouched]]);
  for (const resource of template.resources)
    live.set(`${resource.type.split('/').at(-1)}/${resource.name.split('/').at(-1)}`, resource);

  const calls = [];
  const execute = (command, args) => {
    assert.ok(command === 'az' || command === 'az.cmd' || command.endsWith('\\az'));
    assert.deepEqual(args.slice(0, 3), ['rest', '--method', 'get']);
    calls.push(args);
    const url = args[args.indexOf('--url') + 1];
    assert.ok(url.startsWith(`https://management.azure.com/subscriptions/test-subscription/resourceGroups/test-group/providers/Microsoft.DataFactory/factories/${target.factory}/`));
    if (options.fail) throw new Error('Azure CLI failed');
    if (url.includes('/integrationruntimes/')) return '{}';
    if (url.includes('/linkedservices/')) {
      const linkedServiceName = decodeURIComponent(url.split('/').at(-1).split('?')[0]);
      if (options.missingLinkedService) return '{}';
      if (linkedServiceName.startsWith('ls_kv_'))
        return JSON.stringify({ properties: { type: options.wrongKeyVaultType ? 'WrongType' : 'AzureKeyVault' } });
      const properties = {
        type: linkedServiceName.startsWith('ls_adls_') ? 'AzureBlobFS' : 'AzureSqlDatabase',
        connectVia: { referenceName: options.wrongRuntime ? 'wrong' : target.runtime },
      };
      if (linkedServiceName.startsWith('ls_sql_')) {
        const role = linkedServiceName === target.linkedServiceMap.ls_sql_source_dev ? 'source' : 'destination';
        properties.typeProperties = {
          connectionString: {
            type: 'AzureKeyVaultSecret', secretName: sqlConnectionSecrets[branch][role],
            store: { type: 'LinkedServiceReference', referenceName: target.linkedServiceMap.ls_kv_dev },
          },
        };
        if (options.wrongSqlType) properties.type = 'WrongType';
        if ((options.wrongSourceSecret && role === 'source') ||
            (options.wrongDestinationSecret && role === 'destination'))
          properties.typeProperties.connectionString.secretName = 'wrong';
        if (options.crossEnvironmentSecret)
          properties.typeProperties.connectionString.secretName =
            sqlConnectionSecrets[branch === 'dev' ? 'qa' : 'dev'][role];
        if (options.wrongSecretType) properties.typeProperties.connectionString.type = 'SecureString';
        if (options.wrongVaultReference)
          properties.typeProperties.connectionString.store.referenceName = 'wrong';
        if (options.redactedConnection)
          properties.typeProperties.connectionString = { type: 'SecureString', value: '**********' };
        if (options.missingConnection) delete properties.typeProperties.connectionString;
        if (options.unsupportedConnection)
          properties.typeProperties.connectionString = { type: 'WrongType', value: 'not-a-connection' };
        if (options.inlineConnection)
          properties.typeProperties.connectionString = 'data source=example.database.windows.net';
        if (options.legacyPassword)
          properties.typeProperties.password = {
            type: 'AzureKeyVaultSecret', secretName: 'old-password',
            store: { type: 'LinkedServiceReference', referenceName: target.linkedServiceMap.ls_kv_dev },
          };
      }
      return JSON.stringify({ properties });
    }
    const key = url.split('?')[0].split('/').slice(-2).map(decodeURIComponent).join('/');
    if (options.missing) return '{}';
    const item = structuredClone(live.get(key));
    if (options.wrongService && key.startsWith('datasets/')) item.properties.linkedServiceName.referenceName = 'wrong';
    if (options.wrongPath && key === 'datasets/DelimitedText_sink') item.properties.typeProperties.location.folderPath = 'wrong';
    if (options.wrongSchema && key === 'datasets/SqlTable_destination_customers') item.properties.typeProperties.schema = 'dev';
    return JSON.stringify(item);
  };
  return { execute, calls, live, untouched };
}

for (const branch of ['dev', 'qa']) {
  test(`${branch}: preserve generated ARM data and map scoped artifacts`, () => {
    const source = exported();
    const before = structuredClone(source);
    const { template, parameters } = prepared(branch, source);
    const target = targetForEvent(envFor(branch));
    const originalScoped = before.template.resources.filter(resource => {
      const kind = resource.type.split('/').at(-1);
      return ['datasets', 'pipelines'].includes(kind);
    });

    assert.deepEqual(source, before);
    assert.equal(template.resources.length, originalScoped.length);
    assert.deepEqual(template.variables, source.template.variables);
    assert.deepEqual(template.parameters, source.template.parameters);
    assert.deepEqual(template.functions, source.template.functions);
    assert.equal(parameters.parameters.generatedSetting.value, 'keep-me');
    assert.equal(parameters.parameters.factoryName.value, target.factory);

    for (const resource of template.resources) {
      assert.ok(resource.name.startsWith(target.factory + '/'));
      assert.ok(['/datasets', '/pipelines'].some(kind => resource.type.endsWith(kind)));
      assert.ok(resource.dependsOn.every(value => !/linkedServices|integrationRuntimes/.test(value)));
      if (resource.type.endsWith('/datasets'))
        assert.ok(resource.properties.linkedServiceName.referenceName.endsWith(`_${branch}`));
    }

    const pipeline = template.resources.find(resource => resource.name.endsWith('/pl_sql_copy_customers'));
    assert.ok(pipeline.dependsOn.length >= 2);
    assert.ok(pipeline.dependsOn.every(value => value.includes(`'${target.factory}'`)));

    const sink = template.resources.find(resource => resource.name.endsWith('/DelimitedText_sink'));
    assert.equal(sink.properties.typeProperties.location.folderPath, branch === 'qa' ? 'qa/output' : 'output');
    assert.equal(sink.properties.typeProperties.location.fileSystem, 'sink');

    const sqlSink = template.resources.find(resource => resource.name.endsWith('/SqlTable_destination_customers'));
    assert.equal(sqlSink.properties.typeProperties.schema, branch === 'qa' ? 'qa' : 'dev');

    const sqlSource = template.resources.find(resource => resource.name.endsWith('/SqlTable_source_customers'));
    assert.equal(sqlSource.properties.linkedServiceName.referenceName, target.linkedServiceMap.ls_sql_source_dev);
    assert.equal(sqlSink.properties.linkedServiceName.referenceName, target.linkedServiceMap.ls_sql_destination_dev);
  });

  test(`${branch}: preflight and verification only GET; unlisted live artifacts survive`, () => {
    const { template, parameters } = prepared(branch);
    const mock = mockAzure(branch, template);
    checkArtifacts(envFor(branch), template, parameters, 'prepare', mock.execute);
    checkArtifacts(envFor(branch), template, parameters, 'verify', mock.execute);
    assert.ok(mock.calls.length >= 8);
    assert.equal(mock.live.get('pipelines/absent-from-git'), mock.untouched);
  });
}

test('Terraform-owned linked services never enter the artifact deployment', () => {
  const source = exported();
  source.template.resources.push({
    type: `${prefix}/linkedServices`,
    name: "[concat(parameters('factoryName'), '/another_external_service')]",
    properties: { type: 'AzureKeyVault' },
  });
  const { template, parameters } = prepared('dev', source);
  assert.equal(template.resources.length, 6);
  assert.ok(template.resources.every(resource => /\/(datasets|pipelines)$/.test(resource.type)));
  template.resources.push({
    type: `${prefix}/linkedServices`,
    name: 'adf-poc-dev-mk-001/ls_kv_dev',
    properties: { type: 'AzureKeyVault' },
  });
  assert.throws(() => checkArtifacts(envFor('dev'), template, parameters, 'prepare',
    () => assert.fail('Must reject before Azure access')), /allowed target\/scope/);
});

test('preflight validates full connection-string references without reading secret values', () => {
  for (const branch of ['dev', 'qa']) {
    const { template, parameters } = prepared(branch);
    const mock = mockAzure(branch, template);
    checkArtifacts(envFor(branch), template, parameters, 'prepare', mock.execute);
    assert.ok(mock.calls.some(args => args.some(value => value.includes(`/linkedservices/ls_kv_${branch}?`))));
    assert.ok(mock.calls.every(args => args[args.indexOf('--url') + 1].startsWith('https://management.azure.com/')));
    assert.throws(() => checkArtifacts(envFor(branch), template, parameters, 'prepare',
      mockAzure(branch, template, { crossEnvironmentSecret: true }).execute), /connection-string reference/);
  }
});

test('event gates reject PR deployment, wrong PR base/head checkout and unsupported push refs', () => {
  const pr = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'dev', GITHUB_REF: 'refs/pull/12/merge' };
  assert.equal(targetForEvent(pr).factory, 'adf-poc-dev-mk-001');
  assert.throws(() => targetForEvent(pr, true), /Only Dev/);
  for (const env of [
    { ...pr, GITHUB_BASE_REF: 'qa' }, { ...pr, GITHUB_REF: 'refs/heads/feature/test' },
    { ...envFor('dev'), GITHUB_EVENT_NAME: 'pull_request_target' },
    envFor('feature/test'), envFor('main'), { ...envFor('dev'), GITHUB_EVENT_NAME: 'workflow_dispatch' },
  ]) assert.throws(() => targetForEvent(env), /Only Dev/);
});

test('unsupported resources, dynamic/missing references and invalid export names fail explicitly', () => {
  const cases = [
    [source => source.template.resources.push({ type: `${prefix}/triggers` }), /Outside POC scope/],
    [source => source.template.resources.at(-1).name = 'unexpected', /Unexpected ARM resource name/],
    [source => source.template.resources.at(-1).properties.ref = { type: 'DatasetReference', referenceName: 'missing' }, /Missing reference/],
    [source => source.template.resources.at(-1).properties.ref = { type: 'LinkedServiceReference', referenceName: 'ls_unapproved_dev' }, /Unsupported linked service mapping/],
    [source => source.template.resources.at(-1).properties.ref = { type: 'DatasetReference', referenceName: '@dynamic' }, /static references/],
    [source => source.template.resources.at(-1).properties.ref = { type: 'DatasetReference', referenceName: "[parameters('name')]" }, /static references/],
    [source => source.template.resources.at(-1).properties.ref = { type: 'UnknownReference', referenceName: 'any' }, /Unsupported reference/],
    [source => source.template.resources.at(-1).properties.expression = '@pipeline().globalParameters.test', /global parameters/],
    [source => source.template.resources.push(structuredClone(source.template.resources.at(-1))), /Duplicate artifact/],
    [source => source.template.resources.at(-1).resources = [{}], /Nested ARM/],
  ];
  for (const [mutate, error] of cases) {
    const source = exported();
    mutate(source);
    assert.throws(() => prepared('qa', source), error);
  }
});

test('removing all scoped artifacts is a no-op without any Azure/state calls', () => {
  const source = exported();
  source.template.resources = source.template.resources.filter(resource => {
    if (!resource.type.endsWith('/linkedServices')) return /\/(factory|integrationRuntimes)$/.test(resource.type);
    return resource.name.includes('/ls_adls_dev');
  });
  const { template, parameters } = prepared('qa', source);
  assert.equal(template.resources.length, 0);
  checkArtifacts(envFor('qa'), template, parameters, 'prepare', () => assert.fail('Must not call Azure'));
  checkArtifacts(envFor('qa'), template, parameters, 'verify', () => assert.fail('Must not call Azure'));
});

test('an empty ARM resource list remains a no-op', () => {
  const source = exported();
  source.template.resources = [];
  const { template, parameters } = prepared('dev', source);
  assert.deepEqual(template.resources, []);
  for (const phase of ['prepare', 'verify'])
    checkArtifacts(envFor('dev'), template, parameters, phase, () => assert.fail('Must not call Azure'));
});

test('export skips absent or empty source without tools or stale templates', async t => {
  for (const source of ['absent', 'empty', 'non-json']) {
    await t.test(source, t => {
      const { workspace, result, templatePath } = runExport(t, workspace => {
        if (source === 'absent') return;
        fs.mkdirSync(path.join(workspace, 'adfdev'));
        if (source === 'non-json') {
          fs.writeFileSync(path.join(workspace, 'adfdev', 'notes.txt'), 'Not an ADF definition.');
          fs.mkdirSync(path.join(workspace, 'adfdev', 'directory.json'));
        }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /No ADF source JSON found/);
      assert.equal(fs.readFileSync(path.join(workspace, 'github-output.txt'), 'utf8'), 'has-source=false\n');
      assert.equal(fs.existsSync(path.join(workspace, 'tool-called.txt')), false);
      assert.equal(fs.readFileSync(templatePath, 'utf8'), '{"resources":[{"name":"stale"}]}');
      assert.equal(fs.existsSync(path.join(workspace, 'build', 'export')), false);
    });
  }
});

test('export rejects a non-directory source and fails when a populated export fails', async t => {
  await t.test('source path is a file', t => {
    const { workspace, result } = runExport(t, workspace => {
      fs.writeFileSync(path.join(workspace, 'adfdev'), 'Not a directory.');
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ADF source path must be a directory/);
    assert.equal(fs.existsSync(path.join(workspace, 'tool-called.txt')), false);
    assert.equal(fs.existsSync(path.join(workspace, 'github-output.txt')), false);
  });
  await t.test('JSON source reaches exporter and propagates failure', t => {
    const { workspace, result } = runExport(t, workspace => {
      fs.mkdirSync(path.join(workspace, 'adfdev', 'pipeline'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'adfdev', 'pipeline', 'example.json'), '{}');
    });
    assert.equal(result.status, 97, result.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, 'tool-called.txt'), 'utf8'), 'npm');
    assert.equal(fs.existsSync(path.join(workspace, 'github-output.txt')), false);
  });
});

test('populated export reports source only after export and preparation succeed', async t => {
  for (const prepareExit of [0, 96]) {
    await t.test(`preparation exit ${prepareExit}`, t => {
      const { workspace, result, templatePath } = runExport(t, workspace => {
        fs.mkdirSync(path.join(workspace, 'adfdev', 'pipeline'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'adfdev', 'pipeline', 'example.json'), '{}');
        fs.writeFileSync(path.join(workspace, 'bin', 'npm'),
          "#!/usr/bin/env bash\nprintf 'npm\\n' >> tool-sequence.txt\n");
        fs.writeFileSync(path.join(workspace, 'bin', 'node'), [
          '#!/usr/bin/env bash',
          'if [[ "$1" == "scripts/prepare-adf.mjs" ]]; then',
          "  printf 'prepare\\n' >> tool-sequence.txt",
          `  if [[ ${prepareExit} -ne 0 ]]; then exit ${prepareExit}; fi`,
          '  printf \'{"resources":[]}\' > build/adf/template.json',
          'else',
          "  printf 'export\\n' >> tool-sequence.txt",
          '  mkdir -p build/export',
          "  printf '{}' > build/export/ARMTemplateForFactory.json",
          "  printf '{}' > build/export/ARMTemplateParametersForFactory.json",
          'fi',
          '',
        ].join('\n'));
      });
      assert.equal(result.status, prepareExit, result.stderr);
      assert.equal(fs.readFileSync(path.join(workspace, 'tool-sequence.txt'), 'utf8'), 'npm\nexport\nprepare\n');
      const outputPath = path.join(workspace, 'github-output.txt');
      if (prepareExit === 0) {
        assert.equal(fs.readFileSync(outputPath, 'utf8'), 'has-source=true\n');
        assert.equal(fs.readFileSync(templatePath, 'utf8'), '{"resources":[]}');
      } else {
        assert.equal(fs.existsSync(outputPath), false);
      }
    });
  }
});

test('renames emit only the new artifact, never deletion instructions', () => {
  const source = exported();
  source.template.resources.find(resource => resource.type.endsWith('/pipelines')).name =
    "[concat(parameters('factoryName'), '/renamed_pipeline')]";
  const { template } = prepared('dev', source);
  assert.ok(template.resources.some(resource => resource.name.endsWith('/renamed_pipeline')));
  assert.ok(!template.resources.some(resource => resource.name.endsWith('/pl_dev_copy_test')));
  assert.ok(!JSON.stringify(template).includes('delete'));
});

test('target mismatch, CLI failures and post-deployment mapping failures fail closed', () => {
  const { template, parameters } = prepared('qa');
  assert.throws(() => checkArtifacts(envFor('dev'), template, parameters, 'prepare'), /allowed target/);
  assert.throws(() => checkArtifacts(envFor('qa'), template, parameters, 'invalid'), /Expected prepare/);
  for (const [options, phase, error] of [
    [{ fail: true }, 'prepare', /Azure CLI failed/],
    [{ wrongRuntime: true }, 'prepare', /must use ir-azure-qa/],
    [{ wrongKeyVaultType: true }, 'prepare', /must be an AzureKeyVault linked service/],
    [{ missingLinkedService: true }, 'prepare', /Linked service missing/],
    [{ wrongSqlType: true }, 'prepare', /Wrong QA SQL source connection-string reference/],
    [{ wrongSecretType: true }, 'prepare', /Wrong QA SQL source connection-string reference/],
    [{ wrongVaultReference: true }, 'prepare', /Wrong target Key Vault reference/],
    [{ missingConnection: true }, 'prepare', /connection-string reference/],
    [{ unsupportedConnection: true }, 'prepare', /connection-string reference/],
    [{ redactedConnection: true }, 'prepare', /connection-string reference/],
    [{ inlineConnection: true }, 'prepare', /connection-string reference/],
    [{ legacyPassword: true }, 'prepare', /connection-string reference/],
    [{ missing: true }, 'verify', /missing after deployment/],
    [{ wrongService: true }, 'verify', /Wrong target linked service/],
    [{ wrongPath: true }, 'verify', /Wrong QA output path/],
    [{ wrongSchema: true }, 'verify', /Wrong QA SQL destination schema/],
    [{ wrongSourceSecret: true }, 'prepare', /Wrong QA SQL source connection-string reference/],
    [{ wrongDestinationSecret: true }, 'prepare', /Wrong QA SQL destination connection-string reference/],
  ]) assert.throws(() => checkArtifacts(envFor('qa'), template, parameters, phase,
    mockAzure('qa', template, options).execute), error);
});

test('workflow enables only Dev/QA push deployment while keeping PR validation read-only', () => {
  const workflow = read('.github/workflows/deploy-dev.yml');
  assert.match(workflow, /pull_request:\s+branches: \[dev\]/);
  assert.match(workflow, /push:\s+branches: \[dev, qa\]/);
  const [beforeJobs, jobs] = workflow.split('\njobs:\n');
  assert.match(beforeJobs, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(beforeJobs, /id-token|write/);
  const [validation, deployment] = jobs.split('\n  deploy:\n');
  assert.match(validation, /if: github.event_name == 'pull_request' && github.base_ref == 'dev'/);
  assert.match(validation, /^    permissions:\n      contents: read\n    steps:/m);
  assert.doesNotMatch(validation, /azure\/|id-token|check-adf|secrets\.|persist-credentials:\s*true/);
  assert.match(deployment, /^    if: github.event_name == 'push' && \(github.ref == 'refs\/heads\/dev' \|\| github.ref == 'refs\/heads\/qa'\)$/m);
  assert.doesNotMatch(deployment, /if:\s*false\s*&&/);
  assert.match(deployment, /^    permissions:\n      contents: read\n      id-token: write\n    concurrency:/m);
  assert.match(deployment, /group: adf-\$\{\{ github.ref_name \}\}-deployment/);
  assert.equal((deployment.match(/uses: azure\/bicep-deploy@v2/g) || []).length, 2);
  assert.equal((deployment.match(/type: deployment\n/g) || []).length, 2);
  assert.match(deployment, /operation: validate/);
  assert.match(deployment, /operation: create/);
  assert.match(deployment, /uses: azure\/login@v2/);
  assert.match(deployment, /name: Export and prepare target artifacts\n\s+id: export\n\s+run: bash scripts\/export-adf.sh/);
  assert.match(deployment, /name: Sign in to Azure without a client secret\n\s+if: steps.export.outputs.has-source == 'true'\n\s+uses: azure\/login@v2/);
  assert.match(deployment, /name: Check existing linked services and integration runtimes\n\s+if: steps.export.outputs.has-source == 'true'\n\s+id: target/);
  assert.doesNotMatch(workflow, /operation: delete|deploymentStack|action-on-unmanage|STATE_CONTAINER|STATE_BLOB|storage blob|lease\.json|inventory\.json/);
  const exportScript = read('scripts/export-adf.sh');
  assert.match(exportScript, /azure-data-factory-utilities@1\.0\.3/);
  assert.match(exportScript, /\n  "build\/export"/);
  assert.doesNotMatch(exportScript, /"\$GITHUB_WORKSPACE\/build\/export"/);
});
