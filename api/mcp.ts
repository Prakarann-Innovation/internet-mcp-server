import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Import tools from the compiled dist folder
import tools from '../dist/tools/index.js';

// In-memory session storage (note: Vercel serverless functions are stateless,
// so sessions won't persist across cold starts)
const transports = new Map<string, StreamableHTTPServerTransport>();

const isListToolsRequest = (value: unknown): value is ListToolsRequest =>
  ListToolsRequestSchema.safeParse(value).success;

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
  for (const tool of Object.values(tools)) {
    tool.register(mcpServer);
  }

  return mcpServer;
}

const getTransport = async (
  sessionId: string | undefined,
  body: unknown
): Promise<StreamableHTTPServerTransport> => {
  // Check for an existing session
  if (sessionId && transports.has(sessionId)) {
    return transports.get(sessionId)!;
  }

  // We have a special case where we'll permit ListToolsRequest w/o a session ID
  if (!sessionId && isListToolsRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    return transport;
  }

  // Otherwise, start a new transport/session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      transports.set(newSessionId, transport);
    },
  });

  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  return transport;
};

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

  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = await getTransport(sessionId, req.body);

    // Create a mock request/response for the transport
    // The StreamableHTTPServerTransport expects Express-like req/res
    const mockReq = {
      method: req.method,
      headers: req.headers,
      body: req.body,
      on: (event: string, callback: () => void) => {
        if (event === 'close') {
          // Handle connection close if needed
        }
      },
    };

    const mockRes = {
      statusCode: 200,
      headersSent: false,
      _headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this._headers[name] = value;
        res.setHeader(name, value);
      },
      getHeader(name: string) {
        return this._headers[name];
      },
      status(code: number) {
        this.statusCode = code;
        res.status(code);
        return this;
      },
      json(data: unknown) {
        this.headersSent = true;
        return res.json(data);
      },
      send(data: unknown) {
        this.headersSent = true;
        return res.send(data);
      },
      end(data?: unknown) {
        this.headersSent = true;
        return res.end(data);
      },
      write(chunk: unknown) {
        return res.write(chunk);
      },
      flushHeaders() {
        // Vercel handles this automatically
      },
    };

    await transport.handleRequest(mockReq as any, mockRes as any, req.body);
  } catch (error) {
    console.error('MCP Handler Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        id: null,
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
      });
    }
  }
}

