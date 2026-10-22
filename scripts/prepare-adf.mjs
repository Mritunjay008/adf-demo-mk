import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const prefix = 'Microsoft.DataFactory/factories';
const deployableLinkedServices = new Set(['ls_kv_dev', 'ls_sql_source_dev', 'ls_sql_destination_dev']);
const deployableKinds = new Set(['pipelines', 'datasets', 'linkedServices']);
export const artifactTypes = [...deployableKinds].map(kind => `${prefix}/${kind}`);
export const sqlRuntimeSecrets = {
  dev: {
    sourceUser: 'adf_dev_reader',
    sourceSecret: 'sql-dev-source-password',
    destinationUser: 'adf_dev_writer',
    destinationSecret: 'sql-dev-destination-password',
  },
  qa: {
    sourceUser: 'adf_qa_reader',
    sourceSecret: 'sql-qa-source-password',
    destinationUser: 'adf_qa_writer',
    destinationSecret: 'sql-qa-destination-password',
  },
};

const parseExportName = expression => {
  const match = /^\[concat\(parameters\('factoryName'\), '\/([^']+)'\)\]$/.exec(expression);
  if (!match) throw new Error(`Unexpected ARM resource name: ${expression}`);
  return match[1];
};

export function targetForEvent(env, deployment = false) {
  let branch;
  if (env.GITHUB_EVENT_NAME === 'push' && ['refs/heads/dev', 'refs/heads/qa'].includes(env.GITHUB_REF)) {
    branch = env.GITHUB_REF.slice('refs/heads/'.length);
  } else if (!deployment && env.GITHUB_EVENT_NAME === 'pull_request' &&
      env.GITHUB_BASE_REF === 'dev' && /^refs\/pull\/\d+\/merge$/.test(env.GITHUB_REF)) {
    branch = 'dev';
  } else {
    throw new Error('Only Dev merge PR validation or dev/qa push deployment is supported.');
  }
  return {
    branch,
    factory: `adf-poc-${branch}-mk-001`,
    linkedServiceMap: {
      ls_adls_dev: `ls_adls_${branch}`,
      ls_kv_dev: `ls_kv_${branch}`,
      ls_sql_source_dev: `ls_sql_source_${branch}`,
      ls_sql_destination_dev: `ls_sql_destination_${branch}`,
    },
    runtime: `ir-azure-${branch}`,
  };
}

export function visit(value, action) {
  if (!value || typeof value !== 'object') return;
  action(value);
  Object.values(value).forEach(child => visit(child, action));
}

export function prepareArtifacts(sourceTemplate, sourceParameters, target) {
  const template = structuredClone(sourceTemplate);
  const parameters = structuredClone(sourceParameters);
  if (!Array.isArray(template.resources) || !template.parameters?.factoryName || !parameters.parameters)
    throw new Error('Invalid ADF export: resources and factoryName parameters are required.');

  const scopedResources = [];
  for (const resource of template.resources) {
    if (resource.resources?.length) throw new Error('Nested ARM resources are outside this POC scope.');
    if (resource.type === prefix || resource.type === `${prefix}/integrationRuntimes`) continue;
    if (resource.type === `${prefix}/linkedServices`) {
      const name = parseExportName(resource.name);
      if (name === 'ls_adls_dev') continue;
      if (!deployableLinkedServices.has(name))
        throw new Error(`Outside linked-service scope: ${name}`);
      scopedResources.push({ ...resource, __sourceName: name });
      continue;
    }
    if (!artifactTypes.includes(resource.type)) throw new Error(`Outside POC scope: ${resource.type}`);
    scopedResources.push({ ...resource, __sourceName: parseExportName(resource.name) });
  }
  template.resources = scopedResources;

  const ids = new Set();
  for (const resource of template.resources) {
    const kind = resource.type.split('/').at(-1);
    const key = `${kind}/${resource.__sourceName}`;
    if (ids.has(key)) throw new Error(`Duplicate artifact: ${key}`);
    ids.add(key);
    const targetName = kind === 'linkedServices'
      ? target.linkedServiceMap[resource.__sourceName]
      : resource.__sourceName;
    if (!targetName) throw new Error(`Missing target name mapping: ${resource.__sourceName}`);
    resource.name = `${target.factory}/${targetName}`;
  }
  for (const resource of template.resources) {
    const dependencies = new Set();
    visit(resource.properties, node => {
      if (!node.type?.endsWith?.('Reference')) return;
      if (typeof node.referenceName !== 'string' || /^[@[]/.test(node.referenceName))
        throw new Error('This POC supports static references only.');
      if (node.type === 'LinkedServiceReference') {
        const sourceName = node.referenceName;
        const mappedName = target.linkedServiceMap[sourceName];
        if (!mappedName) throw new Error(`Unsupported linked service mapping: ${sourceName}`);
        node.referenceName = mappedName;
        if (ids.has(`linkedServices/${sourceName}`))
          dependencies.add(`[resourceId('${prefix}/linkedServices', '${target.factory}', '${mappedName}')]`);
      } else if (node.type === 'IntegrationRuntimeReference') {
        if (node.referenceName !== 'ir-azure-dev')
          throw new Error(`Add a runtime mapping for: ${node.referenceName}`);
        node.referenceName = target.runtime;
      } else if (['DatasetReference', 'PipelineReference'].includes(node.type)) {
        const kind = { DatasetReference: 'datasets', PipelineReference: 'pipelines' }[node.type];
        if (!ids.has(`${kind}/${node.referenceName}`)) throw new Error(`Missing reference: ${node.referenceName}`);
        dependencies.add(`[resourceId('${prefix}/${kind}', '${target.factory}', '${node.referenceName}')]`);
      } else throw new Error(`Unsupported reference: ${node.type}`);
    });
    if (target.branch === 'qa' && resource.type.endsWith('/datasets') &&
        resource.name.endsWith('/DelimitedText_sink')) {
      const location = resource.properties.typeProperties?.location;
      if (location?.type !== 'AzureBlobFSLocation') throw new Error('Unexpected QA sink storage type.');
      location.fileSystem = 'sink';
      location.folderPath = 'qa/output';
    }
    if (target.branch === 'qa' && resource.type.endsWith('/datasets') &&
        resource.name.endsWith('/SqlTable_destination_customers')) {
      if (resource.properties?.type !== 'AzureSqlTable')
        throw new Error('Unexpected QA SQL sink dataset type.');
      resource.properties.typeProperties.schema = 'qa';
    }
    if (target.branch === 'qa' && resource.type.endsWith('/linkedServices') &&
        resource.name.endsWith('/ls_sql_source_qa')) {
      const sql = resource.properties?.typeProperties;
      if (resource.properties?.type !== 'AzureSqlDatabase' || typeof sql?.connectionString !== 'string')
        throw new Error('Unexpected QA SQL source linked service shape.');
      sql.connectionString = sql.connectionString.replace(/(\buser\s*id\s*=\s*)adf_dev_reader\b/i,
        `$1${sqlRuntimeSecrets.qa.sourceUser}`);
      sql.password.secretName = sqlRuntimeSecrets.qa.sourceSecret;
    }
    if (target.branch === 'qa' && resource.type.endsWith('/linkedServices') &&
        resource.name.endsWith('/ls_sql_destination_qa')) {
      const sql = resource.properties?.typeProperties;
      if (resource.properties?.type !== 'AzureSqlDatabase' || typeof sql?.connectionString !== 'string')
        throw new Error('Unexpected QA SQL destination linked service shape.');
      sql.connectionString = sql.connectionString.replace(/(\buser\s*id\s*=\s*)adf_dev_writer\b/i,
        `$1${sqlRuntimeSecrets.qa.destinationUser}`);
      sql.password.secretName = sqlRuntimeSecrets.qa.destinationSecret;
    }
    if (JSON.stringify(resource.properties).includes('pipeline().globalParameters'))
      throw new Error('Factory global parameters are outside this POC scope.');
    delete resource.__sourceName;
    resource.dependsOn = [...dependencies];
  }
  parameters.parameters.factoryName = { value: target.factory };
  // Keep generated parameters, variables and functions used by retained artifacts.
  const { $schema, contentVersion, functions, variables } = template;
  return {
    template: { $schema, contentVersion, parameters: template.parameters, functions, variables, resources: template.resources },
    parameters,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = targetForEvent(process.env);
  const read = name => JSON.parse(fs.readFileSync(`build/export/${name}`, 'utf8'));
  const result = prepareArtifacts(read('ARMTemplateForFactory.json'), read('ARMTemplateParametersForFactory.json'), target);
  fs.mkdirSync('build/adf', { recursive: true });
  for (const [name, data] of Object.entries(result))
    fs.writeFileSync(`build/adf/${name}.json`, JSON.stringify(data, null, 2));
  console.log(`Prepared ${result.template.resources.length} artifacts for ${target.factory}.`);
}
