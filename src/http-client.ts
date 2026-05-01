import { Client as MCP } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { IAccessToken, IAuthorizationRequest, IClientRegistrationResponse, IMCPOAuthConfig, IMCPRemoteServer, IServerMetadata } from "./type";
import kyFactory from "ky";
import * as openid_client from "openid-client";

type IMCPOAuthConfigWithToken = Partial<IMCPOAuthConfig> & {
	token?: IAccessToken;
};

/**
 * Faz um probe leve no endpoint MCP para detectar desafio HTTP 401.
 *
 * @param serverUrl URL base do servidor MCP remoto.
 * @param protocolVersion Versao do protocolo MCP enviada no header.
 * @returns true quando o endpoint responde 401; false para demais casos ou erro de rede.
 */
const checkAuthRequired = async (serverUrl: string, protocolVersion: string = "2024-11-05"): Promise<boolean> => {
	try {
		const response = await kyFactory.get(serverUrl, {
			timeout: 5000,
			throwHttpErrors: false,
			headers: {
				"MCP-Protocol-Version": protocolVersion,
			},
		});

		return response.status === 401;
	} catch (error) {
		// Network error or timeout - assume no auth required
		return false;
	}
};

/**
 * Descobre metadata OAuth/OIDC para o servidor MCP.
 *
 * Estrategia:
 * - usa metadata explicita recebida em configuracao, quando completa;
 * - tenta extrair `resource_metadata` de `WWW-Authenticate` em resposta 401;
 * - fallback para `/.well-known/oauth-authorization-server`;
 * - se tudo falhar, construi endpoints padrao com base no host.
 *
 * @param serverUrl URL do servidor MCP.
 * @param protocolVersion Versao MCP para headers de descoberta.
 * @param metadata Metadata preconfigurada opcional.
 */
const discoverMetadata = async (serverUrl: string, protocolVersion: string = "2024-11-05", metadata?: IServerMetadata): Promise<IServerMetadata> => {
	const DEFAULT_ENDPOINTS = {
		authorize: "/authorize",
		token: "/token",
		register: "/register",
	};

	const url = new URL(serverUrl);
	const authBaseUrl = `${url.protocol}//${url.host}`;
	let metadataUrl = `${authBaseUrl}/.well-known/oauth-authorization-server`;

	try {
		const response = await kyFactory.get(serverUrl, {
			timeout: 5000,
			throwHttpErrors: false,
			headers: {
				"MCP-Protocol-Version": protocolVersion,
			},
		});

		if (response.status === 401) {
			const wwwAuthHeader = response.headers.get("WWW-Authenticate");
			if (wwwAuthHeader) {
				const match = wwwAuthHeader.match(/resource_metadata="([^"]+)"/);
				if (match) {
					metadataUrl = match[1];
				}
			}
		}
	} catch {}

	if (!!metadata?.issuer && !!metadata?.authorization_endpoint && !!metadata?.token_endpoint) {
		return metadata;
	}

	try {
		const response = await kyFactory(metadataUrl, {
			headers: {
				"MCP-Protocol-Version": protocolVersion,
			},
			timeout: 5000,
		}).json<IServerMetadata>();

		return response;
	} catch (error) {
		return {
			issuer: authBaseUrl,
			authorization_endpoint: `${authBaseUrl}${DEFAULT_ENDPOINTS.authorize}`,
			token_endpoint: `${authBaseUrl}${DEFAULT_ENDPOINTS.token}`,
			registration_endpoint: `${authBaseUrl}${DEFAULT_ENDPOINTS.register}`,
		};
	}
};

/**
 * Realiza dynamic client registration quando suportado pelo authorization server.
 *
 * @param oauth Configuracao OAuth em memoria.
 * @param protocolVersion Versao MCP para headers de registro.
 * @param metadata Metadata do servidor de autorizacao.
 * @returns Configuracao OAuth atualizada com client_id e credenciais dinamicas.
 */
const dynamicClientRegistration = async (
	oauth: IMCPOAuthConfigWithToken = {
		redirectUri: "http://localhost:3334/callback",
	},
	protocolVersion: string = "2024-11-05",
	metadata?: IServerMetadata,
): Promise<IMCPOAuthConfigWithToken> => {
	if (!metadata?.registration_endpoint) {
		return oauth;
	}

	const registrationData = {
		client_name: "MCP Client",
		redirect_uris: [oauth.redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none", // Public client
	};

	try {
		const response = await kyFactory
			.post(metadata.registration_endpoint, {
				json: registrationData,
				headers: {
					"Content-Type": "application/json",
					"MCP-Protocol-Version": protocolVersion,
				},
			})
			.json<IClientRegistrationResponse>();

		// Update options with dynamically registered client
		oauth.clientId = response.client_id;
		oauth.clientSecret = response.client_secret;
		oauth.clientSecretExpiresAt = response.client_secret_expires_at;
	} catch {}

	return oauth;
};

/**
 * Indica se o access token expirou considerando janela de seguranca de 5 minutos.
 */
const isTokenExpired = (token?: IAccessToken): boolean => {
	if (!token?.expires_at) {
		return false;
	}

	// Add 5-minute buffer before expiration
	const now = Math.floor(Date.now() / 1000);
	return now > token.expires_at - 300;
};

/**
 * Verifica se existe access token nao expirado.
 */
const hasValidToken = (token?: IAccessToken): boolean => {
	return !!token?.access_token && !isTokenExpired(token);
};

/**
 * Converte resposta do endpoint OAuth token para o contrato interno IAccessToken.
 */
const convertTokenResponse = (response: openid_client.TokenEndpointResponse): IAccessToken => {
	const token: IAccessToken = {
		access_token: response.access_token!,
		refresh_token: response.refresh_token,
		token_type: response.token_type,
	};

	// Calculate expiration timestamp
	if (response.expires_in) {
		token.expires_at = Math.floor(Date.now() / 1000) + response.expires_in;
	}

	return token;
};

/**
 * Renova o access token usando refresh token e atualiza estado local do oauth.
 */
const refreshAccessToken = async (oauth: IMCPOAuthConfigWithToken, config: openid_client.Configuration): Promise<IMCPOAuthConfigWithToken> => {
	if (!oauth.token?.refresh_token) {
		throw new Error("Cannot refresh token: missing configuration or refresh token");
	}

	const tokenResponse = await openid_client.refreshTokenGrant(config, oauth.token.refresh_token);

	// Convert and store token with proper expiration
	oauth.token = convertTokenResponse(tokenResponse);
	return oauth;
};

/**
 * Retorna um access token valido, tentando refresh automaticamente quando necessario.
 */
const getAccessToken = async (oauth: IMCPOAuthConfigWithToken, config: openid_client.Configuration): Promise<string> => {
	if (!oauth.token) {
		throw new Error("No token available. Please authenticate first.");
	}

	// Check if token is expired
	if (isTokenExpired(oauth.token)) {
		if (oauth.token.refresh_token) {
			oauth = await refreshAccessToken(oauth, config);
		} else {
			throw new Error("Token expired and no refresh token available");
		}
	}

	return oauth.token!.access_token;
};

/**
 * Cria URL de autorizacao OAuth com PKCE (S256) para inicio do fluxo interativo.
 *
 * @returns Request contendo URL, state e codeVerifier para callback posterior.
 */
const createAuthorizationRequest = async (oauth?: IMCPOAuthConfigWithToken, config?: openid_client.Configuration): Promise<IAuthorizationRequest> => {
	if (!oauth || !config) {
		throw new Error("OAuth not initialized");
	}

	// Generate PKCE parameters
	const codeVerifier = openid_client.randomPKCECodeVerifier();
	const codeChallenge = await openid_client.calculatePKCECodeChallenge(codeVerifier);
	const state = openid_client.randomState();

	const authParams: Record<string, string> = {
		redirect_uri: oauth.redirectUri!,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		state,
		response_type: "code",
		scope: Array.isArray(oauth.scopes) ? oauth.scopes.join(" ") : oauth.scopes || "",
	};

	// Build authorization URL
	const authUrl = openid_client.buildAuthorizationUrl(config, authParams);

	return {
		url: authUrl.href,
		state,
		codeVerifier,
	};
};

/**
 * Troca authorization code por tokens e persiste o resultado no estado OAuth.
 *
 * @param code Authorization code recebido no callback.
 * @param state State originalmente emitido no request de autorizacao.
 * @param codeVerifier Code verifier PKCE associado ao request inicial.
 */
const exchangeCodeForToken = async (code: string, state: string, codeVerifier: string, oauth?: IMCPOAuthConfigWithToken, config?: openid_client.Configuration): Promise<IAccessToken> => {
	if (!oauth || !config) {
		throw new Error("OAuth not initialized");
	}

	// Create callback URL with code and state
	const callbackUrl = new URL(oauth.redirectUri!);
	callbackUrl.searchParams.set("code", code);
	callbackUrl.searchParams.set("state", state);

	// Exchange code for tokens
	try {
		const tokenResponse = await openid_client.authorizationCodeGrant(config, callbackUrl, {
			expectedNonce: undefined, // Not using nonce in this flow
			pkceCodeVerifier: codeVerifier,
			expectedState: state,
		});

		// Convert and store token
		const token = convertTokenResponse(tokenResponse);
		oauth.token = token;

		return token;
	} catch (error: any) {
		throw error;
	}
};

/**
 * Conecta em servidor MCP remoto com suporte a OAuth 2.1 + PKCE, refresh token e fallback de transporte.
 *
 * Fluxo resumido:
 * 1) valida configuracao e segura requisicao HTTPS;
 * 2) detecta necessidade de autenticacao e descobre metadata;
 * 3) tenta registration dinamico quando necessario;
 * 4) retorna request OAuth quando ainda nao ha token valido;
 * 5) conecta via Streamable HTTP com fallback para SSE.
 *
 * @param mcp Configuracao do servidor remoto.
 * @param authToken Token previamente persistido para tentativa de reutilizacao.
 * @param authByCode Authorization code e request original para finalizar OAuth.
 * @returns Union com sucesso (transport/client), solicitacao OAuth ou erro.
 *
 * @example
 * const first = await http_client({
 *   type: "remote",
 *   url: "https://mcp.example.com",
 *   oauth: {
 *     clientId: "my-client-id",
 *     clientSecret: "",
 *     redirectUri: "http://localhost:3334/callback",
 *     scopes: ["openid", "profile"],
 *   },
 * });
 *
 * if ("oauth" in first && "url" in first.oauth) {
 *   // Abrir URL no browser e capturar `code` no callback local.
 *   const resumed = await http_client(
 *     {
 *       type: "remote",
 *       url: "https://mcp.example.com",
 *     },
 *     undefined,
 *     {
 *       code,
 *       authRequest: first.oauth,
 *     },
 *   );
 * }
 */
export const http_client = async (
	mcp: IMCPRemoteServer,
	authToken?: IAccessToken,
	authByCode?: {
		code: string;
		authRequest: IAuthorizationRequest;
	},
): Promise<
	| {
			transport: SSEClientTransport | StreamableHTTPClientTransport;
			client: MCP;
			oauth?: {
				token: IAccessToken;
			};
	  }
	| {
			oauth: IAuthorizationRequest;
	  }
	| {
			error: Error;
	  }
> => {
	try {
		const { url, type, enabled = true, headers, timeout, protocolVersion } = mcp;

		let oauth: IMCPOAuthConfigWithToken = mcp.oauth?.enabled !== false ? (mcp.oauth as IMCPOAuthConfigWithToken) : {};

		if (type !== "remote") {
			throw new Error("Invalid server type: expected 'remote'");
		}

		if (!enabled) {
			throw new Error("MCP server is disabled");
		}

		if (!url.startsWith("https://")) {
			throw new Error("MCP servers must be HTTPS");
		}

		const baseUrl = new URL(url);
		const client = new MCP({ name: "mcp-client-auth", version: "1.0.0" });

		const requiresAuth = await checkAuthRequired(url, protocolVersion);
		const metadata = await discoverMetadata(url, protocolVersion, oauth?.metadata);

		let openidConfig: openid_client.Configuration | null = null;

		if (requiresAuth || oauth.clientId) {
			if (!oauth.clientId && metadata.registration_endpoint) {
				oauth = await dynamicClientRegistration(oauth, protocolVersion, metadata);
			}

			if (oauth.clientId) {
				openidConfig = new openid_client.Configuration(metadata as openid_client.ServerMetadata, oauth.clientId, oauth.clientSecret);
			}
		}

		if (oauth) {
			oauth.token = authToken || oauth.token;
		}

		let requestInit: RequestInit | undefined;
		if (openidConfig) {
			if (!hasValidToken(oauth?.token) && authByCode) {
				oauth.token = await exchangeCodeForToken(authByCode.code, authByCode.authRequest.state, authByCode.authRequest.codeVerifier, oauth, openidConfig).catch(() =>
					Promise.resolve(undefined),
				);
			}

			// Ensure OAuth has a valid token
			if (!oauth?.token || !hasValidToken(oauth?.token)) {
				return {
					oauth: await createAuthorizationRequest(oauth, openidConfig),
				};
			}

			// Get OAuth token and create auth headers
			const token = await getAccessToken(oauth, openidConfig);
			requestInit = {
				headers: {
					...headers,
					Authorization: `Bearer ${token}`,
				},
			};
		}

		let transport: SSEClientTransport | StreamableHTTPClientTransport;

		try {
			// Try StreamableHTTP transport first
			transport = new StreamableHTTPClientTransport(baseUrl, {
				requestInit,
			});
			await client.connect(transport);
		} catch (err) {
			// Fallback to SSE transport
			transport = new SSEClientTransport(baseUrl, { requestInit });
			await client.connect(transport);
		}

		return {
			transport,
			client,
			oauth:
				oauth && oauth.token
					? {
							token: oauth.token,
						}
					: undefined,
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
};
