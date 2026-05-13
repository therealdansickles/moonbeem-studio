import { NextResponse, type NextRequest } from "next/server";
import { searchTitles } from "@/lib/queries/titles";
import { enforce, getIp } from "@/lib/ratelimit";

export async function GET(request: NextRequest) {
  const limit = await enforce("standardAnon", getIp(request), "search");
  if (!limit.ok) return limit.response;

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }
  const results = await searchTitles(q, 8);
  return NextResponse.json({ results });
}
