import { readFileSync } from 'fs'

// The version the client sees is the package's, not a literal that drifts: the literal said 0.2.2 for months.
// `../package.json` holds from both `src/` and `dist/`, which sit at the same depth.
export const SERVER_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version
