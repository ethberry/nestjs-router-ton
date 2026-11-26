import { ConfigService } from "@nestjs/config";

import { TON_API } from "../ton-router.constants.js";

// A request to TON Center HTTP API v2 (`/<method>`): GET with `params` as the query, or POST with `body` as JSON
// (runGetMethod); returns the response's `result` or throws its error
export type TonApi = <T>(method: string, params?: Record<string, string | number>, body?: unknown) => Promise<T>;

export const tonApiProvider = {
  provide: TON_API,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): TonApi => {
    const url = configService.get<string>("TON_API_URL", "http://localhost:8082");
    const apiKey = configService.get<string>("TON_API_KEY");
    return async <T>(method: string, params: Record<string, string | number> = {}, body?: unknown): Promise<T> => {
      const query = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => query.append(key, String(value)));
      const headers: Record<string, string> = apiKey ? { "X-API-Key": apiKey } : {};
      const response = await fetch(
        `${url}/${method}?${query.toString()}`,
        body === undefined
          ? { headers }
          : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      const json = (await response.json()) as { ok: boolean; result: T; error?: string };
      if (!json.ok) {
        throw new Error(`TON API ${method}: ${json.error ?? response.status}`);
      }
      return json.result;
    };
  },
};
