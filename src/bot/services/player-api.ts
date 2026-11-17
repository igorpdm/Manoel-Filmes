import type { DiscordSession, MovieInfo, SelectedEpisode, SessionRating } from "../../shared/types";
import { PLAYER_API_SHARED_SECRET } from "../../config";
import { logger } from "../../shared/logger";

const PLAYER_BASE_URL = process.env.PLAYER_URL || "http://localhost:3000";

export function buildServiceHeaders(): Record<string, string> {
    return {
        "x-player-service-secret": PLAYER_API_SHARED_SECRET,
    };
}

interface CreateSessionData {
    movieName: string;
    movieInfo?: MovieInfo;
    discordSession: DiscordSession & { hostUsername?: string };
    selectedEpisode?: SelectedEpisode;
}

interface SessionResult {
    roomId: string;
    hostToken: string;
    url: string;
}

interface TokenResult {
    token: string;
    url: string;
}

interface SessionStatus {
    status: "waiting" | "playing" | "ended";
    viewerCount: number;
    viewers: { discordId: string; username: string }[];
    ratings: SessionRating[];
    average: number;
    allRated?: boolean;
    movieInfo: MovieInfo | null;
    movieName: string;
}

interface EndResult {
    success: boolean;
    ratings: SessionRating[];
    average: number;
    discordSession?: DiscordSession;
}

/**
 * Cria uma sessão de reprodução integrada ao Discord.
 * @param data Dados da sessão, filme e contexto do Discord.
 * @returns Resultado com roomId e hostToken quando sucesso; null quando falha.
 * @throws Retorna null em erros de rede ou resposta inválida.
 */
export async function createDiscordSession(data: CreateSessionData): Promise<SessionResult | null> {
    try {
        const response = await fetch(`${PLAYER_BASE_URL}/api/discord-session`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...buildServiceHeaders() },
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            const error = await response.json();
            logger.error("PlayerAPI", "Erro ao criar sessão", error);
            return null;
        }

        return await response.json();
    } catch (error) {
        logger.error("PlayerAPI", "Erro de conexão ao criar sessão", error);
        return null;
    }
}

/**
 * Gera token de acesso para um usuário entrar em uma sessão.
 * @param roomId Identificador da sala.
 * @param discordId Identificador do usuário no Discord.
 * @param username Nome de exibição do usuário.
 * @returns Token e URL de acesso quando sucesso; null quando falha.
 */
export async function generateUserToken(
    roomId: string,
    discordId: string,
    username: string
): Promise<TokenResult | null> {
    try {
        const response = await fetch(`${PLAYER_BASE_URL}/api/session-token/${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...buildServiceHeaders() },
            body: JSON.stringify({ discordId, username }),
        });

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (error) {
        logger.error("PlayerAPI", "Erro ao gerar token de sessão", error);
        return null;
    }
}

export type SessionStatusFetchResult =
    | { status: "ok"; data: SessionStatus }
    | { status: "not_found" }
    | { status: "error" };

/**
 * Consulta o status atual de uma sessão de reprodução.
 * @param roomId Identificador da sala.
 * @param token Token opcional de participante; quando omitido, usa autenticação de serviço.
 * @returns Estado tipado diferenciando sala ativa, inexistente (404) ou erro de comunicação.
 */
export async function fetchSessionStatus(roomId: string, token?: string): Promise<SessionStatusFetchResult> {
    try {
        const headers: Record<string, string> = token
            ? { "x-room-token": token }
            : buildServiceHeaders();
        const response = await fetch(`${PLAYER_BASE_URL}/api/session-status/${roomId}`, {
            headers,
        });

        if (response.status === 404) {
            return { status: "not_found" };
        }

        if (!response.ok) {
            return { status: "error" };
        }

        return { status: "ok", data: await response.json() };
    } catch (error) {
        logger.error("PlayerAPI", "Erro ao consultar status da sessão", error);
        return { status: "error" };
    }
}

/**
 * Consulta o status atual de uma sessão de reprodução.
 * @param roomId Identificador da sala.
 * @param token Token opcional de participante; quando omitido, usa autenticação de serviço.
 * @returns Status da sessão quando encontrado; null caso contrário.
 */
export async function getSessionStatus(roomId: string, token?: string): Promise<SessionStatus | null> {
    const result = await fetchSessionStatus(roomId, token);
    return result.status === "ok" ? result.data : null;
}

/**
 * Solicita encerramento da sessão pelo host.
 * @param roomId Identificador da sala.
 * @param token Token do host.
 * @returns true quando o servidor aceita o encerramento.
 */
export async function endDiscordSession(roomId: string, token: string): Promise<boolean> {
    try {
        const response = await fetch(`${PLAYER_BASE_URL}/api/discord-end-session/${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
        });

        return response.ok;
    } catch (error) {
        logger.error("PlayerAPI", "Erro ao encerrar sessão", error);
        return false;
    }
}

/**
 * Finaliza a sessão e retorna consolidação de notas.
 * @param roomId Identificador da sala.
 * @returns Resultado final da sessão quando sucesso; null em falhas.
 */
export async function finalizeSession(roomId: string): Promise<EndResult | null> {
    try {
        const response = await fetch(`${PLAYER_BASE_URL}/api/discord-finalize-session/${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...buildServiceHeaders() },
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (error) {
        logger.error("PlayerAPI", "Erro ao finalizar sessão", error);
        return null;
    }
}

/**
 * Retorna a URL base do player configurada no ambiente.
 * @returns URL base do player.
 */
export function getPlayerUrl(): string {
    return PLAYER_BASE_URL;
}
