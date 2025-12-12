import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Tool type definition
interface Tool {
  name: string;
  register: (mcpServer: McpServer) => void;
}

// Import tools from the compiled dist folder
// @ts-ignore - importing from compiled JS, types are defined above
import tools from '../dist/tools/index.js';

function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    {
      version: '2.0.63',
      name: 'brave-search-mcp-server',
      title: 'Brave Search MCP Server',
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: false },
      },
      instructions: `Use this server to search the Web for various types of data via the Brave Search API.`,
    }
  );

  // Register all tools
  const toolsRecord = tools as Record<string, Tool>;
  for (const tool of Object.values(toolsRecord)) {
    tool.register(mcpServer);
  }

  return mcpServer;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS for preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
    return res.status(200).end();
  }

  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');

  // Health check endpoint
  if (req.url?.includes('/ping') || req.query?.ping !== undefined) {
    return res.status(200).json({ message: 'pong' });
  }

  // Validate API key is configured
  if (!process.env.BRAVE_API_KEY) {
    return res.status(500).json({
      id: null,
      jsonrpc: '2.0',
      error: { code: -32603, message: 'BRAVE_API_KEY environment variable not configured' },
    });
  }

  // Only accept POST requests for MCP
  if (req.method !== 'POST') {
    return res.status(405).json({
      id: null,
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  }

  try {
    // Stateless mode: Create a fresh transport and server for each request
    // This works better with serverless functions that don't persist state
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    // Handle the request using the transport
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP Handler Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (!res.headersSent) {
      return res.status(500).json({
        id: null,
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal server error: ${errorMessage}` },
      });
    }
  }
}
