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

export async function finalizeSession(roomId: string): Promise<EndResult | null> {
    try {
        const response = await fetch(`${PLAYER_BASE_URL}/api/discord-finalize-session/${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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

export function getPlayerUrl(): string {
    return PLAYER_BASE_URL;
}
