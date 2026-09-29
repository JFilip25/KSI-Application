import { beforeEach, vi } from "vitest";
import { resetPushState } from "@/lib/openapply";

const live = process.env.OPENAPPLY_LIVE_TEST === "1";

beforeEach(() => {
  resetPushState();
  // Tests never reach the network unless they install the fake OpenApply (or run the gated live suite).
  if (!live) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected network request in tests: ${String(input)}`);
    });
  }
});
