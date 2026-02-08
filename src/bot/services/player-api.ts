const PLAYER_BASE_URL = process.env.PLAYER_URL || "http://localhost:3000";

interface CreateSessionData {
    title: string;
    movieName: string;
    movieInfo?: any;
    discordSession: {
        channelId: string;
        messageId: string;
        guildId: string;
        hostDiscordId: string;
        hostUsername?: string;
    };
    selectedEpisode?: any;
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
    ratings: { discordId: string; username: string; rating: number }[];
    average: number;
    allRated?: boolean;
    movieInfo: any;
    movieName: string;
}

interface EndResult {
    success: boolean;
    ratings: { discordId: string; username: string; rating: number }[];
    average: number;
    discordSession: any;
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            const error = await response.json();
            console.error("[PlayerAPI] Erro ao criar sessão:", error);
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error("[PlayerAPI] Erro de conexão:", error);
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ discordId, username }),
        });

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error("[PlayerAPI] Erro ao gerar token:", error);
        return null;
    }
}

/**
 * Consulta o status atual de uma sessão de reprodução.
 * @param roomId Identificador da sala.
 * @returns Status da sessão quando encontrado; null caso contrário.
 */
export async function getSessionStatus(roomId: string): Promise<SessionStatus | null> {
    try {
        const response = await fetch(`${PLAYER_BASE_URL}/api/session-status/${roomId}`);

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error("[PlayerAPI] Erro ao obter status:", error);
        return null;
    }
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
        console.error("[PlayerAPI] Erro ao encerrar sessão:", error);
        return false;
    }
}

/**
 * Finaliza a sessão e retorna consolidação de notas.
 * @param roomId Identificador da sala.
 * @param token Token do host autorizado.
 * @returns Resultado final da sessão quando sucesso; null em falhas.
 */
export async function finalizeSession(roomId: string, token: string): Promise<EndResult | null> {
    try {
        const response = await fetch(`${PLAYER_BASE_URL}/api/discord-finalize-session/${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
        });

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error("[PlayerAPI] Erro ao finalizar sessão:", error);
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
