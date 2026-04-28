import { parse as parseCookieHeader, serialize as serializeCookie } from "cookie";
import type { OAuthSession } from "../../shared/types";
import { ValidationHttpError } from "./http-error";

type Params = Record<string, string>;
type Query = Record<string, string | string[] | undefined>;
type HeaderMap = Record<string, string | undefined>;

export type NextFunction = () => void;

export type HandlerResult = void | Response | Promise<void | Response>;

export type Handler = (request: Request, response: Response, next: NextFunction) => HandlerResult;

interface Route {
    method: string;
    pattern: string;
    segments: string[];
    handlers: Handler[];
}

interface CookieOptions {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
    maxAge?: number;
    path?: string;
    expires?: Date;
}

interface RequestOptions {
    params: Params;
    path: string;
    ip: string;
}

interface BunFileLike {
    size: number;
    type: string;
    exists(): Promise<boolean>;
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class Request implements AsyncIterable<Buffer> {
    readonly method: string;
    readonly url: string;
    readonly path: string;
    readonly params: Params;
    readonly query: Query;
    readonly headers: HeaderMap;
    readonly cookies: Record<string, string>;
    readonly ip: string;
    readonly socket: { remoteAddress: string };
    body: any;
    oauthSession?: OAuthSession;

    private didParseBody = false;

    constructor(readonly raw: globalThis.Request, options: RequestOptions) {
        const parsedUrl = new URL(raw.url);

        this.method = raw.method.toUpperCase();
        this.url = `${parsedUrl.pathname}${parsedUrl.search}`;
        this.path = options.path;
        this.params = options.params;
        this.query = buildQuery(parsedUrl.searchParams);
        this.headers = buildHeaders(raw.headers);
        this.cookies = parseCookies(this.headers.cookie);
        this.ip = options.ip;
        this.socket = { remoteAddress: options.ip };
    }

    async parseBody(): Promise<void> {
        if (this.didParseBody) return;
        this.didParseBody = true;

        const contentType = this.headers["content-type"] || "";
        if (!contentType.includes("application/json")) return;

        const text = await readBodyText(this.raw, this.headers["content-length"]);
        if (!text.trim()) {
            this.body = {};
            return;
        }

        this.body = JSON.parse(text);
    }

    async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
        if (!this.raw.body) return;

        const reader = this.raw.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                yield Buffer.from(value);
            }
        } finally {
            reader.releaseLock();
        }
    }
}

async function readBodyText(rawRequest: globalThis.Request, contentLength: string | undefined): Promise<string> {
    const declaredLength = contentLength ? Number(contentLength) : 0;
    if (declaredLength > MAX_JSON_BODY_BYTES) {
        throw new ValidationHttpError("Corpo JSON excede o limite permitido");
    }

    if (!rawRequest.body) return "";

    const reader = rawRequest.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            if (totalBytes > MAX_JSON_BODY_BYTES) {
                throw new ValidationHttpError("Corpo JSON excede o limite permitido");
            }

            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks).toString("utf8");
}

export class Response {
    statusCode = 200;
    headersSent = false;

    private readonly headers = new Headers();
    private responseBody: BodyInit | null = null;
    private directResponse: globalThis.Response | null = null;

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    setHeader(name: string, value: string | number): this {
        this.headers.set(name, String(value));
        return this;
    }

    writeHead(statusCode: number, headers: Record<string, string | number>): this {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers)) {
            this.setHeader(name, value);
        }
        return this;
    }

    json(value: unknown): void {
        this.headers.set("Content-Type", "application/json; charset=utf-8");
        this.responseBody = JSON.stringify(value);
        this.headersSent = true;
    }

    send(value: string | Buffer | Uint8Array): void {
        if (typeof value === "string" && !this.headers.has("Content-Type")) {
            this.headers.set("Content-Type", "text/html; charset=utf-8");
        }
        this.responseBody = typeof value === "string" ? value : new Uint8Array(value);
        this.headersSent = true;
    }

    redirect(location: string): void {
        this.statusCode = 302;
        this.headers.set("Location", location);
        this.responseBody = null;
        this.headersSent = true;
    }

    cookie(name: string, value: string, options: CookieOptions = {}): void {
        appendHeader(this.headers, "Set-Cookie", serializeCookie(name, value, normalizeCookieOptions(options)));
    }

    clearCookie(name: string, options: CookieOptions = {}): void {
        appendHeader(this.headers, "Set-Cookie", serializeCookie(name, "", {
            ...normalizeCookieOptions(options),
            expires: new Date(0),
            maxAge: 0,
        }));
    }

    sendFile(filePath: string): void {
        this.directResponse = new globalThis.Response(Bun.file(filePath), {
            status: this.statusCode,
            headers: this.headers,
        });
        this.headersSent = true;
    }

    respond(response: globalThis.Response): void {
        this.directResponse = response;
        this.headersSent = true;
    }

    toResponse(): globalThis.Response {
        if (this.directResponse) return this.directResponse;

        return new globalThis.Response(this.responseBody, {
            status: this.statusCode,
            headers: this.headers,
        });
    }
}

export class BunRouter {
    readonly routes: Route[] = [];

    get(pattern: string, ...handlers: Handler[]): void {
        this.add("GET", pattern, handlers);
    }

    post(pattern: string, ...handlers: Handler[]): void {
        this.add("POST", pattern, handlers);
    }

    delete(pattern: string, ...handlers: Handler[]): void {
        this.add("DELETE", pattern, handlers);
    }

    private add(method: string, pattern: string, handlers: Handler[]): void {
        this.routes.push({
            method,
            pattern,
            segments: splitPath(pattern),
            handlers,
        });
    }
}

export type Router = BunRouter;

export function Router(): Router {
    return new BunRouter();
}

export interface MountedRouter {
    prefix: string;
    router: Router;
}

export async function dispatchRequest(
    rawRequest: globalThis.Request,
    mountedRouters: MountedRouter[],
    ip = "unknown",
    prepareRequest?: (request: Request) => void
): Promise<globalThis.Response | null> {
    const parsedUrl = new URL(rawRequest.url);
    const path = parsedUrl.pathname;
    const method = rawRequest.method.toUpperCase();

    for (const mounted of mountedRouters) {
        const relativePath = getRelativePath(path, mounted.prefix);
        if (relativePath === null) continue;

        const route = matchRoute(mounted.router.routes, method, relativePath);
        if (!route) continue;

        const request = new Request(rawRequest, { params: route.params, path: relativePath, ip });
        const response = new Response();
        await request.parseBody();
        prepareRequest?.(request);

        const directResponse = await runHandlers(route.handlers, request, response);
        return directResponse || response.toResponse();
    }

    return null;
}

export async function fileResponse(
    filePath: string,
    init: ResponseInit = {}
): Promise<globalThis.Response | null> {
    const file = Bun.file(filePath) as BunFileLike & Blob;
    if (!(await file.exists())) return null;
    return new globalThis.Response(file, init);
}

function buildQuery(searchParams: URLSearchParams): Query {
    const query: Query = {};
    for (const [key, value] of searchParams) {
        const current = query[key];
        if (Array.isArray(current)) {
            current.push(value);
        } else if (typeof current === "string") {
            query[key] = [current, value];
        } else {
            query[key] = value;
        }
    }
    return query;
}

function buildHeaders(headers: Headers): HeaderMap {
    const result: HeaderMap = {};
    headers.forEach((value, name) => {
        result[name.toLowerCase()] = value;
    });
    return result;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
    const parsed = cookieHeader ? parseCookieHeader(cookieHeader) : {};
    const cookies: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === "string") cookies[name] = value;
    }
    return cookies;
}

function normalizeCookieOptions(options: CookieOptions) {
    return {
        ...options,
        maxAge: options.maxAge ? Math.floor(options.maxAge / 1000) : options.maxAge,
    };
}

function appendHeader(headers: Headers, name: string, value: string): void {
    headers.append(name, value);
}

function getRelativePath(path: string, prefix: string): string | null {
    if (!prefix) return path;
    if (path === prefix) return "/";
    if (!path.startsWith(`${prefix}/`)) return null;
    return path.slice(prefix.length) || "/";
}

function matchRoute(routes: Route[], method: string, path: string): { handlers: Handler[]; params: Params } | null {
    const pathSegments = splitPath(path);
    for (const route of routes) {
        if (route.method !== method) continue;
        if (route.segments.length !== pathSegments.length) continue;

        const params: Params = {};
        let matched = true;

        for (let index = 0; index < route.segments.length; index++) {
            const routeSegment = route.segments[index];
            const pathSegment = pathSegments[index];

            if (routeSegment.startsWith(":")) {
                params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
                continue;
            }

            if (routeSegment !== pathSegment) {
                matched = false;
                break;
            }
        }

        if (matched) {
            return { handlers: route.handlers, params };
        }
    }

    return null;
}

async function runHandlers(handlers: Handler[], request: Request, response: Response): Promise<globalThis.Response | null> {
    let index = 0;

    async function runNext(): Promise<globalThis.Response | null> {
        const handler = handlers[index++];
        if (!handler) return null;

        let didCallNext = false;
        const next = () => {
            didCallNext = true;
        };

        const result = await handler(request, response, next);

        if (result instanceof globalThis.Response) return result;
        if (response.headersSent) return null;
        if (handler.length >= 3 && didCallNext) return runNext();
        if (handler.length < 3 && index < handlers.length) return runNext();

        return null;
    }

    return runNext();
}

function splitPath(path: string): string[] {
    return path.split("/").filter(Boolean);
}
