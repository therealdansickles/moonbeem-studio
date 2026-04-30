import { NextResponse, type NextRequest } from "next/server";
import { searchTitles } from "@/lib/queries/titles";

export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }
  const results = await searchTitles(q, 8);
  return NextResponse.json({ results });
}
