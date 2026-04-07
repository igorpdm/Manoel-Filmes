import { Router } from "express";
import { logger } from "../../shared/logger";
import { sendRouteError } from "../http/route-error";
import { createRateLimit } from "../http/rate-limit";
import { ForbiddenHttpError, ValidationHttpError, InfraHttpError } from "../http/http-error";
import {
    createOAuthSession,
    setSessionCookie,
    clearSessionCookie,
    generateOAuthState,
    validateOAuthState,
    buildDiscordAvatarUrl,
} from "../http/session-middleware";
import {
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    DISCORD_OAUTH_REDIRECT_URI,
} from "../../config";
import type { RoomManager } from "../../core/room-manager";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_OAUTH_AUTHORIZE = "https://discord.com/oauth2/authorize";
const OAUTH_SCOPES = "identify";

const oauthLoginRateLimit = createRateLimit({ key: "oauth-login", limit: 30, windowMs: 60000 });
const oauthCallbackRateLimit = createRateLimit({ key: "oauth-callback", limit: 20, windowMs: 60000 });

interface OAuthDeps {
    roomManager: typeof RoomManager.prototype;
}

interface DiscordTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
}

interface DiscordUserResponse {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    global_name: string | null;
}

async function exchangeCodeForToken(code: string): Promise<DiscordTokenResponse> {
    const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID || "",
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_OAUTH_REDIRECT_URI,
    });

    const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error("OAuth", `Falha ao trocar código por token: ${response.status} - ${errorText}`);
        throw new InfraHttpError("Falha na autenticação com Discord");
    }

    return response.json();
}

async function fetchDiscordUser(accessToken: string): Promise<DiscordUserResponse> {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error("OAuth", `Falha ao buscar usuário Discord: ${response.status} - ${errorText}`);
        throw new InfraHttpError("Falha ao buscar dados do usuário");
    }

    return response.json();
}

function validateOAuthConfig(): void {
    if (!DISCORD_CLIENT_ID) {
        throw new InfraHttpError("DISCORD_CLIENT_ID não configurado");
    }
    if (!DISCORD_CLIENT_SECRET) {
        throw new InfraHttpError("DISCORD_CLIENT_SECRET não configurado");
    }
}

/**
 * Cria rotas de autenticação OAuth com Discord.
 * Inclui proteção CSRF via state parameter e rate limiting.
 * @param deps Dependências incluindo roomManager.
 * @returns Router com endpoints OAuth.
 */
export function createOAuthRouter(deps: OAuthDeps): Router {
    const router = Router();

    router.get("/oauth/login", oauthLoginRateLimit, (req, res) => {
        try {
            validateOAuthConfig();

            const redirect = typeof req.query.redirect === "string" ? req.query.redirect : "/";
            const roomIdMatch = redirect.match(/\/room\/([^/?]+)/);
            const roomId = roomIdMatch ? roomIdMatch[1] : "none";

            const state = generateOAuthState(roomId);

            res.cookie("oauth_redirect", redirect, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax",
                maxAge: 10 * 60 * 1000, // 10 minutos
                path: "/",
            });

            const params = new URLSearchParams({
                client_id: DISCORD_CLIENT_ID || "",
                redirect_uri: DISCORD_OAUTH_REDIRECT_URI,
                response_type: "code",
                scope: OAUTH_SCOPES,
                state,
                prompt: "none",
            });

            const authorizeUrl = `${DISCORD_OAUTH_AUTHORIZE}?${params.toString()}`;
            logger.info("OAuth", `Redirecionando para Discord OAuth (roomId: ${roomId})`);
            res.redirect(authorizeUrl);
        } catch (error) {
            sendRouteError(res, error, "OAuth");
        }
    });

    router.get("/oauth/callback", oauthCallbackRateLimit, async (req, res) => {
        try {
            validateOAuthConfig();

            const { code, state, error: oauthError, error_description } = req.query;

            if (oauthError) {
                logger.warn("OAuth", `Discord retornou erro: ${oauthError} - ${error_description}`);

                if (oauthError === "access_denied") {
                    const redirect = req.cookies?.oauth_redirect || "/";
                    res.clearCookie("oauth_redirect");

                    const params = new URLSearchParams({
                        client_id: DISCORD_CLIENT_ID || "",
                        redirect_uri: DISCORD_OAUTH_REDIRECT_URI,
                        response_type: "code",
                        scope: OAUTH_SCOPES,
                        state: state as string,
                        prompt: "consent",
                    });

                    return res.redirect(`${DISCORD_OAUTH_AUTHORIZE}?${params.toString()}`);
                }

                return res.redirect(`/login.html?error=${encodeURIComponent(String(oauthError))}`);
            }

            if (typeof code !== "string" || typeof state !== "string") {
                throw new ValidationHttpError("Parâmetros inválidos no callback");
            }

            const roomId = validateOAuthState(state);
            if (!roomId) {
                throw new ForbiddenHttpError("State inválido ou expirado");
            }

            const tokenData = await exchangeCodeForToken(code);
            const discordUser = await fetchDiscordUser(tokenData.access_token);

            const session = createOAuthSession(discordUser);
            setSessionCookie(res, session);

            logger.success("OAuth", `Login bem-sucedido: ${discordUser.username} (${discordUser.id})`);

            const redirect = req.cookies?.oauth_redirect || "/";
            res.clearCookie("oauth_redirect");

            res.redirect(redirect);
        } catch (error) {
            sendRouteError(res, error, "OAuth");
        }
    });

    router.get("/oauth/me", (req, res) => {
        try {
            if (!req.oauthSession) {
                return res.status(401).json({ error: "Não autenticado" });
            }

            const avatarUrl = buildDiscordAvatarUrl(
                req.oauthSession.discordId,
                req.oauthSession.avatarHash,
                128
            );

            res.json({
                discordId: req.oauthSession.discordId,
                username: req.oauthSession.username,
                avatarUrl,
                globalName: req.oauthSession.globalName,
            });
        } catch (error) {
            sendRouteError(res, error, "OAuth");
        }
    });

    router.post("/oauth/logout", (req, res) => {
        try {
            clearSessionCookie(res);
            res.json({ success: true });
        } catch (error) {
            sendRouteError(res, error, "OAuth");
        }
    });

    router.post("/oauth/authorize-room/:roomId", (req, res) => {
        try {
            const { roomId } = req.params;

            if (!req.oauthSession) {
                return res.status(401).json({ error: "Não autenticado" });
            }

            const room = deps.roomManager.getRoom(roomId);
            if (!room || !room.discordSession) {
                return res.status(404).json({ error: "Sessão não encontrada" });
            }

            const avatarUrl = buildDiscordAvatarUrl(
                req.oauthSession.discordId,
                req.oauthSession.avatarHash,
                64
            );

            const token = deps.roomManager.authorizeUserByOAuth(
                roomId,
                req.oauthSession.discordId,
                req.oauthSession.username,
                avatarUrl
            );

            if (!token) {
                return res.status(500).json({ error: "Falha ao autorizar usuário" });
            }

            const isHost = deps.roomManager.isHostByToken(roomId, token);

            logger.info("OAuth", `Usuário ${req.oauthSession.username} autorizado na sala ${roomId} (host: ${isHost})`);

            res.json({
                token,
                isHost,
                user: {
                    discordId: req.oauthSession.discordId,
                    username: req.oauthSession.username,
                    avatarUrl,
                },
            });
        } catch (error) {
            sendRouteError(res, error, "OAuth");
        }
    });

    return router;
}
