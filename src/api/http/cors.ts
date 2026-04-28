const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? [];

function getAllowedOrigin(request: Request): string | null {
    const origin = request.headers.get("origin");
    if (!origin) return null;
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return origin;
    return null;
}

export function withCors(request: Request, response: Response): Response {
    const origin = getAllowedOrigin(request);
    if (!origin) return response;

    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.append("Vary", "Origin");
    return response;
}

export function createCorsPreflightResponse(request: Request): Response {
    const origin = getAllowedOrigin(request);
    if (!origin && request.headers.get("origin")) {
        return new Response("Not allowed by CORS", { status: 403 });
    }

    const headers = new Headers({
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") || "Content-Type,Authorization,X-Room-Token,X-Player-Service-Secret,X-Filename",
        "Access-Control-Allow-Credentials": "true",
    });

    if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Vary", "Origin");
    }

    return new Response(null, { status: 204, headers });
}
