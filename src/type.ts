export interface IMCPServerConfigBase {
    /** Tipo de servidor MCP, pode ser "local" ou "remote". */
    type: "local" | "remote";
    /** Indica se o servidor MCP está habilitado. */
    enabled?: boolean;
    /** Timeout para conexões com o servidor MCP, em milissegundos. */
    timeout?: number;
    /** Versão do protocolo MCP suportada pelo servidor. */
    protocolVersion?: string;
    /** Descrição opcional do servidor MCP. */
    description?: string;
}

export interface IMCPLocalServer extends IMCPServerConfigBase {
    /** Tipo de servidor MCP local. */
    type: "local";
    /** Comando para iniciar o servidor MCP local, pode ser uma string ou um array de strings para o comando e seus argumentos. */
    command: string | string[];
    /** Variáveis de ambiente opcionais para o processo do servidor MCP local. */
    args?: string[];
    /** Variáveis de ambiente opcionais para o processo do servidor MCP local. */
    environment?: Record<string, string>;
}

export interface IClientRegistrationResponse {
    /** ID do cliente registrado no servidor MCP. */
    client_id: string;
    /** Segredo do cliente registrado no servidor MCP, se aplicável. */
    client_secret?: string;
    /** Timestamp de expiração do segredo do cliente, se aplicável. */
    client_secret_expires_at?: number;
}

export interface IServerMetadata {
    /** Emissor do servidor MCP. */
    issuer: string;
    /** Endpoint de autorização do servidor MCP. */
    authorization_endpoint: string;
    /** Endpoint de token do servidor MCP. */
    token_endpoint: string;
    /** Endpoint de revogação de token do servidor MCP, se aplicável. */
    revocation_endpoint?: string;
    /** Endpoint de registro de cliente do servidor MCP, se aplicável. */
    registration_endpoint?: string;
    /** Tipos de resposta suportados pelo servidor MCP. */
    response_types_supported?: string[];
    /** Tipos de concessão suportados pelo servidor MCP. */
    grant_types_supported?: string[];
    /** Métodos de desafio de código suportados pelo servidor MCP. */
    code_challenge_methods_supported?: string[];
}

export interface IAccessToken {
    /** Token de acesso OAuth válido. */
    access_token: string;
    /** Token de atualização OAuth, se aplicável. */
    refresh_token?: string;
    /** Timestamp de expiração do token de acesso, se aplicável. */
    expires_at?: number;
    /** Tipo de token, geralmente "Bearer". */
    token_type?: string;
}

export interface IAuthorizationRequest {
    /** The authorization URL to redirect the user to */
    url: string;
    /** OAuth state parameter for CSRF protection */
    state: string;
    /** PKCE code verifier to use during token exchange */
    codeVerifier: string;
}

export interface IMCPOAuthConfig {
    /** Indica se a autenticação OAuth está habilitada. */
    enabled?: boolean;
    /** ID do cliente OAuth. */
    clientId: string;
    /** Segredo do cliente OAuth. */
    clientSecret: string;
    /** Timestamp de expiração do segredo do cliente OAuth, se aplicável. */
    clientSecretExpiresAt?: number;
    /** Escopos OAuth solicitados. */
    scopes?: string | string[];
    /** URI de redirecionamento OAuth. */
    redirectUri: string;
    /** Metadados do servidor OAuth. */
    metadata?: IServerMetadata;
}

export interface IMCPRemoteServer extends IMCPServerConfigBase {
    /** Tipo de servidor MCP remoto. */
    type: "remote";
    /** URL do servidor MCP remoto. */
    url: string;
    /** Cabeçalhos HTTP opcionais para autenticação ou configuração de chamadas ao servidor MCP remoto. */
    headers?: Record<string, string>;
    /** Configuração de autenticação OAuth para o servidor MCP remoto, se aplicável. */
    oauth?: IMCPOAuthConfig;
}

export type IMCPClientConfig<K extends string> = Record<K, IMCPLocalServer | IMCPRemoteServer>;
