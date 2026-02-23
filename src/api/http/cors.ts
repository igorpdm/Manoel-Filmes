import cors from "cors";

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? [];

export const corsMiddleware = cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
});
