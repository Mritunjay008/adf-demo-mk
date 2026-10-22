import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { artifactTypes, sqlRuntimeSecrets, targetForEvent, visit } from './prepare-adf.mjs';

export function checkArtifacts(env, template, parameters, phase, execute = execFileSync) {
  const target = targetForEvent(env, true);
  if (!['prepare', 'verify'].includes(phase)) throw new Error('Expected prepare or verify phase.');
  if (!env.SUBSCRIPTION || !env.RESOURCE_GROUP) throw new Error('Subscription and resource group are required.');
  if (parameters.parameters?.factoryName?.value !== target.factory ||
      !Array.isArray(template.resources) || template.resources.some(resource =>
        !artifactTypes.includes(resource.type) || resource.resources?.length ||
        !resource.name.startsWith(`${target.factory}/`)))
    throw new Error('Prepared artifacts do not match the allowed target/scope.');
  if (!template.resources.length) {
    console.log('No scoped artifacts to deploy; existing target artifacts remain unchanged.');
    return;
  }
  const az = args => {
    const cli = process.platform === 'win32'
      ? 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az'
      : 'az';
    const text = execute(cli, [...args, '--only-show-errors', '-o', 'json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return text.trim() ? JSON.parse(text) : null;
  };
  const factoryId = `/subscriptions/${env.SUBSCRIPTION}/resourceGroups/${env.RESOURCE_GROUP}/providers/Microsoft.DataFactory/factories/${target.factory}`;
  const get = path => az(['rest', '--method', 'get', '--url',
    `https://management.azure.com${factoryId}/${path}?api-version=2018-06-01`]);
  if (phase === 'prepare') {
    const linkedServices = new Set();
    const runtimes = new Set();
    visit(template.resources, node => {
      if (node.type === 'LinkedServiceReference') linkedServices.add(node.referenceName);
      if (node.type === 'IntegrationRuntimeReference') runtimes.add(node.referenceName);
    });
    for (const name of linkedServices) {
      const service = get(`linkedservices/${encodeURIComponent(name)}`);
      if (!service?.properties) throw new Error(`Linked service missing in target factory: ${name}`);
      if (name.startsWith('ls_sql_') || name.startsWith('ls_adls_')) {
        if (service.properties.connectVia?.referenceName !== target.runtime)
          throw new Error(`${name} must use ${target.runtime}.`);
        runtimes.add(target.runtime);
      }
      if (name.startsWith('ls_kv_') && service.properties.type !== 'AzureKeyVault')
        throw new Error(`${name} must be an AzureKeyVault linked service.`);
    }
    for (const name of runtimes) {
      if (name !== target.runtime) throw new Error(`Unexpected target runtime: ${name}`);
      get(`integrationruntimes/${encodeURIComponent(name)}`);
    }
    return;
  }
  for (const resource of template.resources) {
    const kind = resource.type.split('/').at(-1);
    const name = resource.name.slice(target.factory.length + 1);
    const item = get(`${kind}/${encodeURIComponent(name)}`);
    if (!item?.properties) throw new Error(`Target artifact missing after deployment: ${name}`);
    if (kind === 'linkedServices' && item.properties.type !== resource.properties.type)
      throw new Error(`Wrong target linked service type: ${name}`);
    if (kind === 'linkedServices' && name.startsWith('ls_sql_') &&
        item.properties.connectVia?.referenceName !== target.runtime)
      throw new Error(`Wrong target runtime on linked service: ${name}`);
    if (kind === 'linkedServices' && target.branch === 'qa' && name === 'ls_sql_source_qa') {
      if (!item.properties.typeProperties?.connectionString?.match(/\buser\s*id\s*=\s*adf_qa_reader\b/i) ||
          item.properties.typeProperties?.password?.secretName !== sqlRuntimeSecrets.qa.sourceSecret)
        throw new Error('Wrong QA SQL source credentials mapping.');
    }
    if (kind === 'linkedServices' && target.branch === 'qa' && name === 'ls_sql_destination_qa') {
      if (!item.properties.typeProperties?.connectionString?.match(/\buser\s*id\s*=\s*adf_qa_writer\b/i) ||
          item.properties.typeProperties?.password?.secretName !== sqlRuntimeSecrets.qa.destinationSecret)
        throw new Error('Wrong QA SQL destination credentials mapping.');
    }
    if (kind === 'datasets' &&
        item.properties.linkedServiceName?.referenceName !== resource.properties.linkedServiceName?.referenceName)
      throw new Error(`Wrong target linked service: ${name}`);
    if (target.branch === 'qa' && kind === 'datasets' && name === 'DelimitedText_sink' &&
        (item.properties.typeProperties?.location?.fileSystem !== 'sink' ||
         item.properties.typeProperties?.location?.folderPath !== 'qa/output'))
      throw new Error('Wrong QA output path.');
    if (target.branch === 'qa' && kind === 'datasets' && name === 'SqlTable_destination_customers' &&
        item.properties.typeProperties?.schema !== 'qa')
      throw new Error('Wrong QA SQL destination schema.');
  }
  console.log(`${target.factory}: Incremental scoped artifact deployment verified.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  targetForEvent(process.env, true);
  const read = name => JSON.parse(fs.readFileSync(`build/adf/${name}.json`, 'utf8'));
  const template = read('template');
  checkArtifacts(process.env, template, read('parameters'), process.argv[2]);
  if (process.argv[2] === 'prepare') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `has-resources=${template.resources.length > 0}\n`);
  }
}
