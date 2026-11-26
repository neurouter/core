/** Stateless GraphQL mock (backend spec §16, A19): `execute` with seeded field resolvers. */
import {
  graphql,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLFieldResolver,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLTypeResolver,
} from 'graphql';
import type { Faker } from '@faker-js/faker';
import { loadGraphqlSchema } from '../graphql/compile-graphql.js';
import { isObj, type Obj } from '../util.js';
import { hashSeed, MOCK_REF_DATE, seededFaker } from './generate.js';
import type { GraphqlMockModel } from './model.js';

const schemaCache = new Map<string, GraphQLSchema>();

function schemaFor(model: GraphqlMockModel): GraphQLSchema {
  let s = schemaCache.get(model.schemaText);
  if (!s) {
    s = loadGraphqlSchema(model.schemaText, model.format);
    if (schemaCache.size > 50) schemaCache.clear();
    schemaCache.set(model.schemaText, s);
  }
  return s;
}

function scalar(name: string, field: string, f: Faker): unknown {
  const n = field.toLowerCase();
  switch (name) {
    case 'Int':
      return n === 'id' ? f.number.int({ min: 1, max: 9999 }) : f.number.int({ min: 0, max: 1000 });
    case 'Float':
      return Math.round(f.number.float({ min: 0, max: 1000 }) * 100) / 100;
    case 'Boolean':
      return f.datatype.boolean();
    case 'ID':
      return f.string.alphanumeric(8);
  }
  if (n.includes('email')) return f.internet.email().toLowerCase();
  if (n.endsWith('url')) return f.internet.url();
  if (n.endsWith('at') || n.includes('date')) return f.date.recent({ refDate: MOCK_REF_DATE }).toISOString();
  if (n === 'code') return f.location.countryCode();
  if (n === 'name' || n.endsWith('name')) return f.location.country();
  if (n === 'capital') return f.location.city();
  if (n === 'currency') return f.finance.currencyCode();
  if (n === 'emoji') return '🏳️';
  return f.lorem.word();
}

function mockFor(type: GraphQLOutputType, field: string, f: Faker, depth: number): unknown {
  if (isNonNullType(type)) return mockFor(type.ofType, field, f, depth);
  if (isListType(type)) return depth > 3 ? [] : Array.from({ length: 5 }, () => mockFor(type.ofType as GraphQLOutputType, field, f, depth + 1));
  if (isScalarType(type)) return scalar(type.name, field, f);
  if (isEnumType(type)) return f.helpers.arrayElement(type.getValues()).name;
  if (isObjectType(type)) return { __typename: type.name };
  if (isInterfaceType(type) || isUnionType(type)) return { __abstract: true };
  return null;
}

export async function handleGraphqlMock(model: GraphqlMockModel, body: { query?: string; variables?: Obj; operationName?: string }): Promise<unknown> {
  const schema = schemaFor(model);
  if (typeof body.query !== 'string') return { errors: [{ message: 'Must provide query string.' }] };
  const faker = seededFaker(hashSeed(body.query, JSON.stringify(body.variables ?? {})));
  const fieldResolver: GraphQLFieldResolver<unknown, unknown> = (source, _args, _ctx, info) => {
    if (isObj(source) && info.fieldName in source) return source[info.fieldName];
    return mockFor(info.returnType, info.fieldName, faker, info.path.key && typeof info.path.key === 'number' ? 2 : 1);
  };
  const typeResolver: GraphQLTypeResolver<unknown, unknown> = (value, _ctx, _info, abstract) => {
    if (isObj(value) && typeof value.__typename === 'string' && !value.__abstract) return value.__typename;
    return schema.getPossibleTypes(abstract)[0]?.name;
  };
  const res = await graphql({ schema, source: body.query, ...(body.variables ? { variableValues: body.variables } : {}), ...(body.operationName ? { operationName: body.operationName } : {}), fieldResolver, typeResolver });
  return JSON.parse(JSON.stringify(res));
}
