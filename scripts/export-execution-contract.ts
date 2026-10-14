import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { executorRequestSchema } from '../src/core/execution-contract.ts';
await writeFile('services/browser-publisher/request.schema.json', `${JSON.stringify(z.toJSONSchema(executorRequestSchema), null, 2)}\n`);
