#!/usr/bin/env node
'use strict';
// agile@canary deploy pipeline step (#51). Copied to .github/scripts/agile-deploy.js by /agile:bootstrap, next to .github/workflows/deploy.yml.
// It runs the "Deploy command" that docs/infra.md declares for the environment: the command local /agile:publish <environment> runs (#50), so
// the two never drift. The command is read from docs/infra.md at run time, never copied into the workflow.
//   node .github/scripts/agile-deploy.js        reads AGILE_ENVIRONMENT and AGILE_TAG from the environment (the workflow sets them)
// Steps: parse docs/infra.md; stop when the environment, the tag or a secret is wrong (names only, values never printed); rebuild
// AGILE_ARTIFACTS from the tag when the command uses it; run the command; poll the Check URL for 200 for up to 60 s; write the run summary.
// With an Azure row in `## Cloud accounts` (#66) it also checks the azure/login the workflow made against the row, and cleans the account variables of the command's environment.
// An AWS or Google Cloud row (#68) is checked the same way against the login configure-aws-credentials or google-github-actions/auth made.
// Exit 0 deployed (or nothing declared on a tag push), 1 stopped.
// `require`d by scripts/sync.js (the plugin), which reads the same table to generate the workflow: one parser, no drift.
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');

const NOT_DECLARED = /^(not declared|none|n\/a|-|—)?$/i;
const unquote = cell => cell.replace(/^`+|`+$/g, '').trim();
const splitRow = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
function sectionTable(lines, heading) {
  const start = lines.findIndex(l => new RegExp(`^##\\s+${heading}\\b`, 'i').test(l));
  if (start < 0) return null;
  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|')) { if (/^##\s/.test(lines[i])) return null; i++; }
  if (i >= lines.length) return null;
  const header = splitRow(lines[i]).map(c => c.toLowerCase());
  const rows = [];
  for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) rows.push(splitRow(lines[j]));
  return { header, rows };
}
const columnOf = (table, prefix) => table.header.findIndex(h => h.startsWith(prefix));
const isRecipe = command => /^aspire\s+deploy\b/.test(command);
// A recipe's secret is an Aspire parameter, supplied as Parameters__<name> (the rule of scripts/publish.js).
const secretVariable = (name, command) => (isRecipe(command) && !/^Parameters__/.test(name) ? `Parameters__${name}` : name);

// What docs/infra.md declares: the environments (name, command, check URL) and, per environment, the secrets its deploy needs from the
// environment of the machine that deploys (the same scoping rule as local /agile:publish).
function readInfra(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const table = sectionTable(lines, 'Environments');
  if (!table) return { error: 'docs/infra.md has no `## Environments` table' };
  const [cEnv, cCmd, cCheck, cUrl] = [columnOf(table, 'environment'), columnOf(table, 'deploy command'), columnOf(table, 'check url'), columnOf(table, 'url')];
  if (cCmd < 0) return { error: 'the environments table of docs/infra.md has no `Deploy command` column (run /agile:sync on the project)' };
  const bad = table.rows.find(r => r.length !== table.header.length);
  if (bad) return { error: `a row of the environments table has ${bad.length} cells, the header ${table.header.length} (write a pipe inside a cell as backslash-pipe)` };
  const environments = table.rows.map(r => {
    const command = unquote(r[cCmd] || '');
    return { name: r[cEnv], command: NOT_DECLARED.test(command) ? null : command, checkUrl: (cCheck >= 0 && unquote(r[cCheck] || '')) || null, url: (cUrl >= 0 && unquote(r[cUrl] || '')) || null };
  }).filter(e => e.name);
  const secretTable = sectionTable(lines, 'Expected secrets');
  const names = environments.map(e => e.name.toLowerCase());
  for (const e of environments) {
    e.secrets = [];
    if (!secretTable || !e.command) continue;
    const [cName, cKept] = [columnOf(secretTable, 'name'), secretTable.header.findIndex(h => h.startsWith('kept'))];
    const others = names.filter(n => n !== e.name.toLowerCase());
    for (const r of secretTable.rows) {
      const name = unquote(r[cName] || '');
      const parts = (r[cKept] || '').toLowerCase().split(';').map(s => s.trim()).filter(Boolean);
      const mine = parts.filter(s => s.includes(e.name.toLowerCase()));
      const scope = mine.length ? mine : parts.filter(s => !others.some(o => s.includes(o)));
      if (name && scope.some(s => /environment variable/.test(s))) e.secrets.push(secretVariable(name, e.command));
    }
  }
  return { environments };
}

// ---- Cloud accounts (#66): `## Cloud accounts` of docs/infra.md says which client's cloud account each environment deploys to. One reader and one
// Azure check for the pipeline (this script) and for local /agile:publish (scripts/publish.js requires this file): they cannot drift.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUDS = ['azure', 'aws', 'gcp', 'other', 'none'];
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const forward = p => String(p).replace(/\\/g, '/');
// { error } | { section: false } | { section: true, row: null } | { section: true, row: {...} } for one environment (BR2: two rows stop, naming both).
function cloudFor(text, environment) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const table = sectionTable(lines, 'Cloud accounts');
  if (!table) return { section: false, row: null };
  const col = prefix => columnOf(table, prefix);
  const [cEnv, cClient, cCloud, cTenant, cSub, cGroup, cRegion, cBudget] = ['environment', 'client', 'cloud', 'tenant', 'subscription', 'resource group', 'region', 'monthly budget'].map(col);
  if ([cEnv, cClient, cCloud, cTenant, cSub].some(c => c < 0)) return { error: 'the `## Cloud accounts` table of docs/infra.md needs the columns Environment, Client, Cloud, Tenant, Subscription or account, Resource group, Region' };
  const bad = table.rows.find(r => r.length !== table.header.length);
  if (bad) return { error: `a row of the \`## Cloud accounts\` table has ${bad.length} cells, the header ${table.header.length} (write a pipe inside a cell as backslash-pipe)` };
  const mine = table.rows.filter(r => same(r[cEnv], environment));
  if (mine.length > 1) return { error: `docs/infra.md has ${mine.length} rows for ${environment} in \`## Cloud accounts\` (${mine.map(r => `${r[cClient] || 'no client'}/${r[cCloud] || 'no cloud'}`).join(' and ')}): keep one; nothing ran` };
  if (!mine.length) return { section: true, row: null };
  const r = mine[0], cell = i => (i >= 0 ? unquote(r[i] || '') : '');
  return { section: true, row: { environment: r[cEnv], client: cell(cClient), cloud: cell(cCloud).toLowerCase(), tenant: cell(cTenant), subscription: cell(cSub), resourceGroup: cell(cGroup), region: cell(cRegion), account: cell(cSub), budget: cell(cBudget), budgetColumn: cBudget >= 0 } };
}
// A message for a row that cannot be used (BR4): the cloud is one of the five, and an Azure row has a GUID tenant and a GUID subscription.
function cloudRowProblem(row) {
  if (!CLOUDS.includes(row.cloud)) return `the row of ${row.environment} in \`## Cloud accounts\` says Cloud "${row.cloud}": use one of ${CLOUDS.join(', ')}; nothing ran`;
  if (row.cloud === 'aws' || row.cloud === 'gcp') return accountCellProblem(row);
  if (row.cloud !== 'azure') return null;
  for (const [name, value] of [['Tenant', row.tenant], ['Subscription', row.subscription]]) {
    if (!value) return `the row of ${row.environment} in \`## Cloud accounts\` has no ${name}: fill it with the client's ${name.toLowerCase()} id (a GUID) before the first deploy; nothing ran`;
    if (!GUID.test(value)) return `the ${name} of ${row.environment} in \`## Cloud accounts\` is "${value}": it must be a GUID, not a name or a domain (az account show prints it); nothing ran`;
  }
  return null;
}
// #68 BR1: an AWS row has a 12-digit account and a region code, a GCP row a project id (not its name or number); the cell and the expected form are named.
const AWS_ACCOUNT = /^\d{12}$/, AWS_REGION = /^[a-z]{2,4}(?:-[a-z]+)+-\d{1,2}$/, GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
function accountCellProblem(row) {
  const aws = row.cloud === 'aws';
  const cells = aws
    ? [['Subscription or account', row.account, AWS_ACCOUNT, 'an AWS row needs the 12-digit account id (aws sts get-caller-identity prints it)'],
       ['Region', row.region, AWS_REGION, 'an AWS row needs a region code such as us-east-1']]
    : [['Subscription or account', row.account, GCP_PROJECT, 'a GCP row needs the project id, not its name or number (gcloud projects list prints it)']];
  for (const [name, value, form, need] of cells) {
    if (!value) return `the row of ${row.environment} in \`## Cloud accounts\` has no ${name}: ${need}; nothing ran`;
    if (!form.test(value)) return `the ${name} of ${row.environment} in \`## Cloud accounts\` is "${value}": ${need}; nothing ran`;
  }
  return null;
}
// The cells of an AWS or GCP row the plugin does not use (BR1): reported in --plan, never a stop.
// #77 BR2: Monthly budget is used by an `aca` environment only (`aca` true); filled anywhere else it is ignored, whatever the cloud.
const ignoredCells = (row, aca = false) => [...(row.cloud === 'aws' || row.cloud === 'gcp' ? [['Tenant', row.tenant], ['Resource group', row.resourceGroup]] : []), ...(aca ? [] : [['Monthly budget', row.budget]])].filter(c => c[1]).map(c => c[0]);
const ignoredNote = (row, ignored) => `${ignored.join(' and ')} ${ignored.length > 1 ? 'are' : 'is'} not used for ${row.cloud === 'aws' ? 'an AWS row' : row.cloud === 'gcp' ? 'a GCP row' : row.cloud === 'azure' ? 'an environment that is not aca' : row.cloud === 'none' ? 'a row with no cloud account' : `an ${row.cloud} row`}: ignored`;
// BR6: an Azure row decides the account; every inherited variable that could decide it is removed first. The names removed are returned (never a value).
function azureEnv(row, source, { pipeline = false } = {}) {
  const env = {}, removed = [];
  const set = { Azure__TenantId: row.tenant, Azure__SubscriptionId: row.subscription, Azure__CredentialSource: 'AzureCli' };
  if (row.resourceGroup) set.Azure__ResourceGroup = row.resourceGroup;
  if (row.region) set.Azure__Location = row.region;
  const home = require('os').homedir();
  const folder = path.join(home, '.agile', 'azure', row.tenant, row.subscription);
  if (!pipeline) { set.AZURE_CONFIG_DIR = folder; set.AZURE_EXTENSION_DIR = path.join(home, '.azure', 'cliextensions'); }
  for (const [k, v] of Object.entries(source)) if (/^(azure_|arm_)/i.test(k)) removed.push(k); else env[k] = v;
  Object.assign(env, set);
  return { env, removed: removed.filter(k => !Object.keys(set).some(s => same(s, k))), folder };
}
// A cloud CLI through its seam (AGILE_AZ_FAKE, AGILE_AWS_FAKE, AGILE_GCLOUD_FAKE: a node script, the check scripts have no cloud), else the real one. Node refuses
// a .cmd without a shell (EINVAL, Node 24 on Windows), so Windows goes through cmd.exe; the arguments are GUIDs, account ids and project ids the row check validated and, for the budget (#77), a resource group name that groupProblem accepted.
function cli(bin, fakeVariable, argv, env, cwd, timeout = 60 * 1000) {
  const o = { env, encoding: 'utf8', timeout, ...(cwd ? { cwd } : {}) };
  const r = process.env[fakeVariable] ? spawnSync(process.execPath, [process.env[fakeVariable], ...argv], o)
    : process.platform === 'win32' ? spawnSync('cmd.exe', ['/d', '/s', '/c', `${bin} ${argv.join(' ')}`], o) : spawnSync(bin, argv, o);
  return { code: r.error ? 127 : r.status, stdout: (r.stdout || '').trim(), out: ((r.stdout || '') + (r.stderr || '')).trim(), ...(r.error && r.error.code === 'ETIMEDOUT' ? { timedOut: true } : {}) };
}
const az = (argv, env, cwd, timeout) => cli('az', 'AGILE_AZ_FAKE', argv, env, cwd, timeout);
const account = r => { try { const j = JSON.parse(r.stdout); return j && j.id ? j : null; } catch { return null; } };
// BR5. mode `plan` reads only (an inactive but visible subscription is `willSet`), `deploy` runs `az account set` in the folder (it belongs to that
// subscription alone), `pipeline` only compares (azure/login chose the subscription). tenantId and id are compared ignoring case; homeTenantId never.
function azureCheck(row, env, mode) {
  const matches = a => a && same(a.id, row.subscription) && same(a.tenantId, row.tenant);
  const shown = az(['account', 'show', '-o', 'json'], env);
  if (shown.code === 127 || /not recognized|not found|ENOENT/i.test(shown.out) && !account(shown)) return { ok: false, status: 'no-az', out: shown.out };
  let active = account(shown);
  if (!active) return { ok: false, status: 'no-login', out: shown.out };
  if (matches(active)) return { ok: true, status: 'ok', active };
  if (mode === 'pipeline') return { ok: false, status: 'mismatch', active };
  if (mode === 'plan') {
    const other = account(az(['account', 'show', '--subscription', row.subscription, '-o', 'json'], env));
    return matches(other) ? { ok: true, status: 'ok', willSet: true, active } : { ok: false, status: 'mismatch', active };
  }
  az(['account', 'set', '--subscription', row.subscription], env);
  active = account(az(['account', 'show', '-o', 'json'], env)) || active;
  return matches(active) ? { ok: true, status: 'ok', switched: true, active } : { ok: false, status: 'mismatch', active };
}
// The stop message of a failed check (the Screens of #66); `login: false` (the pipeline) has no login line.
function azureMessage(row, check, folder, login = true) {
  const place = `${row.environment} is in ${row.client || 'the client'}'s Azure (tenant ${row.tenant}, subscription ${row.subscription})`;
  if (check.status === 'no-az') return { stop: `${place}: the \`az\` CLI is not installed or does not answer (${String(check.out).split('\n')[0] || 'no output'}); nothing ran` };
  if (check.status === 'no-login') {
    if (!login) return { stop: `${place}: \`az account show\` fails, so azure/login did not run or failed (is the GitHub environment variable AZURE_TENANT_ID set?); nothing ran` };
    const f = forward(folder);
    return {
      stop: `${place}: no login in ${f}; nothing ran. Log in once, in Git Bash: AZURE_CONFIG_DIR="${f}" az login --tenant ${row.tenant}`,
      login: { folder: f, gitBash: `AZURE_CONFIG_DIR="${f}" az login --tenant ${row.tenant}`, powershell: `& { $env:AZURE_CONFIG_DIR = '${folder}'; az login --tenant ${row.tenant}; Remove-Item Env:AZURE_CONFIG_DIR }` },
    };
  }
  const a = check.active || {};
  return { stop: `${row.environment} is declared in ${row.client || 'the client'}'s subscription ${row.subscription} (tenant ${row.tenant}), but the ${login ? `login in ${forward(folder)}` : 'pipeline login'} is ${a.name || 'unnamed'} ${a.id || '?'} (tenant ${a.tenantId || '?'}) and cannot see it: ask the client for access to that subscription, or correct the row; nothing ran` };
}

// ---- AWS and Google Cloud (#68), beside Azure's: the same folder-per-account rule, the same removal of inherited variables, one check each.
const json = text => { try { return JSON.parse(text); } catch { return null; } };
const firstLine = text => String(text || '').split('\n')[0] || 'no output';
const NO_CLI = /is not recognized as|command not found|ENOENT/i;
// cmd.exe answers 9009 in any language ("'aws' não é reconhecido..." on a pt-BR Windows), the shell 127.
const noCli = r => r.code === 127 || r.code === 9009 || NO_CLI.test(r.out);
const agileFolder = (...parts) => path.join(require('os').homedir(), '.agile', ...parts);
// BR3, BR2. `pipeline` keeps what the login action exported (it is the login) and only sets the region or the project; local removes every inherited name
// that could decide the account and points the CLI at the account's own folder. The names removed are returned (never a value).
function awsEnv(row, source, { pipeline = false } = {}) {
  const env = {}, removed = [], folder = agileFolder('aws', row.account);
  const set = { AWS_REGION: row.region, AWS_DEFAULT_REGION: row.region };
  if (!pipeline) { set.AWS_CONFIG_FILE = path.join(folder, 'config'); set.AWS_SHARED_CREDENTIALS_FILE = path.join(folder, 'credentials'); }
  for (const [k, v] of Object.entries(source)) if (!pipeline && /^aws_/i.test(k)) removed.push(k); else env[k] = v;
  Object.assign(env, set);
  return { env, removed: removed.filter(k => !Object.keys(set).some(s => same(s, k))), folder };
}
function gcpEnv(row, source, { pipeline = false } = {}) {
  const env = {}, removed = [], folder = agileFolder('gcp', row.account);
  const set = { CLOUDSDK_CORE_PROJECT: row.account, GOOGLE_CLOUD_PROJECT: row.account };
  if (!pipeline) set.CLOUDSDK_CONFIG = folder;
  // The pipeline keeps what google-github-actions/auth exported, and it exports project_id as five names (a GCP_PROJECT_ID of the GitHub environment that is not the row's would reach the command through GCLOUD_PROJECT, which Node's Google libraries read first): all five are the row's.
  else Object.assign(set, { CLOUDSDK_PROJECT: row.account, GCLOUD_PROJECT: row.account, GCP_PROJECT: row.account });
  for (const [k, v] of Object.entries(source)) if (!pipeline && /^(cloudsdk_|google_application_credentials$|google_cloud_project$|gcloud_project$|gcp_project$)/i.test(k)) removed.push(k); else env[k] = v;
  Object.assign(env, set);
  return { env, removed: removed.filter(k => !Object.keys(set).some(s => same(s, k))), folder };
}
// BR4: the caller's account must be the row's. No credentials, an expired SSO session and a bad token all read as "no login"; anything else (the network) is `error`.
function awsCheck(row, env) {
  const r = cli('aws', 'AGILE_AWS_FAKE', ['sts', 'get-caller-identity', '--output', 'json'], env), who = json(r.stdout);
  if (who && who.Account) return String(who.Account) === row.account ? { ok: true, status: 'ok', active: { account: who.Account, arn: who.Arn } } : { ok: false, status: 'mismatch', active: { account: who.Account, arn: who.Arn } };
  if (noCli(r)) return { ok: false, status: 'no-cli', out: r.out };
  return { ok: false, status: /credentials|sso|token|expired|aws configure|profile/i.test(r.out) ? 'no-login' : 'error', out: r.out };
}
// BR5: `projects describe` answers for the identity of the folder or the pipeline; the identity needs resourcemanager.projects.get on the project.
function gcpCheck(row, env) {
  const r = cli('gcloud', 'AGILE_GCLOUD_FAKE', ['projects', 'describe', row.account, '--format=json'], env), project = json(r.stdout);
  if (project && project.projectId) return same(project.projectId, row.account) ? { ok: true, status: 'ok', active: { project: project.projectId, name: project.name } } : { ok: false, status: 'mismatch', active: { project: project.projectId } };
  if (noCli(r)) return { ok: false, status: 'no-cli', out: r.out };
  // The real gcloud ends every 401, 403 and 404 with "This command is authenticated as <account> which is the active account specified by the [core/account] property", so a bare "active account" is not a missing login.
  if (/do not currently have an active account|credentialed accounts|reauth|refreshing your current auth tokens/i.test(r.out)) return { ok: false, status: 'no-login', out: r.out };
  if (/permission|forbidden|not found|may not exist|\b40[34]\b/i.test(r.out)) {
    const listed = json(cli('gcloud', 'AGILE_GCLOUD_FAKE', ['auth', 'list', '--format=json'], env).stdout);
    const active = Array.isArray(listed) && listed.find(a => a.status === 'ACTIVE');
    return { ok: false, status: 'denied', account: active ? active.account : null, out: r.out };
  }
  return { ok: false, status: 'error', out: r.out };
}
function awsMessage(row, check, folder, login = true) {
  const client = row.client || 'the client', place = `${row.environment} is in ${client}'s AWS account ${row.account} (${row.region})`;
  if (check.status === 'no-cli') return { stop: `${place}: the \`aws\` CLI is not installed or does not answer (${firstLine(check.out)}): install it (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html); nothing ran` };
  if (check.status === 'error') return { stop: `${place}: \`aws sts get-caller-identity\` failed (${firstLine(check.out)}); nothing ran` };
  if (check.status === 'no-login') {
    if (!login) return { stop: `${place}: \`aws sts get-caller-identity\` fails, so the pipeline login did not run or failed (did configure-aws-credentials run? is the GitHub environment variable AWS_ROLE_ARN set?); nothing ran` };
    const f = forward(folder), vars = `AWS_CONFIG_FILE="${f}/config" AWS_SHARED_CREDENTIALS_FILE="${f}/credentials"`;
    return {
      stop: `${place}: no login in ${f}; nothing ran. Log in once, in Git Bash: ${vars} aws configure sso (then \`aws sso login\` with the same two variables when the session expires; \`aws configure\` instead for access keys)`,
      login: { folder: f, gitBash: `${vars} aws configure sso`, powershell: `& { $env:AWS_CONFIG_FILE = '${path.join(folder, 'config')}'; $env:AWS_SHARED_CREDENTIALS_FILE = '${path.join(folder, 'credentials')}'; aws configure sso; Remove-Item Env:AWS_CONFIG_FILE, Env:AWS_SHARED_CREDENTIALS_FILE }` },
    };
  }
  const a = check.active || {};
  return { stop: `${row.environment} is declared in ${client}'s AWS account ${row.account}, but the ${login ? `login in ${forward(folder)}` : 'pipeline login'} is account ${a.account || '?'} (${a.arn || 'no ARN'}): ${login ? 'log in to the right account in that folder' : 'set the GitHub environment variable AWS_ROLE_ARN to a role of that account'}, or correct the row; nothing ran` };
}
function gcpMessage(row, check, folder, login = true) {
  const client = row.client || 'the client', place = `${row.environment} is in ${client}'s Google Cloud project ${row.account}`;
  if (check.status === 'no-cli') return { stop: `${place}: the \`gcloud\` CLI is not installed or does not answer (${firstLine(check.out)}): install it (https://cloud.google.com/sdk/docs/install); nothing ran` };
  if (check.status === 'error') return { stop: `${place}: \`gcloud projects describe\` failed (${firstLine(check.out)}); nothing ran` };
  if (check.status === 'no-login') {
    if (!login) return { stop: `${place}: \`gcloud projects describe\` finds no login, so the pipeline login did not run or failed (did google-github-actions/auth run? is GCP_WORKLOAD_IDENTITY_PROVIDER set?); nothing ran` };
    const f = forward(folder), one = `CLOUDSDK_CONFIG="${f}" gcloud auth login`, two = `CLOUDSDK_CONFIG="${f}" gcloud auth application-default login`;
    return {
      stop: `${place}: no login in ${f}; nothing ran. Log in once, in Git Bash: ${one}, then ${two} (for a deploy command that uses a Google SDK)`,
      login: { folder: f, gitBash: `${one} && ${two}`, powershell: `& { $env:CLOUDSDK_CONFIG = '${folder}'; gcloud auth login; gcloud auth application-default login; Remove-Item Env:CLOUDSDK_CONFIG }` },
    };
  }
  const who = check.account || 'the active account';
  if (check.status === 'mismatch') return { stop: `${row.environment} is declared in ${client}'s Google Cloud project ${row.account}, but \`gcloud projects describe\` answered project ${(check.active || {}).project || '?'}: correct the row; nothing ran` };
  return { stop: `${row.environment} is declared in ${client}'s Google Cloud project ${row.account}, but ${login ? `${who} in ${forward(folder)}` : `the pipeline login (${who})`} cannot read it (needs resourcemanager.projects.get: Browser, Viewer, Editor or Owner): ask the client for access, or correct the row; nothing ran` };
}
// One entry for the three checked clouds: the environment of the command, the folder, the check (mode plan | deploy | pipeline) and the message of a failure.
const CHECKED = ['azure', 'aws', 'gcp'];
function cloudAccount(row, source, mode) {
  const pipeline = mode === 'pipeline';
  const [envOf, check, message] = row.cloud === 'azure' ? [azureEnv, (r, e) => azureCheck(r, e, mode), azureMessage] : row.cloud === 'aws' ? [awsEnv, awsCheck, awsMessage] : [gcpEnv, gcpCheck, gcpMessage];
  const e = envOf(row, source, { pipeline }), checked = check(row, e.env);
  return { ...e, checked, message: login => message(row, checked, e.folder, login) };
}
const notChecked = row => `${row.cloud} account ${row.account || 'not given'} of ${row.client || 'the client'}: not checked by the plugin`;

// ---- Azure Container Apps (#67). The recipe is chosen per environment by `Deploy:Target` (`compose` | `aca`) in the AppHost's appsettings.<Environment>.json;
// the AppHost is the project the command's --apphost names. One reader for the pipeline (this script) and local /agile:publish (scripts/publish.js).
const apphostFile = (root, command) => {
  const given = (/--apphost(?:\s+|=)("[^"]+"|\S+)/.exec(command || '') || [])[1];
  if (!given) return null;
  const file = path.resolve(root, given.replace(/"/g, ''));
  try { if (fs.statSync(file).isDirectory()) { const p = fs.readdirSync(file).find(f => /\.csproj$/i.test(f)); return p ? path.join(file, p) : null; } } catch { /* a file that is not there is the caller's to report */ }
  return file;
};
// JSON as .NET's configuration reads it: // and /* */ comments and trailing commas are allowed, keys are case-insensitive.
function parseConfigJson(text) {
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { out += c; if (c === '\\') out += text[++i] || ''; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1'));
}
const ci = (obj, key) => { const k = obj && typeof obj === 'object' ? Object.keys(obj).find(x => x.toLowerCase() === key.toLowerCase()) : undefined; return k === undefined ? undefined : obj[k]; };
// { target: 'aca' | 'compose' (the default: no AppHost named, no file, no key, another value), file } or { error } for a file that exists and is not JSON.
function deployTarget(root, command, environment) {
  const apphost = apphostFile(root, command);
  if (!apphost) return { target: 'compose' };
  const dir = path.dirname(apphost), name = ((/(?:^|\s)(?:-e|--environment)(?:\s+|=)("[^"]+"|\S+)/.exec(command) || [])[1] || environment).replace(/"/g, '');
  let files = []; try { files = fs.readdirSync(dir); } catch { return { target: 'compose' }; }
  const file = files.find(x => x.toLowerCase() === ('appsettings.' + name + '.json').toLowerCase());
  if (!file) return { target: 'compose' };
  try {
    const json = parseConfigJson(fs.readFileSync(path.join(dir, file), 'utf8'));
    const nested = ci(ci(json, 'Deploy'), 'Target'), flat = ci(json, 'Deploy:Target'), value = nested !== undefined ? nested : flat;
    return { target: String(value || '').toLowerCase() === 'aca' ? 'aca' : 'compose', file };
  } catch (x) { return { error: forward(path.relative(root, path.join(dir, file))) + ' is not valid JSON (' + x.message + '), so Deploy:Target cannot be read', file }; }
}
// BR8: an `aca` environment deploys to the client's Azure subscription, in a resource group and a region the row must name (`aspire deploy --non-interactive`
// would fail half way or invent a group). Returns the stop message or null; a `compose` environment keeps both columns optional.
function acaProblem(root, command, environment, row) {
  if (!isRecipe(command || '')) return null;
  const found = deployTarget(root, command, environment);
  if (found.error) return `${environment}: ${found.error} — nothing ran`;
  if (found.target !== 'aca') return null;
  const head = `${environment}: Deploy:Target is aca, but its ## Cloud accounts row`;
  if (!row) return `${head} does not exist: add one (Cloud azure, Tenant, Subscription, Resource group, Region, Monthly budget) — nothing ran`;
  if (row.cloud !== 'azure') return `${head} says Cloud "${row.cloud || 'blank'}": Azure Container Apps deploys to an Azure subscription, so the row must say azure — nothing ran`;
  const blank = [['Resource group', 'Azure__ResourceGroup', row.resourceGroup], ['Region', 'Azure__Location', row.region]].filter(c => !c[2]);
  if (blank.length) return `${head} leaves ${blank.map(c => c[0]).join(' and ')} blank; fill ${blank.length > 1 ? 'them' : 'it'} (${blank.map(c => c[1]).join(', ')}) — nothing ran`;
  // #77 BR2: the ceiling is a whole number or `none`; a blank cell or a table without the column stops, so a forgotten ceiling is never silent.
  if (!row.budgetColumn) return `${head} has no Monthly budget column; add it after Region and write a whole number (the ceiling in the subscription's billing currency) or none — nothing ran`;
  if (!row.budget) return `${head} has no Monthly budget; write a whole number (the ceiling in the subscription's billing currency) or none — nothing ran`;
  if (budgetOf(row).error) return `${environment}: Monthly budget "${row.budget}" is not a whole number or none — nothing ran`;
  return null;
}
// #77 BR1: { none: true } | { amount: <positive whole number> } | { error: true } for the Monthly budget cell of a row.
function budgetOf(row) {
  const v = String(row.budget || '').trim();
  if (/^none$/i.test(v)) return { none: true };
  return /^\d+$/.test(v) && Number(v) > 0 && Number.isSafeInteger(Number(v)) ? { amount: Number(v) } : { error: true };
}

// ---- Azure budget (#77): after the deploy command an `aca` environment gets one monthly budget on its resource group, written with `az rest` (not declared
// in the AppHost: the start date of a budget cannot change and cannot be before the current month, measured on a real subscription). One writer for the
// pipeline (this script) and for local /agile:publish (scripts/publish.js requires this file).
const BUDGET = 'agile-monthly-ceiling';
// The group name goes into a cmd.exe line on Windows: letters, digits and _ . - ( ) only, and no parenthesis there (az.cmd expands its arguments inside a parenthesised block).
const groupProblem = group => (!/^[\w.()-]+$/.test(group) ? `the resource group "${group}" has characters the plugin does not pass to az (letters, digits and _ . - ( ) only)`
  : process.platform === 'win32' && /[()]/.test(group) ? `the resource group "${group}" has parentheses, which the Windows az.cmd cannot take as an argument: write the budget by hand or rename the group` : null);
const budgetUrl = row => `/subscriptions/${row.subscription}/resourceGroups/${row.resourceGroup}/providers/Microsoft.Consumption/budgets/${BUDGET}?api-version=2023-11-01`;
// Azure's reason: the service's own message when the answer carries one, else the first line that is not a warning.
function azReason(r) {
  if (r.timedOut) return 'az did not answer within its time limit (the operation may still finish: run the command again)';
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(r.out);
  if (m) return m[1].replace(/\\"/g, '"');
  return String(r.out).split('\n').map(s => s.trim()).filter(l => l && !/^WARNING/i.test(l)).map(l => l.replace(/^ERROR:\s*/i, ''))[0] || `az exited ${r.code}`;
}
const budgetPlanLine = row => { const b = budgetOf(row); return b.none ? 'Budget: none (declared)' : `Budget: ${b.amount} per month on ${row.resourceGroup} (billing currency of the subscription), alerts at 80 % and 100 % actual and 100 % forecast to Owner and Contributor`; };
// BR7: `none` deletes nothing; an earlier ceiling's budget is only reported (a read, so it also runs in --plan). A group or a budget that cannot be read says nothing.
function leftoverBudget(row, env) {
  if (groupProblem(row.resourceGroup)) return null;
  const got = az(['rest', '--method', 'get', '--url', budgetUrl(row)], env);
  return got.code === 0 ? `a budget ${BUDGET} still exists on ${row.resourceGroup}; delete it by hand if the environment should have none` : null;
}
// BR3-BR6: { ok: true, line } (written, or skipped because the group does not exist) | { ok: false, reason }.
function writeBudget(row, amount, env) {
  const group = row.resourceGroup;
  const unsafe = groupProblem(group);
  if (unsafe) return { ok: false, reason: unsafe };
  const exists = az(['group', 'exists', '--name', group, '--subscription', row.subscription], env);
  if (exists.code !== 0) return { ok: false, reason: azReason(exists) };
  if (!/^true$/i.test(exists.stdout)) return { ok: true, line: `Budget ${BUDGET}: not written, the resource group ${group} does not exist` };
  const got = az(['rest', '--method', 'get', '--url', budgetUrl(row)], env);
  let start, found = false;
  if (got.code === 0) {
    const j = json(got.stdout);
    start = j && j.properties && j.properties.timePeriod && j.properties.timePeriod.startDate;
    if (!start) return { ok: false, reason: `the existing budget ${BUDGET} answers no start date` };
    found = true;
  } else if (/not found|"code"\s*:\s*"404"|No budget found/i.test(got.out)) { const d = new Date(); start = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00Z`; }
  else return { ok: false, reason: azReason(got) };
  const notifications = {};
  for (const [threshold, type] of [[80, 'Actual'], [100, 'Actual'], [100, 'Forecasted']]) {
    notifications[`${type}_GreaterThanOrEqualTo_${threshold}_Percent`] = { enabled: true, operator: 'GreaterThanOrEqualTo', threshold, thresholdType: type, contactRoles: ['Owner', 'Contributor'] };
  }
  const folder = require('os').tmpdir(), name = `agile-budget-${process.pid}.json`, file = path.join(folder, name);
  fs.writeFileSync(file, JSON.stringify({ properties: { category: 'Cost', amount, timeGrain: 'Monthly', timePeriod: { startDate: start }, notifications } }));
  try {
    // The body is a path relative to the temp folder: a profile folder with a space would split an absolute one in cmd.exe.
    const put = az(['rest', '--method', 'put', '--url', budgetUrl(row), '--body', `@${name}`], env, folder);
    if (put.code !== 0) return { ok: false, reason: azReason(put) };
    const unit = ((json(put.stdout) || {}).properties || {}).currentSpend;
    const money = `${amount}${unit && unit.unit ? ` ${unit.unit}` : ''}`, day = start.slice(0, 10);
    return { ok: true, line: `Budget ${BUDGET} on ${group}: ${found ? `updated, ${money} per month (from ${day}, unchanged)` : `created, ${money} per month from ${day}`}` };
  } finally { fs.rmSync(file, { force: true }); }
}

// ---- Month-to-date cost (#99): one read of Azure Cost Management for the environment's resource group, local only (`publish.js cost`, the `Spend:` line of a plan);
// the pipeline and the status never call it. Measured: columns [Cost, Currency], one row, the group need not exist, a handful of queries per minute before a 429.
// AGILE_COST_PAUSE_MS fixes the wait between two 429 answers in a check.
const LAG = 'figures from Azure Cost Management lag 8 to 24 hours', RATE_LIMITED = /Too Many Requests|"code"\s*:\s*"429"/i;
const costUrl = row => `/subscriptions/${row.subscription}/resourceGroups/${row.resourceGroup}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
const costPause = out => (process.env.AGILE_COST_PAUSE_MS !== undefined ? Number(process.env.AGILE_COST_PAUSE_MS) : Math.min(60, Number((/retry-after\W+(\d+)/i.exec(out) || [])[1]) || 5) * 1000);
// { ok: true, amount, currency, text, line } | { ok: false, reason }. `text` is what follows `Spend this month: ` and `Spend: `.
async function readSpend(row, env) {
  const unsafe = groupProblem(row.resourceGroup);
  if (unsafe) return { ok: false, reason: unsafe };
  const folder = require('os').tmpdir(), name = `agile-cost-${process.pid}.json`, file = path.join(folder, name);
  fs.writeFileSync(file, JSON.stringify({ type: 'ActualCost', timeframe: 'MonthToDate', dataset: { granularity: 'None', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } } } }));
  let r;
  try {
    // The body is a path relative to the temp folder, like the budget's: a profile folder with a space would split an absolute one in cmd.exe.
    for (let tries = 0; ; tries++) {
      r = az(['rest', '--method', 'post', '--url', costUrl(row), '--body', `@${name}`], env, folder);
      if (r.code === 0 || !RATE_LIMITED.test(r.out)) break;
      if (tries === 3) return { ok: false, reason: 'Azure Cost Management is rate-limited; try again in a minute' };
      await sleep(costPause(r.out));
    }
  } finally { fs.rmSync(file, { force: true }); }
  if (r.code !== 0) return { ok: false, reason: azReason(r) };
  const props = (json(r.stdout) || {}).properties, columns = props && Array.isArray(props.columns) ? props.columns.map(c => String(c.name).toLowerCase()) : null;
  if (!columns || !Array.isArray(props.rows)) return { ok: false, reason: 'Azure Cost Management answered no cost table' };
  const first = props.rows[0], at = (n, d) => (columns.indexOf(n) >= 0 ? columns.indexOf(n) : d);
  const amount = first ? Number(first[at('cost', 0)]) : 0;
  if (!Number.isFinite(amount)) return { ok: false, reason: 'Azure Cost Management answered a cost that is not a number' };
  const b = budgetOf(row);
  let currency = first ? first[at('currency', 1)] : null;
  // No row: the currency is the budget's, when the budget exists (a read; a missing one leaves it out).
  if (!first && b.amount) { const got = az(['rest', '--method', 'get', '--url', budgetUrl(row)], env), unit = ((json(got.stdout) || {}).properties || {}).currentSpend; currency = got.code === 0 && unit && unit.unit ? unit.unit : null; }
  const text = `${amount.toFixed(2)}${currency ? ` ${currency}` : ''}${b.amount ? ` of ${b.amount} (${Math.floor(Number((amount * 100 / b.amount).toFixed(6)))} %)` : ' (no ceiling declared)'} — ${LAG}`;
  return { ok: true, amount, currency, text, line: `Spend this month: ${text}` };
}

// ---- Park and resume (#75). An `aca` environment is parked on demand (`publish.js park|resume`) and its stopped PostgreSQL server is started before a deploy
// (here for the pipeline, and required by scripts/publish.js for local /agile:publish). Resources are found by listing the resource group, never from the AppHost.
// The marks: `agile-parked=<UTC date>` on a PostgreSQL server (read by a later park, removed by resume and by a deploy), `agile-min-replicas=<n>` on a container app.
// A container app answering ContainerAppOperationInProgress and a server answering "busy" or "not Ready" (the measured texts) are retried every 15 s for 5 min;
// AGILE_PARK_WAIT_MS and AGILE_PARK_PAUSE_MS shorten both in a check, AGILE_PARK_NOW fixes the clock.
const PARKED = 'agile-parked', MIN_TAG = 'agile-min-replicas';
const BUSY = /ContainerAppOperationInProgress|is busy processing other operation|only supported on servers that are in 'Ready' state/i;
const waitLimit = () => (process.env.AGILE_PARK_WAIT_MS !== undefined ? Number(process.env.AGILE_PARK_WAIT_MS) : 5 * 60 * 1000);
const waitPause = () => (process.env.AGILE_PARK_PAUSE_MS !== undefined ? Number(process.env.AGILE_PARK_PAUSE_MS) : 15 * 1000);
const clock = () => (process.env.AGILE_PARK_NOW ? new Date(process.env.AGILE_PARK_NOW) : new Date());
const utcDay = d => d.toISOString().slice(0, 10);
const took = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
const sub = row => ['--subscription', row.subscription], inGroup = row => ['-g', row.resourceGroup, ...sub(row)];
// One az call, retried while Azure says the resource is busy; a stop or a start of a server answers after minutes, so it gets a long timeout.
async function azBusy(argv, env, long = false) {
  const until = Date.now() + waitLimit();
  for (;;) {
    const r = az(argv, env, undefined, long ? 15 * 60 * 1000 : undefined);
    if (r.code === 0 || !BUSY.test(r.out)) return r;
    if (Date.now() >= until) return { ...r, gaveUp: true };
    await sleep(waitPause());
  }
}
const appOf = a => { const p = a.properties || a, scale = (p.template || {}).scale || {}; return { name: a.name, id: a.id, tags: a.tags || {}, min: Number(scale.minReplicas) || 0 }; };
const serverOf = s => ({ name: s.name, id: s.id, state: s.state || (s.properties || {}).state, tags: s.tags || {} });
// The reason park and resume stop on a group name the plugin does not pass to az (the budget has its own wording, groupProblem).
const groupBlocked = group => `the resource group "${group}" cannot be passed to az by the plugin (${/[()]/.test(group) && process.platform === 'win32' ? 'parentheses are refused by the Windows az.cmd' : 'letters, digits and _ . - ( ) only'})`;
// { exists: boolean } | { error }.
function groupLive(row, env) {
  if (groupProblem(row.resourceGroup)) return { error: groupBlocked(row.resourceGroup) };
  const e = az(['group', 'exists', '--name', row.resourceGroup, ...sub(row)], env);
  if (e.code !== 0) return { error: azReason(e) };
  return { exists: /^true$/i.test(e.stdout) };
}
// { apps, pgs, sqls } of the group, or { error }.
// `only` names the kinds to list: the deploy asks for the PostgreSQL servers alone, so the pipeline never needs the `containerapp` extension of az.
function listGroup(row, env, only = ['apps', 'pgs', 'sqls']) {
  const out = { apps: [], pgs: [], sqls: [] };
  for (const [key, argv] of [['apps', ['containerapp', 'list']], ['pgs', ['postgres', 'flexible-server', 'list']], ['sqls', ['sql', 'server', 'list']]]) {
    if (!only.includes(key)) continue;
    const r = az([...argv, ...inGroup(row), '-o', 'json'], env), j = json(r.stdout);
    if (r.code === 0 && Array.isArray(j)) { out[key] = j; continue; }
    const ext = key === 'apps' && /requires the extension|extension.*containerapp|containerapp.*extension/i.test(r.out);
    return { error: ext ? 'az needs its containerapp extension to list the container apps: run az extension add --name containerapp (with the environment\'s AZURE_EXTENSION_DIR, which /agile:publish sets), then run it again; nothing ran' : `az ${argv.join(' ')} failed: ${azReason(r)}` };
  }
  return { apps: out.apps.map(appOf), pgs: out.pgs.map(serverOf), sqls: out.sqls.map(s => ({ name: s.name })) };
}
// BR6: a server in a state other than Ready or Stopped is waited for; `again` ends the message of a run that gives up.
async function settle(row, env, server, again, fresh = false) {
  const until = Date.now() + waitLimit();
  let state = fresh ? null : server.state || null;
  for (;;) {
    if (state === 'Ready' || state === 'Stopped') return { ok: true, state };
    if (state !== null) { if (Date.now() >= until) return { ok: false, reason: `PostgreSQL ${server.name} is ${state}; ${again}` }; await sleep(waitPause()); }
    const r = az(['postgres', 'flexible-server', 'show', ...inGroup(row), '-n', server.name, '-o', 'json'], env), j = json(r.stdout);
    if (r.code !== 0 || !j) return { ok: false, reason: `PostgreSQL ${server.name}: ${azReason(r)}` };
    state = j.state || (j.properties || {}).state || 'in an unknown state';
  }
}
// What the server really is after a stop or a start: the az answer is not trusted alone.
async function confirm(row, env, server, wanted, again) {
  const w = await settle(row, env, server, again, true);
  if (!w.ok) return w;
  return w.state === wanted ? w : { ok: false, reason: `PostgreSQL ${server.name} is ${w.state} after the ${wanted === 'Stopped' ? 'stop' : 'start'}; ${again}` };
}
// A Delete names key=value: the value is the one read from the listing, so it matches whether Azure compares the name alone or the pair.
const tagUpdate = (row, env, id, operation, tags) => azBusy(['tag', 'update', '--resource-id', id, '--operation', operation, '--tags', ...tags, ...sub(row)], env);
// A stop of a resource that went through, in the sentence BR6 asks for.
const stoppedAt = (name, r, changed) => `${name}: ${azReason(r)}${r.gaveUp ? ` (still busy after ${took(waitLimit())})` : ''}; already changed: ${changed.length ? changed.join('; ') : 'nothing'}`;

// BR4, BR7, BR9. { ok, plan?, lines, summary } | { ok: false, reason }. The apps are changed before the server, so a background host never runs without its database.
async function parkEnvironment(row, env, environment, plan = false) {
  const g = groupLive(row, env);
  if (g.error) return { ok: false, reason: g.error };
  if (!g.exists) return { ok: false, reason: `${environment}: resource group ${row.resourceGroup} does not exist (never deployed?); nothing ran` };
  const l = listGroup(row, env);
  if (l.error) return { ok: false, reason: l.error };
  const again = 'run --park again when it is Ready';
  const lines = [], parts = [], changed = [];
  for (const s of l.sqls) { const line = `Azure SQL ${s.name} pauses itself when idle; nothing to stop`; lines.push(line); parts.push(line); }
  if (plan) {
    for (const a of l.apps) { const line = a.min > 0 ? `${a.name}: minimum ${a.min} -> 0` : `${a.name}: already 0`; lines.push(line); parts.push(a.min > 0 ? `${a.name} minimum ${a.min} -> 0` : `${a.name} already 0`); }
    for (const s of l.pgs) {
      const line = s.state === 'Ready' ? `${s.name}: Ready -> Stopped (mark ${PARKED})` : s.state === 'Stopped' ? `${s.name}: already Stopped` : `${s.name}: ${s.state}, waited for before it is stopped`;
      lines.push(line); parts.push(line.replace(': ', ' '));
    }
    if (!l.apps.length && !l.pgs.length && !l.sqls.length) lines.push(`nothing to park in ${row.resourceGroup}`);
    return { ok: true, plan: true, lines, summary: `${environment} (${row.resourceGroup}): ${parts.join('; ') || lines[0]}` };
  }
  // Every server settles (Ready or Stopped) before anything changes: a run that gives up waiting leaves the environment as it was.
  for (const s of l.pgs) { const w = await settle(row, env, s, again); if (!w.ok) return { ok: false, reason: w.reason }; s.state = w.state; }
  for (const a of l.apps) {
    if (a.min <= 0) { lines.push(`${a.name}: already 0`); parts.push(`${a.name} already 0`); continue; }
    // `az containerapp update --tags` merges into the app's tags: only the mark is sent.
    const r = await azBusy(['containerapp', 'update', ...inGroup(row), '-n', a.name, '--min-replicas', '0', '--tags', `${MIN_TAG}=${a.min}`], env, true);
    if (r.code !== 0) return { ok: false, reason: stoppedAt(a.name, r, changed) };
    changed.push(`${a.name} minimum ${a.min} -> 0`); lines.push(`${a.name}: minimum ${a.min} -> 0`); parts.push(`${a.name} minimum ${a.min} -> 0`);
  }
  for (const s of l.pgs) {
    if (s.state === 'Stopped') { lines.push(`${s.name}: already Stopped`); parts.push(`${s.name} already stopped`); continue; }
    const started = Date.now(), mark = await tagUpdate(row, env, s.id, 'Merge', [`${PARKED}=${utcDay(clock())}`]);
    if (mark.code !== 0) return { ok: false, reason: stoppedAt(s.name, mark, changed) };
    const r = await azBusy(['postgres', 'flexible-server', 'stop', ...inGroup(row), '-n', s.name], env, true);
    if (r.code !== 0) return { ok: false, reason: stoppedAt(s.name, r, changed) };
    const done = await confirm(row, env, s, 'Stopped', again);
    if (!done.ok) return { ok: false, reason: `${done.reason}; already changed: ${changed.join('; ') || 'nothing'}` };
    const when = utcDay(new Date(clock().getTime() + 7 * 24 * 3600 * 1000)), t = took(Date.now() - started);
    changed.push(`PostgreSQL ${s.name} stopped`);
    lines.push(`PostgreSQL ${s.name} stopped (${t}); Azure starts it by itself on ${when} unless it is resumed first (run --park again after that to park it again)`);
    parts.push(`${s.name} stopped (${t}). Azure starts ${s.name} by itself on ${when} unless it is resumed first`);
  }
  if (!l.apps.length && !l.pgs.length && !l.sqls.length) lines.push(`nothing to park in ${row.resourceGroup}`);
  return { ok: true, lines, summary: `${environment} (${row.resourceGroup}): ${parts.join('; ') || lines[0]}${parts.length && /unless it is resumed first$/.test(parts[parts.length - 1]) ? '.' : ''}` };
}

// BR5, BR9. Servers first, so the apps that come back find their database. The Check URL is polled by the caller (scripts/publish.js has the poll).
async function resumeEnvironment(row, env, environment, plan = false) {
  const g = groupLive(row, env);
  if (g.error) return { ok: false, reason: g.error };
  if (!g.exists) return { ok: false, reason: `${environment}: resource group ${row.resourceGroup} does not exist (never deployed?); nothing ran` };
  const l = listGroup(row, env);
  if (l.error) return { ok: false, reason: l.error };
  const again = 'run --resume again when it is Ready';
  const lines = [], parts = [], changed = [];
  if (!plan) for (const s of l.pgs) { const w = await settle(row, env, s, again); if (!w.ok) return { ok: false, reason: w.reason }; s.state = w.state; }
  for (const s of l.pgs) {
    const marked = Object.keys(s.tags).includes(PARKED);
    if (plan) { const line = s.state === 'Stopped' ? `${s.name}: Stopped -> Ready${marked ? ` (mark ${PARKED} removed)` : ''}` : marked ? `${s.name}: Ready, mark ${PARKED} removed` : `${s.name}: already ${s.state}`; lines.push(line); parts.push(line.replace(': ', ' ')); continue; }
    let t = '';
    if (s.state === 'Stopped') {
      const started = Date.now(), r = await azBusy(['postgres', 'flexible-server', 'start', ...inGroup(row), '-n', s.name], env, true);
      if (r.code !== 0) return { ok: false, reason: stoppedAt(s.name, r, changed) };
      const done = await confirm(row, env, s, 'Ready', again);
      if (!done.ok) return { ok: false, reason: `${done.reason}; already changed: ${changed.join('; ') || 'nothing'}` };
      t = took(Date.now() - started); changed.push(`PostgreSQL ${s.name} started`);
    }
    if (marked) {
      const r = await tagUpdate(row, env, s.id, 'Delete', [`${PARKED}=${s.tags[PARKED]}`]);
      if (r.code !== 0) return { ok: false, reason: stoppedAt(s.name, r, changed) };
    }
    const line = s.state === 'Stopped' ? `PostgreSQL ${s.name} started (${t})${marked ? ', mark removed' : ''}` : marked ? `PostgreSQL ${s.name} was already Ready; mark removed` : `PostgreSQL ${s.name} already Ready`;
    lines.push(line); parts.push(line.replace(/^PostgreSQL /, ''));
  }
  for (const a of l.apps) {
    const kept = a.tags[MIN_TAG], want = Number(kept);
    if (kept === undefined || !Number.isInteger(want) || want < 0) { const line = `${a.name}: left at ${a.min} (no ${MIN_TAG} tag)`; lines.push(line); parts.push(`${a.name} left at ${a.min} (no ${MIN_TAG} tag)`); continue; }
    if (plan) { const line = `${a.name}: minimum ${a.min} -> ${want}`; lines.push(line); parts.push(`${a.name} minimum ${a.min} -> ${want}`); continue; }
    let r = await azBusy(['containerapp', 'update', ...inGroup(row), '-n', a.name, '--min-replicas', String(want)], env, true);
    if (r.code === 0) { changed.push(`${a.name} minimum ${a.min} -> ${want}`); r = await tagUpdate(row, env, a.id, 'Delete', [`${MIN_TAG}=${kept}`]); }
    if (r.code !== 0) return { ok: false, reason: stoppedAt(a.name, r, changed) };
    lines.push(`${a.name}: minimum ${a.min} -> ${want}`); parts.push(`${a.name} minimum ${a.min} -> ${want}`);
  }
  if (!l.apps.length && !l.pgs.length) lines.push(`nothing to resume in ${row.resourceGroup}`);
  return { ok: true, ...(plan ? { plan: true } : {}), lines, summary: `${environment}: ${parts.join('; ') || lines[0]}` };
}

// BR8: before the deploy command of an `aca` environment each Stopped PostgreSQL server is started and every `agile-parked` mark is removed. `plan` only reads.
// { ok: true, started: [...], line?, lines } | { ok: false, reason }. A group that does not exist yet (the first deploy) or one with only Azure SQL goes on.
async function startParked(row, env, environment, plan = false) {
  // A group name the plugin cannot pass to az was never checked before #75 either: the deploy goes on and says the parked check was skipped.
  if (groupProblem(row.resourceGroup)) { const skipped = `${environment}: parked check skipped, ${groupBlocked(row.resourceGroup)}`; return { ok: true, started: [], lines: [skipped], line: skipped }; }
  const g = groupLive(row, env);
  if (g.error) return { ok: false, reason: g.error };
  if (!g.exists) return { ok: true, started: [], lines: [] };
  const l = listGroup(row, env, ['pgs']);
  if (l.error) return { ok: false, reason: l.error };
  const again = 'run the deploy again when it is Ready', started = [], lines = [];
  for (const s of l.pgs) {
    const marked = Object.keys(s.tags).includes(PARKED);
    if (plan) { if (s.state === 'Stopped') lines.push(`${environment} is parked: the deploy starts PostgreSQL ${s.name} first (about 3 to 4 min)`); continue; }
    const w = await settle(row, env, s, again);
    if (!w.ok) return { ok: false, reason: `${environment}: ${w.reason}; the deploy command did not run` };
    if (w.state === 'Stopped') {
      const t0 = Date.now(), r = await azBusy(['postgres', 'flexible-server', 'start', ...inGroup(row), '-n', s.name], env, true);
      if (r.code !== 0) return { ok: false, reason: `${environment}: PostgreSQL ${s.name} could not be started (${azReason(r)}${r.gaveUp ? `; still busy after ${took(waitLimit())}` : ''}); the deploy command did not run` };
      const done = await confirm(row, env, s, 'Ready', again);
      if (!done.ok) return { ok: false, reason: `${environment}: ${done.reason}; the deploy command did not run` };
      started.push({ name: s.name, took: took(Date.now() - t0) });
    }
    if (marked) {
      const r = await tagUpdate(row, env, s.id, 'Delete', [`${PARKED}=${s.tags[PARKED]}`]);
      if (r.code !== 0) return { ok: false, reason: `${environment}: the mark ${PARKED} of PostgreSQL ${s.name} could not be removed (${azReason(r)}); the deploy command did not run` };
    }
  }
  const line = started.map(s => `${environment} was parked: PostgreSQL ${s.name} started (${s.took}) before the deploy`).join('; ');
  return { ok: true, started, ...(line ? { line } : {}), lines };
}

// ---- Re-park (#102). Azure starts a stopped PostgreSQL server by itself after 7 days (#75, M3), and the server keeps its `agile-parked` mark: a server that is Ready and still
// marked was parked, so the scheduled `re-park` stops it again; a Ready server without the mark was resumed on purpose and is left. Only the servers are listed (no `containerapp`
// call, so the runner needs no extension for it) and no app is changed. { ok, plan?, lines, summary } | { ok: false, reason }.
async function reparkEnvironment(row, env, environment, plan = false) {
  const g = groupLive(row, env);
  if (g.error) return { ok: false, reason: g.error };
  if (!g.exists) return { ok: false, reason: `${environment}: resource group ${row.resourceGroup} does not exist (never deployed?); nothing ran` };
  const l = listGroup(row, env, ['pgs', 'sqls']);
  if (l.error) return { ok: false, reason: l.error };
  const again = 'the next scheduled run tries again', lines = [], parts = [], changed = [];
  let reparked = 0;
  for (const s of l.sqls) { const line = `Azure SQL ${s.name} pauses itself when idle; nothing to stop`; lines.push(line); parts.push(line); }
  for (const s of l.pgs) {
    const marked = Object.keys(s.tags).includes(PARKED);
    // Only a server that is Ready and marked is stopped. A marked server that is Starting or Updating may be a resume or a deploy in progress on someone's machine (the mark goes
    // only after the server is Ready): it is left, and the next run looks again.
    if (!marked || s.state !== 'Ready') {
      const line = s.state === 'Stopped' ? `${s.name}: already Stopped` : marked ? `${s.name}: ${s.state} with mark ${PARKED}, left as it is (something is changing it; the next run looks again)` : `${s.name}: ${s.state}, no ${PARKED} mark; left as it is`;
      lines.push(line); parts.push(line.replace(': ', ' ')); continue;
    }
    if (plan) { const line = `${s.name}: Ready with mark ${PARKED} -> Stopped`; lines.push(line); parts.push(line.replace(': ', ' ')); reparked++; continue; }
    // Read it again just before the stop: a resume that finished since the listing took the mark away, and that server stays running.
    const now = az(['postgres', 'flexible-server', 'show', ...inGroup(row), '-n', s.name, '-o', 'json'], env), shown = json(now.stdout);
    if (now.code !== 0 || !shown) return { ok: false, reason: `PostgreSQL ${s.name}: ${azReason(now)}; already changed: ${changed.join('; ') || 'nothing'}` };
    if ((shown.state || (shown.properties || {}).state) !== 'Ready' || !Object.keys(shown.tags || {}).includes(PARKED)) {
      const line = `${s.name}: no longer Ready with mark ${PARKED}; left as it is`; lines.push(line); parts.push(line.replace(': ', ' ')); continue;
    }
    const started = Date.now(), r = await azBusy(['postgres', 'flexible-server', 'stop', ...inGroup(row), '-n', s.name], env, true);
    if (r.code !== 0) return { ok: false, reason: stoppedAt(s.name, r, changed) };
    const done = await confirm(row, env, s, 'Stopped', again);
    if (!done.ok) return { ok: false, reason: `${done.reason}; already changed: ${changed.join('; ') || 'nothing'}` };
    const when = utcDay(new Date(clock().getTime() + 7 * 24 * 3600 * 1000)), t = took(Date.now() - started);
    changed.push(`PostgreSQL ${s.name} re-parked`); reparked++;
    lines.push(`PostgreSQL ${s.name} re-parked (${t}); Azure starts it by itself on ${when} unless it is resumed first`);
    parts.push(`${s.name} re-parked (${t}). Azure starts ${s.name} by itself on ${when} unless it is resumed first`);
  }
  if (!reparked) { lines.push('nothing to re-park (no marked server is Ready)'); }
  return { ok: true, ...(plan ? { plan: true } : {}), lines, summary: `${environment} (${row.resourceGroup}): ${parts.join('; ') || lines[0]}` };
}

// ---- Schedule (#102): `## Schedule` of docs/infra.md says when an `aca` environment is parked, resumed or re-parked by the pipeline (.github/workflows/park.yml, rendered from this
// table by scripts/sync.js, which requires this file). GitHub reads the cron from the workflow only; the job finds its rows by the cron text it was fired by.
const SCHEDULE_ACTIONS = ['park', 'resume', 're-park'];
const numberIn = (text, min, max) => /^\d{1,2}$/.test(text) && Number(text) >= min && Number(text) <= max;
const numbersIn = (field, min, max) => field.split(',').every(p => numberIn(p, min, max));
// A daily-scale cron: minute and hour are numbers (a comma list is allowed), never a * or a step, so GitHub's 5-minute floor is never reached.
function cronProblem(cron) {
  const text = String(cron || '').trim(), f = text ? text.split(/\s+/) : [];
  if (f.length !== 5) return `"${text}" has ${f.length} fields; a cron has five (minute hour day-of-month month day-of-week)`;
  const [minute, hour, dom, month, dow] = f;
  if (!numbersIn(minute, 0, 59)) return `the minute "${minute}" of "${text}" must be a number from 0 to 59 (a list is allowed; a * or a step is not)`;
  if (!numbersIn(hour, 0, 23)) return `the hour "${hour}" of "${text}" must be a number from 0 to 23 (a list is allowed; a * or a step is not)`;
  if (dom !== '*' && !numbersIn(dom, 1, 31)) return `the day of month "${dom}" of "${text}" must be * or numbers from 1 to 31`;
  if (month !== '*' && !numbersIn(month, 1, 12)) return `the month "${month}" of "${text}" must be * or numbers from 1 to 12`;
  const dayOk = p => numberIn(p, 0, 6) || (/^[0-6]-[0-6]$/.test(p) && p[0] <= p[2]);
  if (dow !== '*' && !dow.split(',').every(dayOk)) return `the day of week "${dow}" of "${text}" must be *, numbers from 0 to 6 (Sunday is 0), ranges like 1-5 or a list`;
  return null;
}
// Blank is UTC. The name is an IANA zone; the characters are checked first because the value is written into a YAML file.
function timezoneProblem(zone) {
  if (!zone) return null;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone)) return `the timezone "${zone}" is not an IANA name such as America/Sao_Paulo`;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { return `the timezone "${zone}" is not an IANA name such as America/Sao_Paulo`; }
  return null;
}
// { section: false, rows: [] } | { section: true, rows: [{ environment, action, when, timezone }] } | { error }. A row with every cell blank (the template's) is no row.
function readSchedule(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const table = sectionTable(lines, 'Schedule');
  if (!table) return { section: false, rows: [] };
  const [cEnv, cAction, cWhen, cZone] = ['environment', 'action', 'when', 'timezone'].map(p => columnOf(table, p));
  if ([cEnv, cAction, cWhen].some(c => c < 0)) return { error: 'the `## Schedule` table of docs/infra.md needs the columns Environment, Action, When and Timezone' };
  const bad = table.rows.find(r => r.length !== table.header.length);
  if (bad) return { error: `a row of the \`## Schedule\` table has ${bad.length} cells, the header ${table.header.length} (write a pipe inside a cell as backslash-pipe)` };
  const cell = (r, i) => (i >= 0 ? unquote(r[i] || '') : '');
  const rows = table.rows.map(r => ({ environment: cell(r, cEnv), action: cell(r, cAction).toLowerCase(), when: cell(r, cWhen).replace(/\s+/g, ' '), timezone: cell(r, cZone) })).filter(r => r.environment || r.action || r.when);
  return { section: true, rows };
}
// The first problem of the table, or null (BR2). `only` limits the per-row checks to one environment (the job's), the duplicate checks always read every row. `root` is the project
// (or the checkout): the AppHost says whether an environment is aca.
function scheduleProblem(text, root, only) {
  const s = readSchedule(text);
  if (s.error) return s.error;
  const infra = readInfra(text);
  if (infra.error) return infra.error;
  const label = r => `the Schedule row "${r.environment} ${r.action} ${r.when}"`;
  for (const r of s.rows) {
    if (only && !same(r.environment, only)) continue;
    const at = label(r);
    if (!SCHEDULE_ACTIONS.includes(r.action)) return `${at} has the action "${r.action}": use park, resume or re-park; nothing written`;
    const env = infra.environments.find(e => same(e.name, r.environment));
    if (!env) return `${at} names an environment that docs/infra.md does not declare (it has: ${infra.environments.map(e => e.name).join(', ')}); nothing written`;
    if (/^local$/i.test(env.name)) return `${at}: local is the developer's machine, there is nothing to park; nothing written`;
    if (/^prod/i.test(env.name)) return `${at}: production is not scheduled (it is promoted by hand, and its required reviewers would hold a scheduled run); nothing written`;
    if (!env.command || !isRecipe(env.command)) return `${at}: ${env.name} has no Aspire deploy command, so it is not an aca environment; nothing written`;
    const target = deployTarget(root, env.command, env.name);
    if (target.error) return `${at}: ${target.error}; nothing written`;
    if (target.target !== 'aca') return `${at}: a schedule works only on an aca environment (${env.name}: Deploy:Target is compose); nothing written`;
    // The cloud checks speak of the deploy ("— nothing ran"): here they name the row and end like the other refusals.
    const own = message => `${at}: ${message.replace(/( — |; )nothing ran$/, '')}; nothing written`;
    const cloud = cloudFor(text, env.name);
    if (cloud.error) return own(cloud.error);
    if (cloud.row) { const bad = cloudRowProblem(cloud.row); if (bad) return own(bad); }
    const aca = acaProblem(root, env.command, env.name, cloud.row);
    if (aca) return own(aca);
    const cron = cronProblem(r.when);
    if (cron) return `${at}: ${cron}; nothing written`;
    const zone = timezoneProblem(r.timezone);
    if (zone) return `${at}: ${zone}; nothing written`;
  }
  const seen = new Map(), zones = new Map();
  for (const r of s.rows) {
    const key = `${r.environment.toLowerCase()}|${r.when}`, zone = r.timezone || 'UTC';
    if (seen.has(key) && (!only || same(r.environment, only))) return `${label(r)} is written twice for ${r.environment}: one environment never has two rows with the same cron; nothing written`;
    seen.set(key, true);
    if (zones.has(r.when) && zones.get(r.when) !== zone) return `the cron "${r.when}" is written with two timezones (${zones.get(r.when)} and ${zone}): the job finds its row by the cron text alone; nothing written`;
    zones.set(r.when, zone);
  }
  return null;
}

// ---- Custom domain (#76). The domain of an `aca` environment is the host of its URL in `## Environments`. Before the command the plugin reads what Azure expects and
// what public DNS answers; with the records right the command gets Deploy__CustomDomain (and Deploy__CertificateName once the managed certificate exists), the AppHost
// declares the domain (ConfigureCustomDomain) and, after the command, the plugin has Azure issue the certificate under a fixed name and binds it. Aspire never creates the
// certificate. The carrier is `Deploy__*`, not `Parameters__*`: Aspire saves every Parameters value in its deployment state and reads it back (change note v2).
// AGILE_DNS_FAKE (a JSON file keyed by name: { cname, a, txt, soa, caa, error }) stands for DNS in a check; AGILE_DOMAIN_WAIT_MS and AGILE_DOMAIN_PAUSE_MS shorten the wait.
const DOMAIN_HOST = 'Deploy__CustomDomain', DOMAIN_CERT = 'Deploy__CertificateName';
const domainWait = () => (process.env.AGILE_DOMAIN_WAIT_MS !== undefined ? Number(process.env.AGILE_DOMAIN_WAIT_MS) : 10 * 60 * 1000);
const domainPause = () => (process.env.AGILE_DOMAIN_PAUSE_MS !== undefined ? Number(process.env.AGILE_DOMAIN_PAUSE_MS) : 15 * 1000);
// BR1: { host } for a URL whose host is a name of the client's own; null for a blank URL, a generated azurecontainerapps.io host or an IP address.
function domainOf(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  let host; try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  // The host goes into a cmd.exe line on Windows (az.cmd): letters, digits, hyphen and dot only (the URL parser lets `&` and `^` through).
  if (!host || !host.includes('.') || /^[\d.]+$/.test(host) || /(^|\.)azurecontainerapps\.io$/.test(host)) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) return { invalid: host };
  return { host };
}
// BR5: the fixed name of the managed certificate, from the host: `mc-` and the host with every non-alphanumeric as a hyphen, cut with a hash past 60 characters.
function certificateNameOf(host) {
  const name = `mc-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  return name.length <= 60 ? name : `${name.slice(0, 51).replace(/-$/, '')}-${require('crypto').createHash('sha1').update(host.toLowerCase()).digest('hex').slice(0, 8)}`;
}
// One DNS answer: { values } (possibly empty: no such record) or { error: <code> } when the resolver did not answer. Public resolvers first, the system's as a fallback.
async function dnsAsk(type, name) {
  if (process.env.AGILE_DNS_FAKE) {
    const all = JSON.parse(fs.readFileSync(process.env.AGILE_DNS_FAKE, 'utf8')), entry = all[name.toLowerCase()] || {};
    if (entry.error) return { error: entry.error };
    const v = { CNAME: entry.cname ? [entry.cname] : [], A: entry.a || [], TXT: entry.txt || [], SOA: entry.soa ? [{ nsname: 'ns1.fake' }] : [], CAA: entry.caa || [] }[type];
    return { values: v };
  }
  const dns = require('dns').promises;
  for (const servers of [['1.1.1.1', '8.8.8.8'], null]) {
    const r = new dns.Resolver({ timeout: 4000, tries: 2 });
    if (servers) r.setServers(servers);
    try {
      const v = await ({ CNAME: () => r.resolveCname(name), A: () => r.resolve4(name), TXT: async () => (await r.resolveTxt(name)).map(p => p.join('')), SOA: async () => [await r.resolveSoa(name)], CAA: () => r.resolveCaa(name) })[type]();
      return { values: v };
    } catch (e) {
      if (['ENODATA', 'ENOTFOUND', 'NXDOMAIN'].includes(e.code)) return { values: [] };
      if (!servers) return { error: e.code || e.message };
    }
  }
  return { error: 'ETIMEOUT' };
}
const dot = s => String(s || '').toLowerCase().replace(/\.$/, '');
// BR3: apex or subdomain by DNS, not by counting labels. A name with a CNAME is a subdomain; a name with its own SOA is its zone's apex; otherwise the first ancestor
// with an SOA is the zone. { apex, zone } | { error }.
async function dnsZone(host) {
  const cname = await dnsAsk('CNAME', host);
  if (cname.error) return { error: `${host} (${cname.error})` };
  if (!cname.values.length) {
    const soa = await dnsAsk('SOA', host);
    if (soa.error) return { error: `${host} (${soa.error})` };
    if (soa.values.length) return { apex: true, zone: host };
  }
  const labels = host.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const up = labels.slice(i).join('.'), soa = await dnsAsk('SOA', up);
    if (soa.error) return { error: `${up} (${soa.error})` };
    if (soa.values.length) return { apex: false, zone: up };
  }
  return { error: `${host} has no DNS zone (is the domain registered and delegated?)` };
}
// BR4: what the DNS of `host` must hold and what it holds, one entry per record: { type, name, expected, found, ok }. `name` is relative to the zone ('@' for the apex).
// A CAA record (at the host or the first ancestor that has any, up to the zone) that does not allow digicert.com is wrong; none at all is fine.
async function dnsRecords(host, expect) {
  const z = await dnsZone(host);
  if (z.error) return { error: z.error };
  const rel = z.apex ? '@' : host.slice(0, host.length - z.zone.length - 1), out = [];
  const txtName = z.apex ? 'asuid' : `asuid.${rel}`;
  const txt = await dnsAsk('TXT', `asuid.${host}`);
  if (txt.error) return { error: `asuid.${host} (${txt.error})` };
  if (z.apex) {
    const a = await dnsAsk('A', host);
    if (a.error) return { error: `${host} (${a.error})` };
    out.push({ type: 'A', name: '@', expected: expect.staticIp, found: a.values.join(', ') || 'nothing', ok: a.values.length === 1 && a.values[0] === expect.staticIp });
  } else {
    const c = await dnsAsk('CNAME', host);
    if (c.error) return { error: `${host} (${c.error})` };
    let found = c.values.map(dot).join(', ');
    if (!found) { const a = await dnsAsk('A', host); if (a.values && a.values.length) found = `A ${a.values.join(', ')} (a proxy in front, or CNAME flattening?)`; }
    out.push({ type: 'CNAME', name: rel, expected: dot(expect.fqdn), found: found || 'nothing', ok: c.values.length === 1 && dot(c.values[0]) === dot(expect.fqdn) });
  }
  out.push({ type: 'TXT', name: txtName, expected: expect.verificationId, found: txt.values.join(', ') || 'nothing', ok: txt.values.includes(expect.verificationId) });
  for (let name = host; ; name = name.split('.').slice(1).join('.')) {
    const caa = await dnsAsk('CAA', name);
    if (caa.error) return { error: `${name} (${caa.error})` };
    if (caa.values.length) {
      const issuers = caa.values.filter(r => r.issue !== undefined).map(r => String(r.issue).split(';')[0].trim().toLowerCase());
      if (issuers.length && !issuers.includes('digicert.com')) out.push({ type: 'CAA', name: name === z.zone ? '@' : name.slice(0, name.length - z.zone.length - 1), expected: '0 issue "digicert.com"', found: issuers.map(i => `0 issue "${i}"`).join(', '), ok: false });
      break;
    }
    if (name === z.zone || !name.includes('.')) break;
  }
  return { apex: z.apex, zone: z.zone, records: out };
}
// The group's one container app with external ingress and what Azure expects of the domain: { app, fqdn, verificationId, environment: { id, name }, staticIp } | { none: true } (no group or no
// app yet) | { stop } (no external app, or more than one: BR2) | { error }.
function domainTarget(row, env) {
  const g = groupLive(row, env);
  if (g.error) return { error: g.error };
  if (!g.exists) return { none: true };
  const r = az(['containerapp', 'list', ...inGroup(row), '-o', 'json'], env), apps = json(r.stdout);
  if (r.code !== 0 || !Array.isArray(apps)) return { error: /requires the extension|extension.*containerapp|containerapp.*extension/i.test(r.out) ? 'az needs its containerapp extension to list the container apps: run az extension add --name containerapp (with the environment AZURE_EXTENSION_DIR, which /agile:publish sets)' : `az containerapp list failed: ${azReason(r)}` };
  if (!apps.length) return { none: true };
  const outside = apps.filter(a => ((((a.properties || a).configuration || {}).ingress) || {}).external === true);
  if (outside.length !== 1) return { stop: outside.length ? `${outside.length} container apps have external ingress (${outside.map(a => a.name).join(', ')}); the domain goes on exactly one` : `no container app has external ingress (${apps.map(a => a.name).join(', ')})` };
  const p = outside[0].properties || outside[0], ingress = p.configuration.ingress, envId = p.environmentId || p.managedEnvironmentId || '';
  const e = az(['containerapp', 'env', 'show', '--ids', envId, '-o', 'json'], env), ej = json(e.stdout);
  if (e.code !== 0 || !ej) return { error: `az containerapp env show failed: ${azReason(e)}` };
  return { app: outside[0].name, fqdn: ingress.fqdn, verificationId: p.customDomainVerificationId, environment: { id: envId, name: envId.split('/').pop() }, staticIp: (ej.properties || ej).staticIp };
}
// The managed certificate of that name: { cert: { name, state, reason, subject } } | { cert: null } | { error }.
function domainCertificate(row, env, target, name) {
  const r = az(['containerapp', 'env', 'certificate', 'list', '-g', row.resourceGroup, '-n', target.environment.name, ...sub(row), '--managed-certificates-only', '-o', 'json'], env), list = json(r.stdout);
  if (r.code !== 0 || !Array.isArray(list)) return { error: `az containerapp env certificate list failed: ${azReason(r)}` };
  const c = list.find(x => x.name === name);
  if (!c) return { cert: null };
  const p = c.properties || c;
  return { cert: { name: c.name, state: p.provisioningState, subject: p.subjectName ? String(p.subjectName).toLowerCase() : null, reason: p.error || p.provisioningErrorMessage || p.provisioningState } };
}
const recordLine = r => `  ${r.type} ${r.name} → ${r.expected} (found: ${r.found})`;
const recordsText = (host, records) => [`Domain ${host}: not bound yet; the client creates these records at their DNS provider, then deploy again:`, ...records.filter(r => !r.ok).map(recordLine)];
// Review of #76: the AppHost must carry the domain code (a project bootstrapped before #76 does not), or Aspire would deploy the app without the domain it already has.
function apphostHasDomainCode(root, command) {
  const apphost = apphostFile(root, command);
  if (!apphost) return null;
  const dir = path.dirname(apphost);
  let files; try { files = fs.readdirSync(dir).filter(f => /\.cs$/i.test(f)); } catch { return null; }
  if (!files.length) return null;
  return files.some(f => { try { return fs.readFileSync(path.join(dir, f), 'utf8').includes('Deploy:CustomDomain'); } catch { return false; } });
}
const dnsMessage = error => (/^\S+ \(/.test(error) ? `public DNS did not answer for ${error}` : error);
// BR4, BR5, BR8. Before the command: { state, host, env, lines, plan, target? } with state `none` (no custom domain), `stop` (the state of the domain cannot be read: nothing runs, so a
// live domain is never taken off by a deploy that could not look at it), `skipped` (the domain step cannot apply: two external apps, an AppHost without the code), `first` (no app yet),
// `missing` (records wrong), `add` (records right, no certificate Succeeded: the command adds the domain; `recreate` when a failed certificate is deleted first) or `kept` (the certificate exists).
// `env` is what the command is given on top of its environment; `lines` is what the run says before the command; `plan` is the line --plan prints. `apphost` is { root, command }.
async function domainBefore(row, env, url, apphost) {
  const d = domainOf(url);
  if (!d) return { state: 'none', env: {}, lines: [], plan: 'Domain: none (the URL is blank or the generated address)' };
  if (d.invalid) { const why = `the host "${d.invalid}" has characters a domain does not (letters, digits, hyphen and dot only)`; return { state: 'skipped', host: null, env: {}, lines: [`Domain ${d.invalid}: not bound: ${why}; the deploy runs without it`], plan: `Domain ${d.invalid}: not bound (${why})` }; }
  const host = d.host, certName = certificateNameOf(host);
  const unreadable = why => ({ state: 'stop', host, env: {}, lines: [], plan: `Domain ${host}: cannot be read (${why})`, stop: `${host}: the custom domain cannot be checked (${why}); nothing ran, so the domain is not taken off the app. Run it again, or blank the URL of the environment in docs/infra.md to deploy without the domain` });
  if (apphost && apphostHasDomainCode(apphost.root, apphost.command) === false) {
    const why = 'the AppHost has no custom-domain code (Deploy:CustomDomain): copy it from the profile section "Deploy recipe (Azure Container Apps + Aspire)" into Program.cs, then deploy again';
    return { state: 'skipped', host, env: {}, lines: [`Domain ${host}: not bound: ${why}; the deploy runs without it`], plan: `Domain ${host}: not bound (${why})` };
  }
  const t = domainTarget(row, env);
  const skip = why => ({ state: 'skipped', host, env: {}, lines: [`Domain ${host}: not bound: ${why}; the deploy runs without it`], plan: `Domain ${host}: not bound (${why})`, ...(t.fqdn ? { target: t } : {}) });
  if (t.error) return unreadable(t.error);
  if (t.stop) return skip(t.stop);
  if (t.none) return { state: 'first', host, env: {}, lines: [], plan: `Domain ${host}: the app does not exist yet; after the first deploy the run lists the DNS records the client creates` };
  const rec = await dnsRecords(host, t);
  if (rec.error) return unreadable(dnsMessage(rec.error));
  const wrong = rec.records.filter(r => !r.ok);
  if (wrong.length) return { state: 'missing', host, target: t, env: {}, lines: recordsText(host, rec.records), plan: recordsText(host, rec.records).join('\n'), records: rec };
  const c = domainCertificate(row, env, t, certName);
  if (c.error) return unreadable(c.error);
  if (c.cert && c.cert.subject && c.cert.subject !== host) return unreadable(`certificate ${certName} is for ${c.cert.subject}, not ${host}: delete it with az containerapp env certificate delete`);
  if (c.cert && c.cert.state === 'Succeeded') return { state: 'kept', host, certName, target: t, records: rec, env: { [DOMAIN_HOST]: host, [DOMAIN_CERT]: certName }, lines: [], plan: `Domain ${host}: certificate ${certName} kept` };
  const recreate = !!(c.cert && /^(Failed|Canceled|DeleteFailed)$/i.test(c.cert.state));
  return { state: 'add', host, certName, target: t, records: rec, recreate, env: { [DOMAIN_HOST]: host }, lines: [], plan: `Domain ${host}: the deploy adds it, ${recreate ? 'recreates' : 'creates'} certificate ${certName} (validation ${rec.apex ? 'HTTP' : 'CNAME'}) and binds it` };
}
// BR5, BR6: after a command that exited 0. { lines, bound, pending?, failure? }: `bound` says the domain answers (for BR7); `pending` is the run's ending note; `failure` makes the run fail.
async function domainAfter(row, env, before) {
  if (before.state === 'none' || before.state === 'skipped' || before.state === 'stop') return { lines: [], bound: false };
  const host = before.host;
  if (before.state === 'kept') return { lines: [`Domain ${host}: certificate ${before.certName} kept.`], bound: true, fqdn: before.target.fqdn };
  if (before.state === 'missing') return { lines: [], bound: false, fqdn: before.target.fqdn };   // the records were listed before the command
  const t = domainTarget(row, env);
  if (t.error) return { lines: [`Domain ${host}: not bound: ${t.error}`], bound: false };
  if (t.stop) return { lines: [`Domain ${host}: not bound: ${t.stop}`], bound: false };
  if (t.none) return { lines: [`Domain ${host}: not bound: the resource group has no container app after the deploy`], bound: false };
  if (before.state === 'first') {
    const rec = await dnsRecords(host, t);
    if (rec.error) return { lines: [`Domain ${host}: not bound yet; public DNS did not answer for ${rec.error}`], bound: false, fqdn: t.fqdn };
    const right = rec.records.every(r => r.ok);
    return { lines: right ? [`Domain ${host}: the records are right; deploy again to add it and bind its certificate`] : recordsText(host, rec.records), bound: false, fqdn: t.fqdn };
  }
  const name = before.certName, started = Date.now(), validation = before.records.apex ? 'HTTP' : 'CNAME';
  let c = domainCertificate(row, env, t, name);
  if (c.error) return { lines: [`Domain ${host}: not bound: ${c.error}`], bound: false, fqdn: t.fqdn, failure: `domain not bound: ${c.error}` };
  if (c.cert && before.recreate) {
    const gone = az(['containerapp', 'env', 'certificate', 'delete', '-g', row.resourceGroup, '-n', t.environment.name, ...sub(row), '--certificate', name, '--yes'], env, undefined, 5 * 60 * 1000);
    if (gone.code !== 0) return { lines: [`Domain ${host}: not bound: certificate ${name} failed earlier and could not be deleted: ${azReason(gone)}`], bound: false, fqdn: t.fqdn, failure: `domain not bound: the failed certificate ${name} could not be deleted (${azReason(gone)})` };
    c = { cert: null };
  }
  if (!c.cert) {
    const made = az(['containerapp', 'env', 'certificate', 'create', '-g', row.resourceGroup, '-n', t.environment.name, ...sub(row), '--certificate-name', name, '--hostname', host, '--validation-method', validation], env, undefined, 5 * 60 * 1000);
    if (made.code !== 0) return { lines: [`Domain ${host}: not bound: ${azReason(made)}`], bound: false, fqdn: t.fqdn, failure: `domain not bound: ${azReason(made)}` };
  }
  const until = Date.now() + domainWait();
  for (;;) {
    c = domainCertificate(row, env, t, name);
    if (c.error) return { lines: [`Domain ${host}: not bound: ${c.error}`], bound: false, fqdn: t.fqdn, failure: `domain not bound: ${c.error}` };
    if (c.cert && c.cert.state === 'Succeeded') break;
    if (c.cert && /^(Failed|Canceled|DeleteFailed)$/i.test(c.cert.state)) return { lines: [`Domain ${host}: not bound: certificate ${name} ${c.cert.state}: ${c.cert.reason}`], bound: false, fqdn: t.fqdn, failure: `domain not bound: ${c.cert.reason}` };
    if (Date.now() >= until) return { lines: [`Domain ${host}: certificate ${name} still pending after ${took(domainWait())}; the next deploy binds it`], bound: false, fqdn: t.fqdn, pending: 'certificate pending: the next deploy binds it' };
    await sleep(domainPause());
  }
  const bound = az(['containerapp', 'hostname', 'bind', '-g', row.resourceGroup, '-n', t.app, ...sub(row), '--hostname', host, '--environment', t.environment.name, '--certificate', name], env, undefined, 5 * 60 * 1000);
  if (bound.code !== 0) return { lines: [`Domain ${host}: not bound: ${azReason(bound)}`], bound: false, fqdn: t.fqdn, failure: `domain not bound: ${azReason(bound)}` };
  return { lines: [`Domain ${host}: added, certificate ${name} issued in ${Math.round((Date.now() - started) / 1000)} s and bound; https://${host} is live.`], bound: true, fqdn: t.fqdn };
}
// BR7: the Check URL as written; its host is the custom domain and the domain is not bound at the end → the generated address with the same path, and the line says so.
function domainCheckUrl(checkUrl, before, after, fqdn) {
  if (!checkUrl || !before || !before.host || after.bound) return { url: checkUrl };
  let u; try { u = new URL(checkUrl); } catch { return { url: checkUrl }; }
  if (u.hostname.toLowerCase() !== before.host || !fqdn) return { url: checkUrl };
  return { url: `https://${fqdn}${u.pathname}${u.search}`, line: `Check URL ${checkUrl} is on ${before.host}, which is not bound: polling the generated address instead` };
}

// BR9: the Aspire CLI version is the one of `Aspire.AppHost.Sdk/<version>` in the AppHost project (or its global.json `msbuild-sdks`).
function aspireSdkVersion(root, command) {
  const apphost = apphostFile(root, command);
  if (!apphost) return { error: 'the command names no --apphost project, so the version of Aspire.AppHost.Sdk cannot be read' };
  if (!fs.existsSync(apphost)) return { error: `the AppHost project ${forward(path.relative(root, apphost))} does not exist at this tag, so the version of Aspire.AppHost.Sdk cannot be read` };
  const sources = [apphost];
  for (let d = path.dirname(apphost); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'global.json'))) sources.push(path.join(d, 'global.json'));
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) break;
  }
  for (const f of sources) {
    const t = fs.readFileSync(f, 'utf8');
    const m = /Aspire\.AppHost\.Sdk\/([^"'\s<>]+)/.exec(t) || /<Sdk\s+Name="Aspire\.AppHost\.Sdk"\s+Version="([^"]+)"/.exec(t) || /"Aspire\.AppHost\.Sdk"\s*:\s*"([^"]+)"/.exec(t);
    if (m && !m[1].includes('$(')) return { version: m[1], from: forward(path.relative(root, f)) };
  }
  return { error: `no literal Aspire.AppHost.Sdk version in ${forward(path.relative(root, apphost))} (or a global.json above it)` };
}
// The `dotnet` of the install goes through the seam AGILE_DOTNET_FAKE (a node script: the check scripts install nothing), else the real one.
function installAspireCli(root, command, env) {
  const found = aspireSdkVersion(root, command);
  if (found.error) return { error: found.error };
  const folder = path.join(process.env.RUNNER_TEMP || require('os').tmpdir(), `aspire-cli-${found.version}`);
  const argv = ['tool', 'install', 'Aspire.Cli', '--version', found.version, '--tool-path', folder];
  const have = path.join(folder, process.platform === 'win32' ? 'aspire.cmd' : 'aspire');
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const prepend = { env: { ...env, [key]: `${folder}${path.delimiter}${env[key] || ''}` }, line: `Aspire CLI ${found.version} installed (from Aspire.AppHost.Sdk of ${found.from})`, version: found.version };
  if (fs.existsSync(have) || fs.existsSync(path.join(folder, 'aspire.exe'))) return { ...prepend, line: `Aspire CLI ${found.version} already installed (from Aspire.AppHost.Sdk of ${found.from})` };
  const r = process.env.AGILE_DOTNET_FAKE ? spawnSync(process.execPath, [process.env.AGILE_DOTNET_FAKE, ...argv], { env, encoding: 'utf8', timeout: 5 * 60 * 1000 }) : spawnSync('dotnet', argv, { env, encoding: 'utf8', timeout: 5 * 60 * 1000 });
  if (r.error || r.status !== 0) return { error: `Aspire.Cli ${found.version} could not be installed (dotnet tool install ${r.error ? r.error.code || r.error.message : `exited ${r.status}`}: ${((r.stdout || '') + (r.stderr || '')).split('\n').filter(Boolean).slice(0, 2).join(' | ')})` };
  return prepend;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pollCheck(url, seconds) {
  const started = Date.now();
  let last = 'no answer';
  while ((Date.now() - started) / 1000 < seconds) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      if (res.status === 200) return { ok: true, seconds: Math.round((Date.now() - started) / 100) / 10 };
      last = `HTTP ${res.status}`;
    } catch (e) { last = (e.cause && e.cause.code) || e.name || 'no answer'; }
    await sleep(1000);
  }
  return { ok: false, last, seconds };
}

// The package folder of the tag, as local /agile:publish lays it out (<name>/ and <name>.zip per deployable project), for a command that uses
// AGILE_ARTIFACTS. A web or API profile only: a mobile or desktop head is not deployed from here.
function rebuild(tag, root) {
  const out = path.join(root, 'artifacts', 'publish', tag);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const found = [];
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!['bin', 'obj', 'node_modules', '.git', 'artifacts'].includes(e.name)) walk(path.join(dir, e.name)); }
      else if (/\.(Api|Web)\.csproj$/i.test(e.name)) found.push(path.join(dir, e.name));
    }
  })(path.join(root, 'src'));
  if (!found.length) return { error: 'no <App>.Api or <App>.Web project under src/ to build AGILE_ARTIFACTS from' };
  for (const csproj of found.sort()) {
    const name = path.basename(csproj).replace(/\.csproj$/i, '');
    const folder = path.join(out, name);
    const built = spawnSync('dotnet', ['publish', csproj, '-c', 'Release', '-o', folder, '-nologo'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (built.status !== 0) return { error: `dotnet publish failed for ${name}: ${((built.stdout || '') + (built.stderr || '')).split('\n').filter(l => /error/i.test(l)).slice(0, 3).join(' | ')}` };
    fs.rmSync(path.join(folder, 'appsettings.Development.json'), { force: true });
    fs.rmSync(path.join(folder, `${name}.xml`), { force: true });
    const zipFile = path.join(out, `${name}.zip`);
    // The runner is ubuntu (zip); Windows' own bsdtar writes a zip with -a, which is how a local run of this script is checked.
    const zipped = process.platform === 'win32'
      ? spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zipFile, '-C', folder, ...fs.readdirSync(folder)], { encoding: 'utf8' })
      : spawnSync('zip', ['-r', '-q', zipFile, '.'], { cwd: folder, encoding: 'utf8' });
    if (zipped.status !== 0) return { error: `zipping ${name} failed` };
  }
  return { folder: out };
}

async function main() {
  const root = process.cwd();
  const environment = process.env.AGILE_ENVIRONMENT || '', tag = process.env.AGILE_TAG || '';
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const summary = [];
  const finish = (ok, line, detail = []) => {
    const text = [`## ${ok ? 'Deployed' : 'Not deployed'}`, '', line, ...detail, ...summary].join('\n');
    console.log(`\n${text}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    return ok ? 0 : 1;
  };
  const stop = (why, detail) => { console.log(`::error::${why}`); return finish(false, why, detail); };
  if (!/^v\d+\.\d+\.\d+\S*$/.test(tag)) return stop(`"${tag}" is not a tag like v0.3.0`);
  let text;
  try { text = fs.readFileSync(path.join(root, 'docs', 'infra.md'), 'utf8'); } catch { return stop(`docs/infra.md does not exist at ${tag}`); }
  const infra = readInfra(text);
  if (infra.error) return stop(infra.error);
  const target = infra.environments.find(e => e.name.toLowerCase() === environment.toLowerCase());
  if (!target) return stop(`docs/infra.md has no environment "${environment}" (it has: ${infra.environments.map(e => e.name).join(', ')})`);
  if (/^local$/i.test(target.name)) return stop('local is not deployed by the pipeline: it is the machine of the developer');
  if (!target.command) {
    const why = `${target.name} declares no deploy command in docs/infra.md: nothing was deployed`;
    if (manual) return stop(why);
    console.log(`::notice::${why}`);
    return finish(true, why);
  }
  // BR4: every secret the deploy needs is set, by name; a value is never printed.
  const unset = target.secrets.filter(v => !process.env[v]);
  if (unset.length) return stop(`the secret${unset.length > 1 ? 's' : ''} ${unset.join(', ')} ${unset.length > 1 ? 'are' : 'is'} not set for the GitHub environment ${target.name}: add ${unset.length > 1 ? 'them' : 'it'} to the environment's secrets, make sure .github/workflows/deploy.yml passes ${unset.length > 1 ? 'them' : 'it'} (secrets.<name>), then run again; the command did not run`);

  // BR9 (#66): the Cloud accounts row is read from the commit that holds the workflow (AGILE_CLOUD_INFRA), never from the tag, so a rollback to a tag
  // older than this section is still checked against today's row. An Azure, AWS or GCP row must match the login the workflow made (azure/login,
  // configure-aws-credentials, google-github-actions/auth); this catches a misconfiguration, the protection rule of the GitHub environment is the boundary.
  // A missing row or another cloud is not checked here.
  let base = process.env;
  const cloud = cloudFor(fs.existsSync(process.env.AGILE_CLOUD_INFRA || '') ? fs.readFileSync(process.env.AGILE_CLOUD_INFRA, 'utf8') : text, target.name);
  if (cloud.error) return stop(cloud.error);
  if (cloud.row) { const bad = cloudRowProblem(cloud.row); if (bad) return stop(bad); }
  const aca = acaProblem(root, target.command, target.name, cloud.row);   // #67 BR8
  if (aca) return stop(aca);
  if (cloud.row) {
    if (CHECKED.includes(cloud.row.cloud)) {
      const row = cloud.row, who = row.client || 'the client', acct = cloudAccount(row, process.env, 'pipeline');
      if (!acct.checked.ok) return stop(acct.message(false).stop);
      base = acct.env;
      const a = acct.checked.active;
      summary.push('', row.cloud === 'azure' ? `Azure: ${who}'s subscription ${a.name || row.subscription} (${row.subscription}), tenant ${row.tenant}; removed from the environment: ${acct.removed.join(', ') || 'nothing'}.`
        : row.cloud === 'aws' ? `AWS: ${who}'s account ${row.account} (${a.arn || 'no ARN'}), region ${row.region}.`
          : `Google Cloud: ${who}'s project ${row.account}${a.name ? ` (${a.name})` : ''}.`);
    } else if (cloud.row.cloud !== 'none') summary.push('', `${notChecked(cloud.row)}.`);
  }
  // #75 BR8: a parked `aca` environment gets its PostgreSQL server started (and its mark removed) before the command; a start that fails stops the deploy.
  if (isRecipe(target.command) && cloud.row && deployTarget(root, target.command, target.name).target === 'aca') {
    const parked = await startParked(cloud.row, base, target.name);
    if (!parked.ok) return stop(parked.reason);
    if (parked.line) { console.log(parked.line); summary.push('', `${parked.line}.`); }
  }
  // #76: the custom domain of an aca environment (the host of its URL): the records are read first, the command gets the domain only when they are right.
  const aca76 = isRecipe(target.command) && cloud.row && deployTarget(root, target.command, target.name).target === 'aca';
  const cloudText = fs.existsSync(process.env.AGILE_CLOUD_INFRA || '') ? fs.readFileSync(process.env.AGILE_CLOUD_INFRA, 'utf8') : text;
  const urlNow = ((readInfra(cloudText).environments || []).find(e => e.name.toLowerCase() === target.name.toLowerCase()) || {}).url || null;   // the same file as the row: a rerun of an old tag keeps the domain
  const domain = aca76 ? await domainBefore(cloud.row, base, urlNow, { root, command: target.command }) : { state: 'none', env: {}, lines: [] };
  if (domain.state === 'stop') return stop(domain.stop);
  for (const line of domain.lines) { console.log(line); summary.push('', line); }
  const env = { ...base, ...domain.env, AGILE_ENVIRONMENT: target.name, AGILE_VERSION: tag.replace(/^v/, ''), AGILE_TAG: tag };
  const artifacts = path.join(root, 'artifacts', 'publish', tag);
  env.AGILE_ARTIFACTS = artifacts;
  // #67 BR9: a recipe command needs the Aspire CLI, at the version of the AppHost's SDK; the workflow names no provider command, so it is installed here.
  let runEnv = env;
  if (isRecipe(target.command)) {
    const cli = installAspireCli(root, target.command, env);
    if (cli.error) return stop(`${cli.error}; the command did not run`);
    console.log(cli.line); summary.push('', `${cli.line}.`);
    runEnv = cli.env;
  }
  if (/AGILE_ARTIFACTS/.test(target.command) && !isRecipe(target.command)) {
    const built = rebuild(tag, root);
    if (built.error) return stop(`the package of ${tag} could not be rebuilt: ${built.error}; the command did not run`);
  }
  console.log(`Deploying ${tag} to ${target.name}: ${target.command}`);
  const started = Date.now();
  const ran = spawnSync(target.command, { cwd: root, env: runEnv, shell: true, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  let output = (ran.stdout || '') + (ran.stderr || '');
  for (const v of target.secrets) if (process.env[v]) output = output.split(process.env[v]).join('***');
  console.log(output);
  const rollback = `/agile:publish ${target.name} v<the version recorded for ${target.name} in docs/infra.md> locally, or run this workflow by hand with that tag`;
  const code = ran.error ? 127 : ran.status;
  // #77 BR3-BR6: an `aca` environment's budget is written after the deploy command whatever its exit code (a deploy that failed halfway may have created the group),
  // with the login the workflow made; a failed write is said after the deploy's own result and fails the step.
  let budgetFail = '';
  if (isRecipe(target.command) && cloud.row && deployTarget(root, target.command, target.name).target === 'aca') {
    const b = budgetOf(cloud.row);
    if (b.none) summary.push('', `${budgetPlanLine(cloud.row)}.`);
    else {
      const wrote = writeBudget(cloud.row, b.amount, base);
      console.log(wrote.ok ? wrote.line : `Budget ${BUDGET} not written: ${wrote.reason}`);
      if (wrote.ok) summary.push('', `${wrote.line}.`); else budgetFail = `; budget not written: ${wrote.reason}`;
    }
  }
  let domainFail = '', domainPending = '', after = { lines: [], bound: false };   // #76, set after the command
  const failedDeploy = why => (budgetFail || domainFail ? `deploy failed (${why})${budgetFail}${domainFail ? `; ${domainFail}` : ''}` : why);   // BR6: `deploy failed; budget not written: <reason>`
  if (code !== 0) return stop(failedDeploy(`the deploy command exited ${code}${ran.error ? ` (${ran.error.code || ran.error.message})` : ''}`),['', `Nothing was rolled back. To go back: ${rollback}.`]);
  // #76 BR5-BR7: after a command that exited 0 the certificate is issued and bound; a pending one is no failure, a refused one fails the run (the deploy is never undone).
  if (aca76 && code === 0) {
    after = await domainAfter(cloud.row, base, domain);
    for (const line of after.lines) { console.log(line); summary.push('', line); }
    domainFail = after.failure || ''; domainPending = after.pending || '';
  }
  if (target.checkUrl) {
    const chosen = domainCheckUrl(target.checkUrl, domain, after, after.fqdn);
    if (chosen.line) { console.log(chosen.line); summary.push('', `${chosen.line}.`); }
    const check = await pollCheck(chosen.url, Number(process.env.AGILE_CHECK_SECONDS) || 60);
    if (!check.ok) return stop(failedDeploy(`the deploy command exited 0 but ${chosen.url} never answered 200 in ${check.seconds} s (last: ${check.last})`),['', `Nothing was rolled back. To go back: ${rollback}.`]);
    summary.push('', `Check: ${chosen.url} answered 200 in ${check.seconds} s.`);
  }
  if (budgetFail || domainFail) return stop(`deploy ok${budgetFail}${domainFail ? `; ${domainFail}` : ''}`, ['', `${tag} is deployed to ${target.name}; nothing was rolled back. Fix the cause and run the deploy again${budgetFail ? ' (the budget can also be written by hand)' : ''}.`]);
  // BR8: the pipeline commits nothing; the owner records the version with a local /agile:publish.
  return finish(true, domainPending ? `deploy ok; ${domainPending}` : `${tag} deployed to ${target.name}`, ['', `It took ${Math.round((Date.now() - started) / 1000)} s.`, `Record it: the Version (deployed on) cell of ${target.name} in docs/infra.md is written only by a local /agile:publish.`]);
}

// #100: the helpers scripts/restore-drill.js shares (the plugin's own file; the pipeline's main() never calls it).
module.exports = { az, cli, azBusy, azReason, listGroup, groupLive, took, sub, inGroup, waitPause, clock, sleep, json, apphostHasDomainCode, domainOf, certificateNameOf, domainBefore, domainAfter, domainCheckUrl, domainTarget, readSpend, parkEnvironment, resumeEnvironment, startParked, reparkEnvironment, readSchedule, scheduleProblem, cronProblem, timezoneProblem, SCHEDULE_ACTIONS, pollCheck, PARKED, MIN_TAG, readInfra, deployTarget, acaProblem, budgetOf, budgetPlanLine, leftoverBudget, writeBudget, ignoredNote, groupProblem, BUDGET, aspireSdkVersion, isRecipe, cloudFor, cloudRowProblem, ignoredCells, azureEnv, azureCheck, azureMessage, awsEnv, awsCheck, gcpEnv, gcpCheck, CHECKED, cloudAccount, notChecked, parseConfigJson };
if (require.main === module) main().then(code => { process.exitCode = code; });
