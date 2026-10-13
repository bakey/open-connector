import type { WhatsAppActionContext } from "./runtime.ts";

import { describe, expect, it } from "vitest";
import { whatsappActionHandlers } from "./runtime.ts";

interface CapturedRequest {
  url: URL;
}

function createContext(respond: (url: URL) => unknown, captured: CapturedRequest[]): WhatsAppActionContext {
  return {
    accessToken: "token",
    wabaId: "123456789",
    fetcher: async (input) => {
      const url = new URL(input.toString());
      captured.push({ url });
      return Response.json(respond(url));
    },
  };
}

describe("WhatsApp analytics", () => {
  it("renders message analytics as a dot-chained WABA field and reads data_points", async () => {
    const captured: CapturedRequest[] = [];
    const context = createContext(
      () => ({
        analytics: {
          granularity: "DAY",
          data_points: [{ start: 1700000000, end: 1700086400, sent: 12, delivered: 11 }],
        },
        id: "123456789",
      }),
      captured,
    );

    const result = await whatsappActionHandlers.get_message_analytics(
      {
        start: 1700000000,
        end: 1700172800,
        phone_numbers: ["16505551111"],
        product_types: [0, 2],
        country_codes: [],
      },
      context,
    );

    expect(captured[0]?.url.pathname).toBe("/v23.0/123456789");
    expect(captured[0]?.url.searchParams.get("fields")).toBe(
      'analytics.start(1700000000).end(1700172800).granularity(DAY).phone_numbers(["16505551111"]).product_types([0,2])',
    );
    expect(result).toEqual({
      granularity: "DAY",
      data_points: [{ start: 1700000000, end: 1700086400, sent: 12, delivered: 11 }],
    });
  });

  it("flattens pricing analytics data[] buckets into one data_points list", async () => {
    const captured: CapturedRequest[] = [];
    const context = createContext(
      () => ({
        pricing_analytics: {
          data: [
            {
              data_points: [
                { start: 1, end: 2, volume: 3, cost: 0.5, pricing_category: "MARKETING", pricing_type: "REGULAR" },
              ],
            },
            { data_points: [{ start: 1, end: 2, volume: 7, cost: 0, pricing_category: "SERVICE" }] },
          ],
        },
      }),
      captured,
    );

    const result = await whatsappActionHandlers.get_pricing_analytics(
      { start: 1, end: 2, dimensions: ["PRICING_CATEGORY", "PRICING_TYPE"], metric_types: ["COST", "VOLUME"] },
      context,
    );

    expect(captured[0]?.url.searchParams.get("fields")).toBe(
      'pricing_analytics.start(1).end(2).granularity(DAILY).metric_types(["COST","VOLUME"]).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])',
    );
    expect(result).toEqual({
      data_points: [
        { start: 1, end: 2, volume: 3, cost: 0.5, pricing_category: "MARKETING", pricing_type: "REGULAR" },
        { start: 1, end: 2, volume: 7, cost: 0, pricing_category: "SERVICE" },
      ],
    });
  });

  it("reads template analytics from the edge with JSON list parameters and keeps paging", async () => {
    const captured: CapturedRequest[] = [];
    const context = createContext(
      () => ({
        data: [
          {
            granularity: "DAILY",
            product_type: "CLOUD_API",
            data_points: [
              {
                template_id: "987",
                start: 1,
                end: 2,
                sent: 5,
                delivered: 4,
                read: 3,
                clicked: [{ type: "quick_reply_button", button_content: "Yes", count: 2 }],
                cost: [{ type: "amount_spent", value: 1.25 }],
              },
            ],
          },
        ],
        paging: { cursors: { before: "b", after: "a" } },
      }),
      captured,
    );

    const result = await whatsappActionHandlers.get_template_analytics(
      { template_ids: ["987"], start: 1, end: 2, metric_types: ["SENT", "CLICKED"], use_waba_timezone: true },
      context,
    );

    const url = captured[0]?.url;
    expect(url?.pathname).toBe("/v23.0/123456789/template_analytics");
    expect(url?.searchParams.get("granularity")).toBe("DAILY");
    expect(url?.searchParams.get("template_ids")).toBe('["987"]');
    expect(url?.searchParams.get("metric_types")).toBe('["SENT","CLICKED"]');
    expect(url?.searchParams.get("use_waba_timezone")).toBe("true");
    expect(result).toEqual({
      data_points: [
        {
          template_id: "987",
          start: 1,
          end: 2,
          sent: 5,
          delivered: 4,
          read: 3,
          clicked: [{ type: "quick_reply_button", button_content: "Yes", count: 2 }],
          cost: [{ type: "amount_spent", value: 1.25 }],
        },
      ],
      paging: { cursors: { before: "b", after: "a" } },
    });
  });

  it("rejects a window whose start is not earlier than its end before calling Meta", async () => {
    const captured: CapturedRequest[] = [];
    const context = createContext(() => ({}), captured);

    await expect(whatsappActionHandlers.get_message_analytics({ start: 10, end: 10 }, context)).rejects.toMatchObject({
      status: 400,
    });
    expect(captured).toHaveLength(0);
  });
});
