import { fetch } from "undici";
function extractCookiePairs(setCookies) {
    const pairs = [];
    for (const sc of setCookies) {
        const first = sc.split(";")[0];
        if (first)
            pairs.push(first.trim());
    }
    return pairs.join("; ");
}
export async function loginWithPassword(baseUrl, email, password) {
    const url = `${baseUrl.replace(/\/$/, "")}/api/auth/sign-in`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Sign-in failed: ${res.status} ${text}`);
    }
    const anyHeaders = res.headers;
    let setCookies = [];
    if (typeof anyHeaders.getSetCookie === "function") {
        setCookies = anyHeaders.getSetCookie();
    }
    else {
        const sc = res.headers.get("set-cookie");
        if (sc)
            setCookies = [sc];
    }
    if (!setCookies.length) {
        throw new Error("Sign-in succeeded but no Set-Cookie received");
    }
    const cookieHeader = extractCookiePairs(setCookies);
    return { cookieHeader };
}
