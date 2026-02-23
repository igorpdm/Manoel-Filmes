import express from "express";

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 120;
const RATE_WINDOW = 60000;

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetTime) {
            rateLimitMap.delete(ip);
        }
    }
}, 60000);

export function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetTime) {
        rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
        return next();
    }

    if (entry.count >= RATE_LIMIT && !req.url.startsWith("/api/upload/")) {
        res.status(429).json({ error: "Too many requests" });
        return;
    }

    entry.count++;
    next();
}
