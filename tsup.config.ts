import { defineConfig } from 'tsup'

// Optional peer dependencies. A serverless deployment on the HTTP transport
// never imports these, and nothing should drag them in.
const external = ['express', 'fastify', 'ws']

export default defineConfig([
  {
    entry: [
      'src/index.ts',
      'src/ws.ts',
      'src/adapters/express.ts',
      'src/adapters/fastify.ts',
      'src/adapters/web.ts',
      'src/store/sqlite.ts',
      'src/testing/index.ts',
    ],
    format: ['esm', 'cjs'],
    dts: true,
    // Shared chunks for CJS as well as ESM, so a class like ConfigurationError
    // exists once however many subpaths are required, and instanceof holds.
    splitting: true,
    sourcemap: true,
    target: 'node20',
    external,
    // Keep `node:` specifiers as written.
    removeNodeProtocol: false,
  },
  {
    // The bin is ESM only and ships no types.
    entry: ['src/cli.ts'],
    format: ['esm'],
    sourcemap: true,
    target: 'node20',
    external,
    removeNodeProtocol: false,
  },
])
