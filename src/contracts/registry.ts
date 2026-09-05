import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * Zod schemas are the API contract (architecture Part 3.4): one definition
 * validates at the Express boundary and generates `openapi/openapi.json`, from
 * which the web and mobile clients generate their typed clients. A
 * hand-written type on either side would be a second source of truth.
 *
 * This module must be imported before any schema calls `.openapi()`.
 */
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export { z };
