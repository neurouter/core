import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../compile.js';

export const REPO = path.resolve(import.meta.dirname, '../../../..');
export const PETSTORE = path.join(REPO, 'examples/petstore/openapi.yaml');
export const COUNTRIES = path.join(REPO, 'examples/graphql-countries/schema.graphql');
export const GITHUB_SUBSET = path.join(REPO, 'examples/github/github-subset.json');
export const GITHUB_FULL = path.join(REPO, 'examples/github/spec/api.github.com.json');
export const GITHUB_OVERLAY = path.join(REPO, 'examples/github/curated.overlay.yaml');

export const enc = (s: string) => new TextEncoder().encode(s);
export const read = (p: string) => fs.readFileSync(p);

export function spec31(paths: Record<string, unknown>, components: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ openapi: '3.1.0', info: { title: 'Test API', version: '1.2.3' }, paths, components, ...extra });
}

export async function compileText(text: string, overlay?: string, namespace = 'test') {
  return compile({ spec: { bytes: enc(text) }, namespace, ...(overlay !== undefined ? { overlay } : {}) });
}

export async function compileFile(file: string, overlay?: string, namespace = 'test') {
  return compile({ spec: { bytes: read(file) }, namespace, ...(overlay !== undefined ? { overlay } : {}) });
}

/** A small CRUD API used across tests. */
export const NOTES_SPEC = spec31(
  {
    '/projects/{project}/notes': {
      parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' }, description: 'Project key' }],
      get: {
        operationId: 'listNotes',
        summary: 'List notes in a project',
        tags: ['notes'],
        parameters: [
          { name: 'state', in: 'query', schema: { type: 'string', enum: ['open', 'closed'] }, description: 'Filter by state' },
          { name: 'per_page', in: 'query', schema: { type: 'integer', default: 30 }, description: 'Page size' },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: 'Page number' },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Note' } } } } } },
      },
      post: {
        operationId: 'createNote',
        summary: 'Create a note',
        tags: ['notes'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewNote' } } } },
        responses: { '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } } },
      },
    },
    '/projects/{project}/notes/{note_id}': {
      parameters: [
        { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'note_id', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      get: { operationId: 'getNote', summary: 'Get a note', tags: ['notes'], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } } } },
      patch: {
        operationId: 'updateNote',
        summary: 'Update a note',
        tags: ['notes'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewNote' } } } },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } } },
      },
      delete: { operationId: 'deleteNote', summary: 'Delete a note', tags: ['admin'], responses: { '204': { description: 'gone' } } },
    },
  },
  {
    schemas: {
      Note: {
        type: 'object',
        required: ['id', 'title'],
        properties: { id: { type: 'integer', readOnly: true }, title: { type: 'string' }, body: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] }, secret: { type: 'string', writeOnly: true }, updated_at: { type: 'string', format: 'date-time' } },
      },
      NewNote: { type: 'object', required: ['title'], properties: { id: { type: 'integer', readOnly: true }, title: { type: 'string', description: 'Note title' }, body: { type: 'string', description: 'Markdown body' }, state: { type: 'string', enum: ['open', 'closed'] } } },
    },
  },
);
