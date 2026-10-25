import { test, expect } from "bun:test";
import { isRecoverableBrowserNetworkFailure } from "../src/adapters/chatgpt-web/browser-worker";
test("actual Chromium tunnel error is classified without treating authentication or arbitrary UI failure as network",()=>{
 expect(isRecoverableBrowserNetworkFailure(new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://chatgpt.com/"))).toBe(true);
 expect(isRecoverableBrowserNetworkFailure(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toBe(true);
 expect(isRecoverableBrowserNetworkFailure(new Error("session_expired"))).toBe(false);
 expect(isRecoverableBrowserNetworkFailure(new Error("connector identity mismatch"))).toBe(false);
});
