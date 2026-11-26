#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { CLI_VERSION } from './version.js';

// commands load lazily: `serve` starts OpenTelemetry before the server modules are imported
const compileCmd = () => import('./commands/compile.js');
const serveCmd = () => import('./commands/serve.js');

/**
 * `npx neurouter serve|validate|eval|mock|compile|keys|console-link` (§15.8). Exit codes: 0 ok,
 * 1 failed check (validation errors, score below --min-score), 2 error.
 */
export function buildProgram(): Command {
  const program = new Command('neurouter').description('Turn an OpenAPI or GraphQL API into a governed MCP server').version(CLI_VERSION);
  const defaultConfig = existsSync('neurouter.yaml') ? 'neurouter.yaml' : undefined;

  program
    .command('serve')
    .description('Run the full server (SQLite at <data>/neurouter.db) and print the console link')
    .option('-c, --config <file>', 'neurouter.yaml', defaultConfig)
    .option('-p, --port <port>', 'port', '3000')
    .option('--host <host>', 'host', '127.0.0.1')
    .option('--data <dir>', 'data directory', './.neurouter')
    .option('--embeddings', 'enable local search embeddings (downloads the model)', false)
    .action(async (o) => {
      const { otelEnabled, startOtel } = await import('@neurouter/server/otel');
      if (otelEnabled(process.env)) await startOtel(process.env);
      await (await serveCmd()).cmdServe(o);
    });

  program
    .command('console-link')
    .description('Mint a one-time console sign-in URL (talks to the same DATABASE_URL)')
    .option('--data <dir>', 'data directory', './.neurouter')
    .action(async (o) => (await serveCmd()).cmdConsoleLink(o));

  program
    .command('validate')
    .description('Parse, reconcile (dry run), compile and lint neurouter.yaml; exit 1 on errors')
    .option('-c, --config <file>', 'neurouter.yaml', defaultConfig ?? 'neurouter.yaml')
    .option('--print-schema', 'print the neurouter.yaml JSON Schema and exit', false)
    .action(async (o) => (await compileCmd()).cmdValidate(o));

  program
    .command('compile')
    .description('Compile a spec (+ overlay) to the tool model and Python stubs')
    .option('--spec <fileOrUrl>', 'OpenAPI 3.x / GraphQL SDL or introspection JSON')
    .option('--overlay <file>', 'overlay YAML')
    .option('--out <file>', 'write tools.json')
    .option('--stubs <dir>', 'write <namespace>.pyi files')
    .option('--namespace <ns>', 'Python namespace (default from the spec title)')
    .option('--graphql-endpoint <url>', 'introspect a live GraphQL endpoint instead of --spec')
    .action(async (o) => (await compileCmd()).cmdCompile(o));

  program
    .command('mock')
    .description('Serve the mock API generated from a spec over HTTP')
    .requiredOption('--spec <fileOrUrl>', 'spec file or URL')
    .option('-p, --port <port>', 'port', '4010')
    .option('--seed <n>', 'seed', '42')
    .action(async (o) => (await import('./commands/mock.js')).cmdMock(o));

  program
    .command('eval')
    .description('Generate or load an eval suite, run it (tool and code mode) and print the agent-readiness score')
    .option('-c, --config <file>', 'neurouter.yaml (with --server)')
    .option('--server <slug>', 'server in the config')
    .option('--spec <fileOrUrl>', 'spec (boots an in-process server with a mock environment)')
    .option('--overlay <file>', 'overlay YAML for --spec')
    .option('--suite <file>', 'suite JSON to run')
    .option('--generate', 'generate a suite', false)
    .option('--counts <s,m,a,i>', 'tasks per category for --generate', '8,8,4,4')
    .option('--save-suite <file>', 'write the suite JSON')
    .option('--models <list>', 'comma-separated models (default gpt-6-luna; e.g. gpt-6-luna,claude-sonnet-5-5,gemini-3.5-flash-lite; provider:model forces a provider)')
    .option('--modes <list>', 'tool,code', 'tool,code')
    .option('--repeats <n>', 'attempts per task', '3')
    .option('--env <slug>', 'environment', 'mock')
    .option('--min-score <n>', 'exit 1 when the headline is below')
    .option('--out <file>', 'write the JSON report')
    .option('--md <file>', 'write the Markdown report')
    .option('--transcripts <file>', 'write every attempt (full transcript, observed calls, assertion results) as JSON, for debugging')
    .option('--transcript-max-chars <n>', 'with --transcripts: trim each transcript item (text, tool result) to n characters (default: untrimmed)')
    .option('--suggest', 'print fix suggestions', false)
    .option('--embeddings', 'enable local search embeddings', false)
    .action(async (o) => (await import('./commands/eval.js')).cmdEval(o));

  const keys = program.command('keys').description('Crypto keys and API keys');
  keys
    .command('gen [keyId]')
    .description('Print NEUROUTER_MASTER_KEYS / NEUROUTER_ACTIVE_KEY_ID / HASH_PEPPER')
    .action(async (keyId?: string) => console.log((await import('./commands/keys.js')).generateKeyEnv(keyId)));
  keys
    .command('create')
    .description('Create an API key for a server environment (dev convenience; talks to DATABASE_URL)')
    .requiredOption('--server <slug>')
    .requiredOption('--env <slug>')
    .option('--scopes <list>', 'tools:read,tools:write,code:run', 'tools:read,code:run')
    .option('--name <name>', 'key name', 'cli')
    .option('--tenant <slug>', 'organization slug (default: the default organization)')
    .option('--data <dir>', 'data directory', './.neurouter')
    .action(async (o) => (await serveCmd()).cmdKeysCreate(o));
  return program;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/neurouter') || process.argv[1]?.endsWith('cli/src/main.ts') || process.argv[1]?.endsWith('cli/dist/main.js')) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    });
}
