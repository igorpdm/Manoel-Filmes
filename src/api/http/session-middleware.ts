import { Request, Response, NextFunction } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { OAuthSession } from "../../shared/types";
import { SESSION_SECRET, IS_PROD } from "../../config";

const SESSION_COOKIE_NAME = "manoel_session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

export { SESSION_COOKIE_NAME };

declare global {
    namespace Express {
        interface Request {
            oauthSession?: OAuthSession;
        }
    }
}

function getSecretKey(): Buffer {
    if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
        throw new Error("SESSION_SECRET deve ter no mínimo 32 caracteres");
    }
    return Buffer.from(SESSION_SECRET, "utf-8");
}

function signPayload(payload: string): string {
    const hmac = createHmac("sha256", getSecretKey());
    hmac.update(payload);
    return hmac.digest("base64url");
}

function verifySignature(payload: string, signature: string): boolean {
    const expectedSignature = signPayload(payload);
    const sigBuffer = Buffer.from(signature, "base64url");
    const expectedBuffer = Buffer.from(expectedSignature, "base64url");

    if (sigBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(sigBuffer, expectedBuffer);
}

/**
 * Codifica uma sessão OAuth em um cookie seguro assinado.
 * Formato: base64url(JSON) + "." + HMAC-SHA256(payload)
 */
export function encodeSession(session: OAuthSession): string {
    const payload = Buffer.from(JSON.stringify(session), "utf-8").toString("base64url");
    const signature = signPayload(payload);
    return `${payload}.${signature}`;
}

/**
 * Decodifica e valida um cookie de sessão.
 * Retorna null se inválido ou expirado.
 */
export function decodeSession(cookie: string): OAuthSession | null {
    if (!cookie || typeof cookie !== "string") return null;

    const parts = cookie.split(".");
    if (parts.length !== 2) return null;

    const [payload, signature] = parts;
    if (!verifySignature(payload, signature)) return null;

    try {
        const json = Buffer.from(payload, "base64url").toString("utf-8");
        const session = JSON.parse(json) as OAuthSession;

        if (!session.discordId || !session.username || !session.expiresAt) {
            return null;
        }

        if (Date.now() > session.expiresAt) {
            return null;
        }

        return session;
    } catch {
        return null;
    }
}

/**
 * Cria uma nova sessão OAuth a partir dos dados do usuário Discord.
 */
export function createOAuthSession(discordUser: {
    id: string;
    username: string;
    avatar: string | null;
    global_name: string | null;
}): OAuthSession {
    const now = Date.now();
    return {
        discordId: discordUser.id,
        username: discordUser.global_name || discordUser.username,
        avatarHash: discordUser.avatar,
        globalName: discordUser.global_name,
        createdAt: now,
        expiresAt: now + SESSION_MAX_AGE_MS,
    };
}

/**
 * Define o cookie de sessão na resposta HTTP.
 */
export function setSessionCookie(res: Response, session: OAuthSession): void {
    const cookieValue = encodeSession(session);
    const maxAgeSeconds = Math.floor((session.expiresAt - Date.now()) / 1000);

    res.cookie(SESSION_COOKIE_NAME, cookieValue, {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: "lax",
        maxAge: maxAgeSeconds * 1000,
        path: "/",
    });
}

/**
 * Remove o cookie de sessão.
 */
export function clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: "lax",
        path: "/",
    });
}

/**
 * Middleware que extrai e valida a sessão OAuth do cookie.
 * Popula req.oauthSession se válido.
 */
export function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
    req.oauthSession = undefined;

    const cookie = req.cookies?.[SESSION_COOKIE_NAME];
    if (cookie) {
        const session = decodeSession(cookie);
        if (session) {
            req.oauthSession = session;
        }
    }

    next();
}

/**
 * Gera um state seguro para proteção CSRF no fluxo OAuth.
 * Formato: roomId:nonce:timestamp:signature
 */
export function generateOAuthState(roomId: string): string {
    const nonce = randomBytes(16).toString("base64url");
    const timestamp = Date.now().toString();
    const payload = `${roomId}:${nonce}:${timestamp}`;
    const signature = signPayload(payload);
    return `${payload}:${signature}`;
}

/**
 * Valida o state retornado pelo Discord.
 * Retorna o roomId se válido, null caso contrário.
 */
export function validateOAuthState(state: string): string | null {
    if (!state || typeof state !== "string") return null;

    const parts = state.split(":");
    if (parts.length !== 4) return null;

    const [roomId, nonce, timestamp, signature] = parts;
    const payload = `${roomId}:${nonce}:${timestamp}`;

    if (!verifySignature(payload, signature)) return null;

    const stateAge = Date.now() - parseInt(timestamp, 10);
    const maxStateAge = 10 * 60 * 1000; // 10 minutos
    if (stateAge > maxStateAge || stateAge < 0) return null;

    return roomId;
}

/**
 * Constrói a URL do avatar Discord.
 */
export function buildDiscordAvatarUrl(discordId: string, avatarHash: string | null, size = 64): string {
    if (!avatarHash) {
        const index = Number(BigInt(discordId) >> 22n) % 6;
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }
    const ext = avatarHash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.${ext}?size=${size}`;
}
