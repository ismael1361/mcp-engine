import { IAccessToken, IAuthorizationRequest, IMCPClientConfig, IMCPLocalServer, IMCPRemoteServer } from "./type";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { http_client } from "./http-client";

type MCPTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

interface McpSession {
    /** ID da sessão MCP, único por sessão. */
    id: string;
    /** Timestamp de criação da sessão. */
    createdAt: number;
    /** Timestamp da última atividade na sessão. */
    lastActivity: number;
}

interface ActiveConnection {
    /** Instância do cliente MCP conectado, pronta para chamadas de ferramentas. */
    client: Client;
    /** Transporte associado à conexão (SSE, HTTP ou stdio). */
    transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
    /** Timestamp da última vez que a conexão foi utilizada. */
    lastUsed: number;
    /** Contador de uso da conexão para métricas e monitoramento. */
    usageCount: number;
    /** Token de acesso OAuth válido para o MCP remoto, se aplicável. Pode ser usado para chamadas diretas ou para persistência de sessão. */
    oauthToken?: IAccessToken;
}

interface McpToolListItem {
    /** Nome da ferramenta disponível no MCP. */
    name: string;
    /** Descrição opcional da ferramenta. */
    description?: string;
    /** Schema de entrada da ferramenta, definindo os parâmetros esperados. */
    inputSchema: any;
}

type MCPConnectResult =
    | {
          /** Status da conexão com o MCP. Indica que o MCP solicitado não foi encontrado ou ocorreu um erro ao conectar. */
          status: "not_found";
          /** Mensagem descritiva sobre o erro ocorrido. */
          message: string;
      }
    | {
          /** Status da conexão com o MCP. Pode ser "connected" se a conexão foi estabelecida agora ou "reused" se uma conexão existente foi reutilizada. */
          status: "connected" | "reused";
          /** Lista de ferramentas disponíveis no MCP conectado, com nome, descrição e schema de entrada. */
          tools: McpToolListItem[];
          /** ID da sessão onde o MCP está conectado, útil para chamadas subsequentes ou persistência de contexto. */
          sessionId: string;
          /** Token de acesso OAuth válido para o MCP remoto, se aplicável. Pode ser usado para chamadas diretas ou para persistência de sessão. */
          oauthToken?: IAccessToken;
          /** Mensagem descritiva sobre o status da conexão. */
          message: string;
      }
    | {
          /** Status da conexão com o MCP. Indica que é necessário autenticação OAuth. */
          status: "oauth_required";
          /** URL de autorização OAuth para redirecionar o usuário e obter o código de autorização. */
          url: string;
          /** ID da sessão onde o MCP está tentando conectar, útil para associar o callback de OAuth. */
          sessionId: string;
          /** Detalhes do pedido de autorização, incluindo parâmetros necessários para o fluxo OAuth/PKCE. */
          message: string;
          /** Parâmetros necessários para o fluxo OAuth, incluindo URL de autorização, estado e codeVerifier para PKCE. */
          request: IAuthorizationRequest;
      };

/**
 * Engine de orquestracao MCP orientado a sessão.
 *
 * Responsabilidades principais:
 * - gerenciar conexões por sessão e por nome de MCP;
 * - reaproveitar conexões já abertas para reduzir latência;
 * - executar limpeza automática de conexões inativas;
 * - expor wrappers compatíveis com function calling para uso por IA.
 *
 * @typeParam K Union com os nomes de MCP aceitos na configuração.
 *
 * @example
 * const engine = new McpEngine({
 *   github: {
 *     type: "remote",
 *     url: "https://mcp.github.com",
 *   },
 * });
 */
export class McpEngine<K extends string = string> {
    private sessions: Map<string, McpSession> = new Map();
    private connections: Map<string, Map<string, ActiveConnection>> = new Map(); // sessionId -> { mcpName -> connection }

    // Configurações de lifecycle
    private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
    private readonly MAX_CONNECTIONS_PER_SESSION = 3;

    /**
     * Inicializa o engine e agenda o cleanup periódico de conexões.
     *
     * @param config Mapa nome -> configuração MCP (local ou remoto).
     */
    constructor(readonly config: IMCPClientConfig<K>) {
        setInterval(() => this.cleanupIdleConnections(), 60_000);
    }

    private async ensureSession(sessionId: string): Promise<McpSession> {
        if (!this.sessions.has(sessionId)) {
            const session: McpSession = {
                id: sessionId,
                createdAt: Date.now(),
                lastActivity: Date.now(),
            };
            this.sessions.set(sessionId, session);
        }
        const session = this.sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        return session;
    }

    private getActiveConnection(mcpName: K, sessionId: string = "default"): ActiveConnection {
        const conn = this.connections.get(sessionId)?.get(mcpName);
        if (!conn) {
            throw new Error(`MCP "${mcpName}" não está conectado na sessão ${sessionId}. Use mcp_connect primeiro.`);
        }
        return conn;
    }

    private async cleanupIdleConnections() {
        const now = Date.now();
        for (const [sessionId, conns] of this.connections) {
            for (const [mcpName, conn] of conns) {
                if (now - conn.lastUsed > this.IDLE_TIMEOUT_MS) {
                    console.log(`[Cleanup] Descarregando MCP "${mcpName}" da sessão ${sessionId} por inatividade`);
                    await this.disconnect({ mcp: mcpName as any, sessionId });
                }
            }
        }

        // Remover sessões inativas
        for (const [sessionId, session] of this.sessions) {
            if (now - session.lastActivity > this.IDLE_TIMEOUT_MS * 2) {
                console.log(`[Cleanup] Removendo sessão inativa: ${sessionId}`);
                this.sessions.delete(sessionId);
                // Garantir que todas as conexões da sessão foram fechadas
                await this.connections.get(sessionId)?.forEach(async (_, name) => {
                    await this.disconnect({ mcp: name as any, sessionId });
                });
            }
        }
    }

    private async connectStdio(mcp: IMCPLocalServer): Promise<{
        transport: StdioClientTransport;
        client: Client;
        oauth: undefined;
    }> {
        throw new Error("Conexões stdio não são suportadas no ambiente de execução atual");
    }

    private async connectSSE(mcp: IMCPRemoteServer, authToken?: IAccessToken, authByCode?: { code: string; authRequest: IAuthorizationRequest }) {
        return await http_client(mcp, authToken, authByCode);
    }

    /**
     * Lista os MCPs configurados para uma sessão, sem abrir conexões de transporte.
     *
     * @param sessionId Identificador da sessão lógica do usuário.
     * @returns Lista de servidores configurados com descrição e transporte estimado.
     *
     * @example
     * const available = await engine.listAvailableMCPs("user-42");
     * // [{ name: "github", transport: "sse", description: "Remoto: https://..." }]
     */
    async listAvailableMCPs(sessionId: string = "default") {
        try {
            await this.ensureSession(sessionId);
            return Object.entries(this.config as IMCPClientConfig<string>).map(([name, cfg]) => ({
                name,
                description: cfg.description || (cfg.type === "local" ? `Servidor local: ${cfg.command}` : `Remoto: ${cfg.url}`),
                transport: cfg.type === "local" ? "stdio" : "sse",
            }));
        } catch {
            return [];
        }
    }

    /**
     * Conecta um MCP para uma sessão e retorna as ferramentas disponíveis.
     *
     * Comportamento por status:
     * - connected: conexão nova criada com sucesso;
     * - reused: conexão existente reaproveitada;
     * - oauth_required: servidor remoto exige autorização OAuth/PKCE;
     * - not_found: falha de configuração, limite de sessão ou erro de transporte.
     *
     * @param props Parâmetros de conexão, incluindo nome do MCP e contexto de sessão.
     * @returns Resultado discriminado por status.
     *
     * @example
     * const first = await engine.connect({ mcp: "github", sessionId: "user-42" });
     *
     * if (first.status === "oauth_required") {
     *   // Depois de receber o `code` no callback, finalize a conexão.
     *   const second = await engine.connect({
     *     mcp: "github",
     *     sessionId: "user-42",
     *     authByCode: {
     *       code,
     *       authRequest: first.request,
     *     },
     *   });
     * }
     */
    async connect(props: {
        mcp: K;
        sessionId?: string;
        authByCode?: {
            code: string;
            authRequest: IAuthorizationRequest;
        };
        authToken?: IAccessToken;
    }): Promise<MCPConnectResult> {
        try {
            const { mcp: name, sessionId = "default", authToken, authByCode } = props;
            await this.ensureSession(sessionId);

            // Verificar limites por sessão
            const userConnections = this.connections.get(sessionId) || new Map();
            if (userConnections.size >= this.MAX_CONNECTIONS_PER_SESSION) {
                throw new Error(`Limite de ${this.MAX_CONNECTIONS_PER_SESSION} MCPs por sessão atingido`);
            }

            // Reutilizar conexão existente
            if (userConnections.has(name)) {
                const existing = userConnections.get(name)!;
                existing.lastUsed = Date.now();
                existing.usageCount++;
                return { status: "reused", tools: await this.listTools({ mcp: name, sessionId }), sessionId, message: `MCP "${name}" já estava conectado, reutilizando conexão` };
            }

            // Criar nova conexão
            const cfg = this.config[name];
            if (!cfg) throw new Error(`MCP "${name}" não configurado`);

            let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
            let client: Client;
            let oauthToken: IAccessToken | undefined = undefined;

            if (cfg.type === "local") {
                const res = await this.connectStdio(cfg);
                transport = res.transport;
                client = res.client;
            } else {
                const res = await this.connectSSE(cfg, authToken, authByCode);

                if ("error" in res) {
                    throw new Error(`Erro ao conectar ao MCP "${name}": ${res.error.message}`);
                }

                if (res.oauth && "url" in res.oauth) {
                    return {
                        status: "oauth_required",
                        url: res.oauth.url,
                        sessionId,
                        message: `MCP "${name}" requer autenticação OAuth. Redirecionando para ${res.oauth.url}`,
                        request: res.oauth,
                    };
                }

                if (!("transport" in res) || !("client" in res)) {
                    throw new Error(`Erro ao conectar ao MCP "${name}": transporte ou cliente não disponíveis`);
                }

                transport = res.transport;
                client = res.client;
                oauthToken = res.oauth?.token;
            }

            // await client.connect(transport);

            // Registrar conexão
            if (!this.connections.has(sessionId)) {
                this.connections.set(sessionId, new Map());
            }

            this.connections.get(sessionId)!.set(name, {
                client,
                transport,
                lastUsed: Date.now(),
                usageCount: 1,
                oauthToken,
            });

            return {
                status: "connected",
                tools: await this.listTools({ mcp: name, sessionId }),
                sessionId,
                oauthToken,
                message: `MCP "${name}" carregado com sucesso`,
            };
        } catch (err) {
            return {
                status: "not_found",
                message: `Erro ao conectar ao MCP "${props.mcp}": ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    /**
     * Lista ferramentas de um MCP já conectado na sessão.
     *
     * @param props Nome do MCP e sessão de onde a conexão será lida.
     * @returns Lista de ferramentas com nome, descrição e schema de entrada.
     *
     * @example
     * const tools = await engine.listTools({ mcp: "github", sessionId: "user-42" });
     * const firstTool = tools[0]?.name;
     */
    async listTools(props: { mcp: K; sessionId?: string }): Promise<McpToolListItem[]> {
        try {
            const { mcp: name, sessionId = "default" } = props;
            const connection = this.getActiveConnection(name, sessionId);
            const { tools } = await connection.client.listTools();
            return tools.map((t: MCPTool) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            }));
        } catch {
            return [];
        }
    }

    /**
     * Encerra uma conexão MCP de uma sessão e libera recursos de cliente/transporte.
     *
     * @param props Nome do MCP e sessão alvo.
     * @returns Status da operação (disconnected, not_found ou error).
     *
     * @example
     * await engine.disconnect({ mcp: "github", sessionId: "user-42" });
     */
    async disconnect(props: { mcp: K; sessionId?: string }) {
        try {
            const { mcp: name, sessionId = "default" } = props;
            const sessionConns = this.connections.get(sessionId);
            const conn = sessionConns?.get(name);

            if (!conn) return { status: "not_found", message: "Conexão não encontrada" };

            // Graceful shutdown
            try {
                await conn.client.close();
                // @ts-ignore - acesso seguro ao método interno do transport
                if (typeof conn.transport.close === "function") {
                    await conn.transport.close();
                }
            } catch (err) {
                console.warn(`Erro ao fechar MCP ${name}:`, err);
            }

            sessionConns!.delete(name);
            if (sessionConns!.size === 0) {
                this.connections.delete(sessionId);
            }

            return { status: "disconnected", sessionId, message: `MCP "${name}" descarregado` };
        } catch (err) {
            return { status: "error", message: `Erro ao desconectar MCP "${props.mcp}": ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    /**
     * Executa uma tool em um MCP conectado com timeout configurável.
     *
     * A chamada atualiza métricas de uso da conexão e encapsula falhas
     * de transporte/timeout em uma resposta padronizada.
     *
     * @param props Parâmetros da execução da tool.
     * @returns Resultado de execução com payload de conteúdo, erro opcional e metadados.
     *
     * @example
     * const result = await engine.callTool({
     *   mcp: "github",
     *   tool: "search_repositories",
     *   arguments: { query: "mcp sdk" },
     *   sessionId: "user-42",
     *   timeoutMs: 20_000,
     * });
     *
     * if (!result.success) {
     *   console.error(result.error);
     * }
     */
    async callTool(props: { mcp: K; tool: string; arguments?: Record<string, any>; sessionId?: string; timeoutMs?: number }) {
        try {
            const { mcp, tool, arguments: args = {}, sessionId = "default", timeoutMs = 30_000 } = props;
            const connection = this.getActiveConnection(mcp, sessionId);

            // Atualizar lastUsed
            connection.lastUsed = Date.now();
            connection.usageCount++;

            // Executar com timeout
            const result = await Promise.race([
                connection.client.callTool({ name: tool, arguments: args }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout de ${timeoutMs}ms na tool "${tool}"`)), timeoutMs)),
            ]);

            return {
                success: !(!!result.isError || !!result.error || false),
                content: result?.content,
                error: result?.error || (result?.isError ? "Erro desconhecido" : undefined),
                meta: {
                    mcp,
                    tool,
                    executedAt: new Date().toISOString(),
                    usageCount: connection.usageCount,
                    sessionId,
                },
            };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
                meta: {
                    mcp: props.mcp,
                    tool: props.tool,
                    executedAt: new Date().toISOString(),
                    sessionId: props.sessionId,
                },
            };
        }
    }

    /**
     * Expoe a API do engine como funções no formato esperado por adapters de IA.
     *
     * Cada item retornado contém schema JSON de parâmetros e callback async
     * pronto para delegar para os métodos internos do engine.
     *
     * @example
     * const aiTools = engine.getAICallableTools();
     * const connectTool = aiTools.find((t) => t.function.name === "mcp_connect");
     */
    getAICallableTools() {
        const self = this;
        return [
            {
                type: "function" as const,
                function: {
                    name: "mcp_list_available",
                    description: "Lista todos os servidores MCP disponíveis para conexão",
                    parameters: {
                        type: "object",
                        properties: {
                            sessionId: { type: "string", description: "ID único da sessão do usuário" },
                        },
                        required: ["sessionId"],
                    },
                },
                async call({ sessionId }: { sessionId: string }) {
                    return await self.listAvailableMCPs(sessionId);
                },
            },
            {
                type: "function" as const,
                function: {
                    name: "mcp_connect",
                    description: "Conecta a um servidor MCP específico e retorna suas ferramentas disponíveis",
                    parameters: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Nome do MCP conforme configuração" },
                            sessionId: { type: "string", description: "ID único da sessão do usuário" },
                        },
                        required: ["name", "sessionId"],
                    },
                },
                async call({ name, sessionId }: { name: string; sessionId: string }) {
                    return await self.connect({ mcp: name as K, sessionId });
                },
            },
            {
                type: "function" as const,
                function: {
                    name: "mcp_list_tools",
                    description: "Lista as ferramentas disponíveis em um MCP já conectado",
                    parameters: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Nome do MCP conectado" },
                            sessionId: { type: "string", description: "ID da sessão" },
                        },
                        required: ["name", "sessionId"],
                    },
                },
                async call({ name, sessionId }: { name: string; sessionId: string }) {
                    return await self.listTools({ mcp: name as K, sessionId });
                },
            },
            {
                type: "function" as const,
                function: {
                    name: "mcp_call_tool",
                    description: "Executa uma ferramenta específica de um MCP conectado",
                    parameters: {
                        type: "object",
                        properties: {
                            mcp: { type: "string", description: "Nome do MCP" },
                            tool: { type: "string", description: "Nome da ferramenta" },
                            arguments: { type: "object", description: "Argumentos da ferramenta" },
                            sessionId: { type: "string", description: "ID da sessão" },
                            timeoutMs: { type: "number", description: "Timeout opcional em ms (padrão: 30000)" },
                        },
                        required: ["mcp", "tool", "arguments", "sessionId"],
                    },
                },
                async call({ mcp, tool, arguments: args, sessionId, timeoutMs }: { mcp: string; tool: string; arguments: Record<string, any>; sessionId: string; timeoutMs?: number }) {
                    return await self.callTool({ mcp: mcp as K, tool, arguments: args, sessionId, timeoutMs });
                },
            },
            {
                type: "function" as const,
                function: {
                    name: "mcp_disconnect",
                    description: "Desconecta e libera recursos de um MCP carregado",
                    parameters: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Nome do MCP" },
                            sessionId: { type: "string", description: "ID da sessão" },
                        },
                        required: ["name", "sessionId"],
                    },
                },
                async call({ name, sessionId }: { name: string; sessionId: string }) {
                    return await self.disconnect({ mcp: name as K, sessionId });
                },
            },
        ];
    }
}
