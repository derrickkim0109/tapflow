#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startClient } from './startup.js'
import { INSTRUCTIONS } from './guide.js'
import { registerTools } from './tools.js'
import { SERVER_VERSION } from './version.js'

const client = await startClient(process.env, (line) => process.stderr.write(`${line}\n`))
if (!client) process.exit(1)

const server = new McpServer({ name: 'tapflow', version: SERVER_VERSION }, { instructions: INSTRUCTIONS })

registerTools(server, client)

const transport = new StdioServerTransport()
await server.connect(transport)

process.on('SIGINT', () => { client.disconnect(); process.exit(0) })
process.on('SIGTERM', () => { client.disconnect(); process.exit(0) })
