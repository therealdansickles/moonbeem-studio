// GET /api/health — uptime probe + deployment readiness check.
//
// No auth and no rate limit, by design — uptime monitors hit this
// frequently and external probes don't carry credentials. Returns
// 200 when everything's healthy, 503 with per-service detail when
// any dependency is degraded. The 200/503 split lets monitors
// distinguish "site is up but DB is broken" from "site is down."
//
// Per-service 2s timeout via Promise.race so a hanging dependency
// doesn't tie up the probe forever.
//
// Response shape:
//   {
//     status: "ok" | "degraded",
//     timestamp: ISO-8601,
//     version: <short git sha> | "dev",
//     services: {
//       db:    { status: "ok" | "error", message?, latency_ms? },
//       redis: { status: "ok" | "error", message?, latency_ms? }
//     }
//   }

import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { createServiceRoleClient } from "@/lib/supabase/service";

const PER_SERVICE_TIMEOUT_MS = 2000;

type ServiceStatus = {
  status: "ok" | "error";
  message?: string;
  latency_ms?: number;
};

async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}-timeout-${ms}ms`)), ms),
    ),
  ]);
}

async function checkDb(): Promise<ServiceStatus> {
  const startedAt = Date.now();
  try {
    const supabase = createServiceRoleClient();
    // head:true + count:planned issues a minimal query that touches
    // the connection + planner without pulling row data. Faster than
    // an actual SELECT and exercises the read path end-to-end.
    const { error } = await withTimeout<{ error: { message: string } | null }>(
      supabase
        .from("partners")
        .select("id", { head: true, count: "planned" })
        .limit(0),
      PER_SERVICE_TIMEOUT_MS,
      "db",
    );
    if (error) {
      return {
        status: "error",
        message: error.message,
        latency_ms: Date.now() - startedAt,
      };
    }
    return { status: "ok", latency_ms: Date.now() - startedAt };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - startedAt,
    };
  }
}

async function checkRedis(): Promise<ServiceStatus> {
  const startedAt = Date.now();
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return {
      status: "error",
      message: "UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set",
      latency_ms: 0,
    };
  }
  try {
    const redis = new Redis({ url, token });
    const pong = await withTimeout(redis.ping(), PER_SERVICE_TIMEOUT_MS, "redis");
    if (pong !== "PONG") {
      return {
        status: "error",
        message: `unexpected ping response: ${String(pong)}`,
        latency_ms: Date.now() - startedAt,
      };
    }
    return { status: "ok", latency_ms: Date.now() - startedAt };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - startedAt,
    };
  }
}

export async function GET() {
  // Fan out both checks concurrently so total latency is max(db, redis)
  // rather than db + redis.
  const [db, redis] = await Promise.all([checkDb(), checkRedis()]);

  const overall: "ok" | "degraded" =
    db.status === "ok" && redis.status === "ok" ? "ok" : "degraded";

  const body = {
    status: overall,
    timestamp: new Date().toISOString(),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    services: { db, redis },
  };

  return NextResponse.json(body, {
    status: overall === "ok" ? 200 : 503,
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
