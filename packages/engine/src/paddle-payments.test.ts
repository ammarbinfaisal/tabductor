import { describe, expect, it, vi } from "vitest";
import { createPaddleTransactionClient, parsePaddleCreditPacks } from "./paddle-payments.js";

describe("Paddle payments", () => {
  it("parses unique server-owned credit packs", () => {
    expect(parsePaddleCreditPacks('[{"priceId":"pri_small","creditUnits":100}]').get("pri_small"))
      .toEqual({ priceId: "pri_small", creditUnits: 100 });
    expect(() => parsePaddleCreditPacks('[{"priceId":"pri_small","creditUnits":100},{"priceId":"pri_small","creditUnits":200}]'))
      .toThrow(expect.objectContaining({ code: "paddle_credit_packs_invalid" }));
  });

  it("creates a sandbox transaction with pack and internal purchase identity only", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      data: { id: "txn_created", checkout: { url: "https://checkout.paddle.test/txn_created" } },
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const client = createPaddleTransactionClient({
      apiKey: "pdl_sdbx_secret",
      environment: "sandbox",
      fetchImpl,
    });
    await expect(client.createTransaction({
      priceId: "pri_small",
      purchaseId: "purchase_internal",
      checkoutUrl: "https://app.example.test/billing",
    })).resolves.toEqual({
      transactionId: "txn_created",
      checkoutUrl: "https://checkout.paddle.test/txn_created",
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://sandbox-api.paddle.com/transactions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer pdl_sdbx_secret" }),
    }));
    const request = fetchImpl.mock.calls[0]![1]!;
    expect(JSON.parse(request.body as string)).toEqual({
      items: [{ price_id: "pri_small", quantity: 1 }],
      collection_mode: "automatic",
      currency_code: "USD",
      custom_data: { tabductor_purchase_id: "purchase_internal" },
      checkout: { url: "https://app.example.test/billing" },
    });
  });
});
