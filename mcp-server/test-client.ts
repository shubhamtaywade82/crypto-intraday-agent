// Minimal MCP stdio client to verify the server: initialize, list tools, call engine_status
// Run from mcp-server/ (deps live here): bun ../scripts/test-mcp-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'bun',
  args: [import.meta.dir + '/index.ts'],
})
const client = new Client({ name: 'test-client', version: '1.0.0' })
await client.connect(transport)

const tools = await client.listTools()
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '))

const res = await client.callTool({ name: 'engine_status', arguments: {} })
console.log('engine_status →', (res.content as any)[0]?.text?.slice(0, 300))

const res2 = await client.callTool({ name: 'open_positions', arguments: {} })
console.log('open_positions →', (res2.content as any)[0]?.text?.slice(0, 200))

await client.close()
console.log('OK')
