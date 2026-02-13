import { fetch } from "undici";
export class GraphQLClient {
    opts;
    headers;
    authenticated = false;
    constructor(opts) {
        this.opts = opts;
        this.headers = { ...(opts.headers || {}) };
        // Set authentication in priority order
        if (opts.bearer) {
            this.headers["Authorization"] = `Bearer ${opts.bearer}`;
            this.authenticated = true;
            console.error("Using Bearer token authentication");
        }
        else if (this.headers.Cookie) {
            this.authenticated = true;
            console.error("Using Cookie authentication");
        }
    }
    setHeaders(next) {
        this.headers = { ...this.headers, ...next };
    }
    setCookie(cookieHeader) {
        this.headers["Cookie"] = cookieHeader;
        this.authenticated = true;
        console.error("Session cookies set from email/password login");
    }
    isAuthenticated() {
        return this.authenticated;
    }
    get endpoint() {
        return this.opts.endpoint;
    }
    getAuthHeaders() {
        const h = {};
        if (this.headers["Authorization"])
            h["Authorization"] = this.headers["Authorization"];
        if (this.headers["Cookie"])
            h["Cookie"] = this.headers["Cookie"];
        return h;
    }
    async request(query, variables) {
        const headers = { "Content-Type": "application/json", ...this.headers };
        const res = await fetch(this.opts.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ query, variables })
        });
        const json = await res.json();
        if (!res.ok || json.errors) {
            const msg = json.errors?.map((e) => e.message).join("; ") || res.statusText;
            throw new Error(`GraphQL error: ${msg}`);
        }
        return json.data;
    }
}
