export { COMPILER_VERSION } from './version.js';
export { compile, detectSpec, buildHash, finalize, agentDefinition, type CompileResult, type DetectedSpec } from './compile.js';
export { compileOpenApi, cleanDescription, type OpenApiCompileOutput } from './openapi/compile-openapi.js';
export { SchemaResolver, schemaDepth, countFields } from './openapi/schema.js';
export { compileGraphql, loadGraphqlSchema, selectionFor, buildDocument, documentWithSelection, type GraphqlCompileOutput } from './graphql/compile-graphql.js';
export { snakeCase, toToolName, nameFromMethodPath, uniquify, pyNamespace, pyIdent, isVerb, PY_KEYWORDS } from './naming.js';
export { parseOverlay, selectorLine, type ParsedOverlay } from './overlay/parse.js';
export { applyOverlay, matchesSelector, selectorClass, compositeTool, type ApplyResult } from './overlay/apply.js';
export { applyOverlayPatch, diffOverlays, OverlayPatchError, type PatchResult } from './overlay/patch.js';
export { parsePath, formatPath, getAll, deleteAt, replaceAt, includePaths, flattenAt, validatePaths, PathSyntaxError, type PathSeg } from './overlay/paths.js';
export { shapeResponse, shapeOutputSchema, wrapStructured, REDACTED_VALUE, type ShapeResult, type ShapeOptions, type TruncationInfo } from './shape.js';
export { generateStubs, generateOpsStub, pySignatureFor, pyArgMap, pascalCase, MAX_TYPED_DICTS, type StubOptions } from './stubs.js';
export { lint, LINT_WEIGHTS, type LintOptions } from './lint.js';
export { diffSpecs, type SpecChangeSummary, type OpRef } from './diff.js';
export { buildMockModel, type MockModel, type OpenApiMockModel, type GraphqlMockModel, type MockOperation, type MockResource, type MockOpKind } from './mock/model.js';
export { MockStore, sampleEntities, defaultScopeValue, SEED_ITEMS, DEFAULT_SEED, type MockStoreOptions, type Collection } from './mock/store.js';
export { handleMockRequest, type MockRequest, type MockResponse } from './mock/handler.js';
export { handleGraphqlMock } from './mock/graphql.js';
export { generateValue, seededFaker, hashSeed } from './mock/generate.js';
export { sha256Hex, jcsHash } from './util.js';

import type { MockStore } from './mock/store.js';
/** Reseeds a mock namespace (`environments.resetMock`). */
export function resetNamespace(store: MockStore, namespace: string, seed?: number): void {
  store.resetNamespace(namespace, seed);
}
